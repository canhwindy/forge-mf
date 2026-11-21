// The forge's in-memory model: repositories, refs, issues, pulls, labels, comments, and the git
// operations the REST, GraphQL and MCP surfaces share.
import {
  ObjectStore, ZERO, buildCommit, buildTree, parseCommit, parseTree, parseTagTarget,
  type TreeEntry,
} from './git.ts';

export const store = new ObjectStore();
export const LOGIN = process.env.MAKEFUN_SHOP_LOGIN || 'adaiversen';
export const USER_ID = 1000;

let clock = Date.UTC(2026, 0, 1) / 1000;
/** A logical clock: every event takes the next second, so two runs agree. */
export function tick(): number { clock += 1; return clock; }
export const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

export interface Label { id: number; name: string; color: string; description: string | null }
export interface Comment { id: number; body: string; created: number; updated: number }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; created: number; updated: number; closed: number | null; comments: Comment[];
  stateReason: string | null; isPull: boolean;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  created: number; updated: number; closed: number | null; merged: number | null; mergeSha: string | null;
  issue: Issue;
}
export interface Repo {
  id: number; owner: string; name: string; description: string | null; private: boolean;
  defaultBranch: string; refs: Map<string, string>; created: number; updated: number; pushed: number;
  issues: Map<number, Issue>; pulls: Map<number, Pull>; labels: Map<string, Label>; nextNumber: number;
  version: number; hasIssues: boolean; homepage: string | null;
}

let nextId = 1;
export const newId = () => nextId++;
export const repos = new Map<string, Repo>(); // key owner/name lower-case

const key = (o: string, n: string) => `${o.toLowerCase()}/${n.toLowerCase()}`;
export function getRepo(owner: string, name: string): Repo | undefined {
  if (name.endsWith('.git')) name = name.slice(0, -4);
  return repos.get(key(owner, name));
}
export function reposById(id: number): Repo | undefined {
  for (const r of repos.values()) if (r.id === id) return r;
  return undefined;
}

export function createRepo(name: string, opts: { description?: string | null; private?: boolean; autoInit?: boolean; homepage?: string | null }): Repo | null {
  if (repos.has(key(LOGIN, name))) return null;
  const t = tick();
  const r: Repo = {
    id: newId(), owner: LOGIN, name, description: opts.description ?? null, private: !!opts.private,
    defaultBranch: 'main', refs: new Map(), created: t, updated: t, pushed: t,
    issues: new Map(), pulls: new Map(), labels: new Map(), nextNumber: 1, version: 0, hasIssues: true,
    homepage: opts.homepage ?? null,
  };
  repos.set(key(LOGIN, name), r);
  if (opts.autoInit) {
    commitFiles(r, 'main', [{ path: 'README.md', content: Buffer.from(`# ${name}\n`) }], 'Initial commit');
  }
  return r;
}
export function deleteRepo(r: Repo) { repos.delete(key(r.owner, r.name)); }

export function setRef(r: Repo, ref: string, oid: string | null) {
  if (oid === null) r.refs.delete(ref); else r.refs.set(ref, oid);
  r.version++;
  r.pushed = r.updated = tick();
}

/** Resolve a branch name, a full ref, a tag or a sha to a commit oid. */
export function resolve(r: Repo, ref: string | undefined): string | null {
  if (!ref) ref = r.defaultBranch;
  const direct = r.refs.get(ref) ?? r.refs.get(`refs/heads/${ref}`) ?? r.refs.get(`refs/tags/${ref}`);
  let oid = direct ?? (/^[0-9a-f]{40}$/.test(ref) && store.has(ref) ? ref : null);
  while (oid) {
    const o = store.get(oid);
    if (o?.type === 'tag') oid = parseTagTarget(o.data); else break;
  }
  return oid ?? null;
}

const ident = (t: number) => `${LOGIN} <${LOGIN}@example.invalid> ${t} +0000`;

// ---------------------------------------------------------------- trees

/** Flatten a tree into path -> {oid, mode}. */
export function flatten(treeOid: string | null, prefix = '', out = new Map<string, { oid: string; mode: string }>()) {
  if (!treeOid) return out;
  const o = store.get(treeOid);
  if (!o) return out;
  for (const e of parseTree(o.data)) {
    const p = prefix + e.name;
    if (e.mode === '40000') flatten(e.oid, p + '/', out); else out.set(p, { oid: e.oid, mode: e.mode });
  }
  return out;
}
/** Build a tree from a flat path map. */
export function buildFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
  type Dir = Map<string, Dir | { oid: string; mode: string }>;
  const root: Dir = new Map();
  for (const [p, v] of flat) {
    const parts = p.split('/');
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = d.get(parts[i]);
      if (!(next instanceof Map)) { next = new Map(); d.set(parts[i], next); }
      d = next as Dir;
    }
    d.set(parts[parts.length - 1], v);
  }
  const write = (d: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of d) {
      if (v instanceof Map) entries.push({ mode: '40000', name, oid: write(v) });
      else entries.push({ mode: v.mode, name, oid: v.oid });
    }
    return store.put('tree', buildTree(entries));
  };
  return write(root);
}

