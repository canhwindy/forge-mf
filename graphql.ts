// GraphQL v4: a small parser and executor over the same store as REST, for the documents gh and
// github-mcp-server send (queries, mutations, fragments, variables, introspection of __type).
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as S from './store.ts';
import { parseCommit } from './git.ts';

// ---------------------------------------------------------------- lexer and parser

type Tok = { k: 'name' | 'punct' | 'str' | 'num' | 'eof'; v: string; pos: number };
class GqlError extends Error {
  extra: Record<string, unknown>;
  constructor(message: string, extra: Record<string, unknown> = {}) { super(message); this.extra = extra; }
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/[\s,﻿]/.test(c)) { i++; continue; }
    if (src.startsWith('...', i)) { toks.push({ k: 'punct', v: '...', pos: i }); i += 3; continue; }
    if ('{}()[]:!$=@|&'.includes(c)) { toks.push({ k: 'punct', v: c, pos: i }); i++; continue; }
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end < 0) throw new GqlError('Unterminated string');
      toks.push({ k: 'str', v: src.slice(i + 3, end), pos: i }); i = end + 3; continue;
    }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
          out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e; j += 2; continue;
        }
        out += src[j++];
      }
      if (j >= src.length) throw new GqlError('Unterminated string');
      toks.push({ k: 'str', v: out, pos: i }); i = j + 1; continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { toks.push({ k: 'num', v: num[0], pos: i }); i += num[0].length; continue; }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
    if (name) { toks.push({ k: 'name', v: name[0], pos: i }); i += name[0].length; continue; }
    throw new GqlError(`Syntax Error: Unexpected character "${c}"`);
  }
  toks.push({ k: 'eof', v: '', pos: src.length });
  return toks;
}

type Value = { kind: 'var'; name: string } | { kind: 'lit'; value: unknown } | { kind: 'list'; items: Value[] } | { kind: 'obj'; fields: Record<string, Value> } | { kind: 'enum'; value: string };
interface Field { kind: 'field'; alias: string; name: string; args: Record<string, Value>; sel: Sel[] | null; pos: number }
interface Inline { kind: 'inline'; on: string | null; sel: Sel[] }
interface Spread { kind: 'spread'; name: string }
type Sel = Field | Inline | Spread;
interface Operation { type: 'query' | 'mutation'; name: string | null; vars: Array<{ name: string; def: Value | null }>; sel: Sel[] }
interface Doc { ops: Operation[]; frags: Map<string, { on: string; sel: Sel[] }> }

function parse(src: string): Doc {
  const t = lex(src);
  let p = 0;
  const peek = () => t[p];
  const next = () => t[p++];
  const expect = (v: string) => { const x = next(); if (x.v !== v || (x.k !== 'punct' && x.k !== 'name')) throw new GqlError(`Syntax Error: Expected "${v}", found "${x.v || '<EOF>'}"`); return x; };
  const isP = (v: string) => peek().k === 'punct' && peek().v === v;
  const name = () => { const x = next(); if (x.k !== 'name') throw new GqlError(`Syntax Error: Expected Name, found "${x.v || '<EOF>'}"`); return x.v; };
  const value = (): Value => {
    const x = peek();
    if (isP('$')) { next(); return { kind: 'var', name: name() }; }
    if (isP('[')) { next(); const items: Value[] = []; while (!isP(']')) items.push(value()); next(); return { kind: 'list', items }; }
    if (isP('{')) { next(); const fields: Record<string, Value> = {}; while (!isP('}')) { const n = name(); expect(':'); fields[n] = value(); } next(); return { kind: 'obj', fields }; }
    next();
    if (x.k === 'str') return { kind: 'lit', value: x.v };
    if (x.k === 'num') return { kind: 'lit', value: Number(x.v) };
    if (x.k === 'name') {
      if (x.v === 'true') return { kind: 'lit', value: true };
      if (x.v === 'false') return { kind: 'lit', value: false };
      if (x.v === 'null') return { kind: 'lit', value: null };
      return { kind: 'enum', value: x.v };
    }
    throw new GqlError(`Syntax Error: Unexpected "${x.v}"`);
  };
  const directives = () => { while (isP('@')) { next(); name(); if (isP('(')) { next(); while (!isP(')')) { name(); expect(':'); value(); } next(); } } };
  const typeRef = () => { if (isP('[')) { next(); typeRef(); expect(']'); } else name(); if (isP('!')) next(); };
  const selection = (): Sel[] => {
    expect('{');
    const out: Sel[] = [];
    while (!isP('}')) {
      if (peek().k === 'eof') throw new GqlError('Syntax Error: Expected "}"');
      if (isP('...')) {
        next();
        if (peek().k === 'name' && peek().v === 'on') { next(); const on = name(); directives(); out.push({ kind: 'inline', on, sel: selection() }); }
        else if (isP('{') || isP('@')) { directives(); out.push({ kind: 'inline', on: null, sel: selection() }); }
        else { out.push({ kind: 'spread', name: name() }); directives(); }
        continue;
      }
      const pos = peek().pos;
      let alias = name(), fname = alias;
      if (isP(':')) { next(); fname = name(); }
      const args: Record<string, Value> = {};
      if (isP('(')) { next(); while (!isP(')')) { const n = name(); expect(':'); args[n] = value(); } next(); }
      directives();
      out.push({ kind: 'field', alias, name: fname, args, sel: isP('{') ? selection() : null, pos });
    }
    next();
    return out;
  };
  const doc: Doc = { ops: [], frags: new Map() };
  while (peek().k !== 'eof') {
    if (isP('{')) { doc.ops.push({ type: 'query', name: null, vars: [], sel: selection() }); continue; }
    const kw = name();
    if (kw === 'fragment') { const fn = name(); expect('on'); const on = name(); directives(); doc.frags.set(fn, { on, sel: selection() }); continue; }
    if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') throw new GqlError(`Syntax Error: Unexpected Name "${kw}"`);
    let opName: string | null = null;
    if (peek().k === 'name') opName = name();
    const vars: Operation['vars'] = [];
    if (isP('(')) {
      next();
      while (!isP(')')) { expect('$'); const vn = name(); expect(':'); typeRef(); let def: Value | null = null; if (isP('=')) { next(); def = value(); } directives(); vars.push({ name: vn, def }); }
      next();
    }
    directives();
    doc.ops.push({ type: kw === 'mutation' ? 'mutation' : 'query', name: opName, vars, sel: selection() });
  }
  if (doc.ops.length === 0) throw new GqlError('Syntax Error: no operation');
  return doc;
}

