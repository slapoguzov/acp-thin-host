// x-scope: the resource of a message, from the table of the schema and the Agent's custom methods.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceOf } from '../src/scope.ts';
import { agentEntries } from '../src/state.ts';
import { tableFromSchema, withEntries } from '../schema/rows.ts';
import { schema } from './fixture.ts';

const table = withEntries(tableFromSchema(schema), agentEntries({ methods: {
  '_task/progress': { 'x-scope': ['/sessions/{sessionId}/_tasks/{taskId}'] },
  '_quota/changed': { 'x-scope': ['/_quota/{accountId}'] },
  '_future/kind': { 'x-scope': ['/workspaces/{workspaceId}'] },
  'elicitation/complete': { 'x-scope': ['/sessions/{sessionId}'] }, // an ACP method
  '_old/shape': { 'x-scope': { resource: ['/'] } }, // not an array: ignored
} }));

const session = { kind: 'sessions', field: 'sessionId', id: 's1' };

test('the first path whose fields are all present names the resource', () => {
  assert.deepEqual(resourceOf(table, 'elicitation/create', { requestId: 7, sessionId: 's1' }), { kind: 'requests', field: 'requestId', id: '7' });
  assert.deepEqual(resourceOf(table, 'elicitation/create', { sessionId: 's1' }), session);
});

test('a tool call path is held as its session', () => {
  assert.deepEqual(resourceOf(table, 'elicitation/create', { sessionId: 's1', toolCallId: 't1' }), session);
  assert.deepEqual(resourceOf(table, 'session/request_permission', { sessionId: 's1', subject: { type: 'tool_call', toolCall: { toolCallId: 't1' } } }), session);
  assert.deepEqual(resourceOf(table, 'session/request_permission', { sessionId: 's1', subject: { type: 'command', command: 'ls', toolCallId: 't1' } }), session);
  assert.deepEqual(resourceOf(table, 'session/request_permission', { sessionId: 's1' }), session);
});

test('a path below a resource is held as it; a custom first segment is held as the Agent; any other is reserved', () => {
  assert.deepEqual(resourceOf(table, '_task/progress', { sessionId: 's1', taskId: 'k1' }), session);
  assert.deepEqual(resourceOf(table, '_quota/changed', { accountId: 'a1' }), { kind: 'root' });
  assert.equal(resourceOf(table, '_future/kind', { workspaceId: 'w1' }), null);
  assert.equal(resourceOf(table, '_old/shape', {}), null, 'an x-scope that is not a list of paths is not read');
});

test("the Agent's scope for an ACP method is used; other methods keep the host's own", () => {
  assert.deepEqual(resourceOf(table, 'elicitation/complete', { sessionId: 's1', elicitationId: 'e1' }), session);
  assert.deepEqual(resourceOf(table, 'mcp/message', { serverId: 'm1' }), { kind: 'mcpServers', field: 'serverId', id: 'm1' });
});
