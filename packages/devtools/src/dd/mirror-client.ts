// ============================================================================
// mirror-client.ts — client for the downdraft devtools WebSocket protocol
// (libraries/devtools/src/web/server.ts).
//
// Wire:  client → {id, method, params}
//        server → {id, result} | {id, error: {message}}
//        server → {event, data}          (console/threads/metrics/snapshot/…)
//        server → {event:"hello", data:{version, panels, inspectorMethods}}
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

export interface MirrorHello {
  version: number;
  panels?: { slot: number; name: string }[];
  inspector?: string[];
  inspectorMethods?: string[];
}

export interface MirrorClientEvents {
  onEvent: (event: string, data: unknown) => void;
  onHello: (hello: MirrorHello) => void;
  onClose: () => void;
  onOpen?: () => void;
}

export class MirrorClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private hello: MirrorHello | null = null;

  constructor(
    private url: string,
    private ev: MirrorClientEvents,
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get helloData(): MirrorHello | null {
    return this.hello;
  }

  connect(): void {
    if (this.ws || this.closed) return;
    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => this.ev.onOpen?.();
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        this.ws = null;
        this.failAll(new Error("devtools ws closed"));
        this.ev.onClose();
      };
    } catch (e) {
      log.warn("mirror", `connect failed: ${e}`);
      this.ev.onClose();
    }
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; event?: string; data?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event) {
      if (msg.event === "hello") {
        this.hello = (msg.data ?? {}) as MirrorHello;
        this.ev.onHello(this.hello);
      }
      this.ev.onEvent(msg.event, msg.data);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
        else p.resolve(msg.result);
      }
    }
  }

  private failAll(e: Error): void {
    this.pending.forEach((p) => p.reject(e));
    this.pending.clear();
  }

  /** JSON-RPC call. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  dispose(): void {
    this.closed = true;
    this.failAll(new Error("disposed"));
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}
