// A thin ACP host: one Agent process, several Client connections that share its sessions.
// Rules are those of the internal document "Thin ACP host: behavior".
//
// The host has code for the session lifecycle only (initialize, session/new|fork|resume|close, session/prompt).
// Everything about update variants and Agent-to-Client methods comes from schema data:
//   - x-state  -> `SessionStore` keeps each session's state and answers a joining Client's session/resume;
//   - x-audience -> `resourceOf` says which connections hold a message, and who may answer a request.
// New ACP variants and methods, and custom ones that the Agent declares in initialize, need no host code.

import { Peer, type Message } from './jsonrpc.ts';
import { SessionStore, withAgentRows, type StateRows } from './state.ts';
import { rowsFromSchema } from '../schema/rows.ts';
import { bindsToResource, audienceFromSchema, resourceOf, withCustomMethods, type AudienceTable, type Resource } from './audience.ts';
import { lookup } from './paths.ts';

type Connection = { id: number; peer: Peer };

/** An Agent-to-Client request while it waits for an answer. */
type Pending = { agentId: number | string; method: string; params: any; toResource: boolean; shownTo: Map<Connection, number>; errors: Map<Connection, Message>; done: boolean };

export type HostOptions = { schema: any; agentSchema?: any; log?: (line: string) => void };

export class ThinHost {
  private agent: Peer;
  private log: (line: string) => void;
  private schemaRows: StateRows;
  private schemaAudience: AudienceTable;
  private audience!: AudienceTable;
  private initialize?: Promise<Message>;
  private nextConnection = 1;
  private nextDownstreamId = 1;

  store!: SessionStore;
  /** sessionId -> connections where the session is active. */
  active = new Map<string, Set<Connection>>();
  /** sessionId -> the connection that sent its latest prompt. In v2 the prompt response only accepts the turn. */
  private prompter = new Map<string, Connection>();
  /** Upstream ID of a Client request in flight -> the connection and its own ID (the /requests resource). */
  private requests = new Map<number, { connection: Connection; id: number | string }>();
  /** elicitationId -> connections that got its elicitation/create (the /elicitations resource). */
  private elicitations = new Map<string, Set<Connection>>();
  private pending = new Map<number | string, Pending>();
  private connections = new Set<Connection>();

  private options: HostOptions;

  constructor(agent: Peer, options: HostOptions) {
    this.agent = agent;
    this.options = options;
    this.log = options.log ?? (() => {});
    this.schemaRows = rowsFromSchema(options.schema);
    this.schemaAudience = audienceFromSchema(options.schema);
    this.useAgentSchema(undefined);
    agent.onMessage = message => this.fromAgent(message);
  }

  /** Custom rows and methods: the Agent's `capabilities.schema`, plus a host-configured one for Agents that send none yet. */
  private useAgentSchema(fromAgent: any) {
    const merged = {
      sessionUpdates: { ...this.options.agentSchema?.sessionUpdates, ...fromAgent?.sessionUpdates },
      methods: { ...this.options.agentSchema?.methods, ...fromAgent?.methods },
    };
    const sessions = this.store?.sessions;
    this.store = new SessionStore(withAgentRows(this.schemaRows, merged));
    if (sessions) this.store.sessions = sessions;
    this.audience = withCustomMethods(this.schemaAudience, merged);
  }

  connect(peer: Peer): Connection {
    const connection: Connection = { id: this.nextConnection++, peer };
    this.connections.add(connection);
    peer.onMessage = message => this.fromClient(connection, message);
    peer.onClose = () => this.disconnect(connection);
    this.log(`client ${connection.id} connected`);
    return connection;
  }

  // ---------------------------------------------------------------- Client -> Agent

