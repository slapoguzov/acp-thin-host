// x-scope: what an Agent-to-Client message is about (RFD, "The x-scope annotation").
//
//   "elicitation/create": ["/requests/{requestId}", "/sessions/{sessionId}/toolCalls/{toolCallId}", "/sessions/{sessionId}"]
//
// The scope is the first path whose fields are all present in the params. This file knows no method by name.

import { resolve } from './paths.ts';
import type { Annotations } from './annotations.ts';

/**
 * The thing a message is about, by its first two segments: `{ kind: "sessions", id: "s1" }`, or `{ kind: "" }` for
 * the Agent ("/"). A path below a session, such as one tool call, belongs to that session. `field` is the param
 * that holds the ID.
 */
export type Scope = { kind: string; id: string; field: string };

export function scopeOf(annotations: Annotations, method: string, params: any): Scope | null {
  for (const path of annotations.methods[method]?.['x-scope'] ?? []) {
    const segments = resolve(path, params);
    if (!segments) continue; // a field is absent: try the next, less specific path
    return { kind: segments[0] ?? '', id: decodeURIComponent(segments[1] ?? ''), field: path.split('/')[2]?.slice(1, -1) ?? '' };
  }
  return null;
}