// ---------------------------------------------------------------- ids

export const nodeId = (kind: string, id: number | string) => Buffer.from(`0${kind.length}:${kind}${id}`).toString('base64');
function decodeId(id: string): { kind: string; id: string } | null {
  try {
    const s = Buffer.from(String(id), 'base64').toString('utf8');
    const m = /^\d+:([A-Za-z]+)(\d+)$/.exec(s) ?? /^\d+:([A-Za-z]+?)([0-9a-f]{40})$/.exec(s);
    if (!m) return null;
    return { kind: m[1], id: m[2] };
  } catch { return null; }
}
function findIssueById(id: number): { r: S.Repo; i: S.Issue } | null {
  for (const r of S.repos.values()) for (const i of r.issues.values()) if (i.id === id) return { r, i };
  return null;
}
function findPullById(id: number): { r: S.Repo; p: S.Pull } | null {
  for (const r of S.repos.values()) for (const p of r.pulls.values()) if (p.id === id) return { r, p };
  return null;
}
function nodeFromId(id: string): Obj | null {
  const d = decodeId(id);
  if (!d) return null;
  if (d.kind === 'Repository') { const r = S.reposById(Number(d.id)); return r ? obj('Repository', r) : null; }
  if (d.kind === 'Issue') { const f = findIssueById(Number(d.id)); return f ? (f.i.isPull ? pullObjFromIssue(f.r, f.i) : obj('Issue', f)) : null; }
  if (d.kind === 'PullRequest') { const f = findPullById(Number(d.id)); return f ? obj('PullRequest', f) : null; }
  if (d.kind === 'User') return obj('User', S.LOGIN);
  return null;
}
function pullObjFromIssue(r: S.Repo, i: S.Issue): Obj | null { const p = r.pulls.get(i.number); return p ? obj('PullRequest', { r, p }) : null; }

// ---------------------------------------------------------------- schema

type Obj = { __t: string; v: any };
const obj = (t: string, v: any): Obj => ({ __t: t, v });
type Resolver = (v: any, args: Record<string, any>) => unknown;

