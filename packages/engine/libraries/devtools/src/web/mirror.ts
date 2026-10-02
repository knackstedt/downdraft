// ============================================================================
// web/mirror.ts — WebDevtoolsMirror: the web transport for devtools data.
//
// Same public surface as DevtoolsMirror (registerProvider,
// registerCommandHandler, registerThreadEval, push*, update) but instead of
// FFI-encoding into the egui crate it emits JSON events on the DevToolsServer
// WebSocket. Eval is request/response over WS — no polling queue.
//
// WS events emitted: console, threads, scene, dom, gpu, metrics, snapshot,
// profile, threads.
// RPC handled (via server.call): ping, eval, snapshot, command, sceneTree,
// domTree, gpuInfo, metrics, threads, inspector.call, profile.start|stop,
// console.clear, domTree.mode.
// ============================================================================

import { addLogSink, createLogger, getRecentLogs, type LogSinkEntry } from "@downdraft/engine/util/logger";
import type { CdpBridge, CdpConsoleEntry, CdpException } from "../cdp-bridge";
import {
    collectDomTree,
    collectGpuInfo,
    collectMetrics,
    collectProfile,
    collectSceneTree,
    collectThreads,
    type CollectorContext,
} from "../collectors";
import { PANEL, type DevtoolsCommand, type PanelName, type PanelSnapshot } from "../egui-ffi";
import type { DevToolsServer } from "./server";

const log = createLogger("info");

type EvalFn = (expr: string) => Promise<{ result?: unknown; error?: string }>;
export type PanelProvider = () => PanelSnapshot | null | undefined | Promise<PanelSnapshot | null | undefined>;
export type PanelCommandHandler = (cmd: DevtoolsCommand) => void | Promise<void>;

function panelSlot(panel: PanelName | number): number {
  return typeof panel === "number" ? panel : (PANEL[panel] ?? 0);
}

function slotName(slot: number): string {
  for (const [name, s] of Object.entries(PANEL)) {
    if (s === slot) return name;
  }
  return `slot-${slot}`;
}

export interface WebMirrorOptions {
  server: DevToolsServer;
  cdp: CdpBridge;
  renderer: unknown;
  gameScene?: unknown;
  profilingSAB: SharedArrayBuffer | null;
}

export class WebDevtoolsMirror {
  private server: DevToolsServer;
  private cdp: CdpBridge;
  private ctx: CollectorContext;
  private threadEvals = new Map<string, EvalFn>();
  private disposed = false;

  private providers = new Map<number, PanelProvider>();
  private commandHandlers = new Map<number, PanelCommandHandler>();
  private globalCommandHandler: PanelCommandHandler | null = null;
  private lastProviderPush = new Map<number, number>();
  providerIntervalMs = 1500;

  private lastMetricsPush = 0;
  private lastGpuPush = 0;
  private lastScenePush = 0;
  private firstUpdate = true;
  private domTreeMode: "scene" | "ecs" = "scene";

  private unsubConsole: (() => void) | null = null;
  private unsubException: (() => void) | null = null;
  private unsubLogger: (() => void) | null = null;
  private loggerBuffer: LogSinkEntry[] = [];

