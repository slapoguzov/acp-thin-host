// Newline-delimited JSON-RPC, the ACP stdio framing, over any pair of streams (a child process or a socket).

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type Message = { jsonrpc?: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any };

/** Sees every message a Peer sends or receives, for `--trace`. */
export type Trace = (peer: string, direction: 'in' | 'out', message: Message) => void;

export class Peer {
  private nextId = 1;
  private waiting = new Map<number | string, (reply: Message) => void>();
  private output: Writable;
  private name: string;
  private trace?: Trace;
  onMessage: (message: Message) => void = () => {};
  onClose: () => void = () => {};

  constructor(input: Readable, output: Writable, name = 'peer', trace?: Trace) {
    this.output = output;
    this.name = name;
    this.trace = trace;
    const lines = createInterface({ input });
    input.on('error', () => lines.close()); // a peer that went away is a closed peer, not a crash
    output.on('error', () => lines.close());
    lines.on('line', line => {
      if (!line.trim()) return;
      let message: Message;
      try { message = JSON.parse(line); } catch { return; } // not JSON-RPC: skip the line
      this.trace?.(this.name, 'in', message);
      const reply = message.method === undefined && message.id !== undefined ? this.waiting.get(message.id) : undefined;
      if (reply) { this.waiting.delete(message.id!); reply(message); } else this.onMessage(message);
    });
    lines.on('close', () => {
      for (const reply of this.waiting.values()) reply({ error: { code: -32603, message: 'connection closed' } });
      this.waiting.clear();
      this.onClose();
    });
  }

  send(message: Message) {
    if (this.output.destroyed || this.output.writableEnded) return;
    this.trace?.(this.name, 'out', message);
    this.output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  /** Sends a request with a fresh ID. `onId` sees the ID before the reply, so a caller can map it. */
  request(method: string, params: any, onId?: (id: number) => void): Promise<Message> {
    const id = this.nextId++;
    onId?.(id);
    return new Promise(resolve => { this.waiting.set(id, resolve); this.send({ id, method, params }); });
  }
}