function connection(items: Obj[] | unknown[], args: Record<string, any>, nodeType: string): Obj {
  let start = 0;
  if (args.after) { const n = Number(Buffer.from(String(args.after), 'base64').toString().replace('cursor:', '')); if (Number.isFinite(n)) start = n + 1; }
  let end = items.length;
  if (args.before) { const n = Number(Buffer.from(String(args.before), 'base64').toString().replace('cursor:', '')); if (Number.isFinite(n)) end = Math.min(end, n); }
  let slice = items.slice(start, end).map((x, k) => ({ x, idx: start + k }));
  if (typeof args.first === 'number') slice = slice.slice(0, Math.max(0, args.first));
  else if (typeof args.last === 'number') slice = slice.slice(Math.max(0, slice.length - args.last));
  const cursor = (i: number) => Buffer.from(`cursor:${i}`).toString('base64');
  return obj(`${nodeType}Connection`, {
    nodes: slice.map((s) => s.x),
    edges: slice.map((s) => obj(`${nodeType}Edge`, { node: s.x, cursor: cursor(s.idx) })),
    totalCount: items.length,
    pageInfo: obj('PageInfo', {
      hasNextPage: slice.length ? slice[slice.length - 1].idx < end - 1 : false,
      hasPreviousPage: slice.length ? slice[0].idx > 0 : start > 0,
      startCursor: slice.length ? cursor(slice[0].idx) : null,
      endCursor: slice.length ? cursor(slice[slice.length - 1].idx) : null,
    }),
  });
}
const plain = (key: string): Resolver => (v) => v[key];
const CONN: Record<string, Resolver> = { nodes: plain('nodes'), edges: plain('edges'), totalCount: plain('totalCount'), pageInfo: plain('pageInfo') };
const EDGE: Record<string, Resolver> = { node: plain('node'), cursor: plain('cursor') };

const userFields: Record<string, Resolver> = {
  login: (v) => v, id: (v) => nodeId('User', v === S.LOGIN ? S.USER_ID : 2000), databaseId: (v) => (v === S.LOGIN ? S.USER_ID : 2000),
  name: (v) => v, email: (v) => `${v}@example.invalid`, url: (v) => `/${v}`, avatarUrl: () => '', __typename: () => 'User',
  repositories: (_v, a) => connection([...S.repos.values()].map((r) => obj('Repository', r)), a, 'Repository'),
};

function issuesOf(r: S.Repo, a: Record<string, any>): S.Issue[] {
  let list = [...r.issues.values()].filter((i) => !i.isPull);
  if (Array.isArray(a.states) && a.states.length) list = list.filter((i) => a.states.includes(i.state.toUpperCase()));
  if (a.filterBy?.states) list = list.filter((i) => a.filterBy.states.includes(i.state.toUpperCase()));
  const order = a.orderBy ?? { field: 'CREATED_AT', direction: 'ASC' };
  const key = (i: S.Issue) => (order.field === 'UPDATED_AT' ? i.updated : order.field === 'COMMENTS' ? i.comments.length : i.created);
  const dir = order.direction === 'DESC' ? -1 : 1;
  list.sort((x, y) => (key(x) - key(y) || x.number - y.number) * dir);
  return list;
}

