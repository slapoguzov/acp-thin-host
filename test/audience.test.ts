// x-audience: the resource of a message, from the table of the schema and the Agent's custom methods.

import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceFromSchema, bindsToResource, resourceOf, withCustomMethods } from '../src/audience.ts';
import { schema } from './fixture.ts';

const table = withCustomMethods(audienceFromSchema(schema), { methods: {
  '_task/progress': { 'x-audience': { resource: ['/sessions/{sessionId}/_tasks/{taskId}'] } },
  '_quota/changed': { 'x-audience': { resource: ['/_quota/{accountId}'] } },
  '_future/kind': { 'x-audience': { resource: ['/workspaces/{workspaceId}'] } },
} });

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
