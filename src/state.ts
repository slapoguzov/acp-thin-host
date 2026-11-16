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
    const declared: Row[] = [].concat(declaration?.['x-state'] ?? []);
    // A custom row writes only a custom node: /sessions/{sessionId}/_name... Receivers ignore any other row.
    const custom = declared.length > 0 && declared.every(row => row.action === 'none' || /^\/sessions\/\{[\w.]+\}\/_/.test(row.path ?? ''));
    if (!(kind in rows.updates) && custom) updates[kind] = declared;
  }
  return { ...rows, updates };
}

/**
 * Splits a resolved row path into the node and the field inside it.
 * - An entity is the path up to and including its last ID segment after the session ID:
 *   "/sessions/s1/terminals/t1/output/data" is entity "/sessions/s1/terminals/t1" and field ["output", "data"].
 * - A current value is the name after the session: "/sessions/s1/info/title" is node "/sessions/s1/info", field ["title"].
 * - "/sessions/s1" alone is the whole session (the session/delete response removes it).
 */
function split(rowPath: string, resolved: string) {
  // Rows of different messages name one node with different fields: {sessionId} or {result.sessionId}, {update.toolCallId}
  // or {subject.toolCall.toolCallId}. The template keeps only the shape, {} for each field, so `render` finds the update
  // that sends a node whichever row made it.
  const segments = parsePath(rowPath), parts = resolved.split('/').slice(1);
  const template = '/' + segments.map(segment => ('name' in segment ? segment.name : '{}')).join('/');
  const sessionId = decodeURIComponent(parts[1]);
  const idAt = segments.findLastIndex((segment, index) => index >= 2 && 'field' in segment);
  const cut = segments.length === 2 ? 2 : idAt < 0 ? 3 : idAt + 1; // segments that name the node
  return {
    node: '/' + parts.slice(0, cut).join('/'),
    template: template.split('/').slice(0, cut + 1).join('/'),
    field: parts.slice(cut),
    history: idAt >= 0,
    wholeSession: segments.length === 2,
    sessionId,
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
    for (const row of rows) this.apply(row, params, payload);
  }

  /** Applies a response that has rows, at the position where it arrives. */
  applyResponse(method: string, requestParams: any, result: any) {
    for (const row of this.rows.responses[method] ?? []) this.apply(row, { ...requestParams, result }, result);
  }

  /** Applies an Agent-to-Client request that has rows, such as the tool call that a permission request carries. */
  applyRequest(method: string, params: any) {
    for (const row of this.rows.requests[method] ?? []) this.apply(row, params, params);
  }

  private apply(row: Row, message: any, payload: any) {
    if (row.action === 'none') return; // adds nothing to the state that a resume restores
    let resolved: string;
    try { resolved = resolvePath(row.path!, message); } catch { return; } // a field of the path is absent: not applied
    const at = split(row.path!, resolved);

    if (at.wholeSession) {
      if (row.action === 'remove') { this.sessions.delete(at.sessionId); this.raws.delete(at.sessionId); }
      return;
    }
    const nodes = this.nodes(at.sessionId);
    if (row.action === 'remove') { // the node and everything under it
      if (at.field.length) { const parent = getIn(nodes.get(at.node)?.value, at.field.slice(0, -1)); if (parent) delete parent[at.field.at(-1)!]; }
      else for (const key of [...nodes.keys()]) if (key === at.node || key.startsWith(at.node + '/')) nodes.delete(key);
      return;
    }

    let source = row.value ? lookup(message, row.value) : payload;
    if (row.action === 'replace' && row.value) source ??= []; // an absent or null list is []
    else if (source === undefined || source === null) return; // the value is absent: not applied

    const node = nodes.get(at.node) ?? { history: at.history, template: at.template, value: {} };
    nodes.set(at.node, node);
    if (row.action === 'replace') node.value = setIn(node.value, at.field, copy(source));
    if (row.action === 'upsert') node.value = setIn(node.value, at.field, upsert(getIn(node.value, at.field), source));
    if (row.action === 'append') {
      const previous = getIn(node.value, at.field);
      const next = row.encoding === 'base64' ? Buffer.concat([Buffer.from(previous ?? '', 'base64'), Buffer.from(String(source), 'base64')]).toString('base64')
        : typeof source === 'string' ? (previous ?? '') + source
        : [...(previous ?? []), copy(source)];
      node.value = setIn(node.value, at.field, next);
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

/** The value at `field` inside `object`; `[]` is the object itself. */
function getIn(object: any, field: string[]): any {
  return field.reduce((at, key) => (at == null ? undefined : at[key]), object);
}

/** `object` with `value` at `field`; an empty field replaces the whole object. */
function setIn(object: any, field: string[], value: any): any {
  if (!field.length) return value;
  const root = object && typeof object === 'object' && !Array.isArray(object) ? object : {};
  const parent = field.slice(0, -1).reduce((at, key) => (at[key] = at[key] && typeof at[key] === 'object' ? at[key] : {}), root);
  parent[field.at(-1)!] = value;
  return root;
}

function setField(object: any, field: string, value: unknown) {
  const keys = field.split('.');
  const parent = keys.slice(0, -1).reduce((at, key) => (at[key] ??= {}), object);
  parent[keys.at(-1)!] = value;
}

/**
 * Upsert: an omitted field is unchanged, a value replaces it, null clears it (a reader takes the default that the page of
 * the variant defines, such as pending for the status of a tool call); `_meta` is patched by key.
 */
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
