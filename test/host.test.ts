// The host with two Clients over one scripted Agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeOf } from '../src/scope.ts';
import { acpAnnotations } from '../src/annotations.ts';
import { setup, twoClients, text, tick } from './fixture.ts';

const permission = { sessionId: 's1', title: 'Run rm?', subject: { type: 'tool_call', toolCall: { toolCallId: 't1' } }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] };

test('x-scope: the most specific path whose fields are present', () => {
  const scope = (method: string, params: any) => scopeOf(acpAnnotations, method, params);
  assert.deepEqual(scope('elicitation/create', { requestId: 7, sessionId: 's1' }), { kind: 'requests', id: '7', field: 'requestId' });
  assert.deepEqual(scope('elicitation/create', { sessionId: 's1' }), { kind: 'sessions', id: 's1', field: 'sessionId' });
  assert.deepEqual(scope('session/request_permission', permission), { kind: 'sessions', id: 's1', field: 'sessionId' });
  assert.deepEqual(scope('auth/status_update', {}), { kind: '', id: '', field: '' });
  assert.equal(scope('_auth/status_update', {}), null, 'a custom method needs the Agent to declare it');
});

test('B joins a live session: the history comes from the store, the Agent is not asked', async () => {
  const { agent, client } = setup();
  const a = await client();
  await a.call('session/new', { cwd: '/w', mcpServers: [] });
  agent.update('s1', { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: text('fix the bug') });
  agent.update('s1', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('Look') });
  agent.update('s1', { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('ing') });
  agent.update('s1', { sessionUpdate: 'notice', severity: 'info', title: 'old notice' });
  agent.update('s1', { sessionUpdate: 'state_update', state: 'idle' });
  await tick();

  const b = await client();
  const resumed = await b.call('session/resume', { sessionId: 's1', cwd: '/w', mcpServers: [], replayFrom: { type: 'start' } });
  assert.equal(agent.count('session/resume'), 0);
  assert.deepEqual(resumed.configOptions, [{ id: 'model', currentValue: 'small' }], 'from the x-state rule of the session/new response');
  assert.deepEqual(b.updates().map(u => u.sessionUpdate),
    ['user_message', 'agent_message', 'replay_complete', 'config_option_update', 'available_commands_update', 'state_update']);
  assert.deepEqual(b.updates()[1].content, [text('Look'), text('ing')]);
  assert.equal(a.updates().length, 5, 'A gets nothing twice');

  agent.update('s1', { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: text('live') });
  await tick();
  assert.equal(b.updates().at(-1).messageId, 'm2', 'then B gets live updates');
});

test('a permission request: both Clients see it, the first answer wins, the other is withdrawn', async () => {
  const { agent, a, b } = await twoClients();
  const reply = agent.ask('session/request_permission', permission);
  await tick();
  const [shownToB] = b.got('session/request_permission');
  assert.equal(a.got('session/request_permission').length, 1);
  b.peer.send({ id: shownToB.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.deepEqual((await reply).result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  await tick();
  assert.equal(a.got('$/cancel_request').length, 1);
});

test('a Client that joins later also sees the waiting permission request', async () => {
  const { agent, client } = setup();
  const a = await client();
  await a.call('session/new', { cwd: '/w', mcpServers: [] });
  void agent.ask('session/request_permission', permission);
  await tick();
  const b = await client();
  await b.call('session/resume', { sessionId: 's1', cwd: '/w', mcpServers: [], replayFrom: { type: 'start' } });
  assert.equal(b.got('session/request_permission').length, 1);
  assert.deepEqual(b.updates()[0], { sessionUpdate: 'tool_call_update', toolCallId: 't1' }, 'the request stored its tool call');
});

test('an elicitation about a Client request goes only to that Client, with its own request ID', async () => {
  const { agent, a, b } = await twoClients();
  await a.call('session/list', {}); // so that the host's request IDs differ from B's own
  let bId = 0;
  void b.peer.request('session/prompt', { sessionId: 's1', prompt: [text('go')] }, id => { bId = id; });
  await tick();
  const hostId = agent.calls.find(m => m.method === 'session/prompt')!.id;
  void agent.ask('elicitation/create', { requestId: hostId, mode: 'form', message: 'Which file?', requestedSchema: {} });
  await tick();
  assert.notEqual(hostId, bId);
  assert.equal(a.got('elicitation/create').length, 0);
  assert.equal(b.got('elicitation/create')[0].params.requestId, bId);
});

test("a custom method reaches every Client when the Agent declares its x-scope in initialize", async () => {
  const { agent, a, b } = await twoClients({ agentAnnotations: { methods: { '_auth/status_update': { 'x-scope': ['/'] } } } });
  agent.notify('_auth/status_update', { status: 'signed_in' });
  await tick();
  assert.equal(a.got('_auth/status_update').length, 1);
  assert.equal(b.got('_auth/status_update').length, 1);
});

test('a Client that asks with capabilities.schema gets the annotations the host uses', async () => {
  const { client } = setup({ agentAnnotations: { methods: { '_auth/status_update': { 'x-scope': ['/'] } } } });
  const asks = await client({ schema: {} });
  const plain = await client();
  assert.deepEqual(asks.initialized.capabilities.schema.methods['_auth/status_update'], { 'x-scope': ['/'] });
  assert.equal(asks.initialized.capabilities.schema.sessionUpdates.tool_call_update['x-state'].action, 'upsert');
  assert.equal(plain.initialized.capabilities.schema, undefined);
});
