// Command line of the thin ACP host.
//
//   node src/main.ts serve --socket /tmp/acp.sock [--agent-schema agent.json] [--trace wire.jsonl] -- <agent command...>
//       Starts the Agent and serves its sessions to every Client that connects to the socket.
//   node src/main.ts connect --socket /tmp/acp.sock
//       An ACP Agent on stdio for a Client such as Air: it pipes stdio to the host socket.

import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Peer, type Trace } from './jsonrpc.ts';
import { ThinHost } from './host.ts';
import { annotatedSchema } from '../schema/annotate.ts';

const split = process.argv.indexOf('--');
const { positionals: [mode], values } = parseArgs({
  args: process.argv.slice(2, split < 0 ? undefined : split),
  allowPositionals: true,
  options: { socket: { type: 'string' }, 'agent-schema': { type: 'string' }, trace: { type: 'string' } },
});
const socket = values.socket ?? '/tmp/acp-thin-host.sock';
const log = (line: string) => process.stderr.write(`[acp-thin-host] ${line}\n`);

if (mode === 'serve') {
  const command = split < 0 ? [] : process.argv.slice(split + 1);
  if (!command.length) throw new Error('usage: serve --socket <path> -- <agent command...>');
  const schema = await annotatedSchema();
  // The capabilities.schema that the Agent would send in initialize, for Agents that send none yet.
  const agentSchema = values['agent-schema'] ? JSON.parse(readFileSync(values['agent-schema'], 'utf8')) : undefined;

  const trace: Trace | undefined = values.trace
    ? (peer, direction, message) => appendFileSync(values.trace!, JSON.stringify({ at: Date.now(), peer, direction, message }) + '\n')
    : undefined;

  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('exit', code => { log(`agent exited with ${code}`); process.exit(code ?? 1); });
  const host = new ThinHost(new Peer(child.stdout, child.stdin, 'agent', trace), { schema, agentSchema, log });

  rmSync(socket, { force: true });
  let clients = 0;
  createServer(stream => host.connect(new Peer(stream, stream, `client ${++clients}`, trace)))
    .listen(socket, () => log(`serving ${command.join(' ')} on ${socket}`));
} else if (mode === 'connect') {
  const stream = createConnection(socket);
  stream.on('error', error => { log(`no host on ${socket}: ${error.message}`); process.exit(1); });
  process.stdin.pipe(stream).pipe(process.stdout);
  stream.on('close', () => process.exit(0));
} else {
  throw new Error('usage: main.ts serve|connect --socket <path> [-- <agent command...>]');
}
