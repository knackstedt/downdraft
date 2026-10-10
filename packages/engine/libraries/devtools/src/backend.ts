// ============================================================================
// backend.ts — DevtoolsBackend: transport-neutral devtools data engine.
//
// Owns the provider/command registry, thread evals, collector context, CDP +
// logger-sink wiring, and the per-frame push cadence. Frontends differ only
// in how events leave the process: WebDevtoolsMirror emits JSON over the
// DevToolsServer WebSocket; the docked Blitz devtools host emits into its
// in-process UI state. Both subscribe to the same event names and dispatch
// the same RPC methods.
//
// Events emitted: console, threads, scene, dom, gpu, metrics, snapshot,
// profile, console.clear.
// RPC handled (via dispatch): ping, eval, snapshot, command, sceneTree,
// domTree, gpuInfo, metrics, threads, inspector.call, profile.start|stop,
// console.clear, domTree.mode.
// ============================================================================

import { addLogSink, createLogger, getRecentLogs, type LogSinkEntry } from "@downdraft/engine/util/logger";
import type { CdpBridge, CdpConsoleEntry, CdpException } from "./cdp-bridge";
import {
    collectDomTree,
    collectGpuInfo,
    collectMetrics,
    collectProfile,
    collectSceneTree,
    collectThreads,
    type CollectorContext,
} from "./collectors";
import type { PanelCommandHandler, PanelProvider } from "./snapshot";
import { PANEL, type DevtoolsCommand, type PanelName, type PanelSnapshot } from "./snapshot";

const log = createLogger("info");

// Devtools' own diagnostics must not round-trip through the logger sink
// into the console panel: a "slow update" row would dirty the console,
// forcing a re-render that makes the next update slower — a self-feeding
// lag spiral. These still write to stdout; only the devtools console view
// skips them.
const SELF_LOG_MODULES = new Set(["devtools-backend", "blitz-devtools-host"]);

type EvalFn = (expr: string) => Promise<{ result?: unknown; error?: string }>;

export function panelSlot(panel: PanelName | number): number {
  return typeof panel === "number" ? panel : (PANEL[panel] ?? 0);
}

export function slotName(slot: number): string {
  for (const [name, s] of Object.entries(PANEL)) {
    if (s === slot) return name;
  }
  return `slot-${slot}`;
}

export interface DevtoolsBackendOptions {
  /** Transport sink — receives every push event (same names as the WS events). */
  emit: (event: string, data: unknown) => void;
  /**
   * Gate for update() work — the web mirror checks server.clientCount, the
   * Blitz host checks its panel visibility. Data collection is skipped while
   * nobody can consume it.
   */
  hasClient: () => boolean;
  cdp: CdpBridge;
  renderer: unknown;
  gameScene?: unknown;
  profilingSAB: SharedArrayBuffer | null;
}

export class DevtoolsBackend {
  private emitFn: (event: string, data: unknown) => void;
  private hasClientFn: () => boolean;
  private cdp: CdpBridge;
  private ctx: CollectorContext;
  private threadEvals = new Map<string, EvalFn>();
  private disposed = false;

  private providers = new Map<number, PanelProvider>();
  private commandHandlers = new Map<number, PanelCommandHandler>();
  private globalCommandHandler: PanelCommandHandler | null = null;
  /** Dynamically-allocated slots for provider names outside the fixed PANEL
   *  table — panelSlot() alone collapsed every unknown name onto slot 0
   *  ("console"), so a second game provider silently replaced the first. */
  private dynSlots = new Map<string, number>();
  private dynSlotNames = new Map<number, string>();
  private nextDynSlot = 100;
  private lastProviderPush = new Map<number, number>();
  providerIntervalMs = 1500;
  /** When non-null, the cadence loop only auto-refreshes this provider
   *  slot — the docked Blitz host sets it to the active snapshot tab (or
   *  -1 when a fixed panel is active) so providers for unviewed tabs
   *  don't collect at all. null = refresh all providers (web mirror). */
  providerWatch: number | null = null;
  private lastProviderTick = 0;
  private lastDiagWarn = 0;

  private lastMetricsPush = 0;
  private lastGpuPush = 0;
  private lastScenePush = 0;
  private firstUpdate = true;
  private domTreeMode: "scene" | "ecs" = "scene";

  private unsubConsole: (() => void) | null = null;
  private unsubException: (() => void) | null = null;
  private unsubLogger: (() => void) | null = null;
  private loggerBuffer: LogSinkEntry[] = [];

  constructor(opts: DevtoolsBackendOptions) {
    this.emitFn = opts.emit;
    this.hasClientFn = opts.hasClient;
    this.cdp = opts.cdp;
    this.ctx = {
      renderer: opts.renderer,
      gameScene: opts.gameScene,
      profilingSAB: opts.profilingSAB,
    };
  }

