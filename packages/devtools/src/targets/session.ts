// ============================================================================
// session.ts — TargetSession: one attached target, all channels merged into
// the normalized model.
//
// Channels: mirror (devtools WS), cdp (inspector WS via agent/--inspect),
// mcp (HTTP automation), procfs (OS sampler), feed (external pushes land
// here via the FeedServer).
//
// Panels never talk to channels directly — they read session state and call
// session methods. State lives in plain structures + ring buffers; store
// version bumps nudge repaints (no per-point reactivity overhead).
// ============================================================================

import type { PanelSnapshot } from "@downdraft/engine/libraries/devtools";
import { createLogger } from "@downdraft/engine/util/logger";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bumpConsole, bumpEvents, bumpMetrics, bumpTargets } from "../app/store";
import { CdpClient } from "../cdp/client";
import type { DiscoveredEndpoint } from "../dd/discovery";
import { McpClient } from "../dd/mcp-client";
import { MirrorClient, type MirrorHello } from "../dd/mirror-client";
import type {
    ConsoleEntry, CpuProfile, EventMarker, HeapSnapshotInfo, MetricSeries,
    NetworkEvent, PluginRec, ProviderPanel, RemoteObjectRef, ThreadRec,
} from "./model";
import { pushPoint } from "./model";
import { previewRemote } from "./preview";
import { ProcfsSampler, procDisplayName } from "./procfs";

const log = createLogger();

const CONSOLE_CAP = 8000;
const METRIC_CAP = 720;        // ~6min @500ms
const EVENT_CAP = 500;
const PROFILE_CAP = 8;         // keep the newest N captures
const NET_CAP = 2000;

export interface SessionEvents {
  onStatus: (s: TargetSession) => void;
  onThreads: (s: TargetSession) => void;
  onPanels: (s: TargetSession) => void;
  onProfile: (s: TargetSession, profile: CpuProfile) => void;
  onSnapshot: (s: TargetSession, slot: number, name: string, snap: PanelSnapshot) => void;
}

const noSessionEvents: SessionEvents = {
  onStatus: () => {}, onThreads: () => {}, onPanels: () => {},
  onProfile: () => {}, onSnapshot: () => {},
};

export class TargetSession {
  readonly id: string;
  readonly pid: number;
  /** True when this session points at the current process (embedded mount). */
  readonly isSelf: boolean;
  name: string;
  /** Secondary label — runtime binary + cwd basename (from /proc). */
  detail = "";
  kind: "downdraft" | "cdp" = "downdraft";
  status: "connecting" | "attached" | "degraded" | "lost" = "connecting";

  mirror: MirrorClient | null = null;
  cdp: CdpClient | null = null;
  mcp: McpClient | null = null;
  procfs: ProcfsSampler | null = null;

