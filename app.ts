// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, over one in-memory store.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import * as S from './store.ts';
import { parseCommit, parseIdent } from './git.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let reqCounter = 0;

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}

export function authOk(req: IncomingMessage): boolean {
  const h = String(req.headers.authorization ?? '');
  const m = /^(?:bearer|token)\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  return TOKEN === '' ? m[1].length > 0 : m[1] === TOKEN;
}

export function baseUrl(req: IncomingMessage): string { return `http://${req.headers.host ?? 'localhost'}`; }

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const buf = status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `F0RG:${(++reqCounter).toString(16).toUpperCase()}`,
    'content-length': buf.length,
    ...headers,
  });
  res.end(buf);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(body: Buffer): any {
  if (body.length === 0) return {};
  try { return JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Problems parsing JSON'); }
}

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      if (path === '/healthz') return sendJson(res, 200, { ok: true });
      const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const body = await readBody(req);
        return await handleGit(req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3], url.searchParams, body);
      }
      const body = await readBody(req);
      if (path === '/mcp' || path.startsWith('/mcp/')) return await handleMcp(req, res, body);
      if (path === '/api/graphql' || path === '/graphql') {
        if (!authOk(req)) return sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' });
        return await handleGraphql(req, res, body);
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authOk(req)) return sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
        const sub = path.slice(7) || '/';
        const out = await rest(req, sub, url.searchParams, body);
        return sendJson(res, out.status, out.body, out.headers);
      }
      return sendJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { message: e.message, ...e.extra });
      process.stderr.write(`[forge] ${(e as Error).stack}\n`);
      return sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
  server.keepAliveTimeout = 65_000;
  return server;
}

// ---------------------------------------------------------------- serializers (shared with GraphQL/MCP)

