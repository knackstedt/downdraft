// ============================================================================
// mirror.ts — DevtoolsMirror: the TS→Rust data bridge.
//
// Subscribes to CdpBridge (console + exceptions + profiles), collects scene/
// GPU/metrics data from the game renderer + ProfilingSAB, and pushes it into
// the Rust egui crate via the egui-ffi bindings. Also handles the eval
// round-trip: polls Rust for pending eval requests, dispatches them to the
// right thread (main via CDP, workers via registered eval fns), and pushes
// results back.
// ============================================================================

import { addLogSink, createLogger, getRecentLogs, type LogSinkEntry } from "@downdraft/engine/util/logger";
import { CdpBridge, type CdpConsoleEntry, type CdpException, type CdpProfile } from "./cdp-bridge";
import {
    devtoolsClearConsole,
    devtoolsGetDomTreeMode,
    devtoolsPushConsole,
    devtoolsPushEvalResult,
    devtoolsSetDomTree,
    devtoolsSetGpuInfo,
    devtoolsSetMetrics,
    devtoolsSetProfile,
    devtoolsSetSceneTree,
    devtoolsSetSnapshot,
    devtoolsSetThreads,
    devtoolsTakeCommand,
    devtoolsTakeEvalRequest,
    devtoolsTakeRefreshRequests,
    encodeGpuInfo,
    encodeMetrics,
    encodeProfile,
    encodeSnapshot,
    encodeThreads,
    encodeTree,
    PANEL,
    REFRESH_DOM,
    REFRESH_GPU,
    REFRESH_METRICS,
    REFRESH_PERF_RECORD,
    REFRESH_PERF_STOP,
    REFRESH_SCENE,
    type DevtoolsCommand,
    type DevtoolsHandle,
    type PanelName,
    type PanelSnapshot
} from "./egui-ffi";

const log = createLogger("info");

// Lazy-load the ProfilingSAB reader (avoids importing @downdraft/engine/profiling
// at module load time; it may not be available in all contexts).
let profilingMod: any = undefined;
async function loadProfilingMod(): Promise<any> {
  if (profilingMod !== undefined) return profilingMod;
  try {
    profilingMod = await import("@downdraft/engine/profiling");
    log.info("DevtoolsMirror", "Profiling module loaded");
  } catch (err) {
    log.warn("DevtoolsMirror", `Failed to load profiling module: ${err}`);
    profilingMod = null;
  }
  return profilingMod;
}

export interface MirrorOptions {
  handle: DevtoolsHandle;
  cdp: CdpBridge;
  renderer: any;
  gameScene?: any;
  profilingSAB: SharedArrayBuffer | null;
}

// Thread eval registry: threadId → eval function.
type EvalFn = (expr: string) => Promise<{ result?: any; error?: string }>;

/** A data provider for a generic panel snapshot (engine or game registered). */
export type PanelProvider = () => PanelSnapshot | null | undefined | Promise<PanelSnapshot | null | undefined>;
/** Handler for UI-originated commands on a panel. */
export type PanelCommandHandler = (cmd: DevtoolsCommand) => void | Promise<void>;

/** Resolve a panel name or numeric id to the Rust slot id. */
function panelSlot(panel: PanelName | number): number {
  return typeof panel === "number" ? panel : (PANEL[panel] ?? 0);
}

export class DevtoolsMirror {
  private handle: DevtoolsHandle;
  private cdp: CdpBridge;
  private renderer: any;
  private gameScene: any;
  private profilingSAB: SharedArrayBuffer | null;
  private threadEvals = new Map<string, EvalFn>();
  private disposed = false;

  // Generic panel providers (slot → collect fn) + command handlers.
  private providers = new Map<number, PanelProvider>();
  private commandHandlers = new Map<number, PanelCommandHandler>();
  private globalCommandHandler: PanelCommandHandler | null = null;
  private lastProviderPush = new Map<number, number>();
  /** Default per-provider push interval (ms). */
  providerIntervalMs = 1500;

