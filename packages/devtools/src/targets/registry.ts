// ============================================================================
// registry.ts — SessionManager: discovery → attach/detach → active session.
//
// Hot-plug contract: targets appear when discovery files land, go "lost" on
// scan removal or channel death, auto-reattach when files return (dev-shell
// session restarts rebind the same pid).
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bumpTargets, store, targetHasWorld, type TargetInfo } from "../app/store";
import { DiscoveryWatcher, scanOnce, type DiscoveredEndpoint } from "../dd/discovery";
import { TargetSession } from "./session";

const log = createLogger();

/** Agent discovery dir — devtools-agent writes <pid>.json here. */
export const AGENT_DIR = join(homedir(), ".downdraft", "devtools-agent");

export class SessionManager {
  sessions = new Map<number, TargetSession>();
  private watcher: DiscoveryWatcher;
  private endpoints = new Map<number, DiscoveredEndpoint>();
  /** Set by runtime.ts — routes an agent's feedKey to its pid for feed pushes. */
  feedRouter: ((feedKey: string, pid: number) => void) | null = null;

  constructor() {
    this.watcher = new DiscoveryWatcher((added, removed) => this.onDiscovery(added, removed));
  }

  /** Pid that should be listed as a target even though it's this process —
   *  set by an embedded mount that self-injected the agent. The standalone
   *  viewer leaves it null: inspecting yourself is meaningless there. */
  private selfPid: number | null = null;
  /** When true, self always takes the active slot on (re)discovery — the
   *  embedded single-target mode where the host app IS the subject and
   *  the target list is hidden. */
  private selfPinned = false;
  setSelfTarget(pid: number | null, opts?: { pin?: boolean }): void {
    this.selfPid = pid;
    this.selfPinned = opts?.pin ?? false;
    // Pin applies immediately if the self session already exists — covers
    // setSelfTarget calls that land after discovery created it.
    if (pid !== null && this.selfPinned) {
      const s = this.sessions.get(pid);
      if (s) this.setActive(s.id);
    }
  }

  start(): void {
    // Keep the agent dir around so agents can write before we boot.
    try { mkdirSync(AGENT_DIR, { recursive: true }); } catch { /* best-effort */ }
    this.watcher.start(1000);
    log.info("targets", "discovery watcher started");
  }

  stop(): void {
    this.watcher.stop();
    this.sessions.forEach((s) => s.dispose());
    this.sessions.clear();
  }

  /** Pids the user detached by hand — discovery must not resurrect them. */
  private suppressed = new Set<number>();

  private onDiscovery(added: DiscoveredEndpoint[], removed: number[]): void {
    added.forEach((ep) => {
      // Don't inspect ourselves — except an embedded mount that opted its
      // own pid in via setSelfTarget (the host app IS the target then).
      if (ep.pid === process.pid && ep.pid !== this.selfPid) return;
      const prev = this.endpoints.get(ep.pid);
      // Merge channels into the remembered endpoint (discovery files land at
      // different times — mirror json may arrive before the agent file).
      const merged: DiscoveredEndpoint = {
        pid: ep.pid,
        mirror: ep.mirror ?? prev?.mirror,
        mcp: ep.mcp ?? prev?.mcp,
        agent: ep.agent ?? prev?.agent,
      };
      this.endpoints.set(ep.pid, merged);
      if (merged.agent?.feedKey) this.feedRouter?.(merged.agent.feedKey, ep.pid);
      const existing = this.sessions.get(ep.pid);
      if (existing) {
        existing.reattach(merged);
        if (existing.status === "lost") existing.status = "connecting";
      } else if (this.suppressed.has(ep.pid)) {
        // user detached — stay detached until explicit reattach
        return;
      } else {
        const s = new TargetSession(merged, {
          onStatus: () => this.syncStore(),
          onThreads: () => this.syncStore(),
          onPanels: () => this.syncStore(),
          onProfile: () => this.syncStore(),
          onSnapshot: () => this.syncStore(),
        });
        this.sessions.set(ep.pid, s);
        // Embedded self-target: the host app is the natural default —
        // without this the overlay arbitrarily attaches to whichever
        // unrelated target discovery found first. Pinned mode takes the
        // slot unconditionally — including on re-discovery after another
        // target won the initial race.
        if (ep.pid === this.selfPid && (this.selfPinned || !store.getState().activeTargetId)) {
          this.setActive(s.id);
        }
      }
    });
    removed.forEach((pid) => {
      const s = this.sessions.get(pid);
      if (s) {
        s.status = "lost";
        s.markEvent("detach", "target gone");
        // GC quickly if it never had a real channel — stale pid files from
        // crashed processes shouldn't linger; sessions with live history
        // stay a while for potential reattach.
        if (!s.mirror?.connected && !s.cdp?.connected) {
          const hadData = s.consoleEntries.length > 0 || s.profiles.length > 0;
          setTimeout(() => {
            if (s.status === "lost" && !hadData) {
              this.sessions.delete(pid);
              this.endpoints.delete(pid);
              this.syncStore();
              bumpTargets();
            }
          }, 15_000);
        }
      }
    });
    this.syncStore();
    bumpTargets();
  }

