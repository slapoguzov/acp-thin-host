// Audience of Agent-to-Client methods from x-audience (RFD "Audience of Agent-to-Client methods").
//
//   "session/request_permission": { "resource": ["/sessions/{sessionId}"], "answer": "any" }
//
// The first path whose fields are all present in the params names the resource.
// This file knows no method by name: the table comes from the schema and from initialize `capabilities.schema.methods`.

import { lookup, parsePath } from './paths.ts';

export type Audience = { resource: string[]; answer?: 'any' | 'one' };
/** A resolved resource: the Agent ("/"), or a kind with an ID, such as { kind: "sessions", id: "s1" }. */
export type Resource = { kind: 'root' } | { kind: string; field: string; id: string };

export type AudienceTable = Map<string, Audience>;

/** Reads x-audience from every Agent-to-Client request or notification type of the schema. */
export function audienceFromSchema(schema: any): AudienceTable {
  const table: AudienceTable = new Map();
  for (const [name, def] of Object.entries<any>(schema.$defs)) {
    if (def['x-side'] === 'client' && def['x-method'] && def['x-audience'] && !name.endsWith('Response')) table.set(def['x-method'], def['x-audience']);
  }
  return table;
}

/** Adds the Agent's custom methods. An entry for a method the schema already has is ignored (RFD rule). */
export function withCustomMethods(table: AudienceTable, agentSchema: any): AudienceTable {
  const out = new Map(table);
  for (const [method, declaration] of Object.entries<any>(agentSchema?.methods ?? {})) {
    if (!table.has(method) && Array.isArray(declaration?.['x-audience']?.resource)) out.set(method, declaration['x-audience']);
  }
  return out;
}

/** The resource a message belongs to, or null when the method has no declared audience. */
export function resourceOf(table: AudienceTable, method: string, params: any): Resource | null {
  const audience = table.get(method);
  for (const path of audience?.resource ?? []) {
    const segments = parsePath(path);
    if (segments.length === 0) return { kind: 'root' };
    const [kind, id] = segments;
    if (!('name' in kind) || !id || !('field' in id)) continue;
    const value = lookup(params, id.field);
    if (typeof value === 'string' || typeof value === 'number') return { kind: kind.name, field: id.field, id: String(value) };
  }
  return null;
}

export const anyMayAnswer = (table: AudienceTable, method: string) => table.get(method)?.answer === 'any';