const repoFields: Record<string, Resolver> = {
  __typename: () => 'Repository',
  id: (r: S.Repo) => nodeId('Repository', r.id), databaseId: (r: S.Repo) => r.id, name: (r: S.Repo) => r.name,
  nameWithOwner: (r: S.Repo) => `${r.owner}/${r.name}`, owner: (r: S.Repo) => obj('User', r.owner),
  description: (r: S.Repo) => r.description, url: (r: S.Repo) => `/${r.owner}/${r.name}`, isPrivate: (r: S.Repo) => r.private,
  visibility: (r: S.Repo) => (r.private ? 'PRIVATE' : 'PUBLIC'), isFork: () => false, isArchived: () => false, isEmpty: (r: S.Repo) => r.refs.size === 0,
  createdAt: (r: S.Repo) => S.iso(r.created), updatedAt: (r: S.Repo) => S.iso(r.updated), pushedAt: (r: S.Repo) => S.iso(r.pushed),
  defaultBranchRef: (r: S.Repo) => (r.refs.has(`refs/heads/${r.defaultBranch}`) ? obj('Ref', { r, name: r.defaultBranch }) : null),
  viewerPermission: () => 'ADMIN', viewerCanAdminister: () => true, hasIssuesEnabled: (r: S.Repo) => r.hasIssues, hasWikiEnabled: () => false,
  issue: (r: S.Repo, a) => { const i = r.issues.get(Number(a.number)); return i && !i.isPull ? obj('Issue', { r, i }) : null; },
  issueOrPullRequest: (r: S.Repo, a) => { const i = r.issues.get(Number(a.number)); return i ? (i.isPull ? pullObjFromIssue(r, i) : obj('Issue', { r, i })) : null; },
  issues: (r: S.Repo, a) => connection(issuesOf(r, a).map((i) => obj('Issue', { r, i })), a, 'Issue'),
  pullRequest: (r: S.Repo, a) => { const p = r.pulls.get(Number(a.number)); return p ? obj('PullRequest', { r, p }) : null; },
  pullRequests: (r: S.Repo, a) => {
    let list = [...r.pulls.values()];
    if (Array.isArray(a.states) && a.states.length) list = list.filter((p) => a.states.includes(pullState(p)));
    if (a.headRefName) list = list.filter((p) => p.head === a.headRefName);
    if (a.baseRefName) list = list.filter((p) => p.base === a.baseRefName);
    if (a.orderBy?.direction === 'DESC') list.reverse();
    return connection(list.map((p) => obj('PullRequest', { r, p })), a, 'PullRequest');
  },
  labels: (r: S.Repo, a) => connection([...r.labels.values()].map((l) => obj('Label', l)), a, 'Label'),
  ref: (r: S.Repo, a) => { const n = String(a.qualifiedName ?? '').replace(/^refs\/heads\//, ''); return r.refs.has(`refs/heads/${n}`) ? obj('Ref', { r, name: n }) : null; },
};
const refFields: Record<string, Resolver> = {
  __typename: () => 'Ref', name: (v) => v.name, prefix: () => 'refs/heads/', id: (v) => nodeId('Ref', `${v.r.id}${v.name}`),
  target: (v) => { const oid = v.r.refs.get(`refs/heads/${v.name}`); return oid ? obj('Commit', oid) : null; },
};
const commitFields: Record<string, Resolver> = {
  __typename: () => 'Commit', oid: (v) => v, id: (v) => nodeId('Commit', v), abbreviatedOid: (v) => String(v).slice(0, 7),
  message: (v) => parseCommit(S.store.get(v)!.data).message.replace(/\n$/, ''),
  messageHeadline: (v) => parseCommit(S.store.get(v)!.data).message.split('\n')[0],
};
const labelFields: Record<string, Resolver> = {
  __typename: () => 'Label', id: (l: S.Label) => nodeId('Label', l.id), name: (l: S.Label) => l.name, color: (l: S.Label) => l.color, description: (l: S.Label) => l.description,
};
const issueFields: Record<string, Resolver> = {
  __typename: () => 'Issue',
  id: ({ i }) => nodeId('Issue', i.id), databaseId: ({ i }) => i.id, number: ({ i }) => i.number, title: ({ i }) => i.title, body: ({ i }) => i.body,
  bodyText: ({ i }) => i.body, state: ({ i }) => i.state.toUpperCase(), stateReason: ({ i }) => (i.stateReason ? i.stateReason.toUpperCase() : null),
  closed: ({ i }) => i.state === 'closed', closedAt: ({ i }) => (i.closed ? S.iso(i.closed) : null), createdAt: ({ i }) => S.iso(i.created), updatedAt: ({ i }) => S.iso(i.updated),
  url: ({ r, i }) => `/${r.owner}/${r.name}/issues/${i.number}`, author: () => obj('User', S.LOGIN), locked: () => false,
  repository: ({ r }) => obj('Repository', r),
  labels: ({ r, i }, a) => connection(i.labels.map((n: string) => r.labels.get(n.toLowerCase())).filter(Boolean).map((l: S.Label) => obj('Label', l)), a, 'Label'),
  comments: ({ r, i }, a) => connection(i.comments.map((c: S.Comment) => obj('IssueComment', { r, i, c })), a, 'IssueComment'),
  assignees: (_v, a) => connection([], a, 'User'), milestone: () => null, reactionGroups: () => [], projectCards: (_v, a) => connection([], a, 'ProjectCard'),
};
const commentFields: Record<string, Resolver> = {
  __typename: () => 'IssueComment', id: ({ c }) => nodeId('IssueComment', c.id), databaseId: ({ c }) => c.id, body: ({ c }) => c.body,
  createdAt: ({ c }) => S.iso(c.created), author: () => obj('User', S.LOGIN), url: ({ r, i, c }) => `/${r.owner}/${r.name}/issues/${i.number}#issuecomment-${c.id}`,
};
const pullState = (p: S.Pull) => (p.merged ? 'MERGED' : p.state.toUpperCase());
const pullFields: Record<string, Resolver> = {
  __typename: () => 'PullRequest',
  id: ({ p }) => nodeId('PullRequest', p.id), databaseId: ({ p }) => p.id, number: ({ p }) => p.number, title: ({ p }) => p.title, body: ({ p }) => p.body,
  state: ({ r, p }) => { S.refreshPull(r, p); return pullState(p); }, merged: ({ p }) => !!p.merged, mergedAt: ({ p }) => (p.merged ? S.iso(p.merged) : null),
  closed: ({ p }) => p.state === 'closed', closedAt: ({ p }) => (p.closed ? S.iso(p.closed) : null), isDraft: () => false,
  createdAt: ({ p }) => S.iso(p.created), updatedAt: ({ p }) => S.iso(p.updated), url: ({ r, p }) => `/${r.owner}/${r.name}/pull/${p.number}`,
  headRefName: ({ p }) => p.head, baseRefName: ({ p }) => p.base,
  headRefOid: ({ r, p }) => { S.refreshPull(r, p); return p.headSha; }, baseRefOid: ({ r, p }) => { S.refreshPull(r, p); return p.baseSha; },
  headRepository: ({ r }) => obj('Repository', r), baseRepository: ({ r }) => obj('Repository', r), repository: ({ r }) => obj('Repository', r),
  mergeable: ({ r, p }) => (p.state !== 'open' ? 'UNKNOWN' : S.pullMergeable(r, p) ? 'MERGEABLE' : 'CONFLICTING'),
  mergeCommit: ({ p }) => (p.mergeSha ? obj('Commit', p.mergeSha) : null), author: () => obj('User', S.LOGIN),
  files: ({ r, p }, a) => connection(S.pullFiles(r, p).map((f) => obj('PullRequestChangedFile', f)), a, 'PullRequestChangedFile'),
  changedFiles: ({ r, p }) => S.pullFiles(r, p).length,
  additions: ({ r, p }) => S.pullFiles(r, p).reduce((x, f) => x + f.additions, 0), deletions: ({ r, p }) => S.pullFiles(r, p).reduce((x, f) => x + f.deletions, 0),
  labels: (_v, a) => connection([], a, 'Label'), assignees: (_v, a) => connection([], a, 'User'),
  comments: ({ r, p }, a) => connection(p.issue.comments.map((c: S.Comment) => obj('IssueComment', { r, i: p.issue, c })), a, 'IssueComment'),
};
const fileFields: Record<string, Resolver> = {
  __typename: () => 'PullRequestChangedFile', path: (f: S.FileChange) => f.filename, additions: (f: S.FileChange) => f.additions, deletions: (f: S.FileChange) => f.deletions,
  changeType: (f: S.FileChange) => ({ added: 'ADDED', modified: 'MODIFIED', removed: 'DELETED' })[f.status],
};

function repoFromId(id: unknown): S.Repo {
  const d = decodeId(String(id));
  const r = d?.kind === 'Repository' ? S.reposById(Number(d.id)) : undefined;
  if (!r) throw new GqlError(`Could not resolve to a node with the global id of '${id}'`, { type: 'NOT_FOUND' });
  return r;
}
const mutationFields: Record<string, Resolver> = {
  createIssue: (_v, a) => {
    const inp = a.input ?? {};
    const r = repoFromId(inp.repositoryId);
    if (typeof inp.title !== 'string' || inp.title === '') throw new GqlError('title cannot be blank');
    const labels: string[] = [];
    for (const lid of inp.labelIds ?? []) { const d = decodeId(lid); const l = [...r.labels.values()].find((x) => String(x.id) === d?.id); if (!l) throw new GqlError(`Could not resolve label ${lid}`); labels.push(l.name); }
    const i = S.createIssue(r, inp.title, inp.body ?? '', labels);
    return obj('CreateIssuePayload', { issue: obj('Issue', { r, i }), clientMutationId: inp.clientMutationId ?? null });
  },
  closeIssue: (_v, a) => {
    const inp = a.input ?? {};
    const d = decodeId(String(inp.issueId));
    const f = d && findIssueById(Number(d.id));
    if (!f) throw new GqlError(`Could not resolve to a node with the global id of '${inp.issueId}'`, { type: 'NOT_FOUND' });
    const t = S.tick();
    f.i.state = 'closed'; f.i.closed = t; f.i.updated = t; f.i.stateReason = (inp.stateReason ?? 'COMPLETED').toLowerCase();
    return obj('CloseIssuePayload', { issue: obj('Issue', f), clientMutationId: inp.clientMutationId ?? null });
  },
  reopenIssue: (_v, a) => {
    const inp = a.input ?? {};
    const d = decodeId(String(inp.issueId));
    const f = d && findIssueById(Number(d.id));
    if (!f) throw new GqlError(`Could not resolve to a node with the global id of '${inp.issueId}'`, { type: 'NOT_FOUND' });
    f.i.state = 'open'; f.i.closed = null; f.i.updated = S.tick(); f.i.stateReason = 'reopened';
    return obj('ReopenIssuePayload', { issue: obj('Issue', f), clientMutationId: inp.clientMutationId ?? null });
  },
  createPullRequest: (_v, a) => {
    const inp = a.input ?? {};
    const r = repoFromId(inp.repositoryId);
    const res = S.createPull(r, String(inp.title ?? ''), inp.body ?? '', String(inp.headRefName ?? ''), String(inp.baseRefName ?? r.defaultBranch));
    if (!res.ok) throw new GqlError(res.message, { type: 'UNPROCESSABLE' });
    return obj('CreatePullRequestPayload', { pullRequest: obj('PullRequest', { r, p: res.pull }), clientMutationId: inp.clientMutationId ?? null });
  },
  mergePullRequest: (_v, a) => {
    const inp = a.input ?? {};
    const d = decodeId(String(inp.pullRequestId));
    const f = d && findPullById(Number(d.id));
    if (!f) throw new GqlError(`Could not resolve to a node with the global id of '${inp.pullRequestId}'`, { type: 'NOT_FOUND' });
    const method = String(inp.mergeMethod ?? 'MERGE').toLowerCase();
    const res = S.mergePull(f.r, f.p, { title: inp.commitHeadline, message: inp.commitBody, method, sha: inp.expectedHeadOid });
    if (!res.ok) throw new GqlError(res.message, { type: 'UNPROCESSABLE' });
    return obj('MergePullRequestPayload', { pullRequest: obj('PullRequest', f), clientMutationId: inp.clientMutationId ?? null });
  },
  addComment: (_v, a) => {
    const inp = a.input ?? {};
    const d = decodeId(String(inp.subjectId));
    let f: { r: S.Repo; i: S.Issue } | null = null;
    if (d?.kind === 'Issue') f = findIssueById(Number(d.id));
    if (d?.kind === 'PullRequest') { const pf = findPullById(Number(d.id)); if (pf) f = { r: pf.r, i: pf.p.issue }; }
    if (!f) throw new GqlError(`Could not resolve to a node with the global id of '${inp.subjectId}'`, { type: 'NOT_FOUND' });
    if (typeof inp.body !== 'string' || inp.body === '') throw new GqlError('body cannot be blank');
    const t = S.tick();
    const c: S.Comment = { id: S.newId(), body: inp.body, created: t, updated: t };
    f.i.comments.push(c); f.i.updated = t;
    const node = obj('IssueComment', { r: f.r, i: f.i, c });
    return obj('AddCommentPayload', { commentEdge: obj('IssueCommentEdge', { node, cursor: Buffer.from(`cursor:${f.i.comments.length - 1}`).toString('base64') }), subject: f.i.isPull ? pullObjFromIssue(f.r, f.i) : obj('Issue', f), timelineEdge: null, clientMutationId: inp.clientMutationId ?? null });
  },
};
const payload = (keys: string[]): Record<string, Resolver> => Object.fromEntries([...keys, 'clientMutationId'].map((k) => [k, plain(k)]));

const queryFields: Record<string, Resolver> = {
  viewer: () => obj('User', S.LOGIN),
  user: (_v, a) => (String(a.login).toLowerCase() === S.LOGIN ? obj('User', S.LOGIN) : null),
  repositoryOwner: (_v, a) => (String(a.login).toLowerCase() === S.LOGIN ? obj('User', S.LOGIN) : null),
  repository: (_v, a) => { const r = S.getRepo(String(a.owner), String(a.name)); return r ? obj('Repository', r) : null; },
  node: (_v, a) => nodeFromId(String(a.id)),
  nodes: (_v, a) => (Array.isArray(a.ids) ? a.ids.map((id: string) => nodeFromId(id)) : []),
  rateLimit: () => obj('RateLimit', { limit: 5000, remaining: 5000, cost: 1, used: 0, resetAt: S.iso(0) }),
  search: (_v, a) => {
    const q = String(a.query ?? '');
    const m = /repo:([^\s/]+)\/([^\s]+)/.exec(q);
    const out: Obj[] = [];
    for (const r of S.repos.values()) {
      if (m && (r.owner.toLowerCase() !== m[1].toLowerCase() || r.name.toLowerCase() !== m[2].toLowerCase())) continue;
      for (const i of r.issues.values()) {
        if (/is:pr/.test(q) && !i.isPull) continue;
        if (/is:issue/.test(q) && i.isPull) continue;
        if (/is:open|state:open/.test(q) && i.state !== 'open') continue;
        if (/is:closed|state:closed/.test(q) && i.state !== 'closed') continue;
        out.push(i.isPull ? pullObjFromIssue(r, i)! : obj('Issue', { r, i }));
      }
    }
    const c = connection(out, a, 'SearchResultItem');
    c.v.issueCount = out.length;
    return c;
  },
};

const TYPES: Record<string, Record<string, Resolver>> = {
  Query: queryFields, Mutation: mutationFields, User: userFields, Repository: repoFields, Ref: refFields, Commit: commitFields,
  Label: labelFields, Issue: issueFields, IssueComment: commentFields, PullRequest: pullFields, PullRequestChangedFile: fileFields,
  PageInfo: { hasNextPage: plain('hasNextPage'), hasPreviousPage: plain('hasPreviousPage'), startCursor: plain('startCursor'), endCursor: plain('endCursor') },
  RateLimit: { limit: plain('limit'), remaining: plain('remaining'), cost: plain('cost'), used: plain('used'), resetAt: plain('resetAt') },
  CreateIssuePayload: payload(['issue']), CloseIssuePayload: payload(['issue']), ReopenIssuePayload: payload(['issue']),
  CreatePullRequestPayload: payload(['pullRequest']), MergePullRequestPayload: payload(['pullRequest']),
  AddCommentPayload: payload(['commentEdge', 'subject', 'timelineEdge']),
};
for (const n of ['Repository', 'Issue', 'IssueComment', 'PullRequest', 'PullRequestChangedFile', 'Label', 'User', 'SearchResultItem', 'ProjectCard']) {
  TYPES[`${n}Connection`] = { ...CONN, ...(n === 'SearchResultItem' ? { issueCount: plain('issueCount') } : {}) };
  TYPES[`${n}Edge`] = EDGE;
}
const INTERFACES: Record<string, string[]> = { Node: ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label', 'Commit', 'Ref'], SearchResultItem: ['Issue', 'PullRequest', 'Repository', 'User'], RepositoryOwner: ['User'], Actor: ['User'] };
const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
};

function introspectType(name: string): Obj | null {
  if (TYPES[name] && name !== 'Query' && name !== 'Mutation' || name === 'Query' || name === 'Mutation') {
    const fields = Object.keys(TYPES[name]).filter((f) => f !== '__typename').map((f) => obj('__Field', { name: f }));
    return obj('__Type', { name, kind: 'OBJECT', fields, enumValues: null, interfaces: [], possibleTypes: null, description: null });
  }
  if (ENUMS[name]) return obj('__Type', { name, kind: 'ENUM', fields: null, enumValues: ENUMS[name].map((v) => obj('__EnumValue', { name: v })), interfaces: null, possibleTypes: null, description: null });
  if (INTERFACES[name]) return obj('__Type', { name, kind: name === 'SearchResultItem' ? 'UNION' : 'INTERFACE', fields: name === 'SearchResultItem' ? null : [obj('__Field', { name: 'id' })], enumValues: null, interfaces: null, possibleTypes: INTERFACES[name].map((t) => obj('__Type', { name: t, kind: 'OBJECT' })), description: null });
  if (['String', 'Int', 'Boolean', 'ID', 'Float', 'DateTime', 'URI', 'GitObjectID', 'HTML'].includes(name)) return obj('__Type', { name, kind: 'SCALAR', fields: null, enumValues: null, interfaces: null, possibleTypes: null, description: null });
  return null;
}
TYPES.__Type = { name: plain('name'), kind: plain('kind'), description: plain('description'), fields: plain('fields'), enumValues: plain('enumValues'), interfaces: plain('interfaces'), possibleTypes: plain('possibleTypes'), ofType: () => null };
TYPES.__Field = { name: plain('name'), description: () => null, isDeprecated: () => false, deprecationReason: () => null, args: () => [], type: () => obj('__Type', { name: 'String', kind: 'SCALAR' }) };
TYPES.__EnumValue = { name: plain('name'), description: () => null, isDeprecated: () => false, deprecationReason: () => null };
TYPES.__Schema = { queryType: () => obj('__Type', { name: 'Query', kind: 'OBJECT' }), mutationType: () => obj('__Type', { name: 'Mutation', kind: 'OBJECT' }), subscriptionType: () => null, types: () => Object.keys(TYPES).filter((t) => !t.startsWith('__')).map((t) => introspectType(t)), directives: () => [] };

// ---------------------------------------------------------------- execution

function evalValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name] ?? null;
    case 'lit': return v.value;
    case 'enum': return v.value;
    case 'list': return v.items.map((x) => evalValue(x, vars));
    case 'obj': return Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, evalValue(x, vars)]));
  }
}

