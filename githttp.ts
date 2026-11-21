// Git smart HTTP: info/refs, upload-pack (v2, with a v0 fallback) and receive-pack (v0).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { DELIM, FLUSH, ZERO, parseCommit, parseTagTarget, parseTree, pkt, readPack, readPkts, sideband, writePack } from './git.ts';
import { getRepo, isAncestor, setRef, store, type Repo } from './store.ts';

const AGENT = 'agent=forge/1.0';

function headTarget(r: Repo): string { return `refs/heads/${r.defaultBranch}`; }

function sortedRefs(r: Repo): Array<[string, string]> {
  return [...r.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peel(oid: string): string | null {
  let cur = oid, peeled = false;
  for (let i = 0; i < 10; i++) {
    const o = store.get(cur);
    if (o?.type !== 'tag') break;
    cur = parseTagTarget(o.data); peeled = true;
  }
  return peeled ? cur : null;
}

function send(res: ServerResponse, status: number, type: string, body: Buffer | Buffer[]) {
  const buf = Array.isArray(body) ? Buffer.concat(body) : body;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': buf.length });
  res.end(buf);
}
function notFound(res: ServerResponse) {
  const b = Buffer.from(JSON.stringify({ message: 'Not Found' }));
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, name: string, rest: string, query: URLSearchParams, body: Buffer): Promise<void> {
  const r = getRepo(owner, name);
  if (!r) return notFound(res);
  const v2 = /version=2/.test(String(req.headers['git-protocol'] ?? ''));
  if (req.method === 'GET' && rest === '/info/refs') {
    const svc = query.get('service');
    if (svc === 'git-upload-pack') {
      if (v2) {
        return send(res, 200, 'application/x-git-upload-pack-advertisement', [
          pkt('version 2\n'), pkt(`${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'),
          pkt('server-option\n'), pkt('object-format=sha1\n'), FLUSH,
        ]);
      }
      return send(res, 200, 'application/x-git-upload-pack-advertisement', [pkt('# service=git-upload-pack\n'), FLUSH, ...advertiseV0(r, 'upload')]);
    }
    if (svc === 'git-receive-pack') {
      return send(res, 200, 'application/x-git-receive-pack-advertisement', [pkt('# service=git-receive-pack\n'), FLUSH, ...advertiseV0(r, 'receive')]);
    }
    return send(res, 403, 'text/plain', Buffer.from('service not supported\n'));
  }
  if (req.method === 'POST' && rest === '/git-upload-pack') {
    try {
      const out = v2 || body.subarray(0, 64).includes('command=') ? uploadPackV2(r, body) : uploadPackV0(r, body);
      return send(res, 200, 'application/x-git-upload-pack-result', out);
    } catch (e) {
      return send(res, 400, 'text/plain', Buffer.from(String((e as Error).message) + '\n'));
    }
  }
  if (req.method === 'POST' && rest === '/git-receive-pack') {
    try {
      return send(res, 200, 'application/x-git-receive-pack-result', receivePack(r, body));
    } catch (e) {
      return send(res, 400, 'text/plain', Buffer.from(String((e as Error).message) + '\n'));
    }
  }
  return notFound(res);
}

function advertiseV0(r: Repo, kind: 'upload' | 'receive'): Buffer[] {
  const caps = kind === 'upload'
    ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:${headTarget(r)} object-format=sha1 ${AGENT}`
    : `report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 ${AGENT}`;
  const refs = sortedRefs(r);
  const out: Buffer[] = [];
  const headOid = r.refs.get(headTarget(r));
  const lines: Array<[string, string]> = [];
  if (kind === 'upload' && headOid) lines.push([headOid, 'HEAD']);
  for (const [ref, oid] of refs) {
    lines.push([oid, ref]);
    if (kind === 'upload') { const p = peel(oid); if (p) lines.push([p, `${ref}^{}`]); }
  }
  if (lines.length === 0) out.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  lines.forEach(([oid, ref], i) => out.push(pkt(i === 0 ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`)));
  out.push(FLUSH);
  return out;
}

// ---------------------------------------------------------------- object selection

function children(oid: string): string[] {
  const o = store.get(oid);
  if (!o) return [];
  if (o.type === 'commit') { const c = parseCommit(o.data); return [c.tree, ...c.parents]; }
  if (o.type === 'tree') return parseTree(o.data).filter((e) => e.mode !== '160000').map((e) => e.oid);
  if (o.type === 'tag') return [parseTagTarget(o.data)];
  return [];
}
function treeClosure(oid: string, into: Set<string>) {
  const stack = [oid];
  while (stack.length) {
    const c = stack.pop()!;
    if (into.has(c) || !store.has(c)) continue;
    into.add(c);
    const o = store.get(c)!;
    if (o.type === 'tree') for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
  }
}

interface Selection { objects: string[]; shallow: string[]; unshallow: string[] }

function selectObjects(wants: string[], haves: string[], clientShallow: Set<string>, depth: number | null): Selection {
  // what the client has
  const have = new Set<string>();
  const hstack = haves.filter((h) => store.has(h));
  const hseen = new Set<string>();
  while (hstack.length) {
    const c = hstack.pop()!;
    if (hseen.has(c)) continue;
    hseen.add(c);
    const o = store.get(c);
    if (!o) continue;
    have.add(c);
    if (o.type === 'commit') {
      const cm = parseCommit(o.data);
      treeClosure(cm.tree, have);
      if (!clientShallow.has(c)) for (const p of cm.parents) hstack.push(p);
    } else if (o.type === 'tag') hstack.push(parseTagTarget(o.data));
    else if (o.type === 'tree') treeClosure(c, have);
  }
  const out: string[] = [];
  const sent = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const addTree = (t: string) => {
    const stack = [t];
    while (stack.length) {
      const c = stack.pop()!;
      if (sent.has(c) || have.has(c) || !store.has(c)) continue;
      sent.add(c); out.push(c);
      const o = store.get(c)!;
      if (o.type === 'tree') for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  };
  // commits: BFS with depth
  const queue: Array<[string, number]> = [];
  const visited = new Set<string>();
  for (const w of wants) {
    let cur = w;
    // tags
    for (let i = 0; i < 10; i++) {
      const o = store.get(cur);
      if (o?.type !== 'tag') break;
      if (!sent.has(cur) && !have.has(cur)) { sent.add(cur); out.push(cur); }
      cur = parseTagTarget(o.data);
    }
    const o = store.get(cur);
    if (o?.type === 'commit') queue.push([cur, 1]);
    else if (o?.type === 'tree') addTree(cur);
    else if (o && !sent.has(cur) && !have.has(cur)) { sent.add(cur); out.push(cur); }
  }
  while (queue.length) {
    const [c, d] = queue.shift()!;
    if (visited.has(c)) continue;
    visited.add(c);
    const o = store.get(c);
    if (!o) continue;
    const cm = parseCommit(o.data);
    const atBoundary = depth !== null && d >= depth;
    if (have.has(c) && depth === null) continue;
    if (have.has(c) && !clientShallow.has(c) && depth !== null) {
      // client holds it fully; nothing more to send below it
      continue;
    }
    if (!have.has(c)) { sent.add(c); out.push(c); addTree(cm.tree); }
    if (atBoundary) {
      if (cm.parents.length && !clientShallow.has(c)) shallow.push(c);
      continue;
    }
    if (clientShallow.has(c) && cm.parents.length && depth !== null) unshallow.push(c);
    if (clientShallow.has(c) && depth === null) continue;
    for (const p of cm.parents) queue.push([p, d + 1]);
  }
  return { objects: out, shallow, unshallow };
}

// ---------------------------------------------------------------- upload-pack v2

const packCache = new Map<string, Buffer[]>();

function uploadPackV2(r: Repo, body: Buffer): Buffer[] {
  // Every v2 command's answer depends only on the request bytes and the repository's ref state.
  const cacheKey = `${r.id}@${r.version}:${body.length}:${createHash('sha1').update(body).digest('hex')}`;
  const hit = packCache.get(cacheKey);
  if (hit) return hit;
  const out = uploadPackV2Uncached(r, body);
  if (packCache.size > 500) packCache.clear();
  packCache.set(cacheKey, out);
  return out;
}

function uploadPackV2Uncached(r: Repo, body: Buffer): Buffer[] {
  const { pkts } = readPkts(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const p of pkts) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (!inArgs) { if (line.startsWith('command=')) command = line.slice(8); }
    else args.push(line);
  }
  if (command === 'ls-refs') return lsRefs(r, args);
  if (command === 'fetch') return fetchV2(r, args);
  throw new Error(`unknown command ${command}`);
}

function lsRefs(r: Repo, args: string[]): Buffer[] {
  const symrefs = args.includes('symrefs');
  const peelOpt = args.includes('peel');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const match = (ref: string) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const out: Buffer[] = [];
  const target = headTarget(r);
  const headOid = r.refs.get(target);
  if (match('HEAD')) {
    if (headOid) out.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    else if (unborn && symrefs) out.push(pkt(`unborn HEAD symref-target:${target}\n`));
  }
  for (const [ref, oid] of sortedRefs(r)) {
    if (!match(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peelOpt) { const p = peel(oid); if (p) line += ` peeled:${p}`; }
    out.push(pkt(line + '\n'));
  }
  out.push(FLUSH);
  return out;
}

function fetchV2(r: Repo, args: string[]): Buffer[] {
  const wants: string[] = [], haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null, done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5, 45));
    else if (a.startsWith('want-ref ')) { const o = r.refs.get(a.slice(9)); if (o) wants.push(o); }
    else if (a.startsWith('have ')) haves.push(a.slice(5, 45));
    else if (a.startsWith('shallow ')) clientShallow.add(a.slice(8, 48));
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
    else if (a === 'done') done = true;
  }
  for (const w of wants) if (!store.has(w)) throw new Error(`not our ref ${w}`);
  const out: Buffer[] = [];
  if (!done) {
    // negotiation round: acknowledge common commits; we are always ready
    out.push(pkt('acknowledgments\n'));
    const common = haves.filter((h) => store.has(h));
    if (common.length === 0) out.push(pkt('NAK\n'));
    for (const h of common) out.push(pkt(`ACK ${h}\n`));
    out.push(pkt('ready\n'));
    out.push(DELIM);
  }
  const sel = selectObjects(wants, haves, clientShallow, depth);
  if (depth !== null || clientShallow.size) {
    if (sel.shallow.length || sel.unshallow.length) {
      out.push(pkt('shallow-info\n'));
      for (const s of sel.shallow) out.push(pkt(`shallow ${s}\n`));
      for (const s of sel.unshallow) out.push(pkt(`unshallow ${s}\n`));
      out.push(DELIM);
    }
  }
  out.push(pkt('packfile\n'));
  out.push(...sideband(writePack(store, sel.objects)));
  out.push(FLUSH);
  return out;
}

// ---------------------------------------------------------------- upload-pack v0

function uploadPackV0(r: Repo, body: Buffer): Buffer[] {
  const { pkts } = readPkts(body);
  const wants: string[] = [], haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let sb = false;
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) { wants.push(line.slice(5, 45)); if (line.includes('side-band')) sb = true; }
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
  }
  const sel = selectObjects(wants, haves, clientShallow, depth);
  const out: Buffer[] = [];
  if (depth !== null) {
    for (const s of sel.shallow) out.push(pkt(`shallow ${s}\n`));
    for (const s of sel.unshallow) out.push(pkt(`unshallow ${s}\n`));
    out.push(FLUSH);
  }
  const common = haves.filter((h) => store.has(h));
  out.push(pkt(common.length ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  const pack = writePack(store, sel.objects);
  if (sb) { out.push(...sideband(pack)); out.push(FLUSH); } else out.push(pack);
  return out;
}

// ---------------------------------------------------------------- receive-pack

function receivePack(r: Repo, body: Buffer): Buffer[] {
  const { pkts, rest } = readPkts(body, true);
  const cmds: Array<{ old: string; new: string; ref: string }> = [];
  let caps = '';
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    let line = p.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) { caps = line.slice(nul + 1); line = line.slice(0, nul); }
    line = line.replace(/\n$/, '');
    const [o, n, ref] = line.split(' ');
    if (o && n && ref) cmds.push({ old: o, new: n, ref });
  }
  const sb = caps.split(/\s+/).includes('side-band-64k');
  let unpack = 'ok';
  const packBuf = body.subarray(rest);
  if (packBuf.length > 0) {
    try { readPack(store, packBuf); } catch (e) { unpack = String((e as Error).message).replace(/\n/g, ' '); }
  }
  const report: Buffer[] = [pkt(`unpack ${unpack}\n`)];
  for (const c of cmds) {
    const cur = r.refs.get(c.ref) ?? ZERO;
    let err: string | null = null;
    if (unpack !== 'ok') err = 'unpacker error';
    else if (!c.ref.startsWith('refs/')) err = 'funny refname';
    else if (cur !== c.old) err = c.old === ZERO ? 'already exists' : (cur === ZERO ? 'stale info' : (c.new !== ZERO && !isAncestor(cur, c.new) ? 'non-fast-forward' : 'stale info'));
    else if (c.new !== ZERO && !store.has(c.new)) err = 'missing necessary objects';
    else if (c.new !== ZERO && cur !== ZERO && c.ref.startsWith('refs/heads/')) {
      const o = store.get(c.new);
      if (o?.type === 'commit' && !isAncestor(cur, c.new)) err = 'non-fast-forward';
    } else if (c.new !== ZERO && cur !== ZERO && c.ref.startsWith('refs/tags/')) {
      if (!isAncestor(cur, c.new)) err = 'non-fast-forward';
    }
    if (err) { report.push(pkt(`ng ${c.ref} ${err}\n`)); continue; }
    const hadBranches = [...r.refs.keys()].some((k) => k.startsWith('refs/heads/'));
    setRef(r, c.ref, c.new === ZERO ? null : c.new);
    if (!hadBranches && c.new !== ZERO && c.ref.startsWith('refs/heads/') && !r.refs.has(`refs/heads/${r.defaultBranch}`)) {
      r.defaultBranch = c.ref.slice(11);
    }
    report.push(pkt(`ok ${c.ref}\n`));
  }
  report.push(FLUSH);
  const payload = Buffer.concat(report);
  if (!sb) return [payload];
  return [...sideband(payload), FLUSH];
}
