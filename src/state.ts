// x-state: one generic function that keeps the state of each session, and the replay that a joining Client gets
// (RFD, "The x-state annotation"). This file knows no update variant and no method by name.

import { lookup, resolve } from './paths.ts';
import { rulesOf, type Annotations, type Rule } from './annotations.ts';

/** A stored entity (it has an ID, so it is history) or a current value. `shape` is its path with `{}` for the IDs. */
type Node = { shape: string; entity: boolean; value: any };

export class SessionStore {
  /** sessionId -> node path -> node. A Map keeps the order in which the nodes were first reported. */
  private sessions = new Map<string, Map<string, Node>>();

  annotations: Annotations;

  constructor(annotations: Annotations) { this.annotations = annotations; }

  /** A `session/update`. A variant without a rule is not stored: it is live only. */
  applyUpdate(params: { sessionId: string; update: any }) {
    const { sessionUpdate, ...payload } = params.update;
    for (const rule of rulesOf(this.annotations.sessionUpdates[sessionUpdate])) this.apply(rule, params, payload);
  }

  /** A response, at the position where it arrives. Rules read `{result.<field>}` and the params of the request. */
  applyResponse(method: string, params: any, result: any) {
    for (const rule of rulesOf(this.annotations.methods[method])) this.apply(rule, { ...params, result }, result);
  }

  /** An Agent-to-Client request, such as a permission request that reports its tool call. */
  applyRequest(method: string, params: any) {
    for (const rule of rulesOf(this.annotations.methods[method])) this.apply(rule, params, params);
  }

  private apply(rule: Rule, message: any, payload: any) {
    if (rule.action === 'none') return;
    const at = locate(rule.path!, message);
    if (!at) return; // a field of the path is absent: the rule is not applied
    if (!at.node) { if (rule.action === 'remove') this.sessions.delete(at.sessionId); return; } // the whole session

    const nodes = this.nodes(at.sessionId);
    const value = structuredClone(rule.value ? lookup(message, rule.value) : payload);
    if (rule.action === 'remove' || (rule.action === 'replace' && value == null)) { // remove it, or clear it
      if (at.field.length) delete getIn(nodes.get(at.node)?.value, at.field.slice(0, -1))?.[at.field.at(-1)!];
      else nodes.delete(at.node);
      return;
    }
    if (value == null) return; // upsert and append need a value

    const node = nodes.get(at.node) ?? { shape: at.shape, entity: at.entity, value: {} };
    nodes.set(at.node, node);
    const old = getIn(node.value, at.field);
    const next = rule.action === 'replace' ? value : rule.action === 'upsert' ? upsert(old, value) : append(old, value, rule.encoding);
    node.value = setIn(node.value, at.field, next);
  }

  /** The session as `session/update` payloads: entities in the order of first report, then current values. */
  replay(sessionId: string): { history: any[]; current: any[] } {
    const history = [], current = [];
    for (const [path, node] of this.nodes(sessionId)) {
      const update = this.render(path, node);
      if (update) (node.entity ? history : current).push(update);
    }
    return { history, current };
  }

  /** The current value at `/sessions/{sessionId}/<name>`, such as `config`. */
  current(sessionId: string, name: string): any {
    return this.nodes(sessionId).get(`/sessions/${encodeURIComponent(sessionId)}/${name}`)?.value;
  }

  forget(sessionId: string) { this.sessions.delete(sessionId); }

  private nodes(sessionId: string) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    return this.sessions.get(sessionId)!;
  }

  /**
   * A node as one update: the variant whose upsert or replace rule writes this whole node. Three
   * `agent_message_chunk` updates become one `agent_message`. The IDs come back from the node path.
   */
  private render(path: string, node: Node): any {
    for (const [variant, entry] of Object.entries(this.annotations.sessionUpdates)) {
      for (const rule of rulesOf(entry)) {
        if (rule.action !== 'upsert' && rule.action !== 'replace') continue;
        const parts = rule.path!.split('/').slice(1);
        if (shapeOf(parts) !== node.shape || parts.length !== node.shape.split('/').length) continue;
        const message = setIn({ update: {} }, (rule.value ?? 'update').split('.'), structuredClone(node.value));
        const ids = path.split('/').slice(1);
        parts.forEach((part, i) => {
          const field = part.slice(1, -1);
          if (i >= 2 && part.startsWith('{') && lookup(message, field) === undefined) setIn(message, field.split('.'), decodeURIComponent(ids[i]));
        });
        return { sessionUpdate: variant, ...message.update };
      }
    }
    return null;
  }
}

/** `["sessions", "{sessionId}", "toolCalls", "{update.toolCallId}"]` -> `"sessions/{}/toolCalls/{}"`. */
const shapeOf = (parts: string[]) => parts.map(part => (part.startsWith('{') ? '{}' : part)).join('/');

/**
 * Where a rule writes:
 *   /sessions/s1/terminals/t1/output/data -> node /sessions/s1/terminals/t1 (an entity: it ends with an ID), field output.data
 *   /sessions/s1/info/title               -> node /sessions/s1/info (a current value), field title
 *   /sessions/s1                          -> the whole session (node null)
 * Paths outside /sessions, such as a custom /_name, are not stored here.
 */
function locate(path: string, message: any) {
  const segments = resolve(path, message), parts = path.split('/').slice(1);
  if (!segments || segments[0] !== 'sessions' || segments.length < 2) return null;
  const lastId = parts.findLastIndex((part, i) => i >= 2 && part.startsWith('{'));
  const end = lastId >= 0 ? lastId + 1 : 3;
  return {
    sessionId: decodeURIComponent(segments[1]),
    node: segments.length > 2 ? '/' + segments.slice(0, end).join('/') : null,
    shape: shapeOf(parts.slice(0, end)),
    entity: lastId >= 0,
    field: segments.slice(end).map(decodeURIComponent),
  };
}

/** The three-state patch of v2: an omitted field is unchanged, a value replaces it, null clears it. `_meta` is patched by key. */
function upsert(old: any = {}, patch: any) {
  const next = { ...old };
  for (const [key, value] of Object.entries<any>(patch)) {
    if (value === null) delete next[key];
    else if (key === '_meta') next._meta = upsert(old._meta, value);
    else next[key] = value;
  }
  return next;
}

/** A string chunk is added to the string, any other chunk is one more item of the list, base64 chunks join as bytes. */
function append(old: any, chunk: any, encoding?: string) {
  if (encoding === 'base64') return Buffer.concat([Buffer.from(old ?? '', 'base64'), Buffer.from(chunk, 'base64')]).toString('base64');
  return typeof chunk === 'string' ? (old ?? '') + chunk : [...(old ?? []), chunk];
}

function getIn(object: any, field: string[]) {
  return field.reduce((at, key) => at?.[key], object);
}

/** `object` with `value` at `field`; an empty field replaces the whole object. */
function setIn(object: any, field: string[], value: any): any {
  if (!field.length) return value;
  const root = object && typeof object === 'object' ? object : {};
  const parent = field.slice(0, -1).reduce((at, key) => (at[key] = at[key] && typeof at[key] === 'object' ? at[key] : {}), root);
  parent[field.at(-1)!] = value;
  return root;
}