interface Ctx { doc: Doc; vars: Record<string, unknown>; errors: any[] }

function typeMatches(cond: string | null, t: string): boolean {
  if (!cond || cond === t) return true;
  return INTERFACES[cond]?.includes(t) ?? false;
}

function collect(ctx: Ctx, sel: Sel[], t: string, out: Field[] = []): Field[] {
  for (const s of sel) {
    if (s.kind === 'field') out.push(s);
    else if (s.kind === 'inline') { if (typeMatches(s.on, t)) collect(ctx, s.sel, t, out); }
    else {
      const f = ctx.doc.frags.get(s.name);
      if (!f) throw new GqlError(`Fragment ${s.name} was used, but not defined`);
      if (typeMatches(f.on, t)) collect(ctx, f.sel, t, out);
    }
  }
  return out;
}

/** Static validation: every field named on a known type must exist. */
function validate(ctx: Ctx, sel: Sel[], t: string, path: string[]) {
  const fields = TYPES[t];
  if (!fields) return;
  for (const s of sel) {
    if (s.kind === 'inline') { validate(ctx, s.sel, s.on && TYPES[s.on] ? s.on : t, path); continue; }
    if (s.kind === 'spread') { const f = ctx.doc.frags.get(s.name); if (!f) throw new GqlError(`Fragment ${s.name} was used, but not defined`); validate(ctx, f.sel, TYPES[f.on] ? f.on : t, path); continue; }
    if (s.name === '__typename') continue;
    if ((t === 'Query') && (s.name === '__type' || s.name === '__schema')) continue;
    if (!(s.name in fields)) {
      ctx.errors.push({
        message: `Field '${s.name}' doesn't exist on type '${t}'`, locations: [{ line: 1, column: s.pos + 1 }], path: [...path, s.alias],
        extensions: { code: 'undefinedField', typeName: t, fieldName: s.name },
      });
    }
  }
}