  // Throttle: push data at most every N ms.
  private lastThreadsPush = 0;
  private lastMetricsPush = 0;
  private lastGpuPush = 0;
  private lastScenePush = 0;
  private firstUpdate = true;
  private domTreeMode: "scene" | "ecs" = "scene";

  private unsubConsole: (() => void) | null = null;
  private unsubException: (() => void) | null = null;
  private unsubLogger: (() => void) | null = null;
  // Buffer for logger entries received from any thread (including workers).
  // Flushed to Rust on the main thread during update() to avoid data races
  // with dd_devtools_update reading s.console.entries concurrently.
  private loggerBuffer: LogSinkEntry[] = [];

  constructor(opts: MirrorOptions) {
    this.handle = opts.handle;
    this.cdp = opts.cdp;
    this.renderer = opts.renderer;
    this.gameScene = opts.gameScene;
    this.profilingSAB = opts.profilingSAB;
  }

  /** Reset the first-update flag so the next update() pushes all data. */
  resetFirstUpdate(): void {
    this.firstUpdate = true;
  }

  /** Start the mirror: subscribe to CDP, push initial data. */
  start(): void {
    // Subscribe to console entries.
    this.unsubConsole = this.cdp.onConsole((entry: CdpConsoleEntry) => {
      const severity = entry.type === "error" ? 3
        : entry.type === "warning" ? 2
        : entry.type === "info" ? 1
        : entry.type === "debug" ? 4
        : entry.type === "trace" ? 5
        : 0;
      const text = entry.args.map((a: any) => a.value ?? a.description ?? String(a)).join(" ");
      devtoolsPushConsole(this.handle, text, severity, "main", entry.timestamp ?? performance.now(), !!entry.stack);
    });

    // Subscribe to exceptions.
    this.unsubException = this.cdp.onException((exc: CdpException) => {
      const text = `${exc.text}\n${exc.stack ?? ""}`.trim();
      devtoolsPushConsole(this.handle, text, 3, "main", performance.now(), true);
    });

    // Push initial threads.
    this.pushThreads();
  }

  /**
   * Bridge the engine's native logger (which writes to process.stdout, so CDP
   * never sees it) into the devtools console. Replays recent history and
   * subscribes to new log lines in real time. Idempotent.
   */
  attachLoggerBridge(): void {
    if (this.unsubLogger) return;
    // Replay recent history so the console isn't empty when first opened.
    for (const entry of getRecentLogs()) {
      this.pushLogEntry(entry);
    }
    // Live sink buffers entries (may fire from worker threads); flushed
    // during update() on the main thread to avoid Rust data races.
    this.unsubLogger = addLogSink((entry) => {
      this.loggerBuffer.push(entry);
      if (this.loggerBuffer.length > 200) this.loggerBuffer.shift();
    });
  }

  /** Flush buffered logger entries to Rust. Call from the main thread only. */
  private flushLoggerBuffer(): void {
    if (this.loggerBuffer.length === 0) return;
    const entries = this.loggerBuffer;
    this.loggerBuffer = [];
    entries.forEach((entry) => {
      this.pushLogEntry(entry);
    });
  }

  /** Map a LogSinkEntry to a devtools console entry + push to Rust. */
  private pushLogEntry(entry: LogSinkEntry): void {
    if (this.disposed) return;
    const severity = logLevelToSeverity(entry.level);
    const thread = entry.thread || "main";
    const text = `[${entry.module}] ${entry.message}`;
    devtoolsPushConsole(this.handle, text, severity, thread, entry.timestamp, false);
  }

  /** Register an eval function for a worker thread. */
  registerThreadEval(threadId: string, evalFn: EvalFn): void {
    this.threadEvals.set(threadId, evalFn);
    this.pushThreads();
  }