  constructor(opts: WebMirrorOptions) {
    this.server = opts.server;
    this.cdp = opts.cdp;
    this.ctx = {
      renderer: opts.renderer,
      gameScene: opts.gameScene,
      profilingSAB: opts.profilingSAB,
    };
    this.server.setHello(() => ({
      version: 1,
      panels: [...this.providers.keys()].map((s) => ({ slot: s, name: slotName(s) })),
      inspector: this.inspectorMethodNames(),
    }));
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
    this.server.emit(event, data);
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

  // ── Data pushes (same names as DevtoolsMirror) ──

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

  registerProvider(panel: PanelName | number, collect: PanelProvider): void {
    this.providers.set(panelSlot(panel), collect);
  }

  registerCommandHandler(panel: PanelName | number | "*", handler: PanelCommandHandler): void {
    if (panel === "*") {
      this.globalCommandHandler = handler;
    } else {
      this.commandHandlers.set(panelSlot(panel), handler);
    }
  }

  /** Collect + emit one provider's snapshot immediately. */
  refreshPanel(panel: PanelName | number): void {
    const slot = panelSlot(panel);
    const collect = this.providers.get(slot);
    if (!collect) return;
    const push = (snap: PanelSnapshot | null | undefined) => {
      if (snap) this.emit("snapshot", { panel: slotName(slot), slot, snap });
      this.lastProviderPush.set(slot, performance.now());
    };
    const fail = (err: unknown) => {
      this.emit("snapshot", {
        panel: slotName(slot), slot,
        snap: { status: "error", statusMsg: String(err), sections: [] },
      });
      this.lastProviderPush.set(slot, performance.now());
    };
    try {
      const r = collect();
      if (r && typeof (r as Promise<PanelSnapshot>).then === "function") {
        (r as Promise<PanelSnapshot>).then(push, fail);
      } else {
        push(r as PanelSnapshot | null | undefined);
      }
    } catch (err) {
      fail(err);
    }
  }

  private pushAllProviders(): void {
    for (const slot of this.providers.keys()) {
      void this.refreshPanel(slot);
    }
  }

  private dispatchCommand(cmd: DevtoolsCommand): void {
    if (cmd.action === "refresh") {
      void this.refreshPanel(cmd.panel);
      return;
    }
    const handler = this.commandHandlers.get(cmd.panel) ?? this.globalCommandHandler;
    if (!handler) {
      log.warn("WebDevtoolsMirror", `unhandled command panel=${cmd.panel} action=${cmd.action}`);
      return;
    }
    try {
      const r = handler(cmd);
      if (r instanceof Promise) r.catch((err) => log.warn("WebDevtoolsMirror", `command error: ${err}`));
    } catch (err) {
      log.warn("WebDevtoolsMirror", `command error: ${err}`);
    }
  }

  setPerfRecording(start: boolean): void {
    if (start) this.startProfiling();
    else void this.stopProfiling();
  }

  private startProfiling(): void {
    try {
      this.cdp.startProfile();
      log.info("WebDevtoolsMirror", "Profiling started");
    } catch (err) {
      log.warn("WebDevtoolsMirror", `Failed to start profiling: ${err}`);
    }
  }

  private async stopProfiling(): Promise<void> {
    try {
      const profile = await this.cdp.stopProfile();
      if (profile) this.pushProfile(profile);
    } catch (err) {
      log.warn("WebDevtoolsMirror", `Failed to stop profiling: ${err}`);
    }
  }

  // ── Per-frame pump (called from WebDevtoolsHost.update) ──

  update(): void {
    if (this.disposed) return;
    if (this.server.clientCount === 0) return; // nobody listening — save the work

    this.flushLoggerBuffer();

    if (this.firstUpdate) {
      this.firstUpdate = false;
      this.pushSceneTree();
      this.pushDomTree(this.domTreeMode);
      this.pushGpuInfo();
      void this.pushMetrics();
      void this.pushThreads();
      this.pushAllProviders();
    }

    const now = performance.now();
    if (now - this.lastMetricsPush > 500) {
      this.lastMetricsPush = now;
      void this.pushMetrics();
      void this.pushThreads();
    }
    if (now - this.lastGpuPush > 1000) {
      this.lastGpuPush = now;
      this.pushGpuInfo();
    }
    if (now - this.lastScenePush > 2000) {
      this.lastScenePush = now;
      this.pushSceneTree();
      this.pushDomTree(this.domTreeMode);
    }
    // Provider snapshots on their own cadence.
    for (const slot of this.providers.keys()) {
      const last = this.lastProviderPush.get(slot) ?? 0;
      if (now - last > this.providerIntervalMs) {
        void this.refreshPanel(slot);
      }
    }
  }

  // ── RPC dispatch (called by DevToolsServer for client requests) ──

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
        const slot = typeof panel === "number" ? panel : panelSlot(panel as PanelName);
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
        const slot = typeof panel === "number" ? panel : panelSlot((panel as PanelName) ?? "console");
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

  private sceneInspector(): Record<string, unknown> | null {
    const g = globalThis as Record<string, unknown>;
    const win = g.window as Record<string, unknown> | undefined;
    return (win?.__sceneInspector ?? g.__sceneInspector ?? null) as Record<string, unknown> | null;
  }

  private inspectorMethodNames(): string[] {
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
