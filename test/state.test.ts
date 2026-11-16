// x-state: one generic fold, rows read from the annotated schema.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, withAgentRows } from '../src/state.ts';
import { rowsFromSchema } from '../schema/rows.ts';
import { schema } from './fixture.ts';

const rows = rowsFromSchema(schema);
const text = (t: string) => ({ type: 'text', text: t });

function fold(updates: any[], store = new SessionStore(rows)) {
  for (const update of updates) store.applyUpdate({ sessionId: 's1', update });
  return store;
}

test('every update variant of the schema has a row', () => {
  assert.equal(Object.keys(rows.updates).length, 25);
  assert.deepEqual(Object.keys(rows.responses).sort(), ['session/fork', 'session/new', 'session/resume', 'session/set_config_option', 'session/set_title']);
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

test('terminal output is base64: chunks are decoded and the bytes appended (schema contentEncoding)', () => {
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
  const declared = new SessionStore(withAgentRows(rows, { sessionUpdates: { _task_update: { 'x-state': { action: 'upsert', path: '/sessions/{sessionId}/_tasks/{update.taskId}' } } } }));
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