let BASE = 'http://localhost';
export const userJson = (login = S.LOGIN) => ({
  login, id: login === S.LOGIN ? S.USER_ID : 2000, node_id: Buffer.from(`04:User${login}`).toString('base64'),
  avatar_url: '', gravatar_id: '', url: `${BASE}/api/v3/users/${login}`, html_url: `${BASE}/${login}`,
  type: 'User', site_admin: false, name: login, email: `${login}@example.invalid`,
});
export function repoJson(r: S.Repo) {
  const full = `${r.owner}/${r.name}`;
  const open = [...r.issues.values()].filter((i) => i.state === 'open' && !i.isPull).length;
  return {
    id: r.id, node_id: Buffer.from(`010:Repository${r.id}`).toString('base64'), name: r.name, full_name: full,
    owner: userJson(r.owner), private: r.private, visibility: r.private ? 'private' : 'public',
    description: r.description, fork: false, homepage: r.homepage,
    url: `${BASE}/api/v3/repos/${full}`, html_url: `${BASE}/${full}`, clone_url: `${BASE}/${full}.git`,
    git_url: `${BASE}/${full}.git`, ssh_url: `${BASE}/${full}.git`,
    created_at: S.iso(r.created), updated_at: S.iso(r.updated), pushed_at: S.iso(r.pushed),
    default_branch: r.defaultBranch, size: 0, stargazers_count: 0, watchers_count: 0, forks_count: 0,
    open_issues_count: open, has_issues: r.hasIssues, has_projects: false, has_wiki: false, has_pages: false,
    has_downloads: true, archived: false, disabled: false, language: null, topics: [], license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
  };
}
export function labelJson(r: S.Repo, l: S.Label) {
  return { id: l.id, node_id: Buffer.from(`010:Label${l.id}`).toString('base64'), url: `${BASE}/api/v3/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, description: l.description, default: false };
}
export function issueJson(r: S.Repo, i: S.Issue) {
  const full = `${r.owner}/${r.name}`;
  const o: Record<string, unknown> = {
    id: i.id, node_id: Buffer.from(`05:Issue${i.id}`).toString('base64'), number: i.number, title: i.title, body: i.body,
    state: i.state, state_reason: i.stateReason, locked: false,
    labels: i.labels.map((n) => r.labels.get(n.toLowerCase())).filter(Boolean).map((l) => labelJson(r, l!)),
    user: userJson(), assignee: null, assignees: [], milestone: null, comments: i.comments.length,
    created_at: S.iso(i.created), updated_at: S.iso(i.updated), closed_at: i.closed ? S.iso(i.closed) : null,
    author_association: 'OWNER', url: `${BASE}/api/v3/repos/${full}/issues/${i.number}`,
    html_url: `${BASE}/${full}/issues/${i.number}`, repository_url: `${BASE}/api/v3/repos/${full}`,
    comments_url: `${BASE}/api/v3/repos/${full}/issues/${i.number}/comments`,
  };
  if (i.isPull) o.pull_request = { url: `${BASE}/api/v3/repos/${full}/pulls/${i.number}`, html_url: `${BASE}/${full}/pull/${i.number}`, merged_at: r.pulls.get(i.number)?.merged ? S.iso(r.pulls.get(i.number)!.merged!) : null };
  return o;
}
export function commentJson(r: S.Repo, i: S.Issue, c: S.Comment) {
  const full = `${r.owner}/${r.name}`;
  return {
    id: c.id, node_id: Buffer.from(`012:IssueComment${c.id}`).toString('base64'), body: c.body, user: userJson(),
    created_at: S.iso(c.created), updated_at: S.iso(c.updated), author_association: 'OWNER',
    url: `${BASE}/api/v3/repos/${full}/issues/comments/${c.id}`, html_url: `${BASE}/${full}/issues/${i.number}#issuecomment-${c.id}`,
    issue_url: `${BASE}/api/v3/repos/${full}/issues/${i.number}`,
  };
}
export function pullJson(r: S.Repo, p: S.Pull) {
  S.refreshPull(r, p);
  const full = `${r.owner}/${r.name}`;
  const branch = (ref: string, sha: string) => ({ label: `${r.owner}:${ref}`, ref, sha, user: userJson(), repo: repoJson(r) });
  const mergeable = p.state === 'open' ? S.pullMergeable(r, p) : null;
  const files = S.pullFiles(r, p);
  return {
    id: p.id, node_id: Buffer.from(`011:PullRequest${p.id}`).toString('base64'), number: p.number, state: p.state,
    locked: false, title: p.title, body: p.body, user: userJson(),
    created_at: S.iso(p.created), updated_at: S.iso(p.updated), closed_at: p.closed ? S.iso(p.closed) : null,
    merged_at: p.merged ? S.iso(p.merged) : null, merge_commit_sha: p.mergeSha, merged: !!p.merged,
    mergeable, mergeable_state: mergeable === false ? 'dirty' : 'clean', merged_by: p.merged ? userJson() : null,
    draft: false, head: branch(p.head, p.headSha), base: branch(p.base, p.baseSha),
    labels: [], assignees: [], requested_reviewers: [], comments: p.issue.comments.length, review_comments: 0,
    commits: 1, additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0),
    changed_files: files.length, author_association: 'OWNER',
    url: `${BASE}/api/v3/repos/${full}/pulls/${p.number}`, html_url: `${BASE}/${full}/pull/${p.number}`,
    issue_url: `${BASE}/api/v3/repos/${full}/issues/${p.number}`, diff_url: `${BASE}/${full}/pull/${p.number}.diff`,
  };
}
export function commitJson(r: S.Repo, oid: string) {
  const c = parseCommit(S.store.get(oid)!.data);
  const a = parseIdent(c.author), m = parseIdent(c.committer);
  const full = `${r.owner}/${r.name}`;
  return {
    sha: oid, node_id: Buffer.from(`06:Commit${oid}`).toString('base64'),
    commit: {
      author: a, committer: m, message: c.message.replace(/\n$/, ''), tree: { sha: c.tree, url: `${BASE}/api/v3/repos/${full}/git/trees/${c.tree}` },
      url: `${BASE}/api/v3/repos/${full}/git/commits/${oid}`, comment_count: 0,
    },
    url: `${BASE}/api/v3/repos/${full}/commits/${oid}`, html_url: `${BASE}/${full}/commit/${oid}`,
    author: userJson(), committer: userJson(),
    parents: c.parents.map((p) => ({ sha: p, url: `${BASE}/api/v3/repos/${full}/commits/${p}` })),
  };
}

// ---------------------------------------------------------------- REST

type Out = { status: number; body: unknown; headers?: Record<string, string> };
const ok = (body: unknown, status = 200, headers?: Record<string, string>): Out => ({ status, body, headers });
const notFound = (): never => { throw new HttpError(404, 'Not Found', { documentation_url: 'https://docs.github.com/rest' }); };
const invalid = (msg = 'Validation Failed', errors: unknown[] = []): never => { throw new HttpError(422, msg, { errors, documentation_url: 'https://docs.github.com/rest' }); };