/** Find the entry at a path: a blob, a tree, or null. */
export function lookupPath(treeOid: string, path: string): { oid: string; mode: string; type: 'file' | 'dir' } | null {
  const parts = path.split('/').filter(Boolean);
  let cur = { oid: treeOid, mode: '40000' };
  for (const part of parts) {
    const o = store.get(cur.oid);
    if (!o || o.type !== 'tree') return null;
    const e = parseTree(o.data).find((x) => x.name === part);
    if (!e) return null;
    cur = { oid: e.oid, mode: e.mode };
  }
  return { ...cur, type: cur.mode === '40000' ? 'dir' : 'file' };
}

export function commitTree(oid: string): string { return parseCommit(store.get(oid)!.data).tree; }

/** Apply file changes on a branch (content null = delete) and advance it; returns the commit oid. */
export function commitFiles(r: Repo, branch: string, changes: Array<{ path: string; content: Buffer | null }>, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = r.refs.get(ref) ?? null;
  const flat = flatten(parent ? commitTree(parent) : null);
  for (const c of changes) {
    if (c.content === null) flat.delete(c.path);
    else flat.set(c.path, { oid: store.put('blob', c.content), mode: '100644' });
  }
  const tree = buildFromFlat(flat);
  const t = tick();
  const oid = store.put('commit', buildCommit(tree, parent ? [parent] : [], ident(t), ident(t), message.endsWith('\n') ? message : message + '\n'));
  setRef(r, ref, oid);
  if (r.refs.size === 1 && !r.refs.has(`refs/heads/${r.defaultBranch}`)) r.defaultBranch = branch;
  return oid;
}

// ---------------------------------------------------------------- history

export function isAncestor(anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  while (queue.length) {
    const c = queue.pop()!;
    if (c === anc) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    const o = store.get(c);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) if (!seen.has(p)) queue.push(p);
  }
  return false;
}
export function ancestors(oid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    const o = store.get(c);
    if (!o || o.type !== 'commit') continue;
    seen.add(c);
    for (const p of parseCommit(o.data).parents) stack.push(p);
  }
  return seen;
}
export function mergeBase(a: string, b: string): string | null {
  const as = ancestors(a);
  // BFS from b, first hit in as
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    if (as.has(c)) return c;
    const o = store.get(c);
    if (!o) continue;
    for (const p of parseCommit(o.data).parents) queue.push(p);
  }
  return null;
}
/** Commits from tip, newest first (by walk order). */
export function log(tip: string, limit = 1e9): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const c = queue.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    const o = store.get(c);
    if (!o || o.type !== 'commit') continue;
    out.push(c);
    for (const p of parseCommit(o.data).parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange { filename: string; status: 'added' | 'modified' | 'removed'; sha: string; additions: number; deletions: number; changes: number; patch: string }

function lines(oid: string | undefined): string[] {
  if (!oid) return [];
  const t = store.get(oid)!.data.toString('utf8');
  if (t === '') return [];
  const ls = t.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}
function lineDiff(a: string[], b: string[]): { add: number; del: number; patch: string } {
  // trim common prefix/suffix, then LCS on the middle (bounded)
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  let common = 0;
  if (A.length && B.length && A.length * B.length <= 4_000_000) {
    let prev = new Uint32Array(B.length + 1);
    for (let i = 1; i <= A.length; i++) {
      const cur = new Uint32Array(B.length + 1);
      for (let j = 1; j <= B.length; j++) cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    common = prev[B.length];
  }
  const del = A.length - common, add = B.length - common;
  const patch = `@@ -${s + 1},${A.length} +${s + 1},${B.length} @@\n` + A.map((l) => `-${l}`).concat(B.map((l) => `+${l}`)).join('\n');
  return { add, del, patch };
}
export function diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
  const a = flatten(baseTree), b = flatten(headTree);
  const out: FileChange[] = [];
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const p of paths) {
    const x = a.get(p), y = b.get(p);
    if (x && y && x.oid === y.oid) continue;
    const d = lineDiff(lines(x?.oid), lines(y?.oid));
    out.push({
      filename: p, status: !x ? 'added' : !y ? 'removed' : 'modified', sha: (y ?? x)!.oid,
      additions: d.add, deletions: d.del, changes: d.add + d.del, patch: d.patch,
    });
  }
  return out;
}
/** Three-way merge of trees; null on conflict. */
export function mergeTrees(base: string | null, ours: string, theirs: string): string | null {
  const B = flatten(base), O = flatten(ours), T = flatten(theirs);
  const out = new Map(O);
  for (const p of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(p)?.oid, o = O.get(p)?.oid, t = T.get(p)?.oid;
    if (t === b) continue; // theirs unchanged
    if (o === b || o === t) { if (t) out.set(p, T.get(p)!); else out.delete(p); continue; }
    return null; // both changed differently
  }
  return buildFromFlat(out);
}

