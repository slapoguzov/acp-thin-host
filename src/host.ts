// A thin ACP host: one Agent process, several Clients that share its sessions.
//
// The host has code for the session lifecycle only. Everything about update variants and Agent-to-Client methods
// comes from the annotations: ours (annotations.json) with the Agent's `capabilities.schema` over them.
//   x-state -> SessionStore keeps each session, and answers session/resume for a Client that joins a live session.
//   x-scope -> scopeOf says what a message is about, and the host sends it to the Clients that hold that thing.
// Who may answer a request is host policy. Here one user is behind all Clients, so every Client that holds the
// scope sees the request and the first answer wins.

import { Peer, type Message } from './jsonrpc.ts';
import { SessionStore } from './state.ts';
import { scopeOf, type Scope } from './scope.ts';
import { acpAnnotations, withAgentAnnotations, type Annotations } from './annotations.ts';

/** An Agent-to-Client request while it waits: the ID that each Client got, and the Clients that answered with an error. */
type Pending = { method: string; params: any; shownTo: Map<Peer, number>; failed: Set<Peer> };

export class ThinHost {
  annotations: Annotations = acpAnnotations;
  store = new SessionStore(this.annotations);
  private initialized?: Promise<Message>;
  private clients = new Set<Peer>();
  /** sessionId -> Clients where the session is active. The /sessions scope. */
  private sessions = new Map<string, Set<Peer>>();
  /** Our ID of a Client request in flight -> the Client and its own ID. The /requests scope. */
  private requests = new Map<number, { client: Peer; id: number | string }>();
  /** elicitationId -> Clients that got its elicitation/create. The /elicitations scope. */
  private elicitations = new Map<string, Set<Peer>>();
  /** The Agent's request ID -> the request. */
  private pending = new Map<number | string, Pending>();
  private nextId = 1;

  private agent: Peer;
  private log: (line: string) => void;

  constructor(agent: Peer, log: (line: string) => void = () => {}) {
    this.agent = agent;
    this.log = log;
    agent.onMessage = message => this.fromAgent(message);
  }

  connect(client: Peer) {
    this.clients.add(client);
    client.onMessage = message => this.fromClient(client, message);
    client.onClose = () => this.disconnect(client);
  }

  // ------------------------------------------------------------------ Client -> Agent

