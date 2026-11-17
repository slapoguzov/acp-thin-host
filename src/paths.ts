// The path grammar shared by x-state and x-scope (RFD, "Paths").
//
//   resolve("/sessions/{sessionId}/toolCalls/{update.toolCallId}", { sessionId: "s1", update: { toolCallId: "a/b" } })
//     -> ["sessions", "s1", "toolCalls", "a%2Fb"]
//
// A {field} is read from the message. Its value must be a string or a number and becomes exactly one segment,
// so an ID that contains "/" cannot name something else.

/** `lookup({ update: { toolCallId: "t1" } }, "update.toolCallId")` is "t1". */
export function lookup(message: any, field: string): any {
  return field.split('.').reduce((value, key) => value?.[key], message);
}

/** The segments of a path with its fields read from the message, or null when a field is absent. */
export function resolve(path: string, message: any): string[] | null {
  const segments: string[] = [];
  for (const part of path.split('/').slice(1).filter(Boolean)) {
    if (!part.startsWith('{')) { segments.push(part); continue; }
    const value = lookup(message, part.slice(1, -1));
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    segments.push(encodeURIComponent(String(value)));
  }
  return segments;
}