function execSel(ctx: Ctx, sel: Sel[], value: Obj, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const t = value.__t;
  for (const f of collect(ctx, sel, t)) {
    const p = [...path, f.alias];
    if (f.name === '__typename') { out[f.alias] = t; continue; }
    const args = Object.fromEntries(Object.entries(f.args).map(([k, v]) => [k, evalValue(v, ctx.vars)]));
    let res: unknown;
    try {
      if (t === 'Query' && f.name === '__type') res = introspectType(String(args.name));
      else if (t === 'Query' && f.name === '__schema') res = obj('__Schema', {});
      else {
        const fields = TYPES[t];
        const r = fields?.[f.name];
        if (!r) throw new GqlError(`Field '${f.name}' doesn't exist on type '${t}'`, { extensions: { code: 'undefinedField', typeName: t, fieldName: f.name } });
        if (t === '__Type' && (f.name === 'fields' || f.name === 'enumValues') && value.v[f.name] === undefined) res = null;
        else res = r(value.v, args);
      }
      out[f.alias] = complete(ctx, f, res, p);
    } catch (e) {
      if (!(e instanceof GqlError)) throw e;
      ctx.errors.push({ message: e.message, path: p, locations: [{ line: 1, column: f.pos + 1 }], ...e.extra });
      out[f.alias] = null;
    }
  }
  return out;
}

