// MCP over streamable HTTP (the initialize handshake era): tools act on the same store as REST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authOk, baseUrl, issueJson, listIssues, pullJson, repoJson } from './app.ts';
import * as S from './store.ts';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

type Schema = { type: 'object'; properties: Record<string, unknown>; required: string[] };
interface Tool { name: string; description: string; inputSchema: Schema; run: (a: Record<string, any>) => unknown }

const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'number', description });
const repoArgs = { owner: s('Repository owner'), repo: s('Repository name') };

class ToolError extends Error {}
function repoOf(a: Record<string, any>): S.Repo {
  const r = S.getRepo(String(a.owner), String(a.repo));
  if (!r) throw new ToolError(`repository ${a.owner}/${a.repo} not found`);
  return r;
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo', description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: s('Repository name'), description: s('Repository description'), private: { type: 'boolean', description: 'Whether the repository is private' }, autoInit: { type: 'boolean', description: 'Initialize with a README' } }, required: ['name'] },
    run: (a) => {
      const r = S.createRepo(String(a.name), { description: a.description ?? null, private: a.private === true, autoInit: a.autoInit === true || a.auto_init === true });
      if (!r) throw new ToolError(`repository ${a.name} already exists`);
      return repoJson(r);
    },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { ...repoArgs }, required: ['owner', 'repo'] },
    run: (a) => repoJson(repoOf(a)),
  },
  {
    name: 'create_issue', description: 'Create a new issue in a repository.',
    inputSchema: { type: 'object', properties: { ...repoArgs, title: s('Issue title'), body: s('Issue body'), labels: { type: 'array', items: { type: 'string' }, description: 'Label names' } }, required: ['owner', 'repo', 'title'] },
    run: (a) => {
      const r = repoOf(a);
      const labels: string[] = Array.isArray(a.labels) ? a.labels : [];
      for (const l of labels) if (!r.labels.has(String(l).toLowerCase())) throw new ToolError(`label ${l} does not exist`);
      return issueJson(r, S.createIssue(r, String(a.title), a.body == null ? '' : String(a.body), labels.map((l) => r.labels.get(String(l).toLowerCase())!.name)));
    },
  },
  {
    name: 'get_issue', description: 'Get one issue of a repository by number.',
    inputSchema: { type: 'object', properties: { ...repoArgs, issue_number: n('Issue number') }, required: ['owner', 'repo', 'issue_number'] },
    run: (a) => {
      const r = repoOf(a);
      const i = r.issues.get(Number(a.issue_number));
      if (!i) throw new ToolError(`issue ${a.issue_number} not found`);
      return issueJson(r, i);
    },
  },
  {
    name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: { type: 'object', properties: { ...repoArgs, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' }, sort: s('Sort field: created, updated or comments'), direction: s('asc or desc') }, required: ['owner', 'repo'] },
    run: (a) => {
      const r = repoOf(a);
      const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'open';
      return listIssues(r, { state, sort: a.sort, direction: a.direction }).map((i) => issueJson(r, i));
    },
  },
  {
    name: 'update_issue', description: 'Update an issue title, body or state.',
    inputSchema: { type: 'object', properties: { ...repoArgs, issue_number: n('Issue number'), title: s('New title'), body: s('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } }, required: ['owner', 'repo', 'issue_number'] },
    run: (a) => {
      const r = repoOf(a);
      const i = r.issues.get(Number(a.issue_number));
      if (!i) throw new ToolError(`issue ${a.issue_number} not found`);
      if (typeof a.title === 'string') i.title = a.title;
      if (typeof a.body === 'string') i.body = a.body;
      if (a.state === 'open' || a.state === 'closed') { i.state = a.state; i.closed = a.state === 'closed' ? S.tick() : null; }
      i.updated = S.tick();
      return issueJson(r, i);
    },
  },
  {
    name: 'create_pull_request', description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { ...repoArgs, title: s('Pull request title'), body: s('Pull request body'), head: s('Head branch'), base: s('Base branch') }, required: ['owner', 'repo', 'title', 'head', 'base'] },
    run: (a) => {
      const r = repoOf(a);
      const res = S.createPull(r, String(a.title), a.body == null ? '' : String(a.body), String(a.head), String(a.base ?? r.defaultBranch));
      if (!res.ok) throw new ToolError(res.message);
      return pullJson(r, res.pull);
    },
  },
  {
    name: 'get_pull_request', description: 'Get one pull request by number.',
    inputSchema: { type: 'object', properties: { ...repoArgs, pull_number: n('Pull request number') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a) => {
      const r = repoOf(a);
      const p = r.pulls.get(Number(a.pull_number));
      if (!p) throw new ToolError(`pull request ${a.pull_number} not found`);
      return pullJson(r, p);
    },
  },
  {
    name: 'list_pull_requests', description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { ...repoArgs, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter' } }, required: ['owner', 'repo'] },
    run: (a) => {
      const r = repoOf(a);
      const state = a.state ?? 'open';
      return [...r.pulls.values()].filter((p) => state === 'all' || p.state === state).map((p) => pullJson(r, p));
    },
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request (merge, squash or rebase).',
    inputSchema: { type: 'object', properties: { ...repoArgs, pull_number: n('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' }, commit_title: s('Commit title'), commit_message: s('Commit message') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a) => {
      const r = repoOf(a);
      const p = r.pulls.get(Number(a.pull_number));
      if (!p) throw new ToolError(`pull request ${a.pull_number} not found`);
      const res = S.mergePull(r, p, { title: a.commit_title, message: a.commit_message, method: a.merge_method ?? 'squash' });
      if (!res.ok) throw new ToolError(res.message);
      return { sha: res.sha, merged: true, message: res.message };
    },
  },
];
const TOOL_LIST = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

function findTool(name: string): Tool | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((t) => lower === t.name || lower.endsWith(`__${t.name}`) || lower.endsWith(`_${t.name}`) || lower.endsWith(`.${t.name}`) || lower.endsWith(`/${t.name}`));
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

function handleOne(msg: Rpc): unknown | null {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') return error(-32600, 'Invalid Request');
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
      return reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.' });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOL_LIST });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const tool = findTool(name);
      if (!tool) return error(-32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, any>;
      if (args.full_name && (!args.owner || !args.repo)) { const [o, r] = String(args.full_name).split('/'); args.owner ??= o; args.repo ??= r; }
      const missing = tool.inputSchema.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
      if (missing.length) return error(-32602, `Missing required argument(s): ${missing.join(', ')}`);
      try {
        const out = tool.run(args);
        const structured = Array.isArray(out) ? { items: out } : out;
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: structured, isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default:
      if (isNotification) return null;
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  void baseUrl;
  const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
    const buf = Buffer.from(payload === undefined ? '' : JSON.stringify(payload));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length, ...extra });
    res.end(buf);
  };
  if (req.method === 'GET') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
  if (req.method === 'DELETE') return send(200, {});
  if (req.method !== 'POST') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
  if (!authOk(req)) return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { 'www-authenticate': 'Bearer' });
  let msg: any;
  try { msg = JSON.parse(body.toString('utf8')); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const session = String(req.headers['mcp-session-id'] ?? '') || 'forge-session-1';
  const headers = { 'mcp-session-id': session };
  if (Array.isArray(msg)) {
    const out = msg.map(handleOne).filter((x) => x !== null);
    if (out.length === 0) { res.writeHead(202, headers); res.end(); return; }
    return send(200, out, headers);
  }
  const out = handleOne(msg);
  if (out === null) { res.writeHead(202, headers); res.end(); return; }
  return send(200, out, headers);
}