function paginate<T>(items: T[], q: URLSearchParams, pathWithQuery: (page: number) => string): { slice: T[]; headers: Record<string, string> } {
  const per = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const last = Math.max(1, Math.ceil(items.length / per));
  const slice = items.slice((page - 1) * per, page * per);
  const links: string[] = [];
  if (page < last) { links.push(`<${pathWithQuery(page + 1)}>; rel="next"`, `<${pathWithQuery(last)}>; rel="last"`); }
  if (page > 1) { links.push(`<${pathWithQuery(1)}>; rel="first"`, `<${pathWithQuery(page - 1)}>; rel="prev"`); }
  return { slice, headers: links.length ? { link: links.join(', ') } : {} };
}
function pageUrl(sub: string, q: URLSearchParams) {
  return (page: number) => { const p = new URLSearchParams(q); p.set('page', String(page)); return `${BASE}/api/v3${sub}?${p.toString()}`; };
}

function str(v: unknown, field: string, required = false): string | undefined {
  if (v === undefined || v === null) { if (required) invalid('Validation Failed', [{ resource: 'Request', field, code: 'missing_field' }]); return undefined; }
  if (typeof v !== 'string') invalid('Validation Failed', [{ resource: 'Request', field, code: 'invalid' }]);
  return v as string;
}

async function rest(req: IncomingMessage, sub: string, q: URLSearchParams, raw: Buffer): Promise<Out> {
  BASE = baseUrl(req);
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? {} : parseJson(raw);
  if (body === null || typeof body !== 'object') throw new HttpError(400, 'Problems parsing JSON');
  const seg = sub.split('/').filter(Boolean).map(decodeURIComponent);

  if (seg.length === 0) {
    return ok({ current_user_url: `${BASE}/api/v3/user`, repository_url: `${BASE}/api/v3/repos/{owner}/{repo}`, user_repositories_url: `${BASE}/api/v3/user/repos` }, 200,
      { 'x-oauth-scopes': 'repo, read:org, workflow, gist', 'x-accepted-oauth-scopes': '', 'x-github-media-type': 'github.v3; format=json' });
  }
  if (seg[0] === 'meta' && seg.length === 1) return ok({ installed_version: '3.14.0', verifiable_password_authentication: false, hooks: [], git: [] });
  if (seg[0] === 'rate_limit') return ok({ resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } });
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') return ok({ ...userJson(), public_repos: S.repos.size });
  if (seg[0] === 'users' && seg.length === 2 && method === 'GET') { if (seg[1].toLowerCase() !== S.LOGIN) notFound(); return ok(userJson()); }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const all = [...S.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
      const { slice, headers } = paginate(all, q, pageUrl(sub, q));
      return ok(slice.map(repoJson), 200, headers);
    }
    if (method === 'POST') {
      const name = str(body.name, 'name', true)!;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) invalid('Validation Failed', [{ resource: 'Repository', field: 'name', code: 'invalid' }]);
      const r = S.createRepo(name, { description: body.description ?? null, private: body.private === true || body.visibility === 'private', autoInit: body.auto_init === true, homepage: body.homepage ?? null });
      if (!r) invalid('Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
      return ok(repoJson(r!), 201);
    }
  }
  if ((seg[0] === 'users' || seg[0] === 'orgs') && seg[2] === 'repos' && method === 'GET') {
    const all = seg[1].toLowerCase() === S.LOGIN ? [...S.repos.values()] : [];
    const { slice, headers } = paginate(all, q, pageUrl(sub, q));
    return ok(slice.map(repoJson), 200, headers);
  }
  if (seg[0] === 'search' && seg[1] === 'issues') return searchIssues(q);
  if (seg[0] === 'repos' && seg.length >= 3) {
    const r = S.getRepo(seg[1], seg[2]);
    if (!r) notFound();
    return repoRoutes(req, r!, seg.slice(3), q, body, method, sub);
  }
  notFound();
  throw 0;
}

