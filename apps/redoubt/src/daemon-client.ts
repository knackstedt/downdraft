// ============================================================================
// daemon-client.ts — JSON-RPC 2.0 client for redoubtd over a unix socket.
//
// Framing: newline-delimited JSON objects, both directions. Server→client
// notifications carry a `method` and no `id` and are fanned out to event
// subscribers. The client reconnects with backoff and can autospawn the
// daemon (env REDOUBTD_BIN → dev build under daemon/target → PATH).
// ============================================================================

import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "@downdraft/engine/util/logger";
import type { DaemonStatus } from "./protocol";

const log = createLogger("info");

export function socketPath(): string {
  if (process.env.REDOUBT_SOCK) return process.env.REDOUBT_SOCK;
  const runtime = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  return `${runtime}/downdraft-redoubt/daemon.sock`;
}

function daemonBinCandidates(): string[] {
  const out: string[] = [];
  if (process.env.REDOUBTD_BIN) out.push(process.env.REDOUBTD_BIN);
  // Dev layout: this file is <app>/src/daemon-client.ts → <app>/daemon/target.
  const appDir = fileURLToPath(new URL("..", import.meta.url));
  out.push(`${appDir}daemon/target/debug/redoubtd`);
  out.push(`${appDir}daemon/target/release/redoubtd`);
  return out;
}

type EventHandler = (method: string, params: unknown) => void;

export class DaemonClient {
  private sock: Socket | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers: EventHandler[] = [];
  private statusHandlers: ((connected: boolean) => void)[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private live = false;

  /** True only after the socket's connect event — a Socket instance exists
   *  from connect() onward even while the dial is failing. */
  get connected(): boolean {
    return this.live;
  }

  onEvent(cb: EventHandler): () => void {
    this.handlers.push(cb);
    return () => { this.handlers = this.handlers.filter((h) => h !== cb); };
  }

  onConnection(cb: (connected: boolean) => void): () => void {
    this.statusHandlers.push(cb);
    return () => { this.statusHandlers = this.statusHandlers.filter((h) => h !== cb); };
  }

  private setConnected(connected: boolean): void {
    this.statusHandlers.forEach((cb) => cb(connected));
  }

  connect(): void {
    if (this.sock) return;
    this.closedByUser = false;
    const sock = new Socket();
    this.sock = sock;
    sock.connect(socketPath());
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("error", () => { /* close event follows */ });
    sock.on("close", () => {
      this.live = false;
      if (this.sock === sock) this.sock = null;
      this.failAllPending(new Error("daemon socket closed"));
      this.setConnected(false);
      this.scheduleReconnect();
    });
    sock.on("connect", () => {
      this.live = true;
      this.setConnected(true);
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.destroy();
    this.sock = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private failAllPending(e: Error): void {
    this.pending.forEach((p) => p.reject(e));
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) return;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.handlers.forEach((cb) => cb(msg.method as string, msg.params));
      }
    }
  }

  rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error("daemon not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  }

  status(): Promise<DaemonStatus> {
    return this.rpc<DaemonStatus>("daemon.status");
  }
}

function waitConnected(client: DaemonClient, ms: number): Promise<boolean> {
  if (client.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const off = client.onConnection((c) => {
      if (c) { off(); clearTimeout(t); resolve(true); }
    });
    const t = setTimeout(() => { off(); resolve(false); }, ms);
  });
}

/** Connect, and if the daemon isn't listening spawn it and retry. Resolves
 *  once a connection is up OR all spawn candidates are exhausted (the client
 *  keeps retrying in the background either way). */
export async function ensureDaemon(client: DaemonClient): Promise<boolean> {
  client.connect();
  if (await waitConnected(client, 1200)) return true;
  const bin = daemonBinCandidates().find((p) => existsSync(p));
  if (bin) {
    log.info("daemon", `autospawn ${bin}`);
    const child = spawn(bin, ["run"], { detached: true, stdio: "ignore" });
    child.unref();
  } else {
    log.warn("daemon", `no redoubtd binary found (tried: ${daemonBinCandidates().join(", ")})`);
    return false;
  }
  return waitConnected(client, 5000);
}
