// A walk through the RFD: one scripted Agent, the host, and two Clients A and B. Prints every message.
//
//   node demo.ts

import { setup, text, tick, type Trace } from './test/fixture.ts';

const json = (value: any) => { const s = JSON.stringify(value); return s.length > 110 ? s.slice(0, 109) + '…' : s; };
const trace: Trace = (from, to, m) => {
  const what = m.method === 'session/update' ? `session/update  ${m.params.update.sessionUpdate} ${json({ ...m.params.update, sessionUpdate: undefined })}`
    : m.method ? `${m.method} ${json(m.params)}`
    : m.error ? `error ${json(m.error)}` : `result ${json(m.result)}`;
  console.log(`  ${from.padStart(5)} → ${to.padEnd(5)}  ${what}`);
};
const step = (title: string, ...why: string[]) => console.log(`\n${title}\n${why.map(line => `  # ${line}\n`).join('')}`);

// The Agent declares one custom method in initialize. claude-agent-acp and codex-acp send `_auth/status_update`.
const { agent, client } = setup({ trace, agentAnnotations: { methods: { '_auth/status_update': { 'x-scope': ['/'] } } } });

step('1. A creates a session', 'The host asks the Agent for its annotations with capabilities.schema: {}.',
  'x-state of the session/new response stores the config options.');
const A = await client({}, 'A');
await A.call('session/new', { cwd: '/repo', mcpServers: [] });

step('2. The Agent works', 'Each update is stored by its x-state rule. The notice has action "none": live only.');
agent.update('s1', { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: text('Fix the test') });
agent.update('s1', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('Look') });
agent.update('s1', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('ing…') });
agent.update('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Run tests', status: 'in_progress' });
agent.update('s1', { sessionUpdate: 'notice', severity: 'warning', title: 'Rate limit soon' });
agent.update('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
await tick();

step('3. B joins the live session', 'The host answers session/resume from its store. The Agent gets nothing.',
  'Two chunks are one agent_message, two tool call updates are one, and the notice is gone.');
const B = await client({}, 'B');
await B.call('session/list', {});
await B.call('session/resume', { sessionId: 's1', cwd: '/repo', mcpServers: [], replayFrom: { type: 'start' } });

step('4. The Agent asks for permission', 'x-scope: /sessions/s1/toolCalls/t2. Both Clients hold s1, so both see it.',
  'Host policy: the first answer wins. B answers, and A gets $/cancel_request.');
B.peer.onMessage = m => { if (m.method === 'session/request_permission') B.peer.send({ id: m.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }); };
await agent.ask('session/request_permission', {
  sessionId: 's1', title: 'Edit file?', subject: { type: 'tool_call', toolCall: { toolCallId: 't2', title: 'Edit test.ts' } },
  options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
});
await tick();

step('5. A custom notification without a sessionId', 'x-scope "/" comes from the Agent\'s capabilities.schema: every Client gets it.');
agent.notify('_auth/status_update', { status: 'signed_in' });
await tick();

step('6. An elicitation about one Client request', 'x-scope: /requests/{requestId}. Only A sent that request, so only A gets it.',
  'The Agent knows the host\'s ID of the prompt (4). A gets its own ID back (3).');
A.peer.onMessage = m => { if (m.method === 'elicitation/create') A.peer.send({ id: m.id, result: { action: 'cancel' } }); };
const prompt = A.call('session/prompt', { sessionId: 's1', prompt: [text('Which test?')] });
await tick();
await agent.ask('elicitation/create', { requestId: agent.prompts[0], mode: 'form', message: 'Which file?', requestedSchema: {} });
agent.endTurn();
await prompt;
await tick();
