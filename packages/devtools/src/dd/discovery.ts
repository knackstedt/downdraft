// ============================================================================
// discovery.ts — local target discovery via ~/.downdraft well-known dirs.
//
// Sources:
//   ~/.downdraft/devtools/<pid>.json  — {pid,port,token,url} devtools WS (mirror)
//   ~/.downdraft/port/<pid>           — MCP port (+ <pid>.token bearer)
//   ~/.downdraft/devtools-agent/<pid>.json — agent: inspector ws url + caps
//   ~/.downdraft/devtools-feed.json   — (written by us) feed endpoint for tools
//
// Polled at ~1Hz — cheap readdir + mtime check, no fs.watch portability risk.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const log = createLogger();

export const DD_DIR = join(homedir(), ".downdraft");
const DEVTOOLS_DIR = join(DD_DIR, "devtools");
const PORT_DIR = join(DD_DIR, "port");
export const AGENT_DIR = join(DD_DIR, "devtools-agent");
export const FEED_FILE = join(DD_DIR, "devtools-feed.json");
// Pre-rename contract: agents built from older platform-native still write
// platinum-agent/ + platinum-feed.json — keep reading both so a mixed-version
// machine doesn't lose targets.
const AGENT_DIRS = [AGENT_DIR, join(DD_DIR, "platinum-agent")];
export const LEGACY_FEED_FILE = join(DD_DIR, "platinum-feed.json");

export interface DiscoveredEndpoint {
  pid: number;
  /** Devtools mirror WS. */
  mirror?: { url: string; token: string; port: number };
  /** MCP HTTP. */
  mcp?: { port: number; token: string | null };
  /** devtools-agent extras. */
  agent?: { cdpUrl?: string; feedKey?: string; cmdPort?: number; caps?: string[]; startedAt?: number };
}

export type DiscoveryListener = (added: DiscoveredEndpoint[], removed: number[]) => void;

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function scanOnce(): Map<number, DiscoveredEndpoint> {
  const out = new Map<number, DiscoveredEndpoint>();
  const ensure = (pid: number): DiscoveredEndpoint => {
    let e = out.get(pid);
    if (!e) { e = { pid }; out.set(pid, e); }
    return e;
  };

  try {
    if (existsSync(PORT_DIR)) {
      readdirSync(PORT_DIR).forEach((f) => {
        if (!/^\d+$/.test(f)) return;
        const pid = Number(f);
        const port = Number(readFileSync(join(PORT_DIR, f), "utf8").trim());
        if (!port) return;
        let token: string | null = null;
        const tokFile = join(PORT_DIR, `${f}.token`);
        if (existsSync(tokFile)) {
          try { token = readFileSync(tokFile, "utf8").trim() || null; } catch { token = null; }
        }
        ensure(pid).mcp = { port, token };
      });
    }
  } catch (e) { log.warn("discover", `port scan: ${e}`); }

  try {
    if (existsSync(DEVTOOLS_DIR)) {
      readdirSync(DEVTOOLS_DIR).forEach((f) => {
        if (!f.endsWith(".json")) return;
        const d = readJson<{ pid?: number; port?: number; token?: string; url?: string }>(join(DEVTOOLS_DIR, f));
        if (!d?.pid || !d.port || !d.url) return;
        const host = new URL(d.url).host;
        ensure(d.pid).mirror = { url: `ws://${host}/ws?t=${d.token}`, token: d.token ?? "", port: d.port };
      });
    }
  } catch (e) { log.warn("discover", `devtools scan: ${e}`); }

  for (const dir of AGENT_DIRS.values()) {
    try {
      if (existsSync(dir)) {
        readdirSync(dir).forEach((f) => {
          if (!f.endsWith(".json")) return;
          const d = readJson<{ pid?: number; cdpUrl?: string; feedKey?: string; cmdPort?: number; caps?: string[]; startedAt?: number }>(join(dir, f));
          if (!d?.pid) return;
          ensure(d.pid).agent = { cdpUrl: d.cdpUrl, feedKey: d.feedKey, cmdPort: d.cmdPort, caps: d.caps, startedAt: d.startedAt };
        });
      }
    } catch (e) { log.warn("discover", `agent scan: ${e}`); }
  }

  // Drop stale pids.
  out.forEach((e, pid) => { if (!pidAlive(pid)) out.delete(pid); });
  return out;
}

function signature(e: DiscoveredEndpoint): string {
  return [
    e.mirror ? `m:${e.mirror.url}` : "",
    e.mcp ? `p:${e.mcp.port}` : "",
    e.agent ? `a:${e.agent.cdpUrl ?? ""}:${e.agent.cmdPort ?? ""}` : "",
  ].join("|");
}

export class DiscoveryWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** pid → channel signature; endpoint changes for a known pid re-emit "added". */
  private known = new Map<number, string>();
  private listener: DiscoveryListener;

  constructor(listener: DiscoveryListener) {
    this.listener = listener;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    const tick = () => {
      const found = scanOnce();
      const added: DiscoveredEndpoint[] = [];
      const removed: number[] = [];
      found.forEach((e, pid) => {
        const sig = signature(e);
        if (this.known.get(pid) !== sig) {
          this.known.set(pid, sig);
          added.push(e);
        }
      });
      this.known.forEach((_sig, pid) => {
        if (!found.has(pid)) { this.known.delete(pid); removed.push(pid); }
      });
      if (added.length || removed.length) this.listener(added, removed);
    };
    this.timer = setInterval(tick, intervalMs);
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
