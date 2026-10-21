// ============================================================================
// client.ts — Chrome DevTools Protocol client over WebSocket.
//
// Speaks standard CDP: {id, method, params} → {id, result|error};
// {method, params} events. Supports flat session multiplexing (sessionId)
// for Node worker targets / browser page targets.
//
// Verified against Bun's inspector.open(): Runtime + Debugger domains work;
// Profiler/HeapProfiler/Performance/Network are absent over Bun's WS (the
// downdraft mirror + platinum-agent cover those on Bun targets; real Node
// --inspect targets expose the full surface).
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

export interface CdpEvents {
  onEvent: (method: string, params: unknown, sessionId?: string) => void;
  onClose: () => void;
  onOpen?: () => void;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private closed = false;
  /** Sessions seen via Target.attachedToTarget (flat mode). */
  sessions = new Map<string, { targetId: string; type: string; title: string }>();

  constructor(
    private url: string,
    private ev: CdpEvents,
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws || this.closed) return resolve();
      try {
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => { this.ev.onOpen?.(); resolve(); };
        ws.onerror = () => { resolve(); };
        ws.onmessage = (e) => this.onMessage(String(e.data));
        ws.onclose = () => {
          this.ws = null;
          this.failAll(new Error("cdp ws closed"));
          this.ev.onClose();
        };
      } catch {
        this.ev.onClose();
        resolve();
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number; result?: unknown;
      error?: { code?: number; message?: string };
      method?: string; params?: unknown; sessionId?: string;
    };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method) {
      if (msg.method === "Target.attachedToTarget" || msg.method === "Target.targetCreated") {
        const p = msg.params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string; title?: string } };
        if (p?.sessionId && p.targetInfo) {
          this.sessions.set(p.sessionId, {
            targetId: p.targetInfo.targetId ?? "",
            type: p.targetInfo.type ?? "",
            title: p.targetInfo.title ?? "",
          });
        }
      }
      this.ev.onEvent(msg.method, msg.params, msg.sessionId);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? "cdp error"}`));
        else p.resolve(msg.result);
      }
    }
  }

  private failAll(e: Error): void {
    this.pending.forEach((p) => p.reject(e));
    this.pending.clear();
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("cdp not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Call that tolerates "method not found" — returns undefined for absent domains. */
  async tryCall<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T | undefined> {
    try {
      return await this.call<T>(method, params, sessionId);
    } catch (e) {
      log.warn("cdp", `${method}: ${(e as Error).message}`);
      return undefined;
    }
  }

  dispose(): void {
    this.closed = true;
    this.failAll(new Error("disposed"));
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.sessions.clear();
  }
}
