// Test helpers: in-memory connections, a scripted ACP v2 Agent and a recording Client.

import { PassThrough } from 'node:stream';
import { Peer, type Message } from '../src/jsonrpc.ts';
import { ThinHost } from '../src/host.ts';

export const tick = () => new Promise(resolve => setTimeout(resolve, 5));
export const text = (t: string) => ({ type: 'text', text: t });

/** Sees every message on a connection, for the demo. */
export type Trace = (from: string, to: string, message: Message) => void;

/** Two Peers connected in memory. With `trace`, every message between them is reported. */
export function pair(names = ['', ''], trace?: Trace): [Peer, Peer] {
  const a = new PassThrough(), b = new PassThrough();
  const tap = (stream: PassThrough, from: string, to: string) =>
    stream.on('data', chunk => String(chunk).split('\n').filter(Boolean).forEach(line => trace!(from, to, JSON.parse(line))));
  if (trace) { tap(b, names[0], names[1]); tap(a, names[1], names[0]); }
  return [new Peer(a, b), new Peer(b, a)];
}

/** A scripted Agent. Tests drive it with `update`, `notify` and `ask`. A prompt runs until `endTurn`. */
export class FakeAgent {
  calls: Message[] = [];
  prompts: (number | string)[] = [];
  /** The `capabilities.schema` it returns when the Client asks for annotations. */
  annotations: any;
  peer: Peer;
  constructor(peer: Peer) {
    this.peer = peer;
    peer.onMessage = message => {
      this.calls.push(message);
      if (message.method === 'session/prompt') this.prompts.push(message.id!);
      else if (message.id !== undefined) peer.send({ id: message.id, result: this.result(message) });
    };
  }
  private result({ method, params }: Message) {
    if (method === 'initialize') return { protocolVersion: 2, info: { name: 'fake', version: '1' }, capabilities: { session: {}, ...(params.capabilities?.schema && this.annotations && { schema: this.annotations }) } };
    if (method === 'session/new') return { sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'small' }], availableCommands: [] };
    if (method === 'session/list') return { sessions: [{ sessionId: 's1', cwd: '/repo' }] };
    return {};
  }
  update(sessionId: string, update: any) { this.peer.send({ method: 'session/update', params: { sessionId, update } }); }
  notify(method: string, params: any) { this.peer.send({ method, params }); }
  ask(method: string, params: any) { return this.peer.request(method, params); }
  endTurn() { this.peer.send({ id: this.prompts.shift(), result: { stopReason: 'end_turn' } }); }
  count(method: string) { return this.calls.filter(m => m.method === method).length; }
}

/** A Client that records what it gets. */
export class Client {
  received: Message[] = [];
  initialized: any;
  peer: Peer;
  constructor(peer: Peer) {
    this.peer = peer;
    peer.onMessage = message => this.received.push(message);
  }
  async call(method: string, params: any) {
    const reply = await this.peer.request(method, params);
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  }
  updates() { return this.received.filter(m => m.method === 'session/update').map(m => m.params.update); }
  got(method: string) { return this.received.filter(m => m.method === method); }
}

/** A host over a FakeAgent. `client()` connects a Client and initializes it. */
export function setup({ agentAnnotations, trace }: { agentAnnotations?: any; trace?: Trace } = {}) {
  const [agentSide, hostSide] = pair(['agent', 'host'], trace);
  const agent = new FakeAgent(agentSide);
  agent.annotations = agentAnnotations;
  const host = new ThinHost(hostSide);
  const client = async (capabilities: any = {}, name = 'client') => {
    const [clientSide, hostSide] = pair([name, 'host'], trace);
    host.connect(hostSide);
    const c = new Client(clientSide);
    c.initialized = await c.call('initialize', { protocolVersion: 2, info: { name, version: '1' }, capabilities });
    return c;
  };
  return { host, agent, client };
}

/** Client A has session s1; Client B joined it. */
export async function twoClients(options = {}) {
  const env = setup(options);
  const a = await env.client();
  await a.call('session/new', { cwd: '/w', mcpServers: [] });
  const b = await env.client();
  await b.call('session/resume', { sessionId: 's1', cwd: '/w', mcpServers: [] });
  return { ...env, a, b };
}