export function pullMergeable(r: Repo, p: Pull): boolean {
  const head = r.refs.get(`refs/heads/${p.head}`) ?? p.headSha;
  const base = r.refs.get(`refs/heads/${p.base}`) ?? p.baseSha;
  const mb = mergeBase(base, head);
  return mergeTrees(mb ? commitTree(mb) : null, commitTree(base), commitTree(head)) !== null;
}

export function pullFiles(r: Repo, p: Pull): FileChange[] {
  const head = p.merged ? p.headSha : (r.refs.get(`refs/heads/${p.head}`) ?? p.headSha);
  const base = p.merged ? p.baseSha : (r.refs.get(`refs/heads/${p.base}`) ?? p.baseSha);
  const mb = mergeBase(base, head);
  return diffTrees(mb ? commitTree(mb) : null, commitTree(head));
}

// ---------------------------------------------------------------- issues and pulls

export function createIssue(r: Repo, title: string, body: string, labels: string[]): Issue {
  const t = tick();
  const i: Issue = {
    id: newId(), number: r.nextNumber++, title, body, state: 'open', labels, created: t, updated: t,
    closed: null, comments: [], stateReason: null, isPull: false,
  };
  r.issues.set(i.number, i);
  return i;
}

export type PullResult = { ok: true; pull: Pull } | { ok: false; status: number; message: string };
export function createPull(r: Repo, title: string, body: string, head: string, base: string): PullResult {
  if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
  const headSha = r.refs.get(`refs/heads/${head}`);
  const baseSha = r.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { ok: false, status: 422, message: 'Validation Failed' };
  for (const p of r.pulls.values()) if (p.state === 'open' && p.head === head && p.base === base) return { ok: false, status: 422, message: `A pull request already exists for ${r.owner}:${head}.` };
  const t = tick();
  const issue: Issue = { id: newId(), number: r.nextNumber++, title, body, state: 'open', labels: [], created: t, updated: t, closed: null, comments: [], stateReason: null, isPull: true };
  r.issues.set(issue.number, issue);
  const p: Pull = { id: newId(), number: issue.number, title, body, state: 'open', head, base, headSha, baseSha, created: t, updated: t, closed: null, merged: null, mergeSha: null, issue };
  r.pulls.set(p.number, p);
  return { ok: true, pull: p };
}
export function refreshPull(r: Repo, p: Pull) {
  if (p.state !== 'open') return;
  p.headSha = r.refs.get(`refs/heads/${p.head}`) ?? p.headSha;
  p.baseSha = r.refs.get(`refs/heads/${p.base}`) ?? p.baseSha;
}

export type MergeResult = { ok: true; sha: string; message: string } | { ok: false; status: number; message: string };
export function mergePull(r: Repo, p: Pull, opts: { title?: string; message?: string; method?: string; sha?: string }): MergeResult {
  refreshPull(r, p);
  if (p.merged) return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  if (p.state !== 'open') return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
  if (opts.sha && opts.sha !== p.headSha) return { ok: false, status: 409, message: 'Head branch was modified. Review and try the merge again.' };
  const head = p.headSha, base = p.baseSha;
  const mb = mergeBase(base, head);
  const tree = mergeTrees(mb ? commitTree(mb) : null, commitTree(base), commitTree(head));
  if (tree === null) return { ok: false, status: 405, message: 'Merge conflict' };
  const t = tick();
  const title = opts.title || `${p.title} (#${p.number})`;
  const msg = opts.message ? `${title}\n\n${opts.message}\n` : `${title}\n`;
  const method = opts.method || 'merge';
  const parents = method === 'merge' ? [base, head] : [base];
  const sha = store.put('commit', buildCommit(tree, parents, ident(t), ident(t), msg));
  setRef(r, `refs/heads/${p.base}`, sha);
  p.state = 'closed'; p.merged = t; p.closed = t; p.updated = t; p.mergeSha = sha;
  p.issue.state = 'closed'; p.issue.closed = t; p.issue.updated = t;
  return { ok: true, sha, message: 'Pull Request successfully merged' };
}

export { ZERO };
