// x-audience: the resource of a message, from the table of the schema and the Agent's custom methods.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bindsToResource, resourceOf } from '../src/audience.ts';
import { agentEntries } from '../src/state.ts';
import { tableFromSchema, withEntries } from '../schema/rows.ts';
import { schema } from './fixture.ts';

const table = withEntries(tableFromSchema(schema), agentEntries({ methods: {
  '_task/progress': { 'x-audience': { resource: ['/sessions/{sessionId}/_tasks/{taskId}'] } },
  '_quota/changed': { 'x-audience': { resource: ['/_quota/{accountId}'] } },
  '_future/kind': { 'x-audience': { resource: ['/workspaces/{workspaceId}'] } },
  'elicitation/complete': { 'x-audience': { resource: ['/sessions/{sessionId}'], binding: 'resource' } }, // an ACP method
} }));

test('the first path whose fields are all present names the resource', () => {
  assert.deepEqual(resourceOf(table, 'elicitation/create', { requestId: 7, sessionId: 's1' }), { kind: 'requests', field: 'requestId', id: '7' });
  assert.deepEqual(resourceOf(table, 'elicitation/create', { sessionId: 's1' }), { kind: 'sessions', field: 'sessionId', id: 's1' });
  assert.ok(bindsToResource(table, 'session/request_permission'));
  assert.ok(!bindsToResource(table, 'elicitation/create'), 'binding "connection" is the default');
});

test('a path below a resource is held as it; a custom first segment is held as the Agent; any other is reserved', () => {
  assert.deepEqual(resourceOf(table, '_task/progress', { sessionId: 's1', taskId: 'k1' }), { kind: 'sessions', field: 'sessionId', id: 's1' });
  assert.deepEqual(resourceOf(table, '_quota/changed', { accountId: 'a1' }), { kind: 'root' });
  assert.equal(resourceOf(table, '_future/kind', { workspaceId: 'w1' }), null);
});

test("the Agent's audience for an ACP method is used; other methods keep the host's own", () => {
  assert.deepEqual(resourceOf(table, 'elicitation/complete', { sessionId: 's1', elicitationId: 'e1' }), { kind: 'sessions', field: 'sessionId', id: 's1' });
  assert.ok(bindsToResource(table, 'elicitation/complete'));
  assert.deepEqual(resourceOf(table, 'mcp/message', { serverId: 'm1' }), { kind: 'mcpServers', field: 'serverId', id: 'm1' });
});
