// GraphQL v4 endpoint (placeholder until the executor lands).
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse, _body: Buffer): Promise<void> {
  const buf = Buffer.from(JSON.stringify({ data: null, errors: [{ message: 'not implemented' }] }));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}