function complete(ctx: Ctx, f: Field, res: unknown, path: Array<string | number>): unknown {
  if (res === null || res === undefined) return null;
  if (Array.isArray(res)) return res.map((x, i) => complete(ctx, f, x, [...path, i]));
  if (typeof res === 'object' && '__t' in (res as object)) {
    if (!f.sel) return null;
    return execSel(ctx, f.sel, res as Obj, path);
  }
  return res;
}

function runOne(body: any): Record<string, unknown> {
  if (!body || typeof body !== 'object' || typeof body.query !== 'string') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc: Doc;
  try { doc = parse(body.query); } catch (e) { return { errors: [{ message: (e as Error).message, extensions: { code: 'parseError' } }] }; }
  let op = doc.ops[0];
  if (body.operationName) { const m = doc.ops.find((o) => o.name === body.operationName); if (!m) return { errors: [{ message: `Unknown operation named "${body.operationName}".` }] }; op = m; }
  else if (doc.ops.length > 1) return { errors: [{ message: 'An operation name is required when the document holds several operations.' }] };
  const vars: Record<string, unknown> = { ...(body.variables && typeof body.variables === 'object' ? body.variables : {}) };
  for (const v of op.vars) if (!(v.name in vars) && v.def) vars[v.name] = evalValue(v.def, {});
  const ctx: Ctx = { doc, vars, errors: [] };
  const root = op.type === 'mutation' ? 'Mutation' : 'Query';
  try { validate(ctx, op.sel, root, []); } catch (e) { return { errors: [{ message: (e as Error).message }] }; }
  if (ctx.errors.length) return { errors: ctx.errors };
  const data = execSel(ctx, op.sel, obj(root, null), []);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  let status = 200;
  let out: unknown;
  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); } catch { status = 400; out = { message: 'Problems parsing JSON' }; }
  if (out === undefined) out = Array.isArray(body) ? body.map(runOne) : runOne(body);
  const buf = Buffer.from(JSON.stringify(out));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'x-github-request-id': 'F0RG:GQL' });
  res.end(buf);
}
