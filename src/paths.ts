// One path grammar for x-state and x-scope (RFD "Session state rules", section "Paths").
//
//   path    = "/" | ("/" segment)+
//   segment = name | "{" field "}"         name = [A-Za-z0-9_]+    field = name ("." name)*
//
// A {field} is looked up in the message: the params of a notification or request, and for a response
// also `result`. Its value becomes exactly one segment, so an ID that contains "/" cannot reach another node.

export type Segment = { name: string } | { field: string };

const SEGMENT = /^(?:([A-Za-z0-9_]+)|\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\})$/;

export function parsePath(path: string): Segment[] {
  if (!path.startsWith('/')) throw new Error(`not an absolute path: ${path}`);
  if (path === '/') return [];
  return path.slice(1).split('/').map(text => {
    const match = SEGMENT.exec(text);
    if (!match) throw new Error(`bad segment "${text}" in ${path}`);
    return match[1] ? { name: match[1] } : { field: match[2] };
  });
}

/** `lookup({ update: { toolCallId: "t1" } }, "update.toolCallId")` is "t1". */
export function lookup(message: unknown, field: string): unknown {
  return field.split('.').reduce<any>((value, key) => (value == null ? undefined : value[key]), message);
}

/** Turns a template into a concrete path: "/sessions/{sessionId}" -> "/sessions/s1". */
export function resolvePath(path: string, message: unknown): string {
  const parts = parsePath(path).map(segment => {
    if ('name' in segment) return segment.name;
    const value = lookup(message, segment.field);
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`path field ${segment.field} is missing`);
    return encodeURIComponent(String(value));
  });
  return '/' + parts.join('/');
}
