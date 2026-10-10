
import { untrackedTimeout } from "../util/session-timer";

export type RPCMessageType = "request" | "response" | "event";

export interface RPCMessage {
  type: RPCMessageType;
  id: number;
  channel: string;
  payload?: unknown;
}

export type RPCHandler = (payload: unknown) => Promise<unknown> | unknown;

export class RPC {
  private handlers: Map<string, RPCHandler> = new Map();
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private eventListeners: Map<string, Set<(payload: unknown) => void>> = new Map();
  private messageIdCounter: number = 0;
  private sendFn: ((msg: RPCMessage) => void) | null = null;
  private static readonly MAX_PENDING = 1024;

  setSendFn(fn: (msg: RPCMessage) => void): void {
    this.sendFn = fn;
  }

  registerHandler(channel: string, handler: RPCHandler): void {
    this.handlers.set(channel, handler);
  }

  async call(channel: string, payload?: unknown, timeoutMs: number = 5000): Promise<unknown> {
    if (!this.sendFn) {
      return Promise.reject(new Error(`[RPC] No send function set for channel "${channel}"`));
    }
    if (this.pending.size >= RPC.MAX_PENDING) {
      return Promise.reject(new Error(`[RPC] Pending map full (${RPC.MAX_PENDING}), cannot call "${channel}"`));
    }
    const id = this.messageIdCounter = (this.messageIdCounter + 1) % 0xFFFFFFFF;
    return new Promise((resolve, reject) => {
      const timer = untrackedTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`[RPC] Call to "${channel}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ type: "request", id, channel, payload });
    });
  }

  emit(channel: string, payload?: unknown): void {
    this.send({ type: "event", id: 0, channel, payload });
  }

  on(channel: string, fn: (payload: unknown) => void): () => void {
    let listeners = this.eventListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(channel, listeners);
    }
    listeners.add(fn);
    return () => listeners!.delete(fn);
  }

  receive(msg: RPCMessage): void {
    if (msg.type === "response") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending.resolve(msg.payload);
      }
    } else if (msg.type === "request") {
      const handler = this.handlers.get(msg.channel);
      if (handler) {
        Promise.resolve(handler(msg.payload))
          .then((result) => {
            this.send({ type: "response", id: msg.id, channel: msg.channel, payload: result });
          })
          .catch((err) => {
            this.send({ type: "response", id: msg.id, channel: msg.channel, payload: { error: String(err) } });
          });
      }
    } else if (msg.type === "event") {
      const listeners = this.eventListeners.get(msg.channel);
      if (listeners) {
        for (const fn of listeners.values()) {
          fn(msg.payload);
        }
      }
    }
  }

  private send(msg: RPCMessage): void {
    if (this.sendFn) {
      this.sendFn(msg);
    }
  }
}
