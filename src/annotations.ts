// The annotations table in the shape of `capabilities.schema` (RFD, "Annotations in initialize"):
//
//   { "sessionUpdates": { "<variant>": { "x-state": rule | [rules] } },
//     "methods":        { "<method>":  { "x-state"?: rule | [rules], "x-scope"?: [paths] } } }

import { readFileSync } from 'node:fs';

export type Rule = { action: 'upsert' | 'replace' | 'append' | 'remove' | 'none'; path?: string; value?: string; encoding?: 'base64' };
export type Entry = { 'x-state'?: Rule | Rule[]; 'x-scope'?: string[] };
export type Annotations = { sessionUpdates: Record<string, Entry>; methods: Record<string, Entry> };

/** The annotations of every ACP v2 message, as the schema generator would emit them. `check.ts` checks them. */
export const acpAnnotations: Annotations = JSON.parse(readFileSync(new URL('../annotations.json', import.meta.url), 'utf8'));

export const rulesOf = (entry?: Entry): Rule[] => [entry?.['x-state'] ?? []].flat();

/**
 * Our annotations with the Agent's `capabilities.schema` over them: for each message, the Agent's annotation wins.
 * Only `x-state` and `x-scope` are read. A custom rule may write only a `_` name below /sessions/{sessionId}/ or
 * directly below /, so a custom update cannot change ACP-defined state.
 */
export function withAgentAnnotations(ours: Annotations, agent: Partial<Annotations> = {}): Annotations {
  const allowed = (name: string, rule: Rule) =>
    !name.startsWith('_') || rule.action === 'none' || /^\/(sessions\/\{[^}]+\}\/)?_/.test(rule.path ?? '');
  const merge = (base: Record<string, Entry>, over: Record<string, Entry> = {}) => {
    const out = { ...base };
    for (const [name, entry] of Object.entries(over)) {
      const rules = rulesOf(entry).filter(rule => allowed(name, rule));
      out[name] = { ...base[name] };
      if (rules.length) out[name]['x-state'] = rules;
      if (Array.isArray(entry['x-scope'])) out[name]['x-scope'] = entry['x-scope'];
    }
    return out;
  };
  return { sessionUpdates: merge(ours.sessionUpdates, agent.sessionUpdates), methods: merge(ours.methods, agent.methods) };
}