  // ── normalized state ──
  consoleEntries: ConsoleEntry[] = [];
  private seq = 0;
  threads: ThreadRec[] = [{ id: "main", name: "main", kind: 0, series: [] }];
  series = new Map<string, MetricSeries>();
  providers: ProviderPanel[] = [];
  inspectorMethods: string[] = [];
  plugins: PluginRec[] = [];
  /** devtools-agent extras: command server + feed routing key + caps. */
  agentCmdPort = 0;
  agentFeedKey = "";
  agentCaps = new Set<string>();
  events: EventMarker[] = [];
  private evSeq = 0;
  network: NetworkEvent[] = [];
  /** Requests older than NET_CAP spill to a JSONL log so the table keeps
   *  unbounded history without growing memory. */
  netSpilled = 0;
  netLogPath: string | null = null;
  private netLogBuf: NetworkEvent[] = [];
  profiles: CpuProfile[] = [];
  heapSnapshots: HeapSnapshotInfo[] = [];
  profiling = false;
  /** Max capture duration before the profile auto-stops (buffer bound). */
  profileMaxMs = 120000;
  /** When the in-flight profile started (ms) — for the recording indicator. */
  profilingSince = 0;
  /** Last known scripts from Debugger.scriptParsed. */
  scripts = new Map<string, { url: string; startLine: number; endLine: number }>();
  /** console.group stack per thread. */
  private groupStack = new Map<string, string[]>();
  private countMap = new Map<string, number>();
  private ev: SessionEvents;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ep: DiscoveredEndpoint, ev?: Partial<SessionEvents>) {
    this.id = `pid-${ep.pid}`;
    this.pid = ep.pid;
    this.isSelf = ep.pid === process.pid;
    this.name = `pid ${ep.pid}`;
    const pn = procDisplayName(ep.pid);
    if (pn) { this.name = pn.name; this.detail = pn.detail; }
    this.ev = { ...noSessionEvents, ...ev };
    this.attach(ep);
  }

  // ── Channel attach ──

  attach(ep: DiscoveredEndpoint): void {
    if (ep.mirror && !this.mirror) {
      this.mirror = new MirrorClient(ep.mirror.url, {
        onHello: (h) => this.onMirrorHello(h),
        onEvent: (event, data) => this.onMirrorEvent(event, data),
        onClose: () => this.onChannelClose("mirror"),
        onOpen: () => this.markEvent("lifecycle", "devtools ws connected"),
      });
      this.mirror.connect();
    }
    if (ep.mcp && !this.mcp) {
      this.mcp = new McpClient(ep.mcp.port, ep.mcp.token);
      void this.mcp.initialize().then(() => {
        this.markEvent("lifecycle", `mcp tools: ${this.mcp!.toolNames().length}`);
        if (this.status === "connecting") this.status = "attached";
        // The app's real name beats the script basename (/proc gave us).
        const serverName = this.mcp!.serverInfo.name?.replace(/-automation$/, "");
        if (serverName) this.name = serverName;
        this.updateCaps();
        this.refreshPlugins();
        this.ev.onStatus(this);
      }).catch(() => { this.mcp = null; });
    }
    if (ep.agent?.cdpUrl && !this.cdp) {
      this.cdp = new CdpClient(ep.agent.cdpUrl, {
        onEvent: (method, params) => this.onCdpEvent(method, params),
        onClose: () => this.onChannelClose("cdp"),
      });
      void this.cdp.connect().then(() => this.enableCdpDomains());
    }
    if (ep.agent) {
      this.agentCmdPort = ep.agent.cmdPort ?? this.agentCmdPort;
      this.agentFeedKey = ep.agent.feedKey ?? this.agentFeedKey;
      (ep.agent.caps ?? []).forEach((x) => this.agentCaps.add(x));
    }
    if (!this.procfs) {
      this.procfs = new ProcfsSampler(this.pid, (s) => this.onProcSample(s));
      this.procfs.start();
    }
    this.updateCaps();
  }

  private onChannelClose(which: "mirror" | "cdp"): void {
    if (which === "mirror") this.mirror = null;
    if (which === "cdp") this.cdp = null;
    this.status = "degraded";
    this.markEvent("lifecycle", `${which} channel closed`);
    this.updateCaps();
    this.ev.onStatus(this);
  }

  /** Periodic re-scan pass: call when discovery adds channels or to retry. */
  reattach(ep: DiscoveredEndpoint): void {
    this.attach(ep);
    if (this.status === "lost") this.status = "connecting";
  }

  // ── Capabilities ──

  caps = new Set<string>();

  private updateCaps(): void {
    const c = this.caps;
    c.clear();
    if (this.mirror?.connected) {
      ["console", "threads", "metrics", "profile-cpu", "eval", "panels", "commands", "inspector"].forEach((x) => c.add(x));
    }
    if (this.cdp?.connected) {
      ["console", "eval", "remote-objects", "scripts", "heap-usage"].forEach((x) => c.add(x));
    }
    if (this.mcp) {
      c.add("mcp");
      if (this.mcp.hasTool("plugin_list")) c.add("plugins");
      if (this.mcp.hasTool("capture_screenshot")) c.add("screenshot");
    }
    if (this.procfs) ["procfs", "disk", "threads-os"].forEach((x) => c.add(x));
    if (this.agentCmdPort || this.agentFeedKey) {
      c.add("agent");
      this.agentCaps.forEach((x) => c.add(`agent:${x}`));
    }
    bumpTargets();
  }

  channelFlags(): Partial<Record<"mirror" | "cdp" | "mcp" | "procfs", boolean>> {
    return {
      mirror: this.mirror?.connected ?? false,
      cdp: this.cdp?.connected ?? false,
      mcp: !!this.mcp,
      procfs: !!this.procfs,
    };
  }

  // ── Console normalization ──

  private pushEntry(e: Omit<ConsoleEntry, "seq">): ConsoleEntry {
    const entry: ConsoleEntry = { ...e, seq: this.seq++ };
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > CONSOLE_CAP) {
      this.consoleEntries.splice(0, this.consoleEntries.length - CONSOLE_CAP);
    }
    bumpConsole();
    return entry;
  }

  addEntry(e: Omit<ConsoleEntry, "seq">): ConsoleEntry {
    return this.pushEntry(e);
  }

  systemNote(text: string, sev: ConsoleEntry["severity"] = 1): void {
    this.pushEntry({ ts: nowMs(), source: "system", severity: sev, thread: "devtools", text });
  }

  markEvent(kind: EventMarker["kind"], label: string, detail?: string): void {
    this.events.push({ seq: this.evSeq++, ts: nowMs(), kind, label, detail });
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
    bumpEvents();
  }

  /** Single push path for captured profiles — clears recording state,
   *  caps retention to the newest PROFILE_CAP captures, notifies listeners. */
  private _pushProfile(prof: CpuProfile): void {
    this.profiles.push(prof);
    while (this.profiles.length > PROFILE_CAP) this.profiles.shift();
    this.profiling = false;
    this.profilingSince = 0;
    this.markEvent("profile", `cpu profile: ${prof.nodes.length} nodes`);
    this.ev.onProfile(this, prof);
  }

  /** Auto-stop the capture once it exceeds the buffer bound. Called
   *  periodically from surfaces; returns true when it stopped. */
  checkProfileLimit(): boolean {
    if (!this.profiling || this.profilingSince <= 0) return false;
    if (Date.now() - this.profilingSince < this.profileMaxMs) return false;
    const lim = this.profileMaxMs / 1000;
    void this.profileStop().then(() =>
        this.systemNote(`CPU profile auto-stopped — ${lim}s buffer limit`));
    return true;
  }

  // ── Mirror events ──

  private onMirrorHello(h: MirrorHello): void {
    this.providers = (h.panels ?? []).map((p) => ({ slot: p.slot, name: p.name }));
    this.inspectorMethods = h.inspector ?? h.inspectorMethods ?? [];
    this.status = "attached";
    this.markEvent("attach", "devtools attached", `panels=${this.providers.length}`);
    this.systemNote(`devtools attached — panels: ${this.providers.map((p) => p.name).join(", ") || "none"}`);
    this.updateCaps();
    this.ev.onPanels(this);
    this.ev.onStatus(this);
    bumpTargets();
  }

  private onMirrorEvent(event: string, data: unknown): void {
    switch (event) {
      case "console": {
        const d = data as { text?: string; severity?: number; thread?: string; ts?: number };
        // Dedupe vs CDP: the same console.* call may already have arrived as
        // a richer consoleAPICalled row (args + stack + url). Match on
        // normalized text within a short window.
        const text = d.text ?? "";
        if (this.cdp?.connected && (d.thread ?? "main") === "main" && this.matchRecent(text)) break;
        this.pushEntry({
          ts: d.ts ?? nowMs(), source: "log",
          severity: (d.severity ?? 0) as ConsoleEntry["severity"],
          thread: d.thread ?? "main", text,
        });
        break;
      }
      case "console.clear":
        this.consoleEntries.length = 0;
        bumpConsole();
        break;
      case "threads": {
        const list = (data as { id: string; name: string; kind: number }[]) ?? [];
        this.threads = list.map((t) => ({
          id: t.id, name: t.name, kind: t.kind,
          series: this.threads.find((x) => x.id === t.id)?.series ?? [],
        }));
        // Resolve eval capability: eval handlers arrive under their registered
        // id ("main", "io", …) while profiling slots are "slot-N". A slot whose
        // name matches an eval thread (modulo a worker/thread suffix) scopes
        // onto it; otherwise the lane is inspect-only.
        const evalIds = new Set(this.threads
          .filter((x) => x.id === "main" || !/^slot-\d+$/.test(x.id))
          .map((x) => x.id));
        const norm = (n: string) => n.toLowerCase().replace(/[-_.]?(worker|thread|sim)$/i, "");
        this.threads.forEach((thr) => {
          if (evalIds.has(thr.id)) thr.evalId = thr.id;
          else thr.evalId = this.threads.find((x) => evalIds.has(x.id) &&
            (x.name === thr.name || norm(x.name) === norm(thr.name)))?.id ?? null;
        });
        this.ev.onThreads(this);
        bumpTargets();
        break;
      }
      case "metrics": {
        const slots = (data as {
          slotIndex: number; name: string; runtime?: number;
          history?: { cpuPercent: number; heapUsed: number; heapTotal: number; gcPauseMaxUs: number; taskLatencyP95Us: number }[];
        }[]) ?? [];
        const t = Date.now() / 1000;
        slots.forEach((slot) => {
          const h = slot.history?.[slot.history.length - 1];
          if (!h) return;
          const g = `thread:${slot.name || slot.slotIndex}`;
          this.point(`${g}.cpu`, "CPU", "%", g, t, h.cpuPercent);
          this.point(`${g}.heap`, "Heap used", "B", g, t, h.heapUsed);
          this.point(`${g}.gc`, "GC pause max", "us", g, t, h.gcPauseMaxUs);
          this.point(`${g}.taskp95`, "Task p95", "us", g, t, h.taskLatencyP95Us);
          const thr = this.threads.find((x) => x.name === slot.name || x.id === `slot-${slot.slotIndex}`);
          if (thr && !thr.series.includes(`${g}.cpu`)) {
            thr.series.push(`${g}.cpu`, `${g}.heap`, `${g}.gc`, `${g}.taskp95`);
          }
        });
        bumpMetrics();
        break;
      }
      case "profile": {
        const p = data as { nodes?: { id: number; hitCount: number; callFrame: string; url: string; line: number; children: number[] }[]; startUs?: number; endUs?: number; samples?: number[]; timeDeltasUs?: number[] };
        const prof: CpuProfile = {
          nodes: (p.nodes ?? []).map((n) => ({
            id: n.id, functionName: n.callFrame, url: n.url, line: n.line,
            hitCount: n.hitCount, children: n.children ?? [],
          })),
          startUs: p.startUs ?? 0, endUs: p.endUs ?? 0,
          samples: p.samples ?? [], timeDeltasUs: p.timeDeltasUs ?? [],
          source: "mirror",
        };
        this._pushProfile(prof);
        this.systemNote(`CPU profile captured — ${prof.nodes.length} nodes, ${prof.samples.length} samples`);
        break;
      }
      case "snapshot": {
        const d = data as { panel?: string; slot?: number; snap?: PanelSnapshot };
        const slot = d.slot ?? 0;
        const name = d.panel ?? `slot-${slot}`;
        const pp = this.providers.find((x) => x.slot === slot);
        if (pp) { pp.lastSnapshot = d.snap; pp.lastPush = nowMs(); }
        else this.providers.push({ slot, name, lastSnapshot: d.snap, lastPush: nowMs() });
        this.ev.onSnapshot(this, slot, name, d.snap ?? { sections: [] });
        bumpTargets();
        break;
      }
      default:
        break;
    }
  }

  // ── CDP events ──

  private async enableCdpDomains(): Promise<void> {
    const c = this.cdp;
    if (!c?.connected) return;
    await c.tryCall("Runtime.enable");
    await c.tryCall("Debugger.enable");
    await c.tryCall("Runtime.setAsyncCallStackDepth", { maxDepth: 32 });
    this.status = this.status === "connecting" ? "attached" : this.status;
    this.markEvent("attach", "cdp channel live");
    this.updateCaps();
    this.ev.onStatus(this);
  }

  private onCdpEvent(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const type = String(p.type ?? "log");
        const rawArgs = (p.args as Record<string, unknown>[] ?? []).map((a) => this.remoteRef(a));
        const { text, args } = this.buildArgsDisplay(rawArgs);
        const frames = ((p.stackTrace as { callFrames?: Record<string, unknown>[] })?.callFrames ?? [])
          .map((f) => ({
            functionName: String(f.functionName ?? "<anon>"),
            url: String(f.url ?? ""), line: Number(f.lineNumber ?? 0) + 1, col: Number(f.columnNumber ?? 0) + 1,
          }));
        const sev = type === "error" || type === "assert" ? 3 : type === "warning" ? 2 : type === "debug" || type === "dir" ? 4 : type === "trace" ? 5 : type === "info" ? 1 : 0;

        // Mirror-connected: the same console.* call arrives via the mirror's
        // logger bridge too. Merge CDP's rich args/stack into that row.
        if (this.mirror?.connected && type !== "group" && type !== "groupEnd" && type !== "groupCollapsed") {
          const twin = this.findTwin(text, sev);
          if (twin) {
            twin.text = this.cleanMirrorText(twin.text);
            twin.args = args;
            twin.stack = frames;
            twin.url = frames[0]?.url ?? twin.url;
            twin.line = frames[0]?.line ?? twin.line;
            twin.col = frames[0]?.col ?? twin.col;
            twin.consoleType = type;
            bumpConsole();
            return;
          }
        }

        if (type === "group" || type === "groupCollapsed") {
          const g = this.groupStack.get("main") ?? [];
          g.push(text);
          this.groupStack.set("main", g);
        } else if (type === "groupEnd") {
          this.groupStack.get("main")?.pop();
        }
        if (type === "count") {
          const label = text || "default";
          const n = (this.countMap.get(label) ?? 0) + 1;
          this.countMap.set(label, n);
          this.pushEntry({
            ts: nowMs(), source: "console-api", consoleType: type,
            severity: sev as ConsoleEntry["severity"], thread: "main",
            text: `${label}: ${n}`, args, stack: frames,
            count: { label, n },
          });
          return;
        }
        this.pushEntry({
          ts: Number(p.timestamp ?? 0) / 1000 || nowMs(), source: "console-api",
          consoleType: type,
          severity: sev as ConsoleEntry["severity"], thread: "main",
          text, args, stack: frames,
          url: frames[0]?.url, line: frames[0]?.line, col: frames[0]?.col,
          group: this.groupStack.get("main")?.slice(-1)[0],
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = (p.exceptionDetails ?? {}) as {
          text?: string; exception?: { description?: string; className?: string };
          stackTrace?: { callFrames?: Record<string, unknown>[] };
          url?: string; lineNumber?: number; columnNumber?: number;
        };
        const frames = (d.stackTrace?.callFrames ?? []).map((f) => ({
          functionName: String(f.functionName ?? "<anon>"),
          url: String(f.url ?? ""), line: Number(f.lineNumber ?? 0) + 1, col: Number(f.columnNumber ?? 0) + 1,
        }));
        this.pushEntry({
          ts: nowMs(), source: "exception", severity: 3, thread: "main",
          text: d.exception?.description ?? d.text ?? "Uncaught exception",
          stack: frames, url: d.url, line: d.lineNumber, col: d.columnNumber,
        });
        break;
      }
      case "Debugger.scriptParsed": {
        const url = String(p.url ?? "");
        if (url) {
          this.scripts.set(String(p.scriptId), {
            url, startLine: Number(p.startLine ?? 0), endLine: Number(p.endLine ?? 0),
          });
        }
        break;
      }
      case "Network.requestWillBeSent": this.onNetRequest(p); break;
      case "Network.responseReceived": this.onNetResponse(p); break;
      case "Network.loadingFinished": this.onNetFinished(p); break;
      case "Network.loadingFailed": this.onNetFailed(p); break;
      case "Network.webSocketCreated": this.onWsCreated(p); break;
      default: break;
    }
  }

  /**
   * Split CDP console args into (a) display text built from primitives — with
   * printf-style %s/%d/%i/%f/%o/%O/%c substitution — and (b) the remaining
   * object/function args rendered as inline previews. Keeps text from
   * duplicating what the arg previews already show.
   */
  private buildArgsDisplay(raw: RemoteObjectRef[]): { text: string; args: RemoteObjectRef[] } {
    const rest = raw.slice();
    const parts: string[] = [];
    const first = rest[0];
    if (first?.type === "string" && /%[sdifoOc]/.test(String(first.value ?? ""))) {
      rest.shift();
      parts.push(String(first.value ?? "").replace(/%([sdifoOc])/g, (spec, s: string) => {
        const a = rest.shift();
        if (!a) return spec;
        if (s === "c") return "";
        if (s === "d" || s === "i") return String(parseInt(String(a.value ?? a.description ?? "NaN"), 10));
        if (s === "f") return String(parseFloat(String(a.value ?? a.description ?? "NaN")));
        if (s === "s") return String(a.value ?? a.description ?? "");
        return previewRemote(a);
      }));
    }
    for (;;) {
      const a = rest[0];
      if (!a) break;
      if (a.type === "string") { parts.push(String(a.value ?? "")); rest.shift(); continue; }
      if (a.type === "number" || a.type === "bigint" || a.type === "boolean" || a.type === "undefined" || a.type === "symbol") {
        parts.push(previewRemote(a)); rest.shift(); continue;
      }
      break;
    }
    return { text: parts.join(" ").trim(), args: rest };
  }

  /** Strip "[object X]" placeholders — the merged args carry the real preview. */
  private cleanMirrorText(t: string): string {
    return t.replace(/\s*\[[oO]bject[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim();
  }

  /** Normalized text for mirror↔CDP console dedupe (quotes, placeholders, blobs stripped). */
  private normText(s: string): string {
    return s
      .replace(/"([^"]*)"/g, "$1")
      .replace(/\[[oO]bject[^\]]*\]/g, "")
      .replace(/\{[^{}]*\}/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }

  /** Do two normalized console texts describe the same log call? */
  private normMatch(a: string, b: string): boolean {
    if (a === b) return true;
    if (a === "" || b === "") return true; // [object X] / JSON-only rows pair up
    return a.startsWith(b) || b.startsWith(a); // CDP appends arg descriptions
  }

  /** Find a recent mirror "log" row that matches this CDP call (merge target). */
  private findTwin(cdpText: string, sev: number): ConsoleEntry | null {
    const want = this.normText(cdpText);
    const tail = this.consoleEntries.slice(-16);
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i]!;
      if (e.source !== "log" || e.thread !== "main" || e.severity !== sev) continue;
      if (this.normMatch(this.normText(e.text), want)) return e;
    }
    return null;
  }

  /** Does a recent CDP "console-api" row already cover this mirror text? */
  private matchRecent(mirrorText: string): boolean {
    const want = this.normText(mirrorText);
    const tail = this.consoleEntries.slice(-16);
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i]!;
      if (e.source !== "console-api" || e.thread !== "main") continue;
      if (this.normMatch(this.normText(e.text), want)) return true;
    }
    return false;
  }

  private remoteRef(a: Record<string, unknown>): RemoteObjectRef {
    return {
      type: String(a.type ?? "object"),
      subtype: a.subtype as string | undefined,
      className: a.className as string | undefined,
      value: a.value,
      unserializableValue: a.unserializableValue as string | undefined,
      description: a.description as string | undefined,
      objectId: a.objectId as string | undefined,
      expandable: !!a.objectId,
      previewProps: ((a.preview as { properties?: { name: string; type?: string; value?: unknown }[] } | undefined)?.properties ?? undefined),
    };
  }

  // ── Network normalization (CDP + agent-pushed identical shapes) ──

  private netId(p: Record<string, unknown>): string {
    return String(p.requestId ?? "");
  }

  private onNetRequest(p: Record<string, unknown>): void {
    const req = p.request as { url?: string; method?: string } | undefined;
    this.network.push({
      id: this.netId(p), ts: Number(p.timestamp ?? Date.now() / 1000),
      method: req?.method ?? "GET", url: req?.url ?? "",
      reqBytes: 0,
    });
    this.trimNetwork();
    bumpMetrics();
  }

  private onNetResponse(p: Record<string, unknown>): void {
    const id = this.netId(p);
    const ev = this.network.find((n) => n.id === id);
    const res = p.response as { status?: number; mimeType?: string; protocol?: string; timing?: Record<string, number>; encodedDataLength?: number } | undefined;
    if (ev && res) {
      ev.status = res.status;
      ev.mime = res.mimeType;
      ev.protocol = res.protocol;
      bumpMetrics();
    }
  }

  private onNetFinished(p: Record<string, unknown>): void {
    const id = this.netId(p);
    const ev = this.network.find((n) => n.id === id);
    if (ev) {
      ev.finished = true;
      ev.resBytes = Number(p.encodedDataLength ?? 0);
      bumpMetrics();
    }
  }

  private onNetFailed(p: Record<string, unknown>): void {
    const id = this.netId(p);
    const ev = this.network.find((n) => n.id === id);
    if (ev) { ev.finished = true; ev.error = String(p.errorText ?? "failed"); bumpMetrics(); }
  }

  private onWsCreated(p: Record<string, unknown>): void {
    const url = (p as { url?: string }).url ?? "";
    this.network.push({ id: this.netId(p), ts: nowMs() / 1000, method: "WS", url, protocol: "ws" });
    bumpMetrics();
  }

  /** External feed → network lane (agent fetch-wrap + arbitrary tools). */
  pushNetworkEvent(ev: NetworkEvent): void {
    const existing = this.network.findIndex((n) => n.id === ev.id);
    if (existing >= 0) this.network[existing] = { ...this.network[existing]!, ...ev };
    else this.network.push(ev);
    this.trimNetwork();
    bumpMetrics();
  }

  /** Cap the in-memory request log; spill overflow to a JSONL artifact. */
  private trimNetwork(): void {
    if (this.network.length <= NET_CAP) return;
    const spilled = this.network.splice(0, this.network.length - NET_CAP);
    this.netSpilled += spilled.length;
    this.netLogBuf.push(...spilled);
    if (this.netLogBuf.length >= 64) this.flushNetLog();
  }

  private flushNetLog(): void {
    if (!this.netLogBuf.length) return;
    try {
      if (!this.netLogPath) {
        const dir = join(homedir(), ".local", "share", "downdraft-devtools");
        mkdirSync(dir, { recursive: true });
        this.netLogPath = join(dir, `netlog-${this.pid}.jsonl`);
      }
      appendFileSync(this.netLogPath, this.netLogBuf.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch { /* best-effort paging */ }
    this.netLogBuf = [];
  }

  // ── Procfs ──

  private onProcSample(s: import("./procfs").ProcSample): void {
    const g = "proc";
    this.point("proc.cpu", "CPU (proc)", "%", g, s.ts, s.cpuPercent);
    this.point("proc.rss", "RSS", "B", g, s.ts, s.rssBytes);
    this.point("proc.io.r", "IO read", "B", g, s.ts, s.ioReadRate);
    this.point("proc.io.w", "IO write", "B", g, s.ts, s.ioWriteRate);
    this.point("proc.iops", "IOPS", "ops", g, s.ts, s.ioReadOps + s.ioWriteOps);
    this.point("proc.fds", "FDs", "count", g, s.ts, s.fdCount);
    this.point("proc.threads", "Threads", "count", g, s.ts, s.threadCount);
    bumpMetrics();
  }

  // ── Series ──

  point(id: string, label: string, unit: MetricSeries["unit"], group: string, t: number, v: number): MetricSeries {
    let s = this.series.get(id);
    if (!s) {
      s = { id, label, unit, group, t: [], v: [], cap: METRIC_CAP, min: Infinity, max: -Infinity };
      this.series.set(id, s);
    }
    pushPoint(s, t, v);
    return s;
  }

  /** Feed API → series. */
  feedPoint(seriesId: string, label: string, unit: MetricSeries["unit"], t: number, v: number): void {
    this.point(seriesId, label, unit, `feed:${seriesId.split(".")[0]}`, t, v);
    bumpMetrics();
  }

  // ── Commands (panels call these) ──

  /** Evaluate JS. Prefers CDP (rich objects), falls back to mirror/thread eval. */
  async eval(expr: string, thread = "main", opts: { awaitPromise?: boolean } = {}): Promise<{ result?: unknown; error?: string; remote?: RemoteObjectRef }> {
    // A profiling-slot id ("slot-N") may alias a registered eval thread.
    const rec = this.threads.find((x) => x.id === thread);
    if (thread !== "main" && rec?.evalId && rec.evalId !== thread) thread = rec.evalId;
    // CDP evaluates in the main context — worker threads need the mirror path.
    if (this.cdp?.connected && thread === "main") {
      try {
        type EvalRes = {
          result?: Record<string, unknown>;
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        let res = await this.cdp.call<EvalRes>("Runtime.evaluate", {
          expression: expr, returnByValue: false, awaitPromise: false,
          replMode: true, generatePreview: true,
        });
        // Bun's inspector rejects awaitPromise on non-promise results, so
        // await explicitly only when the result is actually a promise.
        const r0 = res.result;
        if (!res.exceptionDetails && opts.awaitPromise !== false &&
            (r0?.subtype === "promise" || r0?.className === "Promise") &&
            typeof r0.objectId === "string") {
          const awaited = await this.cdp.tryCall<EvalRes>("Runtime.awaitPromise", {
            promiseObjectId: r0.objectId, returnByValue: false, generatePreview: true,
          }).catch(() => undefined);
          if (awaited) res = awaited;
        }
        if (res.exceptionDetails) {
          return { error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "eval error" };
        }
        const r = res.result;
        if (r) {
          return {
            result: r.value ?? r.description,
            remote: this.remoteRef(r),
          };
        }
        return { result: undefined };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    if (this.mirror?.connected) {
      try {
        const res = await this.mirror.call<{ result?: unknown; error?: string }>("eval", { thread, expr });
        return { result: res?.result, error: res?.error };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    return { error: "no eval channel" };
  }

  /**
   * REPL eval: pushes the echo row + a pending result row immediately, then
   * fills the result row when the eval resolves. Async/promise results show
   * their live state — `asyncState` flips pending → resolved/rejected.
   */
  async repl(expr: string, thread = "main"): Promise<{ echo: ConsoleEntry; result: ConsoleEntry }> {
    const echo = this.pushEntry({
      ts: nowMs(), source: "repl-echo", severity: 0, thread, text: expr,
    });
    const resultRow = this.pushEntry({
      ts: nowMs(), source: "repl-result", severity: 0, thread,
      text: "⏳", asyncState: "pending", forSeq: echo.seq,
    });
    const done = this.eval(expr, thread, { awaitPromise: true });
    done.then((out) => {
      if (out.error) {
        resultRow.text = out.error;
        resultRow.severity = 3;
        resultRow.asyncState = "rejected";
      } else if (out.remote) {
        resultRow.args = [out.remote];
        resultRow.text = "";
        resultRow.asyncState = "resolved";
      } else {
        const r = out.result;
        resultRow.text = r === undefined ? "undefined" : typeof r === "string" ? r : JSON.stringify(r, null, 2) ?? String(r);
        resultRow.asyncState = "resolved";
      }
      bumpConsole();
    }).catch((e) => {
      resultRow.text = String(e);
      resultRow.severity = 3;
      resultRow.asyncState = "rejected";
      bumpConsole();
    });
    return { echo, result: resultRow };
  }

  /** Lazy property expansion for RemoteObjectRef (CDP only). */
  async getProperties(objectId: string): Promise<{ name: string; value?: RemoteObjectRef; writable?: boolean }[]> {
    if (!this.cdp?.connected) return [];
    try {
      const res = await this.cdp.call<{ result?: { name: string; value?: Record<string, unknown>; writable?: boolean }[] }>(
        "Runtime.getProperties", { objectId, ownProperties: true });
      return (res.result ?? []).map((p) => ({
        name: p.name, writable: p.writable,
        value: p.value ? this.remoteRef(p.value) : undefined,
      }));
    } catch { return []; }
  }

  async callFunctionOn(objectId: string, fn: string, args: unknown[] = []): Promise<{ result?: RemoteObjectRef; error?: string }> {
    if (!this.cdp?.connected) return { error: "no cdp" };
    try {
      const res = await this.cdp.call<{ result?: Record<string, unknown> }>("Runtime.callFunctionOn", {
        objectId, functionDeclaration: fn,
        arguments: args.map((a) => ({ value: a })),
        returnByValue: false,
      });
      return { result: res.result ? this.remoteRef(res.result) : undefined };
    } catch (e) { return { error: (e as Error).message }; }
  }

  async consoleClear(): Promise<void> {
    this.consoleEntries.length = 0;
    this.countMap.clear();
    bumpConsole();
    try { await this.mirror?.call("console.clear"); } catch { /* optional */ }
  }

  async profileStart(): Promise<boolean> {
    if (this.profiling) return false;
    const hasChannel = !!(this.cdp?.connected || this.mirror?.connected || this.agentCmdPort);
    if (!hasChannel) {
      this.systemNote("no CPU profiling channel on this target (needs mirror, CDP, or agent)", 2);
      return false;
    }
    this.profiling = true;
    let started = false;
    try {
      if (this.cdp?.connected) {
        started = (await this.cdp.tryCall("Profiler.start")) !== undefined;
      }
      if (!started && this.mirror?.connected) {
        await this.mirror.call("profile.start");
        started = true;
      }
      if (!started && this.agentCmdPort) {
        const r = await this.agentCall("/profile/start") as { ok?: boolean } | undefined;
        started = !!r?.ok;
      }
    } catch (e) {
      log.warn("session", `profileStart: ${e}`);
    }
    this.profiling = started;
    this.profilingSince = started ? Date.now() : 0;
    if (started) {
      this.markEvent("profile", "cpu profile started");
      this.systemNote(`CPU profile recording — auto-stops at ${this.profileMaxMs / 1000}s buffer`);
    }
    else this.systemNote("CPU profile failed to start — target may not expose a profiler", 2);
    return started;
  }

  async profileStop(): Promise<CpuProfile | null> {
    if (!this.profiling) return null;
    try {
      if (this.cdp?.connected) {
        const res = await this.cdp.tryCall<{ profile?: { nodes?: { id: number; hitCount: number; callFrame: { functionName?: string; url?: string; lineNumber?: number }; children?: number[] }[]; startTime?: number; endTime?: number; samples?: number[]; timeDeltas?: number[] } }>("Profiler.stop");
        if (res?.profile) {
          this.profiling = false;
          this.profilingSince = 0;
          const prof: CpuProfile = {
            nodes: (res.profile.nodes ?? []).map((n) => ({
              id: n.id, functionName: n.callFrame?.functionName ?? "?",
              url: n.callFrame?.url ?? "", line: n.callFrame?.lineNumber ?? 0,
              hitCount: n.hitCount ?? 0, children: n.children ?? [],
            })),
            startUs: res.profile.startTime ?? 0, endUs: res.profile.endTime ?? 0,
            samples: res.profile.samples ?? [], timeDeltasUs: res.profile.timeDeltas ?? [],
            source: "cdp",
          };
          this._pushProfile(prof);
          return prof;
        }
      }
      if (this.mirror?.connected) {
        // Result arrives as the "profile" event.
        await this.mirror.call("profile.stop");
        return null;
      }
      if (this.agentCmdPort) {
        // Profile arrives as a feed "profile" push.
        const r = await this.agentCall("/profile/stop") as { ok?: boolean } | undefined;
        if (r?.ok) return null;
      }
    } catch (e) {
      log.warn("session", `profileStop: ${e}`);
    }
    this.profiling = false;
    this.profilingSince = 0;
    return null;
  }

  /** devtools-agent command server (loopback HTTP). */
  async agentCall(path: string): Promise<unknown> {
    if (!this.agentCmdPort) return { error: "no agent" };
    try {
      const res = await fetch(`http://127.0.0.1:${this.agentCmdPort}${path}`, { method: "POST" });
      return await res.json();
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /** Heap snapshot via the agent's jsc channel (result pushed over feed). */
  async heapSnapshot(): Promise<boolean> {
    const r = await this.agentCall("/snapshot") as { ok?: boolean; error?: string } | undefined;
    if (r?.ok) {
      this.markEvent("snapshot", "heap snapshot requested");
      return true;
    }
    if (r?.error) this.systemNote(`heap snapshot failed: ${r.error}`, 3);
    return false;
  }

  /** Provider panel RPC — fetch a fresh snapshot. */
  async snapshot(slot: number | string): Promise<PanelSnapshot | null> {
    if (!this.mirror?.connected) return null;
    try {
      return await this.mirror.call<PanelSnapshot>("snapshot", { panel: slot });
    } catch { return null; }
  }

  /** Fetch + store a provider snapshot so surfaces can render it. */
  async pollProvider(slotOrName: number | string): Promise<PanelSnapshot | null> {
    const snap = await this.snapshot(slotOrName);
    if (snap) {
      const p = typeof slotOrName === "string"
        ? this.providers.find((x) => x.name === slotOrName)
        : this.providers.find((x) => x.slot === slotOrName);
      if (p) { p.lastSnapshot = snap; p.lastPush = Date.now(); }
    }
    return snap;
  }

  /** Find a provider panel by name (engine slots use stable names). */
  provider(name: string): ProviderPanel | undefined {
    return this.providers.find((p) => p.name === name);
  }

  /** Provider control activation. */
  async panelCommand(panel: number | string, action: string, payload = ""): Promise<void> {
    try { await this.mirror?.call("command", { panel, action, payload }); } catch { /* optional */ }
  }

  /** __downdraftDevtools.* inspector call. */
  async inspectorCall(method: string, args: unknown[] = []): Promise<unknown> {
    try { return await this.mirror?.call("inspector.call", { method, args }); } catch (e) { return { error: (e as Error).message }; }
  }

  async mcpCall<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T | { error: string }> {
    if (!this.mcp) return { error: "no mcp" };
    try { return await this.mcp.call<T>(tool, args); } catch (e) { return { error: (e as Error).message }; }
  }

  async refreshPlugins(): Promise<void> {
    if (!this.mcp?.hasTool("plugin_list")) { this.plugins = []; return; }
    try {
      const res = await this.mcpCall<{ plugins?: PluginRec[] } | PluginRec[]>("plugin_list");
      const list = Array.isArray(res) ? res : (res as { plugins?: PluginRec[] }).plugins ?? [];
      this.plugins = list.map((p) => ({ ...p }));
    } catch { this.plugins = []; }
    bumpTargets();
  }

  dispose(): void {
    this.flushNetLog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.mirror?.dispose();
    this.cdp?.dispose();
    this.procfs?.stop();
    this.mirror = null; this.cdp = null; this.procfs = null; this.mcp = null;
    this.status = "lost";
    bumpTargets();
  }
}

function nowMs(): number {
  return Date.now();
}