  // ── Lifecycle ──

  start(): void {
    this.unsubConsole = this.cdp.onConsole((entry: CdpConsoleEntry) => {
      const severity = entry.type === "error" ? 3
        : entry.type === "warning" ? 2
        : entry.type === "info" ? 1
        : entry.type === "debug" ? 4
        : entry.type === "trace" ? 5
        : 0;
      const text = entry.args.map((a: { value?: unknown; description?: string }) =>
        a.value ?? a.description ?? String(a)).join(" ");
      this.emitConsole(text, severity, "main", entry.timestamp ?? performance.now(), !!entry.stack);
    });
    this.unsubException = this.cdp.onException((exc: CdpException) => {
      const text = `${exc.text}\n${exc.stack ?? ""}`.trim();
      this.emitConsole(text, 3, "main", performance.now(), true);
    });
    void this.pushThreads();
  }

  attachLoggerBridge(): void {
    if (this.unsubLogger) return;
    for (const entry of getRecentLogs()) {
      this.pushLogEntry(entry);
    }
    this.unsubLogger = addLogSink((entry) => {
      this.loggerBuffer.push(entry);
      if (this.loggerBuffer.length > 200) this.loggerBuffer.shift();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubConsole?.();
    this.unsubException?.();
    this.unsubLogger?.();
  }

  resetFirstUpdate(): void {
    this.firstUpdate = true;
  }

  // ── Emission helpers ──

  private emit(event: string, data: unknown): void {
    if (this.disposed) return;
    this.emitFn(event, data);
  }

  /** Diagnostic warnings, ≤1/sec — they still reach stdout, but a flood of
   *  them would go through the sink machinery per frame for nothing (and
   *  pre-filter they'd also dirty the console panel each time). */
  private diagWarn(msg: string): void {
    const now = performance.now();
    if (now - this.lastDiagWarn < 1000) return;
    this.lastDiagWarn = now;
    log.warn("devtools-backend", msg);
  }

  private emitConsole(text: string, severity: number, thread: string, ts: number, hasStack: boolean): void {
    this.emit("console", { text, severity, thread, ts, hasStack });
  }

  private flushLoggerBuffer(): void {
    if (this.loggerBuffer.length === 0) return;
    const entries = this.loggerBuffer;
    this.loggerBuffer = [];
    entries.forEach((entry) => this.pushLogEntry(entry));
  }

  private pushLogEntry(entry: LogSinkEntry): void {
    if (this.disposed) return;
    if (SELF_LOG_MODULES.has(entry.module)) return;
    this.emitConsole(
      `[${entry.module}] ${entry.message}`,
      logLevelToSeverity(entry.level),
      entry.thread || "main",
      entry.timestamp,
      false,
    );
  }

  // ── Thread eval ──

  registerThreadEval(threadId: string, evalFn: EvalFn): void {
    this.threadEvals.set(threadId, evalFn);
    void this.pushThreads();
  }

  threadEvalNames(): string[] {
    return [...this.threadEvals.keys()];
  }

  // ── Data pushes ──

  async pushThreads(): Promise<void> {
    this.emit("threads", await collectThreads(this.ctx, [...this.threadEvals.keys()]));
  }

  pushSceneTree(): void {
    this.emit("scene", collectSceneTree(this.ctx));
  }

  pushDomTree(mode: "scene" | "ecs"): void {
    this.domTreeMode = mode;
    this.emit("dom", collectDomTree(this.ctx, mode));
  }

  pushGpuInfo(): void {
    this.emit("gpu", collectGpuInfo(this.ctx));
  }

  async pushMetrics(): Promise<void> {
    this.emit("metrics", await collectMetrics(this.ctx));
  }

  pushProfile(profile: Parameters<typeof collectProfile>[0]): void {
    this.emit("profile", collectProfile(profile));
  }

  clearConsole(): void {
    this.emit("console.clear", {});
  }

  // ── Providers / commands ──

  /** Resolve a panel id to its slot. Names outside the fixed PANEL table
   *  get a stable dynamically-allocated slot so bespoke game providers can
   *  coexist instead of colliding on slot 0. */
  private slotFor(panel: PanelName | number | string): number {
    if (typeof panel === "number") return panel;
    const fixed = PANEL[panel as PanelName];
    if (fixed !== undefined) return fixed;
    let s = this.dynSlots.get(panel);
    if (s === undefined) {
      s = this.nextDynSlot++;
      this.dynSlots.set(panel, s);
      this.dynSlotNames.set(s, panel);
    }
    return s;
  }

  private nameFor(slot: number): string {
    return this.dynSlotNames.get(slot) ?? slotName(slot);
  }

  registerProvider(panel: PanelName | number | string, collect: PanelProvider): void {
    this.providers.set(this.slotFor(panel), collect);
  }

  registerCommandHandler(panel: PanelName | number | string, handler: PanelCommandHandler): void {
    if (panel === "*") {
      this.globalCommandHandler = handler;
    } else {
      this.commandHandlers.set(this.slotFor(panel), handler);
    }
  }

  /** Registered provider slots — the dynamic tab list for frontends. */
  providerSlots(): { slot: number; name: string }[] {
    return [...this.providers.keys()].map((slot) => ({ slot, name: this.nameFor(slot) }));
  }

  /** Collect + emit one provider's snapshot immediately. */
  refreshPanel(panel: PanelName | number | string): void {
    const trace: number[] = [performance.now()];
    const slot = this.slotFor(panel);
    trace.push(performance.now());
    const collect = this.providers.get(slot);
    if (!collect) return;
    const push = (snap: PanelSnapshot | null | undefined) => {
      if (snap) this.emit("snapshot", { panel: this.nameFor(slot), slot, snap });
      this.lastProviderPush.set(slot, performance.now());
    };
    const fail = (err: unknown) => {
      this.emit("snapshot", {
        panel: this.nameFor(slot), slot,
        snap: { status: "error", statusMsg: String(err), sections: [] },
      });
      this.lastProviderPush.set(slot, performance.now());
    };
    trace.push(performance.now());
    try {
      const r = collect();
      trace.push(performance.now());
      if (r && typeof (r as Promise<PanelSnapshot>).then === "function") {
        (r as Promise<PanelSnapshot>).then(push, fail);
      } else {
        push(r as PanelSnapshot | null | undefined);
      }
    } catch (err) {
      fail(err);
    }
    trace.push(performance.now());
    const total = trace[4]! - trace[0]!;
    if (total > 10) {
      const seg = `pre=${(trace[2]! - trace[0]!).toFixed(1)} collect=${(trace[3]! - trace[2]!).toFixed(1)} emit=${(trace[4]! - trace[3]!).toFixed(1)}`;
      this.diagWarn(`slow provider ${this.nameFor(slot)}: ${total.toFixed(1)}ms [${seg}]`);
    }
  }

  private dispatchCommand(cmd: DevtoolsCommand): void {
    if (cmd.action === "refresh") {
      void this.refreshPanel(cmd.panel);
      return;
    }
    const handler = this.commandHandlers.get(cmd.panel) ?? this.globalCommandHandler;
    if (!handler) {
      log.warn("devtools-backend", `unhandled command panel=${cmd.panel} action=${cmd.action}`);
      return;
    }
    try {
      const r = handler(cmd);
      if (r instanceof Promise) r.catch((err) => log.warn("devtools-backend", `command error: ${err}`));
    } catch (err) {
      log.warn("devtools-backend", `command error: ${err}`);
    }
  }

  setPerfRecording(start: boolean): void {
    if (start) this.startProfiling();
    else void this.stopProfiling();
  }

  private startProfiling(): void {
    try {
      this.cdp.startProfile();
      log.info("devtools-backend", "Profiling started");
    } catch (err) {
      log.warn("devtools-backend", `Failed to start profiling: ${err}`);
    }
  }

  private async stopProfiling(): Promise<void> {
    try {
      const profile = await this.cdp.stopProfile();
      if (profile) this.pushProfile(profile);
    } catch (err) {
      log.warn("devtools-backend", `Failed to stop profiling: ${err}`);
    }
  }

  // ── Per-frame pump (called from the host's update) ──

  update(): void {
    if (this.disposed) return;
    if (!this.hasClientFn()) return; // nobody listening — save the work

    const t0 = performance.now();
    this.flushLoggerBuffer();
    const t1 = performance.now();

    if (this.firstUpdate) {
      this.firstUpdate = false;
      this.pushSceneTree();
      this.pushDomTree(this.domTreeMode);
      this.pushGpuInfo();
      void this.pushMetrics();
      void this.pushThreads();
      // Providers intentionally skipped — the cadence loop below serves
      // overdue providers one-per-update, spreading the initial burst.
    }

    const now = performance.now();
    const seg: Record<string, number> = {};
    let tSeg = now;
    const mark = (name: string) => { const t = performance.now(); seg[name] = (seg[name] ?? 0) + t - tSeg; tSeg = t; };
    if (now - this.lastMetricsPush > 500) {
      this.lastMetricsPush = now;
      void this.pushMetrics();
      void this.pushThreads();
      mark("metrics");
    }
    if (now - this.lastGpuPush > 1000) {
      this.lastGpuPush = now;
      this.pushGpuInfo();
      mark("gpu");
    }
    if (now - this.lastScenePush > 2000) {
      this.lastScenePush = now;
      this.pushSceneTree();
      this.pushDomTree(this.domTreeMode);
      mark("scene");
    }
    // Provider snapshots on their own cadence — at most one synchronous
    // collect per tick so a batch of overdue panels can't stall a single
    // frame. The tick gap spreads N providers evenly across the interval
    // instead of refreshing them in one burst; providerWatch (set by the
    // docked host to the active snapshot tab, or -1 for fixed panels)
    // skips collection for tabs nobody is looking at.
    const count = this.providers.size;
    if (count > 0) {
      const gap = Math.max(100, this.providerIntervalMs / count);
      if (now - this.lastProviderTick >= gap) {
        for (const slot of this.providers.keys()) {
          if (this.providerWatch !== null && slot !== this.providerWatch) continue;
          const last = this.lastProviderPush.get(slot) ?? 0;
          if (now - last > this.providerIntervalMs) {
            this.lastProviderTick = now;
            void this.refreshPanel(slot);
            break;
          }
        }
      }
    }
    mark("providers");
    const t2 = performance.now();
    if (t2 - t0 > 6) {
      const rest = [
        t1 - t0 > 2 ? `logs=${(t1 - t0).toFixed(1)}ms` : "",
        now - t1 > 2 ? `init=${(now - t1).toFixed(1)}ms` : "",
        ...Object.entries(seg).filter(([, v]) => v > 2).map(([k, v]) => `${k}=${v.toFixed(1)}ms`),
      ].filter(Boolean).join(" ");
      this.diagWarn(`slow update ${(t2 - t0).toFixed(1)}ms: ${rest}`);
    }
  }

  // ── RPC dispatch (WS requests for the web frontend; direct calls for Blitz) ──

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "eval": {
        const threadId = String(params.thread ?? "main");
        const expr = String(params.expr ?? "");
        const evalFn = this.threadEvals.get(threadId) ?? (threadId === "main" ? this.cdp.evaluate.bind(this.cdp) : null);
        if (!evalFn) return { error: `no eval for thread "${threadId}"` };
        return evalFn(expr);
      }
      case "sceneTree":
        return collectSceneTree(this.ctx);
      case "domTree":
        return collectDomTree(this.ctx, (params.mode === "ecs" ? "ecs" : "scene"));
      case "gpuInfo":
        return collectGpuInfo(this.ctx);
      case "metrics":
        return collectMetrics(this.ctx);
      case "threads":
        return collectThreads(this.ctx, [...this.threadEvals.keys()]);
      case "snapshot": {
        const panel = params.panel;
        const slot = typeof panel === "number" ? panel : this.slotFor(String(panel));
        const collect = this.providers.get(slot);
        if (!collect) return { status: "unsupported", statusMsg: `no provider for ${String(panel)}`, sections: [] };
        try {
          const snap = await collect();
          return snap ?? { status: "ok", sections: [] };
        } catch (err) {
          return { status: "error", statusMsg: String(err), sections: [] };
        }
      }
      case "command": {
        const panel = params.panel;
        const slot = typeof panel === "number" ? panel : this.slotFor(String(panel ?? "console"));
        this.dispatchCommand({ panel: slot, action: String(params.action ?? ""), payload: String(params.payload ?? "") });
        return true;
      }
      case "inspector.call": {
        const api = this.sceneInspector();
        const name = String(params.method ?? "");
        const fn = api?.[name];
        if (typeof fn !== "function") throw new Error(`__sceneInspector.${name} is not a function`);
        return fn(...((params.args as unknown[]) ?? []));
      }
      case "profile.start":
        this.startProfiling();
        return true;
      case "profile.stop":
        await this.stopProfiling();
        return true;
      case "console.clear":
        this.cdp.clear();
        this.emit("console.clear", {});
        return true;
      case "domTree.mode":
        this.domTreeMode = params.mode === "ecs" ? "ecs" : "scene";
        this.pushDomTree(this.domTreeMode);
        return this.domTreeMode;
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  sceneInspector(): Record<string, unknown> | null {
    const g = globalThis as Record<string, unknown>;
    const win = g.window as Record<string, unknown> | undefined;
    return (win?.__sceneInspector ?? g.__sceneInspector ?? null) as Record<string, unknown> | null;
  }

  inspectorMethodNames(): string[] {
    const api = this.sceneInspector();
    if (!api) return [];
    return Object.keys(api).filter((k) => typeof api[k] === "function");
  }
}

function logLevelToSeverity(level: string): number {
  switch (level) {
    case "error":
    case "fatal":
      return 3;
    case "warn":
      return 2;
    case "info":
      return 1;
    case "debug":
      return 4;
    case "trace":
      return 5;
    default:
      return 0;
  }
}
