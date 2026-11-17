// Newline-delimited JSON-RPC, the ACP stdio framing, over any pair of streams (a child process, a socket, memory).

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

export class Peer {
  private nextId = 1;
  private waiting = new Map<number | string, (reply: Message) => void>();
  onMessage: (message: Message) => void = () => {};
  onClose: () => void = () => {};

  private output: Writable;

  constructor(input: Readable, output: Writable) {
    this.output = output;
    const lines = createInterface({ input });
    input.on('error', () => lines.close());
    output.on('error', () => lines.close());
    lines.on('line', line => {
      let message: Message;
      try { message = JSON.parse(line); } catch { return; }
      const reply = message.method === undefined ? this.waiting.get(message.id!) : undefined;
      if (reply) { this.waiting.delete(message.id!); reply(message); } else this.onMessage(message);
    });
    lines.on('close', () => {
      for (const reply of this.waiting.values()) reply({ error: { code: -32603, message: 'connection closed' } });
      this.onClose();
    });
  }

  send(message: Message) {
    if (!this.output.writableEnded) this.output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  /** Sends a request with a new ID. `onId` gets the ID before the reply arrives. */
  request(method: string, params: any, onId?: (id: number) => void): Promise<Message> {
    const id = this.nextId++;
    onId?.(id);
    return new Promise(resolve => { this.waiting.set(id, resolve); this.send({ id, method, params }); });
  }
}
