// Test helpers: in-memory connections and a scripted ACP v2 Agent.

import { PassThrough } from 'node:stream';
import { Peer, type Message } from '../src/jsonrpc.ts';
import { ThinHost } from '../src/host.ts';

import { annotatedSchema } from '../schema/annotate.ts';

/** The ACP schema with the rows of x-rows.json; the first run downloads it. */
export const schema = await annotatedSchema();

/** Two Peers connected to each other in memory. */
export function pair(): [Peer, Peer] {
  const a = new PassThrough(), b = new PassThrough();
  return [new Peer(a, b), new Peer(b, a)];
}

export const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** A Client that records everything it receives. `answers` maps an Agent-to-Client method to its result. */
export class Client {
  peer: Peer;
  received: Message[] = [];
  initialized: any;
  answers = new Map<string, (params: any) => any>();
  constructor(peer: Peer) {
    this.peer = peer;
    peer.onMessage = message => {
      this.received.push(message);
      const answer = message.id !== undefined && message.method ? this.answers.get(message.method) : undefined;
      if (answer) peer.send({ id: message.id, result: answer(message.params) });
    };
  }
  async call(method: string, params: any) {
    const reply = await this.peer.request(method, params);
    if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
    return reply.result;
  }
  updates(sessionId: string) { return this.received.filter(m => m.method === 'session/update' && m.params.sessionId === sessionId).map(m => m.params.update); }
  got(method: string) { return this.received.filter(m => m.method === method); }
}

/** A scripted Agent: tests drive it with `notify` and `ask`; it records the requests it gets. */
export class FakeAgent {
  peer: Peer;
  calls: Message[] = [];
  /** The capabilities.schema this Agent returns in initialize when the Client asks for it. */
  agentSchema: any;
  prompts: (number | string)[] = [];
  private sessions = 0;
  constructor(peer: Peer) {
    this.peer = peer;
    peer.onMessage = message => {
      if (message.method === undefined) return;
      this.calls.push(message);
      if (message.method === 'session/prompt') this.prompts.push(message.id!); // a turn runs until `endTurn`
      else if (message.id !== undefined) peer.send({ id: message.id, result: this.result(message) });
    };
  }
  private result(message: Message) {
    switch (message.method) {
      case 'initialize': return { protocolVersion: 2, info: { name: 'fake', version: '1' }, capabilities: { session: {}, ...(this.agentSchema && message.params?.capabilities?.schema ? { schema: this.agentSchema } : {}) } };
      case 'session/new': return { sessionId: `s${++this.sessions}`, configOptions: [{ id: 'model', currentValue: 'small' }], availableCommands: [] };
      default: return {};
    }
  }
  endTurn() { this.peer.send({ id: this.prompts.shift(), result: { stopReason: 'end_turn' } }); }
  update(sessionId: string, update: any) { this.peer.send({ method: 'session/update', params: { sessionId, update } }); }
  notify(method: string, params: any) { this.peer.send({ method, params }); }
  ask(method: string, params: any) { return this.peer.request(method, params); }
  count(method: string) { return this.calls.filter(m => m.method === method).length; }
}

/** A host over a FakeAgent, and a way to connect Clients to it. */
export function hostWith(options: { hostAgentSchema?: any; agentSchema?: any } = {}) {
  const [agentSide, hostSide] = pair();
  const agent = new FakeAgent(agentSide);
  agent.agentSchema = options.agentSchema;
  const logs: string[] = [];
  const host = new ThinHost(hostSide, { schema, agentSchema: options.hostAgentSchema, log: line => logs.push(line) });
  /** A Client after initialize; `capabilities` are its own, such as { schema: {} } to ask for the rows. */
  const client = async (capabilities: any = {}) => {
    const [clientSide, serverSide] = pair();
    host.connect(serverSide);
    const c = new Client(clientSide);
    c.initialized = await c.call('initialize', { protocolVersion: 2, info: { name: 'test', version: '1' }, capabilities });
    return c;
  };
  return { host, agent, client, logs };
}
