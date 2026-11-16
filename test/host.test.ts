// The thin host with two Clients over one scripted Agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostWith, tick } from './fixture.ts';

const text = (t: string) => ({ type: 'text', text: t });
const AUTH_STATUS = { methods: { '_auth/status_update': { 'x-audience': { resource: ['/'] } } } };

async function sharedSession(options = {}) {
  const env = hostWith(options);
  const a = await env.client();
  const { sessionId } = await a.call('session/new', { cwd: '/w', mcpServers: [] });
  return { ...env, a, sessionId };
}

/** A creates a session, and B joins it without replay. */
async function twoClients(options = {}) {
  const env = await sharedSession(options);
  const b = await env.client();
  await b.call('session/resume', { sessionId: env.sessionId, cwd: '/w', mcpServers: [] });
  return { ...env, b };
}

test('B joins a live session: history comes from the host store, not from the Agent', async () => {
  const { agent, client, a, sessionId } = await sharedSession();
  agent.update(sessionId, { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: text('fix the bug') });
  agent.update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('Look') });
  agent.update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('ing') });
  agent.update(sessionId, { sessionUpdate: 'notice', severity: 'info', title: 'old notice' });
  agent.update(sessionId, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
  await tick();

  const b = await client();
  const resumed = await b.call('session/resume', { sessionId, cwd: '/w', mcpServers: [], replayFrom: { type: 'start' } });

  assert.equal(agent.count('session/resume'), 0, 'the Agent is not asked again');
  assert.deepEqual(resumed.configOptions, [{ id: 'model', currentValue: 'small' }], 'lists come from the session/new response row');
  assert.deepEqual(b.updates(sessionId).map(u => u.sessionUpdate),
    ['user_message', 'agent_message', 'replay_complete', 'config_option_update', 'available_commands_update', 'state_update'],
    'history, then current values (the lists of the session/new response), state_update last');
  assert.deepEqual(b.updates(sessionId)[1].content, [text('Look'), text('ing')], 'three chunks became one message');
  assert.equal(a.updates(sessionId).length, 5, 'A got no duplicates');

  agent.update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: text('live') });
  await tick();
  assert.equal(a.updates(sessionId).at(-1).messageId, 'm2');
  assert.equal(b.updates(sessionId).at(-1).messageId, 'm2', 'after joining, B gets live updates too');
});

test('permission request has binding "resource": both Clients see it, the first answer wins, the other is withdrawn', async () => {
  const { agent, a, b, sessionId } = await twoClients();

  const reply = agent.ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] });
  await tick();
  assert.equal(a.got('session/request_permission').length, 1);
  assert.equal(b.got('session/request_permission').length, 1);

  const shownToB = b.got('session/request_permission')[0];
  b.peer.send({ id: shownToB.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.deepEqual((await reply).result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  await tick();
  assert.equal(a.got('$/cancel_request').length, 1, "A's prompt is withdrawn");
});

test('a request scoped to a Client request goes only to that Client, with its own request ID', async () => {
  const { agent, a, b, sessionId } = await twoClients();

  await a.call('session/list', {}); // makes the host's upstream IDs differ from B's own IDs
  // B sends a prompt; while it runs, the Agent asks about B's request.
  let promptId = 0;
  const prompt = b.peer.request('session/prompt', { sessionId, prompt: [text('go')] }, id => { promptId = id; });
  await tick();
  const upstreamId = agent.calls.find(m => m.method === 'session/prompt')!.id;
  void agent.ask('elicitation/create', { requestId: upstreamId, mode: 'form', message: 'Which file?' });
  await tick();
  assert.equal(a.got('elicitation/create').length, 0);
  const shown = b.got('elicitation/create');
  assert.notEqual(upstreamId, promptId);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].params.requestId, promptId, "B sees the ID of its own prompt, not the host's upstream ID");
  agent.endTurn();
  await prompt;
});

