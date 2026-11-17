// A small terminal Client that joins a live session through the host.
//
//   node src/watch.ts [--socket /tmp/acp-thin-host.sock] [sessionId]
//
// It joins the given session, or the latest one from session/list, and prints the history that the host
// sends from its store, then the live updates. A typed line is a prompt, or the number of a permission option.

import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Peer, type Message } from './jsonrpc.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { socket: { type: 'string', default: '/tmp/acp-thin-host.sock' } } });
const stream = createConnection(values.socket);
const host = new Peer(stream, stream);
let permission: Message | undefined;

const text = (content: any) => [content ?? []].flat().map((c: any) => c.text ?? `[${c.type}]`).join('');
host.onMessage = ({ id, method, params }) => {
  if (method === 'session/update') {
    const u = params.update;
    if (u.sessionUpdate.startsWith('user_message')) console.log(`> ${text(u.content)}`);
    else if (u.sessionUpdate.startsWith('agent_message')) console.log(`  ${text(u.content)}`);
    else if (u.sessionUpdate === 'tool_call_update') console.log(`  [${u.title ?? u.toolCallId}${u.status ? ': ' + u.status : ''}]`);
    else if (u.sessionUpdate === 'replay_complete') console.log('--- the history above came from the host store; live from here ---');
    else console.log(`  (${u.sessionUpdate})`);
  } else if (method === 'session/request_permission') {
    permission = { id, params };
    console.log(`? permission\n${params.options.map((o: any, i: number) => `  ${i + 1}. ${o.name}`).join('\n')}`);
  } else if (method === '$/cancel_request' && params.requestId === permission?.id) {
    permission = undefined;
    console.log('  (answered by another Client)');
  } else if (method) {
    console.log(`· ${method} ${JSON.stringify(params)}`);
  }
};

const call = async (method: string, params: any) => {
  const reply = await host.request(method, params);
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
};

await call('initialize', { protocolVersion: 2, info: { name: 'watch', version: '1' }, capabilities: {} });
const { sessions } = await call('session/list', {});
const session = sessions.find((s: any) => s.sessionId === (positionals[0] ?? s.sessionId));
if (!session) throw new Error('no session to join');
console.log(`joining ${session.sessionId}`);
await call('session/resume', { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [], replayFrom: { type: 'start' } });

createInterface({ input: process.stdin }).on('line', line => {
  if (permission) {
    const option = permission.params.options[Number(line) - 1];
    host.send({ id: permission.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    permission = undefined;
  } else if (line.trim()) {
    void call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: line }] });
  }
});
