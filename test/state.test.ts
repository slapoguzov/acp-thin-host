// x-state: one generic fold, rows read from the annotated schema and from the Agent's capabilities.schema.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, agentEntries } from '../src/state.ts';
import { rowsOf, tableFromSchema, withEntries } from '../schema/rows.ts';
import { schema } from './fixture.ts';

const table = tableFromSchema(schema);
/** The host's table with an Agent's capabilities.schema over it. */
const withAgent = (agentSchema: any) => withEntries(table, agentEntries(agentSchema));
const text = (t: string) => ({ type: 'text', text: t });

function fold(updates: any[], store = new SessionStore(table)) {
  for (const update of updates) store.applyUpdate({ sessionId: 's1', update });
  return store;
}

test('the table of the schema: every update variant has a row, and seven methods change state', () => {
  assert.equal(Object.keys(table.sessionUpdates).length, 25);
  assert.deepEqual(Object.keys(table.methods).filter(method => table.methods[method]['x-state']).sort(),
    ['session/delete', 'session/fork', 'session/new', 'session/request_permission', 'session/resume', 'session/set_config_option', 'session/set_title']);
  assert.equal(rowsOf(table.sessionUpdates.terminal_output_chunk)![0].encoding, 'base64', 'the generator copied contentEncoding');
});

test('chunks append to their message; messages keep the order of first report', () => {
  const store = fold([
    { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: text('hi') },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('Hel') },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Read', status: 'in_progress' },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('lo') },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
  ]);
  assert.deepEqual(store.replay('s1').history, [
    { sessionUpdate: 'user_message', messageId: 'u1', content: [text('hi')] },
    { sessionUpdate: 'agent_message', messageId: 'a1', content: [text('Hel'), text('lo')] },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Read', status: 'completed' },
  ]);
});

test('terminal output is base64: the row has encoding, so chunks are decoded and the bytes appended', () => {
  const store = fold([
    { sessionUpdate: 'terminal_update', terminalId: 'x', command: 'echo' },
    { sessionUpdate: 'terminal_output_chunk', terminalId: 'x', data: Buffer.from('h').toString('base64') },
    { sessionUpdate: 'terminal_output_chunk', terminalId: 'x', data: Buffer.from('i').toString('base64') },
  ]);
  const [terminal] = store.replay('s1').history;
  assert.equal(Buffer.from(terminal.output.data, 'base64').toString(), 'hi');
});

test('current values keep only the latest; responses replace lists; live-only updates are not stored', () => {
  const store = fold([
    { sessionUpdate: 'state_update', state: 'running' },
    { sessionUpdate: 'notice', severity: 'info', title: 'live only' },
    { sessionUpdate: 'session_info_update', title: 'First' },
    { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
  ]);
  store.applyResponse('session/set_config_option', { sessionId: 's1' }, { configOptions: [{ id: 'model', currentValue: 'large' }] });
  assert.deepEqual(store.replay('s1'), {
    history: [],
    current: [
      { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
      { sessionUpdate: 'session_info_update', title: 'First' },
      { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'large' }] },
    ],
  });
});

test('a custom update is stored by the row the Agent declares; without a row it stays raw', () => {
  const custom = { sessionUpdate: '_task_update', taskId: 'k1', status: 'open' };
  const declared = new SessionStore(withAgent({ sessionUpdates: { _task_update: { 'x-state': { action: 'upsert', path: '/sessions/{sessionId}/_tasks/{update.taskId}' } } } }));
  fold([custom, { ...custom, status: 'done' }], declared);
  assert.deepEqual(declared.replay('s1').history, [{ sessionUpdate: '_task_update', taskId: 'k1', status: 'done' }]);

  const undeclared = fold([custom, { ...custom, status: 'done' }]);
  assert.deepEqual(undeclared.replay('s1').history, [custom, { ...custom, status: 'done' }]);
});

test('folding the replay again gives the same state (joiner fold = live fold)', () => {
  const live = fold([
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('x') },
    { sessionUpdate: 'plan_update', plan: { planId: 'p1', entries: [] } },
    { sessionUpdate: 'usage_update', used: 10, size: 100 },
    { sessionUpdate: 'state_update', state: 'idle' },
  ]);
  const { history, current } = live.replay('s1');
  const joiner = fold([...history, ...current]);
  assert.deepEqual(joiner.replay('s1'), live.replay('s1'));
});

test('raw nodes keep their own numbering when another node is removed', () => {
  const custom = (n: number) => ({ sessionUpdate: '_custom', n });
  const store = fold([custom(1), { sessionUpdate: 'plan_update', plan: { planId: 'p1', entries: [] } }, custom(2),
    { sessionUpdate: 'plan_removed', planId: 'p1' }, custom(3)]);
  assert.deepEqual(store.replay('s1').history, [custom(1), custom(2), custom(3)]);
});