  /** Manually attach to a raw endpoint (cdp url / mirror url / mcp port),
   *  or re-attach by pid — rescanning discovery files for live endpoints. */
  attachManual(opts: { cdpUrl?: string; mirrorUrl?: string; mcpPort?: number; mcpToken?: string; pid?: number }): TargetSession {
    const pid = opts.pid ?? -(this.sessions.size + 1);
    this.suppressed.delete(pid);
    const explicit = !!(opts.cdpUrl || opts.mirrorUrl || opts.mcpPort);
    const ep: DiscoveredEndpoint = explicit ? {
      pid,
      mirror: opts.mirrorUrl ? { url: opts.mirrorUrl, token: "", port: 0 } : undefined,
      mcp: opts.mcpPort ? { port: opts.mcpPort, token: opts.mcpToken ?? null } : undefined,
      agent: opts.cdpUrl ? { cdpUrl: opts.cdpUrl } : undefined,
    } : (scanOnce().get(pid) ?? { pid });
    const existing = this.sessions.get(pid);
    if (existing) { existing.reattach(ep); return existing; }
    const s = new TargetSession(ep, {
      onStatus: () => this.syncStore(),
      onThreads: () => this.syncStore(),
      onPanels: () => this.syncStore(),
      onProfile: () => this.syncStore(),
      onSnapshot: () => this.syncStore(),
    });
    if (!ep.mirror && !ep.mcp && !ep.agent) s.status = "degraded";
    this.sessions.set(pid, s);
    this.endpoints.set(pid, ep);
    this.syncStore();
    return s;
  }

  detach(pid: number): void {
    const s = this.sessions.get(pid);
    if (s) {
      this.suppressed.add(pid);
      s.dispose();
      this.sessions.delete(pid);
      this.endpoints.delete(pid);
      this.syncStore();
      bumpTargets();
    }
  }

  active(): TargetSession | null {
    const id = store.getState().activeTargetId;
    if (id === null || id === undefined) return this.sessions.values().next().value ?? null;
    const pid = Number(id.replace("pid-", ""));
    return this.sessions.get(pid) ?? null;
  }

  setActive(id: string | null): void {
    store.setState({ activeTargetId: id });
    bumpTargets();
  }

  sessionById(id: string): TargetSession | null {
    const pid = Number(id.replace("pid-", ""));
    return this.sessions.get(pid) ?? null;
  }

  /** Push store-side target list. */
  syncStore(): void {
    const targets: TargetInfo[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      pid: s.pid,
      kind: s.kind,
      name: s.name,
      detail: s.detail,
      isSelf: s.isSelf || undefined,
      status: s.status,
      channels: s.channelFlags(),
      caps: [...s.caps],
      mcpTools: s.mcp?.toolNames() ?? [],
      panels: s.providers.map((p) => ({ slot: p.slot, name: p.name })),
      inspectorMethods: s.inspectorMethods,
      threads: s.threads.map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
      endpoints: [
        s.mirror ? { label: "mirror", url: "devtools-ws" } : null,
        s.cdp ? { label: "cdp", url: "inspector-ws" } : null,
        s.mcp ? { label: "mcp", url: `port ${s.mcp ? "" : ""}` } : null,
      ].filter(Boolean) as { label: string; url: string }[],
    }));
    const st = store.getState();
    const activeTargetId = st.activeTargetId && targets.some((t) => t.id === st.activeTargetId)
      ? st.activeTargetId
      : targets[0]?.id ?? null;
    const active = targets.find((t) => t.id === activeTargetId);
    store.setState({
      targets,
      activeTargetId,
      // World tab hides without a world/scene surface — don't stay on it.
      mainTab: st.mainTab === "world" && !targetHasWorld(active) ? "console" : st.mainTab,
    });
  }
}

// ── Feed endpoint discovery file (external tools read it) ──

export function writeFeedDiscovery(port: number, token: string): () => void {
  const files = [
    join(homedir(), ".downdraft", "devtools-feed.json"),
    // Agents built from older platform-native read the pre-rename filename —
    // keep writing it until the whole fleet is on the new contract.
    join(homedir(), ".downdraft", "platinum-feed.json"),
  ];
  try {
    const body = JSON.stringify({ pid: process.pid, port, token, startedAt: Date.now() });
    const written = files.filter((f) => { try { writeFileSync(f, body, { mode: 0o600 }); return true; } catch { return false; } });
    return () => { written.forEach((f) => { try { unlinkSync(f); } catch { /* gone */ } }); };
  } catch { return () => {}; }
}

export function readFeedDiscovery(): { pid: number; port: number; token: string } | null {
  for (const name of ["devtools-feed.json", "platinum-feed.json"].values()) {
    try {
      const file = join(homedir(), ".downdraft", name);
      if (!existsSync(file)) continue;
      return JSON.parse(readFileSync(file, "utf8"));
    } catch { /* try next */ }
  }
  return null;
}
