// ============================================================================
// feed-server.ts — open ingest endpoint for external tools + the agent.
//
// Loopback HTTP JSON, node:http (works under Bun/Node/Deno — no runtime dep):
//   POST /feed  Authorization: Bearer <token>
//     {key, type, ...} — key routes to a target session (agent feedKey), or
//     explicit {pid} field, or the "external" pseudo-target.
//   GET  /health
//
// Discovery: we write ~/.downdraft/devtools-feed.json {pid,port,token} so
// agents and arbitrary tools can find the endpoint without configuration.
// ============================================================================

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { createLogger } from "@downdraft/engine/util/logger";
import type { SessionManager } from "./registry";
import type { CpuProfile, HeapSnapshotInfo, NetworkEvent } from "./model";
import type { PanelSnapshot } from "@downdraft/engine/libraries/devtools";

const log = createLogger();

export interface FeedMetric { id: string; label: string; unit?: "%" | "B" | "ms" | "us" | "ops" | "count"; points: [number, number][] }

export interface FeedMessage {
  key?: string;
  pid?: number;
  type: "metric" | "event" | "panel" | "snapshot" | "network" | "heap" | "console" | "profile" | "hmr";
  // metric
  series?: { id: string; label: string; unit?: string };
  points?: [number, number][];
  // event
  kind?: string; label?: string; detail?: string;
  // panel / snapshot
  panel?: string; snap?: PanelSnapshot;
  // network
  event?: NetworkEvent;
  // heap
  heap?: HeapSnapshotInfo;
  // console
  severity?: number; text?: string; thread?: string;
  // profile
  profile?: CpuProfile;
}

export class FeedServer {
  private server: Server | null = null;
  private token = randomBytes(16).toString("hex");
  private port = 0;
  /** feedKey → pid routing table (agents publish feedKey in discovery file). */
  private keyRoutes = new Map<string, number>();

  constructor(private sessions: SessionManager) {}

  get feedPort(): number { return this.port; }
  get feedToken(): string { return this.token; }

  /** Agent feedKey → pid so its pushes land on the right session. */
  routeKey(feedKey: string, pid: number): void {
    this.keyRoutes.set(feedKey, pid);
  }

  async start(port = 0): Promise<number> {
    if (this.server) return this.port;
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, port: this.port }));
        return;
      }
      if (url.pathname !== "/feed" || req.method !== "POST") {
        res.writeHead(404); res.end();
        return;
      }
      const auth = req.headers.authorization;
      const qk = url.searchParams.get("t");
      if (auth !== `Bearer ${this.token}` && qk !== this.token) {
        res.writeHead(401); res.end("unauthorized");
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 64 * 1024 * 1024) { res.writeHead(413); req.destroy(); }
      });
      req.on("end", () => {
        try {
          const msg = JSON.parse(body) as FeedMessage;
          this.dispatch(msg);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400); res.end(String(e));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    log.info("feed", `feed endpoint on 127.0.0.1:${this.port}`);
    return this.port;
  }

  private dispatch(msg: FeedMessage): void {
    const s = this.resolveSession(msg);
    if (!s) return;
    switch (msg.type) {
      case "metric": {
        const sr = msg.series;
        if (sr) {
          (msg.points ?? []).forEach(([t, v]) => {
            s.feedPoint(sr.id, sr.label, (sr.unit as never) ?? "count", t, v);
          });
        }
        break;
      }
      case "event":
        s.markEvent("feed", msg.label ?? "feed event", msg.detail);
        break;
      case "hmr":
        s.markEvent("hmr", msg.label ?? "target reload", msg.detail);
        s.systemNote(`⚡ ${msg.label ?? "target reload"}${msg.detail ? ` — ${msg.detail}` : ""}`);
        break;
      case "panel":
        if (msg.panel && !s.providers.some((p) => p.name === msg.panel)) {
          s.providers.push({ slot: 1000 + s.providers.length, name: `feed:${msg.panel}` });
        }
        break;
      case "snapshot": {
        if (msg.panel) {
          let pp = s.providers.find((p) => p.name === `feed:${msg.panel}` || p.name === msg.panel);
          if (!pp) {
            pp = { slot: 1000 + s.providers.length, name: `feed:${msg.panel}` };
            s.providers.push(pp);
          }
          pp.lastSnapshot = msg.snap;
          pp.lastPush = Date.now();
        }
        break;
      }
      case "network":
        if (msg.event) s.pushNetworkEvent(msg.event);
        break;
      case "heap":
        if (msg.heap) {
          s.heapSnapshots.push(msg.heap);
          s.markEvent("snapshot", `heap snapshot ${msg.heap.format} ${(msg.heap.totalBytes / 1048576).toFixed(1)}MB`);
        }
        break;
      case "console":
        // The mirror already captures console.* — skip agent-wrapped dupes.
        if (s.mirror?.connected) break;
        s.addEntry({
          ts: Date.now(), source: "log", severity: (msg.severity ?? 0) as never,
          thread: msg.thread ?? "feed", text: msg.text ?? "",
        });
        break;
      case "profile":
        if (msg.profile) {
          s.profiles.push(msg.profile);
          s.markEvent("profile", `external profile (${msg.profile.nodes.length} nodes)`);
        }
        break;
    }
  }

  private resolveSession(msg: FeedMessage): import("./session").TargetSession | null {
    if (msg.key) {
      const pid = this.keyRoutes.get(msg.key);
      if (pid !== undefined) return this.sessions.sessions.get(pid) ?? null;
    }
    if (msg.pid !== undefined) {
      return this.sessions.sessions.get(msg.pid) ?? null;
    }
    // External pseudo-target (pid -9000) for unkeyed pushes.
    return this.sessions.attachManual({ pid: -9000 });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = null;
  }
}
