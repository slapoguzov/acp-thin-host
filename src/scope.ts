// Scope of Agent-to-Client methods from x-scope (RFD "Session state rules", section "Scope").
//
//   "elicitation/create": ["/requests/{requestId}", "/sessions/{sessionId}/toolCalls/{toolCallId}", "/sessions/{sessionId}"]
//
// The first path whose fields are all present in the params names the resource. Its first segment selects the kind;
// a path may continue below it and is held as that resource. A custom first segment (_name) is held as "/".
// This file knows no method by name: the scopes come from the same table as the rows, the host's own entries
// with the Agent's `capabilities.schema.methods` over them (schema/rows.ts).

import { lookup, parsePath } from './paths.ts';
import type { Scope, SchemaTable } from '../schema/rows.ts';

export type { Scope };
/** A resolved resource: the Agent ("/"), or a kind with an ID, such as { kind: "sessions", id: "s1" }. */
export type Resource = { kind: 'root' } | { kind: string; field: string; id: string };

/** The resource kinds of the RFD table. Any other first segment that does not start with _ is reserved for ACP. */
const KINDS = new Set(['sessions', 'requests', 'mcpServers', 'elicitations']);

/** The resource a message belongs to, or null when the method has no declared resource. */
export function resourceOf(table: SchemaTable, method: string, params: any): Resource | null {
  for (const path of table.methods[method]?.['x-scope'] ?? []) {
    const segments = parsePath(path);
    if (segments.some(s => 'field' in s && lookup(params, s.field) == null)) continue; // a field is absent: next path
    const [kind, id] = segments;
    if (!kind) return { kind: 'root' };
    if (!('name' in kind)) continue;
    if (kind.name.startsWith('_')) return { kind: 'root' }; // a custom resource of the Agent is held as /
    if (!KINDS.has(kind.name) || !id || !('field' in id)) continue; // reserved: no declared resource
    const value = lookup(params, id.field);
    if (typeof value === 'string' || typeof value === 'number') return { kind: kind.name, field: id.field, id: String(value) };
  }
  return null;
}
