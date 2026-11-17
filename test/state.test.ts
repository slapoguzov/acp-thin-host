// x-state: the store applies the rules of annotations.json and knows no variant by name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/state.ts';
import { acpAnnotations, withAgentAnnotations } from '../src/annotations.ts';
import { text } from './fixture.ts';

const store = (annotations = acpAnnotations) => {
  const s = new SessionStore(annotations);
  return Object.assign(s, { update: (update: any) => s.applyUpdate({ sessionId: 's1', update }) });
};

test('the worked example of the RFD: two tool call updates and a notice', () => {
  const s = store();
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', title: 'Read file', status: 'in_progress' });
  s.update({ sessionUpdate: 'notice', severity: 'info', title: 'Rate limit soon' });
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
  assert.deepEqual(s.replay('s1').history, [{ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', title: 'Read file', status: 'completed' }]);
});

test('append: chunks become one message; base64 chunks join as bytes', () => {
  const s = store();
  s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('Hel') });
  s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('lo') });
  s.update({ sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: Buffer.from('ab').toString('base64') });
  s.update({ sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: Buffer.from('c').toString('base64') });
  assert.deepEqual(s.replay('s1').history, [
    { sessionUpdate: 'agent_message', messageId: 'm1', content: [text('Hel'), text('lo')] },
    { sessionUpdate: 'terminal_update', terminalId: 't1', output: { data: Buffer.from('abc').toString('base64') } },
  ]);
});

test('upsert: an omitted field is unchanged, null clears a field, _meta is patched by key', () => {
  const s = store();
  s.update({ sessionUpdate: 'session_info_update', title: 'Fix', updatedAt: '1', _meta: { a: 1, b: 2 } });
  s.update({ sessionUpdate: 'session_info_update', updatedAt: null, _meta: { b: null, c: 3 } });
  assert.deepEqual(s.current('s1', 'info'), { title: 'Fix', _meta: { a: 1, c: 3 } });
});

test('replace and remove: current values and entities', () => {
  const s = store();
  s.update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model' }] });
  s.update({ sessionUpdate: 'plan_update', plan: { planId: 'p1', entries: [] } });
  s.update({ sessionUpdate: 'plan_removed', planId: 'p1' });
  s.applyResponse('session/set_title', { sessionId: 's1' }, { title: 'New title' });
  assert.deepEqual(s.replay('s1'), {
    history: [],
    current: [{ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model' }] }, { sessionUpdate: 'session_info_update', title: 'New title' }],
  });
  s.update({ sessionUpdate: 'config_option_update', configOptions: null });
  assert.equal(s.current('s1', 'config'), undefined, 'a null value clears it');
  s.applyResponse('session/delete', { sessionId: 's1' }, {});
  assert.deepEqual(s.replay('s1'), { history: [], current: [] });
});

test('responses and requests: session/new stores the options; a permission request stores its tool call', () => {
  const s = store();
  s.applyResponse('session/new', { cwd: '/w' }, { sessionId: 's1', configOptions: [{ id: 'model' }], availableCommands: [] });
  s.applyRequest('session/request_permission', { sessionId: 's1', title: 'Run?', subject: { type: 'tool_call', toolCall: { toolCallId: 't1', title: 'rm' } }, options: [] });
  s.applyRequest('session/request_permission', { sessionId: 's1', title: 'Run?', subject: { type: 'command', command: 'ls' }, options: [] });
  assert.deepEqual(s.current('s1', 'config'), [{ id: 'model' }]);
  assert.deepEqual(s.replay('s1').history, [{ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'rm' }], 'no tool call in the subject: not applied');
});

test('a variant without a rule is live only; an ID with "/" stays one segment', () => {
  const s = store();
  s.update({ sessionUpdate: '_unknown', x: 1 });
  s.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a/b', status: 'pending' });
  assert.deepEqual(s.replay('s1').history, [{ sessionUpdate: 'tool_call_update', toolCallId: 'a/b', status: 'pending' }]);
});

test("the Agent's annotations: a custom update is stored; a custom rule cannot write ACP state", () => {
  const s = store(withAgentAnnotations(acpAnnotations, {
    sessionUpdates: {
      _task_update: { 'x-state': { action: 'upsert', path: '/sessions/{sessionId}/_tasks/{update.taskId}' } },
      _evil_update: { 'x-state': { action: 'replace', path: '/sessions/{sessionId}/config' } },
      _other_update: { 'x-state': { action: 'upsert', path: '/sessions/{update.other}/_tasks/{update.taskId}' } },
      _bad_update: { 'x-state': { action: 'merge' as any, path: '/sessions/{sessionId}/_x' } },
    },
  }));
  s.update({ sessionUpdate: '_task_update', taskId: 'k1', status: 'running' });
  s.update({ sessionUpdate: '_task_update', taskId: 'k1', status: 'done' });
  s.update({ sessionUpdate: '_evil_update', configOptions: [] });
  s.update({ sessionUpdate: '_other_update', other: 's2', taskId: 'k2' });
  s.update({ sessionUpdate: '_bad_update' });
  assert.deepEqual(s.replay('s2'), { history: [], current: [] }, 'a custom rule writes only the session of its message');
  assert.deepEqual(s.replay('s1'), { history: [{ sessionUpdate: '_task_update', taskId: 'k1', status: 'done' }], current: [] });
});