function searchIssues(q: URLSearchParams): Out {
  const query = q.get('q') ?? '';
  const repoM = /repo:([^\s]+)\/([^\s]+)/.exec(query);
  const items: unknown[] = [];
  for (const r of S.repos.values()) {
    if (repoM && (r.owner.toLowerCase() !== repoM[1].toLowerCase() || r.name.toLowerCase() !== repoM[2].toLowerCase())) continue;
    for (const i of r.issues.values()) {
      if (/is:pr/.test(query) && !i.isPull) continue;
      if (/is:issue/.test(query) && i.isPull) continue;
      if (/is:open|state:open/.test(query) && i.state !== 'open') continue;
      if (/is:closed|state:closed/.test(query) && i.state !== 'closed') continue;
      items.push(issueJson(r, i));
    }
  }
  return ok({ total_count: items.length, incomplete_results: false, items });
}

function repoRoutes(req: IncomingMessage, r: S.Repo, seg: string[], q: URLSearchParams, body: any, method: string, sub: string): Out {
  const [a, b, ...more] = seg;
  if (!a) {
    if (method === 'GET') return ok(repoJson(r));
    if (method === 'PATCH') {
      if (body.description !== undefined) r.description = body.description;
      if (body.homepage !== undefined) r.homepage = body.homepage;
      if (body.private !== undefined) r.private = !!body.private;
      if (body.has_issues !== undefined) r.hasIssues = !!body.has_issues;
      if (typeof body.default_branch === 'string') r.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== r.name) {
        if (S.getRepo(r.owner, body.name)) invalid();
        S.deleteRepo(r); r.name = body.name; S.repos.set(`${r.owner.toLowerCase()}/${r.name.toLowerCase()}`, r);
      }
      r.updated = S.tick();
      return ok(repoJson(r));
    }
    if (method === 'DELETE') { S.deleteRepo(r); return ok(null, 204); }
  }
  switch (a) {
    case 'branches': {
      if (!b && method === 'GET') {
        const list = [...r.refs.entries()].filter(([k]) => k.startsWith('refs/heads/')).map(([k, v]) => ({ name: k.slice(11), commit: { sha: v, url: `${BASE}/api/v3/repos/${r.owner}/${r.name}/commits/${v}` }, protected: false }));
        list.sort((x, y) => x.name.localeCompare(y.name));
        const { slice, headers } = paginate(list, q, pageUrl(sub, q));
        return ok(slice, 200, headers);
      }
      if (b && method === 'GET') {
        const name = [b, ...more].join('/');
        const oid = r.refs.get(`refs/heads/${name}`);
        if (!oid) throw new HttpError(404, 'Branch not found');
        return ok({ name, commit: commitJson(r, oid), protected: false, _links: {} });
      }
      break;
    }
    case 'commits': {
      if (!b && method === 'GET') {
        const tip = S.resolve(r, q.get('sha') ?? undefined);
        if (!tip) { if (r.refs.size === 0) throw new HttpError(409, 'Git Repository is empty.'); notFound(); }
        let list = S.log(tip!);
        const path = q.get('path');
        if (path) list = list.filter((c) => { const cm = parseCommit(S.store.get(c)!.data); const here = S.lookupPath(cm.tree, path)?.oid; const prev = cm.parents[0] ? S.lookupPath(S.commitTree(cm.parents[0]), path)?.oid : undefined; return here !== prev; });
        const { slice, headers } = paginate(list, q, pageUrl(sub, q));
        return ok(slice.map((c) => commitJson(r, c)), 200, headers);
      }
      if (b && method === 'GET') {
        const oid = S.resolve(r, [b, ...more].join('/'));
        if (!oid) throw new HttpError(422, `No commit found for SHA: ${b}`);
        const cm = parseCommit(S.store.get(oid)!.data);
        const files = S.diffTrees(cm.parents[0] ? S.commitTree(cm.parents[0]) : null, cm.tree);
        return ok({ ...commitJson(r, oid), files, stats: { additions: files.reduce((x, f) => x + f.additions, 0), deletions: files.reduce((x, f) => x + f.deletions, 0), total: files.reduce((x, f) => x + f.changes, 0) } });
      }
      break;
    }
    case 'git': return gitRoutes(r, b, more, body, method);
    case 'contents': return contentsRoutes(r, [b, ...more].filter((x) => x !== undefined).join('/'), q, body, method);
    case 'readme': {
      const tip = S.resolve(r, q.get('ref') ?? undefined);
      if (!tip) notFound();
      const tree = S.commitTree(tip!);
      for (const n of ['README.md', 'README', 'readme.md']) { const e = S.lookupPath(tree, n); if (e) return contentsRoutes(r, n, q, body, 'GET'); }
      notFound();
      break;
    }
    case 'labels': {
      if (!b && method === 'GET') return ok([...r.labels.values()].map((l) => labelJson(r, l)));
      if (!b && method === 'POST') {
        const name = str(body.name, 'name', true)!;
        if (r.labels.has(name.toLowerCase())) invalid('Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
        const l: S.Label = { id: S.newId(), name, color: (body.color ?? 'ededed').replace(/^#/, ''), description: body.description ?? null };
        r.labels.set(name.toLowerCase(), l);
        return ok(labelJson(r, l), 201);
      }
      if (b) {
        const l = r.labels.get(b.toLowerCase());
        if (!l) notFound();
        if (method === 'GET') return ok(labelJson(r, l!));
        if (method === 'DELETE') { r.labels.delete(b.toLowerCase()); return ok(null, 204); }
        if (method === 'PATCH') { if (body.new_name) { r.labels.delete(b.toLowerCase()); l!.name = body.new_name; r.labels.set(l!.name.toLowerCase(), l!); } if (body.color) l!.color = body.color; if (body.description !== undefined) l!.description = body.description; return ok(labelJson(r, l!)); }
      }
      break;
    }
    case 'issues': return issueRoutes(r, b, more, q, body, method, sub);
    case 'pulls': return pullRoutes(r, b, more, q, body, method, sub);
  }
  notFound();
  throw 0;
}

function gitRoutes(r: S.Repo, b: string | undefined, more: string[], body: any, method: string): Out {
  const refJson = (ref: string, oid: string) => ({ ref, node_id: '', url: `${BASE}/api/v3/repos/${r.owner}/${r.name}/git/${ref}`, object: { sha: oid, type: S.store.get(oid)?.type ?? 'commit', url: '' } });
  if ((b === 'refs' || b === 'ref') && method === 'GET' && more.length) {
    const name = `refs/${more.join('/')}`;
    const oid = r.refs.get(name);
    if (oid) return ok(refJson(name, oid));
    if (b === 'refs') {
      const list = [...r.refs.entries()].filter(([k]) => k.startsWith(name + '/')).map(([k, v]) => refJson(k, v));
      if (list.length) return ok(list);
    }
    notFound();
  }
  if (b === 'refs' && method === 'GET' && !more.length) return ok([...r.refs.entries()].map(([k, v]) => refJson(k, v)));
  if (b === 'refs' && method === 'POST' && !more.length) {
    const ref = str(body.ref, 'ref', true)!, sha = str(body.sha, 'sha', true)!;
    if (!ref.startsWith('refs/') || ref.split('/').length < 3) invalid('Reference name must start with \'refs/\' and have at least two slashes.');
    if (!S.store.has(sha)) invalid('Object does not exist');
    if (r.refs.has(ref)) invalid('Reference already exists');
    S.setRef(r, ref, sha);
    return ok(refJson(ref, sha), 201);
  }
  if (b === 'refs' && more.length && (method === 'PATCH' || method === 'POST')) {
    const ref = `refs/${more.join('/')}`;
    const cur = r.refs.get(ref);
    if (!cur) invalid('Reference does not exist');
    const sha = str(body.sha, 'sha', true)!;
    if (!S.store.has(sha)) invalid('Object does not exist');
    if (!body.force && !S.isAncestor(cur!, sha)) invalid('Update is not a fast forward');
    S.setRef(r, ref, sha);
    return ok(refJson(ref, sha));
  }
  if (b === 'refs' && more.length && method === 'DELETE') {
    const ref = `refs/${more.join('/')}`;
    if (!r.refs.has(ref)) invalid('Reference does not exist');
    S.setRef(r, ref, null);
    return ok(null, 204);
  }
  if (b === 'commits' && more[0] && method === 'GET') {
    const o = S.store.get(more[0]);
    if (o?.type !== 'commit') notFound();
    const c = commitJson(r, more[0]);
    return ok({ sha: c.sha, ...c.commit, parents: c.parents });
  }
  if (b === 'trees' && more[0] && method === 'GET') {
    const oid = S.resolve(r, more[0]);
    const tree = oid && S.store.get(oid)?.type === 'commit' ? S.commitTree(oid) : more[0];
    if (S.store.get(tree)?.type !== 'tree') notFound();
    const flat = S.flatten(tree);
    return ok({ sha: tree, truncated: false, tree: [...flat.entries()].map(([p, v]) => ({ path: p, mode: v.mode, type: 'blob', sha: v.oid, size: S.store.get(v.oid)!.data.length })) });
  }
  if (b === 'blobs' && more[0] && method === 'GET') {
    const o = S.store.get(more[0]);
    if (o?.type !== 'blob') notFound();
    return ok({ sha: more[0], size: o!.data.length, encoding: 'base64', content: o!.data.toString('base64') });
  }
  notFound();
  throw 0;
}

function contentEntry(r: S.Repo, path: string, oid: string, mode: string) {
  const full = `${r.owner}/${r.name}`;
  const name = path.split('/').pop() ?? path;
  const isDir = mode === '40000';
  const o = S.store.get(oid)!;
  return {
    type: isDir ? 'dir' : 'file', name, path, sha: oid, size: isDir ? 0 : o.data.length,
    url: `${BASE}/api/v3/repos/${full}/contents/${path}`, html_url: `${BASE}/${full}/blob/${r.defaultBranch}/${path}`,
    git_url: `${BASE}/api/v3/repos/${full}/git/${isDir ? 'trees' : 'blobs'}/${oid}`, download_url: isDir ? null : `${BASE}/${full}/raw/${path}`,
    _links: { self: `${BASE}/api/v3/repos/${full}/contents/${path}` },
  };
}

function contentsRoutes(r: S.Repo, path: string, q: URLSearchParams, body: any, method: string): Out {
  path = path.replace(/^\/+|\/+$/g, '');
  if (method === 'GET') {
    const tip = S.resolve(r, q.get('ref') ?? undefined);
    if (!tip) { if (r.refs.size === 0) throw new HttpError(404, 'This repository is empty.'); notFound(); }
    const tree = S.commitTree(tip!);
    const e = path === '' ? { oid: tree, mode: '40000', type: 'dir' as const } : S.lookupPath(tree, path);
    if (!e) notFound();
    if (e!.type === 'dir') {
      const entries = S.flatten(null);
      void entries;
      const o = S.store.get(e!.oid)!;
      const list = (awaitTree(o.data)).map((x) => contentEntry(r, path ? `${path}/${x.name}` : x.name, x.oid, x.mode));
      return ok(list);
    }
    const blob = S.store.get(e!.oid)!;
    return ok({ ...contentEntry(r, path, e!.oid, e!.mode), encoding: 'base64', content: blob.data.toString('base64').replace(/(.{60})/g, '$1\n') });
  }
  if (method === 'PUT') {
    const message = str(body.message, 'message', true)!;
    const content = str(body.content, 'content', true)!;
    if (!path) invalid();
    const branch = body.branch ?? r.defaultBranch;
    const tip = r.refs.get(`refs/heads/${branch}`);
    if (!tip && body.branch && r.refs.size > 0) throw new HttpError(404, `Branch ${branch} not found`);
    const existing = tip ? S.lookupPath(S.commitTree(tip), path) : null;
    if (existing && existing.type === 'dir') invalid();
    if (existing) {
      if (!body.sha) invalid('Invalid request.\n\n"sha" wasn\'t supplied.', [{ resource: 'Contents', field: 'sha', code: 'missing_field' }]);
      if (body.sha !== existing.oid) throw new HttpError(409, `${path} does not match ${body.sha}`);
    } else if (body.sha && tip) {
      // a sha for a file that does not exist is stale too
      throw new HttpError(409, `${path} does not match ${body.sha}`);
    }
    const buf = Buffer.from(content.replace(/\s/g, ''), 'base64');
    const commit = S.commitFiles(r, branch, [{ path, content: buf }], message);
    const e = S.lookupPath(S.commitTree(commit), path)!;
    return ok({ content: contentEntry(r, path, e.oid, e.mode), commit: commitShort(r, commit) }, existing ? 200 : 201);
  }
  if (method === 'DELETE') {
    const message = str(body.message, 'message', true)!;
    const branch = body.branch ?? r.defaultBranch;
    const tip = r.refs.get(`refs/heads/${branch}`);
    const existing = tip ? S.lookupPath(S.commitTree(tip), path) : null;
    if (!existing || existing.type !== 'file') notFound();
    if (!body.sha) invalid('Validation Failed', [{ resource: 'Contents', field: 'sha', code: 'missing_field' }]);
    if (body.sha !== existing!.oid) throw new HttpError(409, `${path} does not match ${body.sha}`);
    const commit = S.commitFiles(r, branch, [{ path, content: null }], message);
    return ok({ content: null, commit: commitShort(r, commit) });
  }
  notFound();
  throw 0;
}
import { parseTree } from './git.ts';
const awaitTree = (data: Buffer) => parseTree(data);
function commitShort(r: S.Repo, oid: string) {
  const c = commitJson(r, oid);
  return { sha: oid, node_id: c.node_id, url: c.commit.url, html_url: c.html_url, author: c.commit.author, committer: c.commit.committer, message: c.commit.message, tree: c.commit.tree, parents: c.parents };
}

function getIssue(r: S.Repo, n: string | undefined): S.Issue {
  const i = r.issues.get(Number(n));
  if (!i || !/^\d+$/.test(n ?? '')) notFound();
  return i!;
}

function checkLabels(r: S.Repo, labels: unknown): string[] {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) invalid();
  const names = (labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as any)?.name));
  for (const n of names) {
    if (typeof n !== 'string' || !r.labels.has(n.toLowerCase())) invalid('Validation Failed', [{ resource: 'Label', field: 'labels', code: 'invalid', value: n }]);
  }
  return names.map((n) => r.labels.get(n.toLowerCase())!.name);
}

