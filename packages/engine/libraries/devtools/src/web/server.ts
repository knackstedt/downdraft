// ============================================================================
// server.ts — DevToolsServer: the web-devtools loopback endpoint.
//
// Development-only. Binds 127.0.0.1:0 (ephemeral), serves the devtools-web
// frontend over HTTP and the JSON-RPC channel over WebSocket. A bearer token
// is required on the WS upgrade; discovery is via ~/.downdraft/devtools/<pid>
// (mirrors the MCP ~/.downdraft/port convention).
//
// Wire protocol (JSON, single WS connection):
//   client → {id, method, params}
//   server → {id, result} | {id, error: {message}}
//   server → {event, data}            (unsolicited pushes: console, metrics…)
//   server → {event:"hello", data:{version, panels, inspectorMethods}}
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { findPackageRoot } from "@downdraft/engine/platform/pkg-root";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("info");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface DevToolsServerOptions {
  /** Directory containing index.html + panel assets. Defaults to the
   *  sibling devtools-web package. */
  webRoot?: string;
  /** Extra routes: path → content (e.g. generated kit.css). */
  extraRoutes?: Record<string, string>;
  /** JSON-RPC dispatch — see WebDevtoolsMirror.dispatch(). */
  call?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Connection bookkeeping (e.g. host focuses data pushes on live clients). */
  onClientsChanged?: (n: number) => void;
}

interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class DevToolsServer {
  private port = 0;
  private token = randomBytes(16).toString("hex");
  private server: { port: number; stop(): void; upgrade(req: Request, opts?: unknown): boolean } | null = null;
  private sockets = new Set<WsSocket>();
  private opts: DevToolsServerOptions;
  private cleanupPid: (() => void) | null = null;
  private nextId = 1;

  constructor(opts: DevToolsServerOptions = {}) {
    this.opts = opts;
  }

  /** The websocket-capable URL handed to the browser launcher. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/?t=${this.token}`;
  }

  get clientCount(): number { return this.sockets.size; }

  async start(): Promise<void> {
    if (this.server) return;
    const BunG = (globalThis as Record<string, unknown>).Bun;
    if (!BunG || typeof (BunG as { serve?: unknown }).serve !== "function") {
      throw new Error("DevToolsServer requires Bun.serve (Bun runtime)");
    }
    const webRoot = this.opts.webRoot ?? join(
      findPackageRoot(dirname(fileURLToPath(import.meta.url))), "..", "devtools-web",
    );
    const srv = (BunG as {
      serve(o: Record<string, unknown>): { port: number; stop(): void; upgrade(r: Request, o?: unknown): boolean };
    }).serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req: Request, server: { upgrade(r: Request, o?: unknown): boolean }) => {
        const url = new URL(req.url);
        // ── WS upgrade (token via query — browsers can't set headers on WS) ──
        if (url.pathname === "/ws") {
          if (url.searchParams.get("t") !== this.token) {
            return new Response("unauthorized", { status: 401 });
          }
          if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
          return new Response("upgrade failed", { status: 400 });
        }
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", clients: this.sockets.size, port: this.port });
        }
        // ── Static: extra routes (generated) then webRoot files ──
        const extra = this.opts.extraRoutes?.[url.pathname];
        if (extra !== undefined) {
          return new Response(extra, { headers: { "content-type": "text/css; charset=utf-8" } });
        }
        let rel = url.pathname === "/" ? "/index.html" : url.pathname;
        rel = normalize(rel);
        if (rel.includes("..")) return new Response("no", { status: 403 });
        const file = join(webRoot, rel);
        if (!existsSync(file)) return new Response("not found", { status: 404 });
        const body = readFileSync(file);
        return new Response(body, {
          headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
        });
      },
      websocket: {
        open: (ws: WsSocket) => {
          this.sockets.add(ws);
          this.opts.onClientsChanged?.(this.sockets.size);
          ws.send(JSON.stringify({ event: "hello", data: this.helloData() }));
        },
        message: async (ws: WsSocket, raw: string | Buffer) => {
          let msg: { id?: number; method?: string; params?: Record<string, unknown> };
          try {
            msg = JSON.parse(String(raw));
          } catch {
            ws.send(JSON.stringify({ id: 0, error: { message: "parse error" } }));
            return;
          }
          if (!msg.method) return;
          const id = msg.id ?? this.nextId++;
          try {
            const result = await this.callRpc(msg.method, msg.params ?? {});
            ws.send(JSON.stringify({ id, result }));
          } catch (err) {
            ws.send(JSON.stringify({ id, error: { message: String(err) } }));
          }
        },
        close: (ws: WsSocket) => {
          this.sockets.delete(ws);
          this.opts.onClientsChanged?.(this.sockets.size);
        },
      },
    });
    this.server = srv;
    this.port = srv.port;
    this.writeDiscoveryFile();
    log.info("dev-tools-server", `devtools at ${this.url}`);
  }

  private helloData(): Record<string, unknown> {
    const hello = (this.opts as { hello?: () => Record<string, unknown> }).hello;
    return hello?.() ?? { version: 1 };
  }

  /** Provide the "hello" payload producer (panel list, inspector methods). */
  setHello(fn: () => Record<string, unknown>): void {
    (this.opts as { hello?: () => Record<string, unknown> }).hello = fn;
  }

  private async callRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "ping") return "pong";
    if (!this.opts.call) throw new Error(`no dispatcher for ${method}`);
    return this.opts.call(method, params);
  }

  /** Push an event to every connected client. */
  emit(event: string, data: unknown): void {
    if (this.sockets.size === 0) return;
    const msg = JSON.stringify({ event, data });
    this.sockets.forEach((ws) => {
      try { ws.send(msg); } catch { /* dropping client errors */ }
    });
  }

  private writeDiscoveryFile(): void {
    const dir = join(homedir(), ".downdraft", "devtools");
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${process.pid}.json`);
      writeFileSync(file, JSON.stringify({
        pid: process.pid, port: this.port, token: this.token,
        url: this.url, startedAt: Date.now(),
      }), { mode: 0o600 });
      this.cleanupPid = () => { try { unlinkSync(file); } catch { /* gone */ } };
    } catch (err) {
      log.warn("dev-tools-server", `discovery file failed: ${err}`);
    }
  }

  async stop(): Promise<void> {
    this.sockets.forEach((ws) => { try { ws.close(); } catch { /* ignore */ } });
    this.sockets.clear();
    try { this.server?.stop(); } catch { /* ignore */ }
    this.server = null;
    this.cleanupPid?.();
    this.cleanupPid = null;
  }
}
