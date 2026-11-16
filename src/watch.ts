// A second ACP Client for the demo: joins a session that another Client (Air) runs through the host.
//
//   node src/watch.ts [--socket /tmp/acp-thin-host.sock] [sessionId]
//
// Without a sessionId it joins the most recent session from session/list. It prints the history that the host
// replays from its store, then the live stream. A typed line is sent as a prompt; when the Agent asks for
// permission, the line chooses an option by its number.

import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Peer, type Message } from './jsonrpc.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { socket: { type: 'string' } } });
const stream = createConnection(values.socket ?? '/tmp/acp-thin-host.sock');
const agent = new Peer(stream, stream);
const say = (line: string) => process.stdout.write(line + '\n');
let permission: Message | undefined;

agent.onMessage = message => {
  if (message.method === 'session/update') return say(describe(message.params.update));
  if (message.method === 'session/request_permission') {
    permission = message;
    return say(`? ${message.params.title}\n${message.params.options.map((o: any, i: number) => `  ${i + 1}. ${o.name}`).join('\n')}`);
  }
  if (message.method === '$/cancel_request' && permission?.id === message.params.requestId) { permission = undefined; return say('  (answered by another client)'); }
  if (message.method) say(`· ${message.method} ${JSON.stringify(message.params).slice(0, 120)}`);
};

function describe(update: any): string {
  const text = (content: any) => [].concat(content ?? []).map((c: any) => c?.text ?? `[${c?.type}]`).join('');
  switch (update.sessionUpdate) {
    case 'user_message': case 'user_message_chunk': return `> ${text(update.content)}`;
    case 'agent_message': case 'agent_message_chunk': return `  ${text(update.content)}`;
    case 'tool_call_update': return `  [tool ${update.title ?? update.toolCallId}${update.status ? ': ' + update.status : ''}]`;
    case 'state_update': return `  (${update.state})`;
    case 'replay_complete': return '--- history above came from the host store; live from here ---';
    default: return `  (${update.sessionUpdate})`;
  }
}

const call = async (method: string, params: any) => {
  const reply = await agent.request(method, params);
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
};

await call('initialize', { protocolVersion: 2, info: { name: 'acp-watch', version: '1' }, capabilities: {} });
const listed = await call('session/list', {});
const session = positionals[0] ? listed.sessions.find((s: any) => s.sessionId === positionals[0]) : listed.sessions[0];
if (!session) throw new Error('no session to join');
say(`joining ${session.sessionId} (${session.title ?? 'untitled'})`);
await call('session/resume', { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [], replayFrom: { type: 'start' } });

createInterface({ input: process.stdin }).on('line', line => {
  if (permission) {
    const option = permission.params.options[Number(line) - 1];
    agent.send({ id: permission.id, result: option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } } });
    permission = undefined;
  } else if (line.trim()) {
    void call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: line }] });
  }
});