export function listIssues(r: S.Repo, opts: { state?: string; sort?: string; direction?: string; labels?: string }): S.Issue[] {
  const state = opts.state ?? 'open';
  let list = [...r.issues.values()].filter((i) => !i.isPull && (state === 'all' || i.state === state));
  if (opts.labels) { const want = opts.labels.split(',').map((x) => x.trim().toLowerCase()); list = list.filter((i) => want.every((w) => i.labels.some((l) => l.toLowerCase() === w))); }
  const sort = opts.sort ?? 'created';
  const key = (i: S.Issue) => (sort === 'updated' ? i.updated : sort === 'comments' ? i.comments.length : i.created);
  const dir = (opts.direction ?? 'desc') === 'asc' ? 1 : -1;
  list.sort((x, y) => (key(x) - key(y) || x.number - y.number) * dir);
  return list;
}

function issueRoutes(r: S.Repo, b: string | undefined, more: string[], q: URLSearchParams, body: any, method: string, sub: string): Out {
  if (!b) {
    if (method === 'GET') {
      const list = listIssues(r, { state: q.get('state') ?? undefined, sort: q.get('sort') ?? undefined, direction: q.get('direction') ?? undefined, labels: q.get('labels') ?? undefined });
      const { slice, headers } = paginate(list, q, pageUrl(sub, q));
      return ok(slice.map((i) => issueJson(r, i)), 200, headers);
    }
    if (method === 'POST') {
      const title = str(body.title, 'title', true)!;
      const bodyText = str(body.body, 'body') ?? '';
      const labels = checkLabels(r, body.labels);
      return ok(issueJson(r, S.createIssue(r, title, bodyText, labels)), 201);
    }
  }
  if (b === 'comments' && method === 'GET') {
    const all = [...r.issues.values()].flatMap((i) => i.comments.map((c) => commentJson(r, i, c)));
    return ok(all);
  }
  const i = getIssue(r, b);
  if (more.length === 0) {
    if (method === 'GET') return ok(issueJson(r, i));
    if (method === 'PATCH') {
      if (body.title !== undefined) i.title = str(body.title, 'title')!;
      if (body.body !== undefined) i.body = body.body ?? '';
      if (body.labels !== undefined) i.labels = checkLabels(r, body.labels);
      if (body.state !== undefined) {
        if (body.state !== 'open' && body.state !== 'closed') invalid();
        if (body.state !== i.state) {
          i.state = body.state;
          i.closed = i.state === 'closed' ? S.tick() : null;
          i.stateReason = i.state === 'closed' ? (body.state_reason ?? 'completed') : 'reopened';
        }
      }
      i.updated = S.tick();
      const p = r.pulls.get(i.number);
      if (p) { p.title = i.title; p.body = i.body; if (!p.merged) { p.state = i.state; p.closed = i.closed; } }
      return ok(issueJson(r, i));
    }
  }
  if (more[0] === 'comments') {
    if (method === 'GET') return ok(i.comments.map((c) => commentJson(r, i, c)));
    if (method === 'POST') {
      const text = str(body.body, 'body', true)!;
      const t = S.tick();
      const c: S.Comment = { id: S.newId(), body: text, created: t, updated: t };
      i.comments.push(c); i.updated = t;
      return ok(commentJson(r, i, c), 201);
    }
  }
  if (more[0] === 'labels') {
    if (method === 'GET') return ok(i.labels.map((n) => labelJson(r, r.labels.get(n.toLowerCase())!)));
    if (method === 'POST' || method === 'PUT') {
      const add = checkLabels(r, Array.isArray(body) ? body : body.labels);
      i.labels = method === 'PUT' ? add : [...new Set([...i.labels, ...add])];
      return ok(i.labels.map((n) => labelJson(r, r.labels.get(n.toLowerCase())!)));
    }
  }
  notFound();
  throw 0;
}

