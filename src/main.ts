// Command line.
//
//   node src/main.ts serve [--socket /tmp/acp-thin-host.sock] -- <agent command...>
//       Starts the Agent and serves its sessions to every Client that connects to the socket.
//   node src/main.ts connect [--socket /tmp/acp-thin-host.sock]
//       An ACP Agent on stdio for an editor: it pipes stdio to the host socket.

import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Peer } from './jsonrpc.ts';
import { ThinHost } from './host.ts';

const split = process.argv.indexOf('--');
const { positionals: [mode], values } = parseArgs({
  args: process.argv.slice(2, split < 0 ? undefined : split),
  allowPositionals: true,
  options: { socket: { type: 'string', default: '/tmp/acp-thin-host.sock' } },
});
const log = (line: string) => process.stderr.write(`[acp-thin-host] ${line}\n`);

if (mode === 'serve' && split > 0) {
  const [command, ...args] = process.argv.slice(split + 1);
  const agent = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  agent.on('exit', code => process.exit(code ?? 1));
  const host = new ThinHost(new Peer(agent.stdout, agent.stdin), log);
  rmSync(values.socket, { force: true });
  createServer(stream => host.connect(new Peer(stream, stream))).listen(values.socket, () => log(`serving on ${values.socket}`));
} else if (mode === 'connect') {
  const stream = createConnection(values.socket);
  process.stdin.pipe(stream).pipe(process.stdout);
  stream.on('close', () => process.exit(0));
} else {
  console.error('usage: main.ts serve [--socket <path>] -- <agent command...>\n       main.ts connect [--socket <path>]');
  process.exit(2);
}
