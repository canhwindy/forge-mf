// Local development: serve the forge on a fixed port with no env (node dev.ts [port]).
import { createApp } from './app.ts';

const port = Number(process.argv[2] ?? 4567);
createApp().listen(port, '127.0.0.1', () => process.stdout.write(`[dev] forge on http://127.0.0.1:${port}\n`));