test('Agent-level notification ("/"): every Client with the declaration, nobody without it', async () => {
  for (const declared of [AUTH_STATUS, undefined]) {
    const { agent, client, a, logs } = await sharedSession({ agentSchema: declared });
    const b = await client();
    agent.notify('_auth/status_update', { status: 'authenticated' });
    await tick();
    const expected = declared ? 1 : 0;
    assert.deepEqual([a.got('_auth/status_update').length, b.got('_auth/status_update').length], [expected, expected]);
    if (!declared) assert.ok(logs.includes('dropped _auth/status_update: no audience'));
  }
});

test('a request without an audience is refused with -32601', async () => {
  const { agent } = await sharedSession();
  const reply = await agent.ask('_fixture/pick', { sessionId: 's1' });
  assert.equal(reply.error.code, -32601);
});

test('closing a session that another Client still uses does not close it in the Agent', async () => {
  const { agent, a, b, sessionId } = await twoClients();
  await a.call('session/close', { sessionId });
  assert.equal(agent.count('session/close'), 0);
  agent.update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm9', content: text('still here') });
  await tick();
  assert.equal(b.updates(sessionId).at(-1).messageId, 'm9');
  assert.equal(a.updates(sessionId).length, 0);
});

test('a session request with binding "connection" goes to one Client: the one that sent the latest prompt', async () => {
  const PICK = { methods: { '_fixture/pick': { 'x-audience': { resource: ['/sessions/{sessionId}'] } } } };
  const { agent, a, b, sessionId } = await twoClients({ agentSchema: PICK });
  void b.peer.request('session/prompt', { sessionId, prompt: [text('go')] });
  await tick();
  agent.endTurn(); // in v2 the prompt response only accepts the turn; the request comes later
  await tick();
  b.answers.set('_fixture/pick', () => ({ picked: 'b' }));
  const reply = await agent.ask('_fixture/pick', { sessionId });
  assert.deepEqual(reply.result, { picked: 'b' });
  assert.equal(a.got('_fixture/pick').length, 0);
});

test('a request bound to the resource ends when every Client that holds it answered with an error, or left', async () => {
  const { agent, a, b, sessionId } = await twoClients();
  const reply = agent.ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1' }, options: [] });
  await tick();
  const shownToA = a.got('session/request_permission')[0];
  a.peer.send({ id: shownToA.id, error: { code: -32000, message: 'A cannot answer' } });
  await tick();
  b.peer.send({ id: b.got('session/request_permission')[0].id, error: { code: -32000, message: 'B cannot answer' } });
  assert.equal((await reply).error.code, -32000);
});

test("a Client's $/cancel_request reaches the Agent with the Agent's ID of that request", async () => {
  const { agent, a, b, sessionId } = await twoClients();
  await a.call('session/list', {}); // the host's IDs and B's IDs now differ
  let promptId = 0;
  void b.peer.request('session/prompt', { sessionId, prompt: [text('go')] }, id => { promptId = id; });
  await tick();
  b.peer.send({ method: '$/cancel_request', params: { requestId: promptId } });
  await tick();
  const upstreamId = agent.calls.find(m => m.method === 'session/prompt')!.id;
  assert.deepEqual(agent.calls.find(m => m.method === '$/cancel_request')?.params, { requestId: upstreamId });
});

test('a permission request upserts the tool call it carries, and a joining Client gets that tool call', async () => {
  const { agent, client, sessionId } = await sharedSession();
  void agent.ask('session/request_permission', { sessionId, subject: { type: 'tool_call', toolCall: { toolCallId: 't7', title: 'rm -rf build' } }, options: [] });
  await tick();
  const b = await client();
  await b.call('session/resume', { sessionId, cwd: '/w', mcpServers: [], replayFrom: { type: 'start' } });
  assert.deepEqual(b.updates(sessionId).find(u => u.sessionUpdate === 'tool_call_update'), { sessionUpdate: 'tool_call_update', toolCallId: 't7', title: 'rm -rf build' });
});