  /** Push the thread list to Rust. */
  private async pushThreads(): Promise<void> {
    const threads: { id: string; name: string; kind: number }[] = [
      { id: "main", name: "main", kind: 0 },
    ];
    // Worker threads from ProfilingSAB.
    if (this.profilingSAB) {
      try {
        const mod = await loadProfilingMod();
        if (mod) {
          const { ProfilingSABReader, computeProfilingSABLayout } = mod;
          const layout = computeProfilingSABLayout();
          if (this.profilingSAB.byteLength >= layout.byteLength) {
            const reader = new ProfilingSABReader(this.profilingSAB, layout);
            const snapshot = reader.readSnapshot();
            snapshot.slots.forEach((slot: any) => {
              const name = slot.name || `worker-${slot.slotIndex}`;
              const id = `slot-${slot.slotIndex}`;
              threads.push({ id, name, kind: 1 });
            });
          }
        }
      } catch (err) {
        log.warn("DevtoolsMirror", `ProfilingSAB read failed: ${err}`);
      }
    }
    // Registered eval fns (e.g. "sim" worker).
    for (const id of this.threadEvals.keys()) {
      if (!threads.find((t) => t.id === id)) {
        threads.push({ id, name: id, kind: 1 });
      }
    }
    devtoolsSetThreads(this.handle, encodeThreads(threads));
  }

  /** Collect + push the scene tree. */
  pushSceneTree(): void {
    const stage = this.gameScene?.stage;
    if (!stage) return;
    const nodes: any[] = [];
    let idCounter = 1;
    const idMap = new WeakMap();
    const collect = (node: any, parentId: number, depth: number) => {
      const id = idCounter++;
      idMap.set(node, id);
      // Prefer `label` (some scene-graph hosts deprecate `name` or warn on
      // access); fall back to `name` for hosts that only set that.
      const nodeLabel = typeof node.label === "string" ? node.label
        : typeof node.name === "string" ? node.name : "";
      const ctorName = node.constructor?.name ?? "Node";
      // If the node has a label, show it as the primary label with the type
      // as detail. Otherwise just show the type.
      const label = nodeLabel || ctorName;
      const detail = nodeLabel ? ctorName : "";
      const childCount = node.children?.length ?? 0;
      nodes.push({ id, parentId, depth, childCount, kind: 0, label, detail });
      if (node.children) {
        node.children.forEach((child: any) => {
          collect(child, id, depth + 1);
        });
      }
    };
    collect(stage, -1, 0);
    devtoolsSetSceneTree(this.handle, encodeTree(nodes));
  }

  /** Collect + push the DOM/ECS tree (scene or ECS mode). */
  pushDomTree(mode: "scene" | "ecs"): void {
    if (mode === "scene") {
      // Collect the scene tree but push it to the DOM tree slot
      // (the dom-tree panel reads from dom_tree.nodes, not scene_tree.nodes).
      const stage = this.gameScene?.stage;
      if (!stage) {
        devtoolsSetDomTree(this.handle, encodeTree([]));
        return;
      }
      const nodes: any[] = [];
      let idCounter = 1;
      const collect = (node: any, parentId: number, depth: number) => {
        const id = idCounter++;
        const nodeLabel = typeof node.label === "string" ? node.label
          : typeof node.name === "string" ? node.name : "";
        const ctorName = node.constructor?.name ?? "Node";
        const label = nodeLabel || ctorName;
        const detail = nodeLabel ? ctorName : "";
        const childCount = node.children?.length ?? 0;
        nodes.push({ id, parentId, depth, childCount, kind: 0, label, detail });
        if (node.children) {
          node.children.forEach((child: any) => {
            collect(child, id, depth + 1);
          });
        }
      };
      collect(stage, -1, 0);
      devtoolsSetDomTree(this.handle, encodeTree(nodes));
      return;
    }
    // ECS mode: read entities from the sim buffer reader.
    const simReader = this.renderer?.simReader ?? this.renderer?.getSimReader?.();
    if (!simReader?.isValid?.()) {
      devtoolsSetDomTree(this.handle, encodeTree([]));
      return;
    }
    const nodes: any[] = [];
    let idCounter = 1;
    try {
      const count = simReader.getEntityCount();
      const iter = simReader.iterEntities?.();
      if (iter) {
        iter.forEach((ent: any) => {
          const id = idCounter++;
          const f32 = ent.f32;
          const u32 = ent.u32;
          // Entity type is typically in u32[0] or similar; show position from f32.
          const entityType = u32?.[0] ?? 0;
          const x = f32?.[0] ?? 0;
          const y = f32?.[1] ?? 0;
          const z = f32?.[2] ?? 0;
          const label = `Entity ${ent.idx}`;
          const detail = `type=${entityType} pos=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`;
          nodes.push({ id, parentId: -1, depth: 0, childCount: 0, kind: 1, label, detail });
        });
      }
    } catch { /* ignore */ }
    devtoolsSetDomTree(this.handle, encodeTree(nodes));
  }

