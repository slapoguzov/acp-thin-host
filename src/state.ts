// Session state from x-state rows (RFD "Session state rules").
//
// This file knows no update variant and no method by name. Every rule comes from rows:
//   - schema rows on each SessionUpdate variant and on five responses (`rowsFromSchema` in schema/rows.ts);
//   - custom rows that the Agent declares in initialize `capabilities.schema.sessionUpdates`.
// A variant without a row is kept raw, in order, as history (host rule, "Thin ACP host: behavior").

import { lookup, parsePath, resolvePath } from './paths.ts';
import type { Row, StateRows } from '../schema/rows.ts';

export type { Row, StateRows };

/** One stored node. `template` is the entity part of the row path, so the node can be sent again as an update. */
type Node = { history: boolean; template: string | null; value: any };

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** Adds the Agent's custom rows from initialize. A row for an ACP-defined variant is ignored (RFD rule). */
export function withAgentRows(rows: StateRows, agentSchema: any): StateRows {
  const updates = { ...rows.updates };
  for (const [kind, declaration] of Object.entries<any>(agentSchema?.sessionUpdates ?? {})) {
    if (!(kind in rows.updates) && declaration?.['x-state']) updates[kind] = [].concat(declaration['x-state']);
  }
  return { ...rows, updates };
}

/**
 * Splits a resolved row path into the entity and the field inside it.
 * The entity is the path up to and including its last ID segment after the session ID;
 * "/sessions/s1/terminals/t1/output/data" -> entity "/sessions/s1/terminals/t1", field ["output", "data"].
 * A path without such an ID segment ("/sessions/s1/config") is a current value; it is its own entity.
 */
function split(rowPath: string, resolved: string) {
  // The session segment is written {sessionId} or {result.sessionId}; one spelling lets a response row and an update
  // row name the same node, so `render` finds the update that sends it.
  const template = rowPath.replace(/^\/sessions\/\{[\w.]+\}/, '/sessions/{sessionId}');
  const segments = parsePath(template);
  const idAt = segments.findLastIndex((segment, index) => index >= 2 && 'field' in segment);
  const parts = resolved.split('/').slice(1);
  if (idAt < 0) return { entity: resolved, template, field: [] as string[], history: false, sessionId: decodeURIComponent(parts[1]) };
  const cut = idAt + 1;
  return {
    entity: '/' + parts.slice(0, cut).join('/'),
    template: template.split('/').slice(0, cut + 1).join('/'),
    field: parts.slice(cut),
    history: true,
    sessionId: decodeURIComponent(parts[1]),
  };
}

export class SessionStore {
  rows: StateRows;
  /** sessionId -> entity path -> node. A Map keeps the order of first report, across all kinds. */
  sessions = new Map<string, Map<string, Node>>();
  /** Raw nodes per session, for their keys. Not the node count: a `remove` makes that shrink. */
  private raws = new Map<string, number>();

  constructor(rows: StateRows) { this.rows = rows; }

  nodes(sessionId: string): Map<string, Node> {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    return this.sessions.get(sessionId)!;
  }

  /** Applies one `session/update` notification. */
  applyUpdate(params: { sessionId: string; update: any }) {
    const kind = params.update?.sessionUpdate, rows = this.rows.updates[kind];
    if (!rows) { // no row: keep it raw, as history
      const count = this.raws.get(params.sessionId) ?? 0;
      this.raws.set(params.sessionId, count + 1);
      this.nodes(params.sessionId).set(`raw:${count}`, { history: true, template: null, value: copy(params.update) });
      return;
    }
    const { sessionUpdate, ...payload } = params.update;
    for (const row of rows) this.apply(row, params, payload, this.rows.encodings[`${kind} ${row.value}`]);
  }

  /** Applies a response that has rows, at the position where it arrives. */
  applyResponse(method: string, requestParams: any, result: any) {
    for (const row of this.rows.responses[method] ?? []) this.apply(row, { ...requestParams, result }, result);
  }

  private apply(row: Row, message: any, payload: any, encoding?: string) {
    if (row.action === 'none') return; // live only
    const at = split(row.path!, resolvePath(row.path!, message));
    const nodes = this.nodes(at.sessionId);
    if (row.action === 'remove') { nodes.delete(at.entity); return; }

    const node = nodes.get(at.entity) ?? { history: at.history, template: at.template, value: {} };
    nodes.set(at.entity, node);
    const source = row.value ? lookup(message, row.value) : payload;

    if (row.action === 'replace') node.value = copy(source ?? (row.value ? [] : {}));
    if (row.action === 'upsert') node.value = upsert(node.value, source);
    if (row.action === 'append') {
      const parent = at.field.slice(0, -1).reduce((object, key) => (object[key] ??= {}), node.value);
      const key = at.field.at(-1)!, previous = parent[key];
      if (encoding === 'base64') parent[key] = Buffer.concat([Buffer.from(previous ?? '', 'base64'), Buffer.from(String(source), 'base64')]).toString('base64');
      else if (typeof source === 'string') parent[key] = (previous ?? '') + source;
      else parent[key] = [...(previous ?? []), copy(source)];
    }
  }

  /**
   * The session as `session/update` payloads: history in report order, then current values.
   * A node is sent with the upsert or replace row that has the same entity path; raw nodes are sent as they came.
   */
  replay(sessionId: string): { history: any[]; current: any[] } {
    const out = { history: [] as any[], current: [] as any[] };
    for (const [entity, node] of this.nodes(sessionId)) {
      const update = node.template === null ? copy(node.value) : this.render(entity, node);
      if (update) (node.history ? out.history : out.current).push(update);
    }
    return out;
  }

  /** The current value of a node, for example `current("s1", "config")`. */
  current(sessionId: string, name: string): any {
    return copy(this.nodes(sessionId).get(`/sessions/${encodeURIComponent(sessionId)}/${name}`)?.value);
  }

  private render(entity: string, node: Node): any {
    for (const [kind, rows] of Object.entries(this.rows.updates)) {
      for (const row of rows) {
        if ((row.action !== 'upsert' && row.action !== 'replace') || split(row.path!, entity).template !== node.template) continue;
        const message: any = { update: {} };
        setField(message, row.value ?? 'update', copy(node.value));
        // Put back the IDs that the path holds, such as messageId, when the value does not carry them.
        const values = entity.split('/').slice(1);
        parsePath(row.path).forEach((segment, index) => {
          if (index > 1 && 'field' in segment && lookup(message, segment.field) === undefined) setField(message, segment.field, decodeURIComponent(values[index]));
        });
        return { sessionUpdate: kind, ...message.update };
      }
    }
    return null; // a node that only an append row creates: nothing to send it with
  }
}

function setField(object: any, field: string, value: unknown) {
  const keys = field.split('.');
  const parent = keys.slice(0, -1).reduce((at, key) => (at[key] ??= {}), object);
  parent[keys.at(-1)!] = value;
}

/** Upsert: an omitted field is unchanged, null clears it, a value replaces it; `_meta` is patched by key. */
function upsert(current: any, patch: any) {
  const next = { ...current };
  for (const [key, value] of Object.entries<any>(patch ?? {})) {
    if (value === undefined) continue;
    if (key === '_meta' && value && typeof value === 'object') {
      next._meta = { ...next._meta };
      for (const [metaKey, metaValue] of Object.entries(value)) {
        if (metaValue === null) delete next._meta[metaKey]; else next._meta[metaKey] = copy(metaValue);
      }
    } else if (value === null) delete next[key];
    else next[key] = copy(value);
  }
  return next;
}
