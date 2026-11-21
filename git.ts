// Git object model, pack reading/writing and pkt-line helpers. Standard library only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer }
export const ZERO = '0000000000000000000000000000000000000000';

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObj(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

/** A global content-addressed store; refs are per repository. */
export class ObjectStore {
  objs = new Map<string, GitObj>();
  packed = new Map<string, Buffer>(); // oid -> pack entry bytes (header + deflated), cached
  put(type: ObjType, data: Buffer): string {
    const oid = hashObj(type, data);
    if (!this.objs.has(oid)) this.objs.set(oid, { type, data });
    return oid;
  }
  get(oid: string): GitObj | undefined { return this.objs.get(oid); }
  has(oid: string): boolean { return this.objs.has(oid); }
  entry(oid: string): Buffer {
    let e = this.packed.get(oid);
    if (e) return e;
    const o = this.objs.get(oid)!;
    const z = deflateSync(o.data, { level: 1 });
    const head: number[] = [];
    let size = o.data.length;
    let byte = (TYPE_NUM[o.type] << 4) | (size & 15);
    size >>>= 4;
    while (size > 0) { head.push(byte | 0x80); byte = size & 0x7f; size >>>= 7; }
    head.push(byte);
    e = Buffer.concat([Buffer.from(head), z]);
    this.packed.set(oid, e);
    return e;
  }
}

// ---------------------------------------------------------------- parsing objects

export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(32, i);
    const nul = data.indexOf(0, sp);
    out.push({ mode: data.toString('latin1', i, sp), name: data.toString('utf8', sp + 1, nul), oid: data.toString('hex', nul + 1, nul + 21) });
    i = nul + 21;
  }
  return out;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return Buffer.compare(Buffer.from(an), Buffer.from(bn));
  });
  return Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]));
}

export interface Commit { tree: string; parents: string[]; author: string; committer: string; message: string }
export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const c: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
  }
  return c;
}
export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(s);
}
export function parseTagTarget(data: Buffer): string {
  const m = /^object ([0-9a-f]{40})/.exec(data.toString('latin1'));
  return m ? m[1] : '';
}
/** "Name <email> 1700000000 +0000" -> parts */
export function parseIdent(s: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (!m) return { name: s, email: '', date: new Date(0).toISOString() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
}

// ---------------------------------------------------------------- packs

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = delta[i++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r; };
  varint(); // base size
  const size = varint();
  const out = Buffer.allocUnsafe(size);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0, len = 0;
      if (op & 1) off |= delta[i++];
      if (op & 2) off |= delta[i++] << 8;
      if (op & 4) off |= delta[i++] << 16;
      if (op & 8) off |= delta[i++] * 0x1000000;
      if (op & 16) len |= delta[i++];
      if (op & 32) len |= delta[i++] << 8;
      if (op & 64) len |= delta[i++] << 16;
      if (len === 0) len = 0x10000;
      base.copy(out, o, off, off + len); o += len;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op); o += op; i += op;
    } else throw new Error('bad delta opcode');
  }
  return out;
}

function inflateAt(buf: Buffer, pos: number): { data: Buffer; used: number } {
  const r = inflateSync(buf.subarray(pos), { info: true } as any) as any;
  return { data: r.buffer as Buffer, used: r.engine.bytesWritten as number };
}

/** Parse a pack into the store; returns the oids it held. Throws on a malformed pack. */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const sum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!sum.equals(pack.subarray(pack.length - 20))) throw new Error('pack checksum mismatch');
  let pos = 12;
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const pending: Array<{ off: number; kind: 'ofs' | 'ref'; base: number | string; delta: Buffer }> = [];
  const oids: string[] = [];
  for (let n = 0; n < count; n++) {
    const start = pos;
    let b = pack[pos++];
    const t = (b >> 4) & 7;
    let size = b & 15, shift = 4;
    while (b & 0x80) { b = pack[pos++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    if (t === 6) {
      b = pack[pos++];
      let off = b & 0x7f;
      while (b & 0x80) { b = pack[pos++]; off = ((off + 1) * 128) + (b & 0x7f); }
      const z = inflateAt(pack, pos); pos += z.used;
      pending.push({ off: start, kind: 'ofs', base: start - off, delta: z.data });
    } else if (t === 7) {
      const base = pack.toString('hex', pos, pos + 20); pos += 20;
      const z = inflateAt(pack, pos); pos += z.used;
      pending.push({ off: start, kind: 'ref', base, delta: z.data });
    } else {
      const type = NUM_TYPE[t];
      if (!type) throw new Error('bad object type');
      const z = inflateAt(pack, pos); pos += z.used;
      byOffset.set(start, { type, data: z.data });
      oids.push(store.put(type, z.data));
    }
  }
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let k = 0; k < pending.length; k++) {
      const p = pending[k];
      let base: { type: ObjType; data: Buffer } | undefined;
      if (p.kind === 'ofs') base = byOffset.get(p.base as number);
      else base = store.get(p.base as string);
      if (!base) continue;
      const data = applyDelta(base.data, p.delta);
      byOffset.set(p.off, { type: base.type, data });
      oids.push(store.put(base.type, data));
      pending.splice(k--, 1);
      progress = true;
    }
  }
  if (pending.length) throw new Error('unresolved delta base');
  return oids;
}

export function writePack(store: ObjectStore, oids: string[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(oids.length, 8);
  const parts = [head];
  for (const oid of oids) parts.push(store.entry(oid));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-line

export function pkt(s: string | Buffer): Buffer {
  const b = typeof s === 'string' ? Buffer.from(s) : s;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };
/** Split pkt-lines; returns packets and the offset where parsing stopped (for a trailing pack). */
export function readPkts(buf: Buffer, stopAtFlush = false): { pkts: Pkt[]; rest: number } {
  const pkts: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('latin1', i, i + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) { pkts.push({ kind: 'flush' }); i += 4; if (stopAtFlush) break; continue; }
    if (len === 1) { pkts.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { pkts.push({ kind: 'end' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) throw new Error('truncated pkt-line');
    pkts.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { pkts, rest: i };
}

/** Wrap a payload into side-band-64k band-1 packets. */
export function sideband(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const max = 65515;
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, i + max);
    out.push(Buffer.concat([Buffer.from((chunk.length + 5).toString(16).padStart(4, '0')), Buffer.from([band]), chunk]));
  }
  return out;
}