  /** Collect + push GPU info. */
  pushGpuInfo(): void {
    const r = this.renderer;
    const entries: { key: string; value: string; isHeader: boolean }[] = [];
    try {
      // ── Adapter Info ──
      const adapterInfo = r?.getAdapterInfo?.() ?? r?.gpuProfiler?.getAdapterInfo?.() ?? {};
      entries.push({ key: "GPU Adapter Info", value: "", isHeader: true });
      entries.push({ key: "Vendor", value: adapterInfo.vendor ?? "?", isHeader: false });
      entries.push({ key: "Architecture", value: adapterInfo.architecture ?? "?", isHeader: false });
      entries.push({ key: "Description", value: adapterInfo.description ?? "?", isHeader: false });
      entries.push({ key: "Device", value: adapterInfo.device ?? "?", isHeader: false });

      // ── Device Limits ──
      const device = r?.getDevice?.() ?? r?.device;
      const limits = device?.limits;
      if (limits) {
        entries.push({ key: "Device Limits", value: "", isHeader: true });
        // maxBufferSize from wgpu-native is a u64 BigInt that can exceed
        // Number.MAX_SAFE_INTEGER (2^64-1). Cap at a sane display value.
        const maxBuf = limits.maxBufferSize;
        const maxBufNum = typeof maxBuf === "bigint" ? Number(maxBuf) : maxBuf;
        const maxBufDisplay = maxBufNum > 4 * 1024 * 1024 * 1024 ? "4 GB (capped)" : this.formatBytes(maxBuf);
        entries.push({ key: "maxBufferSize", value: maxBufDisplay, isHeader: false });
        entries.push({ key: "maxTextureDim2D", value: String(limits.maxTextureDimension2D), isHeader: false });
        entries.push({ key: "maxTextureDim3D", value: String(limits.maxTextureDimension3D), isHeader: false });
        entries.push({ key: "maxTextureArrayLayers", value: String(limits.maxTextureArrayLayers), isHeader: false });
        entries.push({ key: "maxStorageBuffer", value: this.formatBytes(limits.maxStorageBufferBindingSize), isHeader: false });
        entries.push({ key: "maxUniformBuffer", value: this.formatBytes(limits.maxUniformBufferBindingSize), isHeader: false });
        entries.push({ key: "maxBindGroups", value: String(limits.maxBindGroups), isHeader: false });
        entries.push({ key: "maxVertexAttributes", value: String(limits.maxVertexAttributes), isHeader: false });
        entries.push({ key: "maxVertexBuffers", value: String(limits.maxVertexBuffers), isHeader: false });
        entries.push({ key: "maxColorAttachments", value: String(limits.maxColorAttachments), isHeader: false });
        entries.push({ key: "maxComputeWorkgroupsPerDimension", value: String(limits.maxComputeWorkgroupsPerDimension), isHeader: false });
      }

      // ── Frame Performance ──
      const telemetry = r?.telemetryCollector;
      if (telemetry?.getFrameTelemetry) {
        const ft = telemetry.getFrameTelemetry();
        if (ft) {
          entries.push({ key: "Frame Performance", value: "", isHeader: true });
          entries.push({ key: "FPS", value: String(Math.round(ft.fps ?? 0)), isHeader: false });
          entries.push({ key: "Avg frame time", value: `${(ft.avgFrameTime ?? 0).toFixed(2)} ms`, isHeader: false });
          entries.push({ key: "P95 frame time", value: `${(ft.p95 ?? 0).toFixed(2)} ms`, isHeader: false });
          entries.push({ key: "P99 frame time", value: `${(ft.p99 ?? 0).toFixed(2)} ms`, isHeader: false });
          entries.push({ key: "GPU time", value: `${(ft.gpuTimeMs ?? 0).toFixed(2)} ms`, isHeader: false });
          entries.push({ key: "Draw calls", value: String(ft.drawCalls ?? 0), isHeader: false });
          entries.push({ key: "Triangles", value: String(ft.triangles ?? 0), isHeader: false });
        }
      }

      // ── GPU Resources (VRAM Tracking) ──
      const resTracker = r?.gpuResourceTracker;
      if (resTracker?.getStats) {
        const stats = resTracker.getStats();
        entries.push({ key: "GPU Resources", value: "", isHeader: true });
        entries.push({ key: "Textures", value: String(stats.textureCount), isHeader: false });
        entries.push({ key: "Buffers", value: String(stats.bufferCount), isHeader: false });
        entries.push({ key: "Texture VRAM", value: this.formatBytes(stats.textureBytes), isHeader: false });
        entries.push({ key: "Buffer VRAM", value: this.formatBytes(stats.bufferBytes), isHeader: false });
        entries.push({ key: "Total VRAM", value: this.formatBytes(stats.totalBytes), isHeader: false });
        // Top resources by size.
        const topResources = (stats.resources ?? []).slice(0, 15);
        if (topResources.length > 0) {
          entries.push({ key: "Top Resources", value: "", isHeader: true });
          topResources.forEach((res: any) => {
            entries.push({
              key: res.label ?? res.type ?? "resource",
              value: `${res.type} ${this.formatBytes(res.size)} ${res.dims ?? ""}`.trim(),
              isHeader: false,
            });
          });
        }
      }

      // ── Per-Pass GPU Timing ──
      const profiler = r?.gpuProfiler;
      if (profiler?.getPassTimings) {
        const timings = profiler.getPassTimings();
        if (timings.length > 0) {
          entries.push({ key: "Per-Pass GPU Timing", value: "", isHeader: true });
          timings.forEach((t: any) => {
            const gpu = t.gpuMs > 0 ? `gpu=${t.gpuMs.toFixed(2)}ms` : "";
            entries.push({
              key: t.name ?? "pass",
              value: `cpu=${t.cpuMs.toFixed(2)}ms ${gpu} draws=${t.drawCalls} tris=${t.triangles}`.trim(),
              isHeader: false,
            });
          });
        }
      }

      // ── GPU Errors ──
      if (profiler?.getGPUErrors) {
        const errors = profiler.getGPUErrors();
        if (errors.length > 0) {
          entries.push({ key: "GPU Errors", value: "", isHeader: true });
          errors.forEach((e: any) => {
            entries.push({ key: e.type ?? "error", value: e.message ?? String(e), isHeader: false });
          });
        }
      }

      // ── Frame Graph ──
      const frameGraph = r?.frameGraph ?? r?.getFrameGraph?.();
      if (frameGraph) {
        const slots = frameGraph.getSlots?.() ?? frameGraph.getSlotRegistry?.()?.getAll?.() ?? [];
        if (slots.length > 0) {
          entries.push({ key: "Frame Graph Passes", value: "", isHeader: true });
          slots.forEach((s: any) => {
            const name = typeof s === "string" ? s : (s.name ?? s.label ?? "slot");
            entries.push({ key: name, value: "", isHeader: false });
          });
        }
      }
    } catch (err) {
      entries.push({ key: "Error", value: String(err), isHeader: false });
    }

    // ── Frame-time history for the graph ──
    const frameTimes: [number, number][] = [];
    const memHistory: number[] = [];
    try {
      const telemetry = r?.telemetryCollector;
      if (telemetry?.getFrameTimes) {
        const times = telemetry.getFrameTimes();
        for (let i = Math.max(0, times.length - 120); i < times.length; i++) {
          frameTimes.push([times[i], 0]);
        }
      }
      // Per-pass CPU+GPU totals as a secondary data point.
      const profiler = r?.gpuProfiler;
      if (profiler?.getPassTimings) {
        const timings = profiler.getPassTimings();
        if (timings.length > 0 && frameTimes.length > 0) {
          let gpuTotal = 0;
          timings.forEach((t: any) => { gpuTotal += t.gpuMs ?? 0;; });
          // Add GPU total to the most recent frame's GPU column.
          if (frameTimes.length > 0) {
            frameTimes[frameTimes.length - 1][1] = gpuTotal;
          }
        }
      }
      const resTracker = r?.gpuResourceTracker;
      if (resTracker?.getStats) {
        memHistory.push(resTracker.getStats().totalBytes);
      }
    } catch { /* ignore */ }

    devtoolsSetGpuInfo(this.handle, encodeGpuInfo(entries, frameTimes, memHistory));
  }

