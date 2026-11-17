// The schema generator rule of the RFD ("Schema requirements"), run against the ACP v2 schema:
//   - every SessionUpdate variant has x-state, and every Agent-to-Client method has x-scope;
//   - every field that a path or a value names exists in the type of the message;
//   - an append rule has the encoding of its value (`contentEncoding` in the schema).
//
//   node check.ts      downloads schema.unstable.json at ACP_COMMIT once, into .cache/, and checks annotations.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { acpAnnotations as annotations, rulesOf, type Rule } from './src/annotations.ts';

const ACP_COMMIT = 'af7218e3831f8cdac98b22610d3b444c057c1232';
const url = `https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/${ACP_COMMIT}/schema/v2/schema.unstable.json`;
const file = new URL(`.cache/schema.unstable.${ACP_COMMIT.slice(0, 7)}.json`, import.meta.url);
if (!existsSync(file)) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot download ${url}: ${response.status}`);
  mkdirSync(new URL('.cache/', import.meta.url), { recursive: true });
  writeFileSync(file, await response.text());
}
const defs = JSON.parse(readFileSync(file, 'utf8')).$defs;
const problems: string[] = [];

/** The schema of a dotted field inside a type. Follows $ref, allOf, anyOf and oneOf, where ACP types keep their fields. */
function field(type: any, path: string[]): any {
  if (!path.length) return type;
  const branches = (node: any): any[] => !node || typeof node !== 'object' ? []
    : node.$ref ? branches(defs[node.$ref.split('/').pop()])
    : [node, ...['allOf', 'anyOf', 'oneOf'].flatMap(key => (node[key] ?? []).flatMap(branches))];
  for (const branch of branches(type)) {
    const found = branch.properties?.[path[0]] && field(branch.properties[path[0]], path.slice(1));
    if (found) return found;
  }
}

/** Checks the fields of a rule or a scope path. `types` maps the first name of a field (`update`, `result`) to a type. */
function check(where: string, rule: Rule, params: any, types: Record<string, any> = {}) {
  const names = [...(rule.path?.match(/\{[\w.]+\}/g) ?? []).map(f => f.slice(1, -1)), ...(rule.value ? [rule.value] : [])];
  for (const name of names) {
    const [first, ...rest] = name.split('.');
    if (!(types[first] ? field(types[first], rest) : field(params, [first, ...rest]))) problems.push(`${where}: no field ${name}`);
  }
  if (rule.action === 'append') {
    const [first, ...rest] = rule.value!.split('.');
    const encoding = field(types[first] ?? params, rest)?.contentEncoding;
    if (encoding !== rule.encoding) problems.push(`${where}: encoding should be ${encoding}`);
  }
}

const typeOf = (method: string, side: string, response = false) =>
  Object.entries<any>(defs).find(([name, def]) => def['x-method'] === method && def['x-side'] === side && name.endsWith('Response') === response)?.[1];

const variants = (defs.SessionUpdate.anyOf ?? defs.SessionUpdate.oneOf).filter((v: any) => v.properties?.sessionUpdate?.const);
for (const variant of variants) {
  const name = variant.properties.sessionUpdate.const, rules = rulesOf(annotations.sessionUpdates[name]);
  if (!rules.length) problems.push(`${name}: no x-state`);
  for (const rule of rules) check(name, rule, typeOf('session/update', 'client'), { update: variant });
}
for (const [method, entry] of Object.entries(annotations.methods)) {
  const toClient = typeOf(method, 'client'), toAgent = typeOf(method, 'agent');
  if (!toClient && !toAgent) { problems.push(`${method}: not an ACP method`); continue; }
  for (const rule of rulesOf(entry)) {
    if (toClient) check(`${method} request`, rule, toClient);
    else check(`${method} response`, rule, toAgent, { result: typeOf(method, 'agent', true) });
  }
}
for (const def of Object.values<any>(defs)) {
  const method = def['x-method'];
  if (def['x-side'] !== 'client' || !method || def === typeOf(method, 'client', true)) continue;
  const scope = annotations.methods[method]?.['x-scope'];
  if (!scope) problems.push(`${method}: no x-scope`);
  for (const path of scope ?? []) check(`${method} x-scope`, { action: 'none', path }, def);
}

if (problems.length) { console.error(`annotations.json does not fit ACP ${ACP_COMMIT.slice(0, 7)}:\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`annotations.json fits ACP ${ACP_COMMIT.slice(0, 7)}: ${variants.length} update variants, every Agent-to-Client method has x-scope`);