  private async fromClient(connection: Connection, message: Message) {
    if (message.method === undefined) return this.answer(connection, message);
    if (message.method === '$/cancel_request') { // the Client names its own request ID: give the Agent its upstream ID
      const upstream = [...this.requests].find(([, owner]) => owner.connection === connection && owner.id === message.params?.requestId)?.[0];
      if (upstream !== undefined) this.agent.send({ method: message.method, params: { ...message.params, requestId: upstream } });
      return;
    }
    if (message.id === undefined) return this.agent.send({ method: message.method, params: message.params }); // session/cancel and others
    let reply: Message;
    try {
      reply = await this.clientRequest(connection, message.method, message.params, message.id);
    } catch (error: any) {
      reply = { error: { code: -32603, message: String(error?.message ?? error) } };
    }
    connection.peer.send({ id: message.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) });
  }

  private async clientRequest(connection: Connection, method: string, params: any, clientId: number | string): Promise<Message> {
    const sessionId: string | undefined = params?.sessionId;

    if (method === 'initialize') { // one v2 initialize upstream; every Client gets its result
      this.initialize ??= this.agent.request(method, { ...params, protocolVersion: 2 }).then(reply => {
        if (reply.error) this.initialize = undefined; // let the next Client try again
        else this.useAgentSchema(reply.result?.capabilities?.schema);
        return reply;
      });
      return this.initialize;
    }
    if (method === 'session/resume' && sessionId && this.holders(sessionId).size > 0) {
      return this.join(connection, sessionId, params); // the session is live on another connection: answer from the store
    }
    if (method === 'session/close' && sessionId && [...this.holders(sessionId)].some(other => other !== connection)) {
      this.holders(sessionId).delete(connection); // others still use it: do not close it in the Agent
      return { result: {} };
    }

    if (method === 'session/resume' && sessionId) {
      if (params.replayFrom) this.store.nodes(sessionId).clear(); // a full replay is authoritative
      this.holders(sessionId).add(connection); // the replay goes to the connection that asked for it
    }
    if (method === 'session/prompt' && sessionId) this.prompter.set(sessionId, connection);

    let upstreamId = 0;
    const reply = await this.agent.request(method, params, id => { upstreamId = id; this.requests.set(id, { connection, id: clientId }); });
    this.requests.delete(upstreamId);

    if (reply.error) {
      if (method === 'session/resume' && sessionId) this.holders(sessionId).delete(connection);
      return reply;
    }
    this.store.applyResponse(method, params, reply.result);
    const created = method === 'session/new' || method === 'session/fork' ? reply.result?.sessionId : undefined;
    if (created) this.holders(created).add(connection);
    if (method === 'session/close' && sessionId) this.holders(sessionId).delete(connection);
    if (created || method === 'session/resume') this.showPendingTo(connection, created ?? sessionId!);
    return reply;
  }

  /**
   * session/resume for a session that is already live: history (when replay is requested), replay_complete,
   * current values, and state_update last. The response carries the lists from the store.
   */
  private join(connection: Connection, sessionId: string, params: any): Message {
    const { history, current } = this.store.replay(sessionId);
    const send = (update: any) => connection.peer.send({ method: 'session/update', params: { sessionId, update } });
    if (params.replayFrom) history.forEach(send);
    send({ sessionUpdate: 'replay_complete' });
    current.filter(update => update.sessionUpdate !== 'state_update').forEach(send);
    current.filter(update => update.sessionUpdate === 'state_update').forEach(send);
    this.holders(sessionId).add(connection);
    this.showPendingTo(connection, sessionId);
    this.log(`client ${connection.id} joined ${sessionId}: ${params.replayFrom ? history.length : 0} history updates from the store`);
    return { result: { configOptions: this.store.current(sessionId, 'config') ?? [], availableCommands: this.store.current(sessionId, 'commands') ?? [] } };
  }

  // ---------------------------------------------------------------- Agent -> Clients

  private fromAgent(message: Message) {
    if (message.method === '$/cancel_request') return this.withdraw(this.pending.get(message.params?.requestId));
    if (message.method === 'session/update') this.store.applyUpdate(message.params);
    else if (message.id !== undefined) this.store.applyRequest(message.method!, message.params); // a permission request carries its tool call

    const resource = resourceOf(this.audience, message.method!, message.params);
    const holders = resource ? this.connectionsHolding(resource) : [];

    if (message.id === undefined) { // notification: every connection that holds the resource
      if (!resource) this.log(`dropped ${message.method}: no audience`);
      for (const connection of holders) connection.peer.send({ method: message.method, params: this.paramsFor(connection, resource!, message.params) });
      return;
    }
    if (!resource) {
      this.log(`refused ${message.method}: no audience`);
      return this.agent.send({ id: message.id, error: { code: -32601, message: `${message.method} has no audience` } });
    }
    const request: Pending = { agentId: message.id, method: message.method!, params: message.params, toResource: bindsToResource(this.audience, message.method!), shownTo: new Map(), errors: new Map(), done: false };
    this.pending.set(message.id, request);
    // binding "resource": show it to every holder, the first answer wins. binding "connection": one connection,
    // the one that sent the session's latest prompt, else the first holder.
    const prompter = resource.kind === 'sessions' ? this.prompter.get((resource as any).id) : undefined;
    const to = request.toResource ? holders : [holders.find(c => c === prompter) ?? holders[0]].filter(Boolean);
    if (!to.length) return this.finish(request, { error: { code: -32603, message: 'no connection holds the resource' } });
    for (const connection of to) this.show(request, connection, resource);
  }

  private show(request: Pending, connection: Connection, resource: Resource) {
    const id = this.nextDownstreamId++;
    request.shownTo.set(connection, id);
    const elicitationId = request.params?.elicitationId; // remember who got it: the /elicitations resource
    if (typeof elicitationId === 'string') this.elicitations.set(elicitationId, (this.elicitations.get(elicitationId) ?? new Set()).add(connection));
    connection.peer.send({ id, method: request.method, params: this.paramsFor(connection, resource, request.params) });
  }

  /** A Client answers an Agent-to-Client request. */
  private answer(connection: Connection, message: Message) {
    const request = [...this.pending.values()].find(p => p.shownTo.get(connection) === message.id);
    if (!request || request.done) return; // late answer of a request that another connection answered
    if (message.error && request.toResource) {
      request.errors.set(connection, message);
      if (request.errors.size < request.shownTo.size) return; // others may still answer
    }
    this.finish(request, message, connection);
  }

  private finish(request: Pending, reply: Message, winner?: Connection) {
    request.done = true;
    this.pending.delete(request.agentId);
    this.agent.send({ id: request.agentId, ...(reply.error ? { error: reply.error } : { result: reply.result }) });
    for (const [connection, id] of request.shownTo) if (connection !== winner) connection.peer.send({ method: '$/cancel_request', params: { requestId: id } });
  }

  private withdraw(request?: Pending) {
    if (!request) return;
    request.done = true;
    this.pending.delete(request.agentId);
    for (const [connection, id] of request.shownTo) connection.peer.send({ method: '$/cancel_request', params: { requestId: id } });
  }

  /** A connection that joins a session also gets its pending requests that are bound to the session, not a connection. */
  private showPendingTo(connection: Connection, sessionId: string) {
    for (const request of this.pending.values()) {
      const resource = resourceOf(this.audience, request.method, request.params);
      if (request.toResource && resource?.kind === 'sessions' && (resource as any).id === sessionId && !request.shownTo.has(connection)) this.show(request, connection, resource);
    }
  }

  // ---------------------------------------------------------------- resources

  holders(sessionId: string): Set<Connection> {
    if (!this.active.has(sessionId)) this.active.set(sessionId, new Set());
    return this.active.get(sessionId)!;
  }

  private connectionsHolding(resource: Resource): Connection[] {
    if (resource.kind === 'root') return [...this.connections]; // one local user: every connection may see Agent-level state
    const { kind, id } = resource as { kind: string; id: string };
    if (kind === 'sessions') return [...this.holders(id)];
    if (kind === 'requests') { const owner = this.requests.get(Number(id)); return owner ? [owner.connection] : []; }
    if (kind === 'elicitations') return [...(this.elicitations.get(id) ?? [])];
    return []; // mcpServers: MCP over ACP is not supported by this host
  }

  /** IDs under /requests are per connection: give the Client its own request ID back. */
  private paramsFor(connection: Connection, resource: Resource, params: any) {
    if (resource.kind !== 'requests') return params;
    const { field, id } = resource as { field: string; id: string };
    const owner = this.requests.get(Number(id));
    return owner?.connection === connection && lookup(params, field) !== undefined ? { ...params, [field]: owner.id } : params;
  }

  private disconnect(connection: Connection) {
    this.connections.delete(connection);
    for (const [sessionId, prompter] of this.prompter) if (prompter === connection) this.prompter.delete(sessionId);
    for (const holders of this.active.values()) holders.delete(connection);
    for (const holders of this.elicitations.values()) holders.delete(connection);
    for (const request of [...this.pending.values()]) {
      if (!request.shownTo.delete(connection)) continue;
      request.errors.delete(connection);
      if (request.shownTo.size === 0) this.finish(request, { error: { code: -32603, message: 'the connection that held the request closed' } });
      else if (request.errors.size === request.shownTo.size) this.finish(request, request.errors.values().next().value!); // the rest answered with errors
    }
    this.log(`client ${connection.id} disconnected`);
  }
}