  private async fromClient(client: Peer, message: Message) {
    if (message.method === undefined) return this.answer(client, message);
    if (message.method === '$/cancel_request') { // the Client names its own ID; the Agent knows ours
      const ours = [...this.requests].find(([, r]) => r.client === client && r.id === message.params.requestId)?.[0];
      if (ours !== undefined) this.agent.send({ method: message.method, params: { requestId: ours } });
      return;
    }
    if (message.id === undefined) return this.agent.send(message); // session/cancel and other notifications
    const reply = await this.request(client, message.method, message.params, message.id)
      .catch((error): Message => ({ error: { code: -32603, message: String(error) } }));
    client.send({ id: message.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) });
  }

  private async request(client: Peer, method: string, params: any, clientId: number | string): Promise<Message> {
    const sessionId: string | undefined = params?.sessionId;
    const holders = sessionId ? this.holders(sessionId) : new Set<Peer>();

    if (method === 'initialize') return this.initialize(params);
    if (method === 'session/resume' && holders.size > 0) return this.join(client, sessionId!, params);
    if (method === 'session/close' && [...holders].some(other => other !== client)) { holders.delete(client); return { result: {} }; }
    if (method === 'session/resume') {
      if (params.replayFrom) this.store.forget(sessionId!); // the Agent sends the whole history again
      holders.add(client); // the replay goes to this Client
    }

    let ours = 0;
    const reply = await this.agent.request(method, params, id => { ours = id; this.requests.set(id, { client, id: clientId }); });
    this.requests.delete(ours);
    if (reply.error) { if (method === 'session/resume') holders.delete(client); return reply; }

    this.store.applyResponse(method, params, reply.result); // x-state of a response, such as the options of session/new
    const created = method === 'session/new' || method === 'session/fork' ? reply.result.sessionId : undefined;
    if (created) this.holders(created).add(client);
    if (method === 'session/close') holders.delete(client);
    if (created || method === 'session/resume') this.showPending(client, created ?? sessionId);
    return reply;
  }

  /**
   * The first initialize goes to the Agent and asks for its annotations (`capabilities.schema: {}`). A Client that
   * asks for annotations gets the ones the host uses: ours with the Agent's over them.
   */
  private async initialize(params: any): Promise<Message> {
    this.initialized ??= this.agent.request('initialize', { ...params, protocolVersion: 2, capabilities: { ...params.capabilities, schema: {} } });
    const reply = await this.initialized;
    if (reply.error) { this.initialized = undefined; return reply; }
    const { schema: fromAgent, ...capabilities } = reply.result.capabilities ?? {};
    this.annotations = this.store.annotations = withAgentAnnotations(acpAnnotations, fromAgent);
    if (params.capabilities?.schema) capabilities.schema = this.annotations;
    return { result: { ...reply.result, capabilities } };
  }

  /** session/resume of a session that is live on another Client, answered from the store. The Agent is not asked. */
  private join(client: Peer, sessionId: string, params: any): Message {
    const { history, current } = this.store.replay(sessionId);
    const send = (update: any) => client.send({ method: 'session/update', params: { sessionId, update } });
    if (params.replayFrom) history.forEach(send);
    send({ sessionUpdate: 'replay_complete' });
    current.filter(update => update.sessionUpdate !== 'state_update').forEach(send);
    current.filter(update => update.sessionUpdate === 'state_update').forEach(send);
    this.holders(sessionId).add(client);
    this.showPending(client, sessionId);
    this.log(`a Client joined ${sessionId}: ${params.replayFrom ? history.length : 0} history updates from the store`);
    return { result: { configOptions: this.store.current(sessionId, 'config') ?? [], availableCommands: this.store.current(sessionId, 'commands') ?? [] } };
  }

  // ------------------------------------------------------------------ Agent -> Clients

  private fromAgent({ id, method, params }: Message) {
    if (method === undefined) return;
    if (method === '$/cancel_request') return this.close(params.requestId);
    if (method === 'session/update') this.store.applyUpdate(params);
    else if (id !== undefined) this.store.applyRequest(method, params); // a permission request reports its tool call

    const scope = scopeOf(this.annotations, method, params);
    if (!scope) this.log(`${method} has no x-scope: not delivered`);
    const to = scope ? this.holdersOf(scope) : [];

    if (id === undefined) { for (const client of to) client.send({ method, params: this.paramsFor(client, scope!, params) }); return; }
    if (!to.length) return this.agent.send({ id, error: { code: -32603, message: `no Client holds the scope of ${method}` } });
    const request: Pending = { method, params, shownTo: new Map(), failed: new Set() };
    this.pending.set(id, request);
    for (const client of to) this.show(request, client, scope!);
  }

  private show(request: Pending, client: Peer, scope: Scope) {
    const id = this.nextId++;
    request.shownTo.set(client, id);
    const elicitationId = request.params?.elicitationId; // a later elicitation/complete goes to the same Clients
    if (typeof elicitationId === 'string') this.elicitations.set(elicitationId, (this.elicitations.get(elicitationId) ?? new Set()).add(client));
    client.send({ id, method: request.method, params: this.paramsFor(client, scope, request.params) });
  }

  /** A Client answers. The first answer wins; an error wins only when every Client that saw the request failed. */
  private answer(client: Peer, message: Message) {
    const [agentId, request] = [...this.pending].find(([, r]) => r.shownTo.get(client) === message.id) ?? [];
    if (!request) return; // another Client answered first
    if (message.error) { request.failed.add(client); if (request.failed.size < request.shownTo.size) return; }
    this.agent.send({ id: agentId, ...(message.error ? { error: message.error } : { result: message.result }) });
    this.close(agentId!, client);
  }

  /** The request is over. The other Clients that saw it get `$/cancel_request`. */
  private close(agentId: number | string, except?: Peer) {
    const request = this.pending.get(agentId);
    this.pending.delete(agentId);
    for (const [client, id] of request?.shownTo ?? []) if (client !== except) client.send({ method: '$/cancel_request', params: { requestId: id } });
  }

  /** A Client that joins a session also sees the requests that wait in it. */
  private showPending(client: Peer, sessionId: string) {
    for (const request of this.pending.values()) {
      const scope = scopeOf(this.annotations, request.method, request.params);
      if (scope?.kind === 'sessions' && scope.id === sessionId && !request.shownTo.has(client)) this.show(request, client, scope);
    }
  }

  // ------------------------------------------------------------------ scopes

  /** The Clients that hold what a message is about. */
  private holdersOf(scope: Scope): Peer[] {
    if (scope.kind === 'sessions') return [...this.holders(scope.id)];
    if (scope.kind === 'requests') { const r = this.requests.get(Number(scope.id)); return r ? [r.client] : []; }
    if (scope.kind === 'elicitations') return [...(this.elicitations.get(scope.id) ?? [])];
    if (scope.kind === '' || scope.kind.startsWith('_')) return [...this.clients]; // the Agent, or a custom thing of the Agent
    return []; // mcpServers: MCP over ACP is not supported here
  }

  /** A /requests ID is ours. The Client gets its own ID back. */
  private paramsFor(client: Peer, scope: Scope, params: any) {
    const r = scope.kind === 'requests' ? this.requests.get(Number(scope.id)) : undefined;
    return r?.client === client ? { ...params, [scope.field]: r.id } : params;
  }

  private holders(sessionId: string): Set<Peer> {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Set());
    return this.sessions.get(sessionId)!;
  }

  private disconnect(client: Peer) {
    this.clients.delete(client);
    for (const holders of [...this.sessions.values(), ...this.elicitations.values()]) holders.delete(client);
    for (const [agentId, request] of [...this.pending]) {
      if (!request.shownTo.delete(client)) continue;
      request.failed.delete(client);
      if (request.failed.size < request.shownTo.size) continue; // someone can still answer
      this.pending.delete(agentId);
      this.agent.send({ id: agentId, error: { code: -32603, message: 'no Client can answer the request any more' } });
    }
  }
}