  private formatBytes(bytes: any): string {
    const b = typeof bytes === "bigint" ? Number(bytes) : bytes;
    if (!b || b < 0 || !Number.isFinite(b)) return String(bytes);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /** Collect + push per-thread metrics from ProfilingSAB. */
  async pushMetrics(): Promise<void> {
    // Always include the main thread metrics (from performance API).
    // Accumulate history locally so charts build up over time.
    const slots: any[] = [{
      slotIndex: 0,
      name: "main",
      runtime: 0,
      history: [{
        cpuPercent: 0,
        heapUsed: (performance as any)?.memory?.usedJSHeapSize ?? 0,
        heapTotal: (performance as any)?.memory?.totalJSHeapSize ?? 0,
        gcPauseMaxUs: 0,
        taskLatencyP95Us: 0,
      }],
    }];

    if (this.profilingSAB) {
      try {
        const mod = await loadProfilingMod();
        if (mod) {
          const { ProfilingSABReader, computeProfilingSABLayout } = mod;
          const layout = computeProfilingSABLayout();
          if (this.profilingSAB.byteLength >= layout.byteLength) {
            const reader = new ProfilingSABReader(this.profilingSAB, layout);
            const snapshot = reader.readSnapshot();
            snapshot.slots.forEach((slot: any) => {
              slots.push({
                slotIndex: slot.slotIndex,
                name: slot.name || `worker-${slot.slotIndex}`,
                runtime: slot.runtime ?? 0,
                history: [{
                  cpuPercent: slot.metrics?.cpuPercent ?? 0,
                  heapUsed: slot.metrics?.heapUsed ?? 0,
                  heapTotal: slot.metrics?.heapTotal ?? 0,
                  gcPauseMaxUs: slot.metrics?.gcPauseMaxUs ?? 0,
                  taskLatencyP95Us: slot.metrics?.taskLatencyP95Us ?? 0,
                }],
              });
            });
          }
        }
      } catch (err) {
        log.warn("DevtoolsMirror", `pushMetrics ProfilingSAB read failed: ${err}`);
      }
    }

    devtoolsSetMetrics(this.handle, encodeMetrics(slots));
  }

  /** Push a CDP profile to Rust (after Profiler.stop). */
  pushProfile(profile: CdpProfile): void {
    const nodes = (profile.nodes ?? []).map((n: any) => ({
      id: n.id,
      hitCount: n.hitCount ?? 0,
      callFrame: n.callFrame?.functionName ?? "?",
      url: n.callFrame?.url ?? "",
      line: n.callFrame?.lineNumber ?? 0,
      children: n.children ?? [],
    }));
    devtoolsSetProfile(this.handle, encodeProfile({
      nodes,
      startUs: profile.startTime ?? 0,
      endUs: profile.endTime ?? 0,
      samples: profile.samples ?? [],
      timeDeltasUs: profile.timeDeltas ?? [],
    }));
  }

  /** Clear the console in Rust. */
  clearConsole(): void {
    devtoolsClearConsole(this.handle);
  }

  // ── Generic panel providers + commands ──

  /**
   * Register a data provider for a generic panel slot. `collect` runs on the
   * main thread during update() and returns a PanelSnapshot pushed to Rust.
   */
  registerProvider(panel: PanelName | number, collect: PanelProvider): void {
    this.providers.set(panelSlot(panel), collect);
  }

  /** Register a command handler for a panel (or "*" for all panels). */
  registerCommandHandler(panel: PanelName | number | "*", handler: PanelCommandHandler): void {
    if (panel === "*") {
      this.globalCommandHandler = handler;
    } else {
      this.commandHandlers.set(panelSlot(panel), handler);
    }
  }

  /** Collect + push one provider's snapshot immediately. Sync providers push
   * synchronously (no microtask hop) so callers can rely on the snapshot
   * landing before the next egui frame. */
  refreshPanel(panel: PanelName | number): void {
    const slot = panelSlot(panel);
    const collect = this.providers.get(slot);
    if (!collect) return;
    const push = (snap: PanelSnapshot | null | undefined) => {
      if (snap) devtoolsSetSnapshot(this.handle, slot, encodeSnapshot(snap));
      this.lastProviderPush.set(slot, performance.now());
    };
    const fail = (err: unknown) => {
      devtoolsSetSnapshot(this.handle, slot, encodeSnapshot({
        status: "error",
        statusMsg: String(err),
        sections: [],
      }));
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

  /** Push all registered providers' snapshots (used on first update). */
  private pushAllProviders(): void {
    for (const slot of this.providers.keys()) {
      void this.refreshPanel(slot);
    }
  }

  /** Throttled provider refresh + command dispatch. */
  private pollProvidersAndCommands(): void {
    const now = performance.now();
    for (const slot of this.providers.keys()) {
      const last = this.lastProviderPush.get(slot) ?? 0;
      if (now - last > this.providerIntervalMs) {
        void this.refreshPanel(slot);
      }
    }
    // Drain UI-originated commands.
    for (let i = 0; i < 16; i++) {
      const cmd = devtoolsTakeCommand(this.handle);
      if (!cmd) break;
      this.dispatchCommand(cmd);
    }
  }

  private dispatchCommand(cmd: DevtoolsCommand): void {
    if (cmd.action === "refresh") {
      void this.refreshPanel(cmd.panel);
      return;
    }
    const handler = this.commandHandlers.get(cmd.panel) ?? this.globalCommandHandler;
    if (!handler) {
      log.warn("DevtoolsMirror", `unhandled command panel=${cmd.panel} action=${cmd.action}`);
      return;
    }
    try {
      const r = handler(cmd);
      if (r instanceof Promise) r.catch((err) => log.warn("DevtoolsMirror", `command error: ${err}`));
    } catch (err) {
      log.warn("DevtoolsMirror", `command error: ${err}`);
    }
  }

  /**
   * Per-frame update: poll eval requests, handle refresh requests, push
   * throttled data. Called by NativeDebuggerHost.update().
   */
  update(): void {
    if (this.disposed) return;

    // Flush buffered logger entries to Rust on the main thread (the sink
    // may fire from worker threads; pushing directly would race with
    // dd_devtools_update reading s.console.entries).
    this.flushLoggerBuffer();

    // On first update (debugger just became visible), push all data
    // immediately so panels aren't empty until the user clicks Refresh.
    if (this.firstUpdate) {
      this.firstUpdate = false;
      this.pushSceneTree();
      this.pushDomTree(this.domTreeMode);
      this.pushGpuInfo();
      this.pushMetrics();
      this.pushThreads();
      this.pushAllProviders();
    }

    // 1. Poll eval requests.
    for (let i = 0; i < 10; i++) {
      const req = devtoolsTakeEvalRequest(this.handle);
      if (!req) break;
      this.handleEvalRequest(req);
    }

    // 1b. Poll UI commands + throttled provider pushes.
    this.pollProvidersAndCommands();

    // 2. Handle refresh requests.
    // Read the current dom tree mode from Rust (0=scene, 1=ecs).
    this.domTreeMode = devtoolsGetDomTreeMode(this.handle) === 1 ? "ecs" : "scene";
    const refresh = devtoolsTakeRefreshRequests(this.handle);
    if (refresh & REFRESH_SCENE) this.pushSceneTree();
    if (refresh & REFRESH_DOM) this.pushDomTree(this.domTreeMode);
    if (refresh & REFRESH_GPU) this.pushGpuInfo();
    if (refresh & REFRESH_METRICS) this.pushMetrics();
    if (refresh & REFRESH_PERF_RECORD) this.startProfiling();
    if (refresh & REFRESH_PERF_STOP) this.stopProfiling();

    // 3. Throttled pushes (every 500ms).
    const now = performance.now();
    if (now - this.lastMetricsPush > 500) {
      this.lastMetricsPush = now;
      this.pushMetrics();
      this.pushThreads();
    }
    if (now - this.lastGpuPush > 1000) {
      this.lastGpuPush = now;
      this.pushGpuInfo();
    }
    if (now - this.lastScenePush > 2000) {
      this.lastScenePush = now;
      this.pushSceneTree();
    }
  }

  private async handleEvalRequest(req: { requestId: number; threadId: string; expr: string }): Promise<void> {
    const evalFn = this.threadEvals.get(req.threadId) ?? (req.threadId === "main" ? this.cdpEvaluate.bind(this) : null);
    if (!evalFn) {
      devtoolsPushEvalResult(this.handle, req.requestId, `< no eval for thread "${req.threadId}" >`, true);
      return;
    }
    try {
      const result = await evalFn(req.expr);
      if (result.error) {
        devtoolsPushEvalResult(this.handle, req.requestId, result.error, true);
      } else {
        const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
        devtoolsPushEvalResult(this.handle, req.requestId, text, false);
      }
    } catch (err) {
      devtoolsPushEvalResult(this.handle, req.requestId, String(err), true);
    }
  }

  private async cdpEvaluate(expr: string): Promise<{ result?: any; error?: string }> {
    return this.cdp.evaluate(expr);
  }

  /** Programmatic record/stop (same path as the panel's Record/Stop buttons). */
  setPerfRecording(start: boolean): void {
    if (start) this.startProfiling();
    else void this.stopProfiling();
  }

  private startProfiling(): void {
    try {
      this.cdp.startProfile();
      log.info("DevtoolsMirror", "Profiling started");
    } catch (err) {
      log.warn("DevtoolsMirror", `Failed to start profiling: ${err}`);
    }
  }

  private async stopProfiling(): Promise<void> {
    try {
      log.info("DevtoolsMirror", "Stopping profile...");
      const profile = await this.cdp.stopProfile();
      log.info("DevtoolsMirror", `Profile result: ${profile ? `${profile.nodes?.length ?? 0} nodes` : "null"}`);
      if (profile) this.pushProfile(profile);
    } catch (err) {
      log.warn("DevtoolsMirror", `Failed to stop profiling: ${err}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubConsole?.();
    this.unsubException?.();
    this.unsubLogger?.();
  }
}

// ── Helpers ──

/** Map a logger level string to the devtools console severity byte. */
function logLevelToSeverity(level: string): number {
  switch (level) {
    case "error":
    case "fatal":
      return 3; // Error
    case "warn":
      return 2; // Warning
    case "info":
      return 1; // Info
    case "debug":
      return 4; // Debug
    case "trace":
      return 5; // Trace
    default:
      return 0; // Log
  }
}