function pullRoutes(r: S.Repo, b: string | undefined, more: string[], q: URLSearchParams, body: any, method: string, sub: string): Out {
  if (!b) {
    if (method === 'GET') {
      const state = q.get('state') ?? 'open';
      let list = [...r.pulls.values()].filter((p) => state === 'all' || p.state === state);
      if (q.get('head')) { const h = q.get('head')!.split(':').pop(); list = list.filter((p) => p.head === h); }
      if (q.get('base')) list = list.filter((p) => p.base === q.get('base'));
      const dir = (q.get('direction') ?? 'desc') === 'asc' ? 1 : -1;
      list.sort((x, y) => (x.number - y.number) * dir);
      const { slice, headers } = paginate(list, q, pageUrl(sub, q));
      return ok(slice.map((p) => pullJson(r, p)), 200, headers);
    }
    if (method === 'POST') {
      const title = str(body.title, 'title', true)!;
      const head = str(body.head, 'head', true)!;
      const base = str(body.base, 'base') ?? r.defaultBranch;
      const res = S.createPull(r, title, str(body.body, 'body') ?? '', head, base);
      if (!res.ok) invalid(res.message, [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
      return ok(pullJson(r, (res as any).pull), 201);
    }
  }
  const p = r.pulls.get(Number(b));
  if (!p || !/^\d+$/.test(b ?? '')) notFound();
  if (more.length === 0) {
    if (method === 'GET') return ok(pullJson(r, p!));
    if (method === 'PATCH') {
      if (body.title !== undefined) p!.title = p!.issue.title = body.title;
      if (body.body !== undefined) p!.body = p!.issue.body = body.body ?? '';
      if (body.state === 'closed' && !p!.merged) { p!.state = p!.issue.state = 'closed'; p!.closed = p!.issue.closed = S.tick(); }
      if (body.state === 'open' && !p!.merged) { p!.state = p!.issue.state = 'open'; p!.closed = p!.issue.closed = null; }
      if (typeof body.base === 'string') p!.base = body.base;
      p!.updated = S.tick();
      return ok(pullJson(r, p!));
    }
  }
  if (more[0] === 'files' && method === 'GET') {
    const files = S.pullFiles(r, p!).map((f) => ({ ...f, blob_url: '', raw_url: '', contents_url: '' }));
    return ok(files);
  }
  if (more[0] === 'commits' && method === 'GET') {
    const head = p!.headSha;
    const baseAnc = S.ancestors(p!.merged ? p!.baseSha : (r.refs.get(`refs/heads/${p!.base}`) ?? p!.baseSha));
    const list = S.log(head).filter((c) => !baseAnc.has(c) || p!.merged).reverse();
    return ok(list.map((c) => commitJson(r, c)));
  }
  if (more[0] === 'merge') {
    if (method === 'GET') { if (p!.merged) return ok(null, 204); notFound(); }
    if (method === 'PUT') {
      const res = S.mergePull(r, p!, { title: body.commit_title, message: body.commit_message, method: body.merge_method ?? 'merge', sha: body.sha });
      if (!res.ok) throw new HttpError(res.status, res.message);
      return ok({ sha: res.sha, merged: true, message: res.message });
    }
  }
  if (more[0] === 'reviews' && method === 'GET') return ok([]);
  if (more[0] === 'comments' && method === 'GET') return ok([]);
  notFound();
  throw 0;
}