test('set_title replaces info/title, a field inside the current value info', () => {
  const store = fold([{ sessionUpdate: 'session_info_update', title: 'Old', updatedAt: 'T1' }]);
  store.applyResponse('session/set_title', { sessionId: 's1', title: 'New' }, { title: 'New' });
  assert.deepEqual(store.current('s1', 'info'), { title: 'New', updatedAt: 'T1' });
});

test('the session/delete response removes the session and everything under it', () => {
  const store = fold([{ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: text('x') }, { sessionUpdate: 'state_update', state: 'idle' }]);
  store.applyResponse('session/delete', { sessionId: 's1' }, {});
  assert.deepEqual(store.replay('s1'), { history: [], current: [] });
});

test('a permission request upserts its tool call; one without a tool call changes nothing', () => {
  const store = fold([{ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }]);
  store.applyRequest('session/request_permission', { sessionId: 's1', subject: { type: 'tool_call', toolCall: { toolCallId: 't1', title: 'Edit' } } });
  store.applyRequest('session/request_permission', { sessionId: 's1', subject: { type: 'command', command: 'ls' } });
  assert.deepEqual(store.replay('s1').history, [{ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', title: 'Edit' }]);
});

test('a row whose path field is absent is not applied', () => {
  const store = fold([{ sessionUpdate: 'tool_call_update', status: 'completed' }]); // no toolCallId
  assert.deepEqual(store.replay('s1'), { history: [], current: [] });
});

test('a custom row that writes an ACP node is ignored', () => {
  const custom = withAgent({ sessionUpdates: {
    _fixture_title: { 'x-state': { action: 'replace', path: '/sessions/{sessionId}/info', value: 'update.info' } },
    _fixture_task: { 'x-state': { action: 'upsert', path: '/sessions/{sessionId}/_tasks/{update.taskId}' } },
  } });
  assert.equal(custom.sessionUpdates._fixture_title, undefined);
  assert.ok(custom.sessionUpdates._fixture_task);
});

test("the Agent's row for an ACP variant is used; other variants keep the host's own rows", () => {
  const store = new SessionStore(withAgent({ sessionUpdates: {
    session_info_update: { 'x-state': { action: 'replace', path: '/sessions/{sessionId}/info' } }, // a newer rule
  } }));
  fold([
    { sessionUpdate: 'session_info_update', title: 'Old', updatedAt: 'T1' },
    { sessionUpdate: 'session_info_update', updatedAt: 'T2' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
  ], store);
  assert.deepEqual(store.current('s1', 'info'), { updatedAt: 'T2' }, "replace, the Agent's row, not the host's upsert");
  assert.deepEqual(store.replay('s1').history, [{ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }]);
});

test("a newer Agent: a variant and a response that the host's schema lacks are folded by the Agent's rows", () => {
  const newer = {
    sessionUpdates: { review_update: { 'x-state': { action: 'upsert', path: '/sessions/{sessionId}/reviews/{update.reviewId}' } } },
    methods: { 'session/set_goal': { 'x-state': { action: 'replace', path: '/sessions/{sessionId}/goal', value: 'result.goal' } } },
  };
  const review = (status: string) => ({ sessionUpdate: 'review_update', reviewId: 'r1', status });
  const host = fold([review('open'), review('done')]);
  assert.deepEqual(host.replay('s1').history, [review('open'), review('done')], 'without the Agent row: raw');

  const store = fold([review('open'), review('done')], new SessionStore(withAgent(newer)));
  store.applyResponse('session/set_goal', { sessionId: 's1' }, { goal: 'ship' });
  assert.deepEqual(store.replay('s1').history, [review('done')]);
  assert.equal(store.current('s1', 'goal'), 'ship');
});

test('replace with an absent or null value empties the node: a list and a title. upsert and append skip the row', () => {
  const store = fold([
    { sessionUpdate: 'session_info_update', title: 'Old', updatedAt: 'T1' },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'test' }] },
    { sessionUpdate: 'available_commands_update', availableCommands: null },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1' }, // append without content
  ]);
  store.applyResponse('session/set_config_option', { sessionId: 's1' }, { configOptions: [{ id: 'model' }] });
  store.applyResponse('session/set_config_option', { sessionId: 's1' }, {});
  store.applyResponse('session/set_title', { sessionId: 's1' }, {});
  assert.equal(store.current('s1', 'commands'), undefined, 'an empty list');
  assert.equal(store.current('s1', 'config'), undefined, 'an empty list');
  assert.deepEqual(store.current('s1', 'info'), { updatedAt: 'T1' }, 'a title with no value');
  assert.deepEqual(store.replay('s1').history, [], 'the chunk without content created no message');
});
