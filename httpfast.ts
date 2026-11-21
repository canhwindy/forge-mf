// A lean HTTP/1.1 server on node:net: keep-alive, pipelining in order, content-length and chunked
// request bodies. It hands the forge's handlers a request/response pair with the small surface they
// use (method, url, headers; writeHead, end), which skips node:http's per-request machinery.
import { createServer as createNetServer, type Server, type Socket } from 'node:net';

export interface FastReq { method: string; url: string; headers: Record<string, string>; body: Buffer }
export class FastRes {
  sock: Socket;
  keepAlive: boolean;
  status = 200;
  headers: Record<string, string | number> = {};
  done = false;
  constructor(sock: Socket, keepAlive: boolean) { this.sock = sock; this.keepAlive = keepAlive; }
  writeHead(status: number, headers: Record<string, string | number> = {}) { this.status = status; this.headers = headers; return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  end(body?: Buffer | string) {
    if (this.done) return;
    this.done = true;
    const buf = body === undefined ? EMPTY : typeof body === 'string' ? Buffer.from(body) : body;
    let head = `HTTP/1.1 ${this.status} ${REASONS[this.status] ?? 'OK'}\r\n`;
    let hasLen = false;
    for (const k in this.headers) {
      const lk = k.toLowerCase();
      if (lk === 'content-length') { hasLen = true; head += `content-length: ${buf.length}\r\n`; continue; }
      if (lk === 'connection') continue;
      head += `${k}: ${this.headers[k]}\r\n`;
    }
    if (!hasLen && this.status !== 204 && this.status !== 304) head += `content-length: ${buf.length}\r\n`;
    head += this.keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
    if (buf.length === 0 || this.status === 204) this.sock.write(head);
    else if (buf.length < 16384) this.sock.write(Buffer.concat([Buffer.from(head, 'latin1'), buf]));
    else { this.sock.cork(); this.sock.write(head); this.sock.write(buf); this.sock.uncork(); }
    if (!this.keepAlive) this.sock.end();
  }
}
const EMPTY = Buffer.alloc(0);
const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity', 500: 'Internal Server Error',
};

type Handler = (req: FastReq, res: FastRes) => Promise<void> | void;

export function createFastServer(handler: Handler): Server {
  const server = createNetServer({ noDelay: true }, (sock) => {
    sock.setNoDelay(true);
    let buf: Buffer = EMPTY;
    let busy = false;
    const queue: Array<{ req: FastReq; keepAlive: boolean }> = [];
    const run = async () => {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const { req, keepAlive } = queue.shift()!;
        const res = new FastRes(sock, keepAlive);
        try { await handler(req, res); } catch { if (!res.done) res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"Internal Server Error"}'); }
        if (!res.done) res.end();
        if (!keepAlive) { queue.length = 0; break; }
      }
      busy = false;
    };
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > 65536) sock.destroy(); return; }
        const head = buf.toString('latin1', 0, end);
        const lines = head.split('\r\n');
        const [method, url, version] = lines[0].split(' ');
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const c = lines[i].indexOf(':');
          if (c > 0) {
            const k = lines[i].slice(0, c).trim().toLowerCase();
            const v = lines[i].slice(c + 1).trim();
            headers[k] = headers[k] !== undefined ? `${headers[k]}, ${v}` : v;
          }
        }
        let body: Buffer = EMPTY;
        let consumed = end + 4;
        if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
          const parts: Buffer[] = [];
          let pos = consumed;
          let complete = false;
          for (;;) {
            const le = buf.indexOf('\r\n', pos);
            if (le < 0) break;
            const size = parseInt(buf.toString('latin1', pos, le).split(';')[0], 16);
            if (Number.isNaN(size)) { sock.destroy(); return; }
            if (size === 0) {
              const tr = buf.indexOf('\r\n\r\n', le);
              if (buf.length >= le + 4 && buf[le + 2] === 13 && buf[le + 3] === 10) { pos = le + 4; complete = true; break; }
              if (tr < 0) break;
              pos = tr + 4; complete = true; break;
            }
            if (buf.length < le + 2 + size + 2) break;
            parts.push(buf.subarray(le + 2, le + 2 + size));
            pos = le + 2 + size + 2;
          }
          if (!complete) return; // wait for more
          body = Buffer.concat(parts);
          consumed = pos;
        } else {
          const len = Number(headers['content-length'] ?? 0) || 0;
          if (buf.length < consumed + len) return; // wait for the body
          body = buf.subarray(consumed, consumed + len);
          consumed += len;
        }
        if (headers.expect && /100-continue/i.test(headers.expect)) { /* body already here */ }
        buf = consumed >= buf.length ? EMPTY : Buffer.from(buf.subarray(consumed));
        const conn = (headers.connection ?? '').toLowerCase();
        const keepAlive = version === 'HTTP/1.0' ? conn.includes('keep-alive') : !conn.includes('close');
        queue.push({ req: { method, url, headers, body: Buffer.from(body) }, keepAlive });
        void run();
      }
    });
    sock.on('error', () => sock.destroy());
  });
  return server;
}
