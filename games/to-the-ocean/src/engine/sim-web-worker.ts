// ============================================================================
// SimWebWorker — manages the simulation Web Worker from the renderer process
// Allocates SharedArrayBuffers, spawns the worker, and routes events.
// Uses the RPC layer (wrap/exposeEvents) for typed async communication.
// ============================================================================

import { allocateInputBuffer, allocateSimBuffer, HotReloadPipeline, type GCControllerConfig, type GCControllerStats, type IHotReloadable, type LoadOptions, type SaveOptions } from "@downdraft/core";
import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import type { OpfsSaveStoreOptions } from "@downdraft/library-persistence/browser";
import { WaterChannel } from "@downdraft/library-water";
import type { DevToolsManifest } from "@downdraft/module-devtools";
import { DEFAULT_GAME_RULES } from "@shared/constants";
import { SimToMainMessage } from "@shared/types";
import { allocateBoatBuffer } from "@to-the-ocean/library-boats/boat-sab";

export type SimEventCallback = (msg: SimToMainMessage) => void;

export interface SimWebWorkerConfig {
  seed: number;
  gamemode: number;
  rules: Record<string, number | boolean>;
  isDev?: boolean;
}

type SimApi = {
  init(simBuffer: SharedArrayBuffer, inputBuffer: SharedArrayBuffer, waterBuffer: SharedArrayBuffer, boatBuffer: SharedArrayBuffer, config: any): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number }>;
  load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean>;
  initSaveStore(opts: OpfsSaveStoreOptions): Promise<void>;
  setGamemode(mode: number): Promise<void>;
  addPlayer(playerId: number, name: string): Promise<void>;
  removePlayer(playerId: number): Promise<void>;
  setSetting(key: string, value: number | boolean): Promise<void>;
  respawnPlayer(playerId: number): Promise<void>;
  shutdown(): Promise<void>;
  setDebugMode(enabled: boolean): Promise<void>;
  sendCommand(cmd: any): Promise<void>;
  sendWorldCommand(cmd: any): Promise<void>;
  setWeather(weatherType: number): Promise<void>;
  setTimeOfDay(time: number): Promise<void>;
  setSimSpeed(speed: number): Promise<void>;
  getSimSpeed(): Promise<number>;
  setPhysicsProfiler(enabled: boolean): Promise<void>;
  restoreFromState(stateJson: string): Promise<void>;
  setGCConfig(config: Partial<GCControllerConfig>): Promise<void>;
  getGCStats(): Promise<GCControllerStats | null>;
  forceMajorGC(): Promise<void>;
  // DevTools RPC methods (added by exposeDevToolsApi in the worker)
  __devtoolsGetManifest(): Promise<DevToolsManifest>;
  __devtoolsCallCommand(name: string, args: any[]): Promise<any>;
  __devtoolsGetSAB(): Promise<SharedArrayBuffer | null>;
};

/**
 * Public interface for the simulation worker — the subset of SimWebWorker
 * methods used by the sim-bridge. Extracted so the bridge can depend on an
 * interface (enabling DI + testing with fakes) rather than the concrete class.
 */
export interface ISimWorker {
  start(config: SimWebWorkerConfig): Promise<void>;
  addPlayer(playerId: number, name: string): void;
  removePlayer(playerId: number): void;
  pause(): void;
  resume(): void;
  save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number } | null>;
  load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean>;
  initSaveStore(opts: OpfsSaveStoreOptions): Promise<void>;
  setGamemode(mode: number): void;
  setSetting(key: string, value: number | boolean): void;
  respawnPlayer(playerId: number): void;
  setDebugMode(enabled: boolean): void;
  sendCommand(cmd: any): void;
  sendWorldCommand(cmd: any): void;
  setWeather(weatherType: number): void;
  setTimeOfDay(time: number): void;
  setSimSpeed(speed: number): void;
  getSimSpeed(): Promise<number>;
  setPhysicsProfiler(enabled: boolean): void;
  setGCConfig(config: Partial<GCControllerConfig>): void;
  getGCStats(): Promise<GCControllerStats | null>;
  forceMajorGC(): void;
  restoreFromState(stateJson: string): Promise<void>;
  hotReload(config: SimWebWorkerConfig, preserveState: boolean): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: SimEventCallback): void;
  offEvent(cb: SimEventCallback): void;
  getSimBuffer(): SharedArrayBuffer;
  getInputBuffer(): SharedArrayBuffer;
  getWaterBuffer(): SharedArrayBuffer;
  getBoatBuffer(): SharedArrayBuffer;
  /** Extra SABs exposed via GameContext.extraBuffers (water + boat). */
  getExtraBuffers?(): Record<string, SharedArrayBuffer>;
  isReady(): boolean;
}

export class SimWebWorker implements IHotReloadable, ISimWorker {
  private simBuffer: SharedArrayBuffer;
  private inputBuffer: SharedArrayBuffer;
  private waterBuffer: SharedArrayBuffer;
  private boatBuffer: SharedArrayBuffer;
  private wp: WorkerProxy<SimApi> | null = null;
  private eventCallbacks: Set<SimEventCallback> = new Set();
  private unsubEvents: (() => void) | null = null;
  private ready: boolean = false;

  /**
   * @param externalBuffers Optional pre-allocated SABs (e.g. from EngineLibrary
   *   descriptors). If provided, the worker uses these instead of allocating
   *   its own. Keys: "water", "boat" (sim/input are always self-allocated).
   */
  constructor(externalBuffers?: { water?: SharedArrayBuffer; boat?: SharedArrayBuffer }) {
    this.simBuffer = allocateSimBuffer();
    this.inputBuffer = allocateInputBuffer();
    this.waterBuffer = externalBuffers?.water ?? WaterChannel.allocate();
    this.boatBuffer = externalBuffers?.boat ?? allocateBoatBuffer();
  }

  getSimBuffer(): SharedArrayBuffer { return this.simBuffer; }
  getInputBuffer(): SharedArrayBuffer { return this.inputBuffer; }
  getWaterBuffer(): SharedArrayBuffer { return this.waterBuffer; }
  getBoatBuffer(): SharedArrayBuffer { return this.boatBuffer; }
  /** Extra SABs exposed via GameContext.extraBuffers (water + boat). */
  getExtraBuffers(): Record<string, SharedArrayBuffer> {
    return { water: this.waterBuffer, boat: this.boatBuffer };
  }

  isReady(): boolean { return this.ready; }

  /**
   * Attach the global ProfilingSAB to the sim worker. Called by the renderer
   * after initDevTools({ profiling: true }) creates the ProfilingBridge.
   * The worker's profiling prelude claims a slot + patches prototypes +
   * initializes the warning engine + event-loop monitor.
   */
  async attachProfilingSAB(sab: SharedArrayBuffer): Promise<void> {
    if (!this.wp) return;
    try {
      await (this.wp.proxy as any).__profilingAttach?.(sab, {
        workerTag: "sim",
        runtime: 0,
        opfs: true,
        idb: true,
        defaultWarningRules: true,
      });
    } catch (err) {
      console.warn("[SimWebWorker] Profiling SAB attach failed:", err);
    }
  }

  /**
   * Returns a DevToolsWorkerProxy for syncing the worker's devtools manifest
   * with the renderer-side registry. Used by initDevTools() via syncWorkerManifests().
   */
  getDevToolsProxy(): { __devtoolsGetManifest(): Promise<DevToolsManifest>; __devtoolsCallCommand(name: string, args: any[]): Promise<any>; __devtoolsGetSAB(): Promise<SharedArrayBuffer | null> } | null {
    return this.wp?.proxy ?? null;
  }

  onEvent(cb: SimEventCallback): void {
    this.eventCallbacks.add(cb);
  }

  offEvent(cb: SimEventCallback): void {
    this.eventCallbacks.delete(cb);
  }

  private dispatchEvents(kind: string, data: any): void {
    const msg = { kind, data } as SimToMainMessage;
    for (const cb of this.eventCallbacks) {
      try { cb(msg); } catch (err) {
        console.error("[SimWebWorker] Event callback error:", err);
      }
    }
  }

  async start(config: SimWebWorkerConfig): Promise<void> {
    await this.startInternal(config, Date.now());
  }

  addPlayer(playerId: number, name: string): void {
    this.wp?.proxy.addPlayer(playerId, name).catch(() => {});
  }

  removePlayer(playerId: number): void {
    this.wp?.proxy.removePlayer(playerId).catch(() => {});
  }

  pause(): void {
    this.wp?.proxy.pause().catch(() => {});
  }

  resume(): void {
    this.wp?.proxy.resume().catch(() => {});
  }

  async save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number } | null> {
    if (!this.wp) return null;
    try {
      return await this.wp.proxy.save(slotName, opts);
    } catch (err) {
      console.error("[SimWebWorker] Save failed:", err);
      return null;
    }
  }

  async load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean> {
    if (!this.wp) return false;
    try {
      return await this.wp.proxy.load(slotName, stateJson, opts);
    } catch (err) {
      console.error("[SimWebWorker] Load failed:", err);
      return false;
    }
  }

  async initSaveStore(opts: OpfsSaveStoreOptions): Promise<void> {
    if (!this.wp) throw new Error("Worker not started");
    await this.wp.proxy.initSaveStore(opts);
  }

  setGamemode(mode: number): void {
    this.wp?.proxy.setGamemode(mode).catch(() => {});
  }

  setSetting(key: string, value: number | boolean): void {
    this.wp?.proxy.setSetting(key, value).catch(() => {});
  }

  respawnPlayer(playerId: number): void {
    this.wp?.proxy.respawnPlayer(playerId).catch(() => {});
  }

  setDebugMode(enabled: boolean): void {
    this.wp?.proxy.setDebugMode(enabled).catch(() => {});
  }

  sendCommand(cmd: any): void {
    this.wp?.proxy.sendCommand(cmd).catch(() => {});
  }

  sendWorldCommand(cmd: any): void {
    this.wp?.proxy.sendWorldCommand(cmd).catch(() => {});
  }

  setWeather(weatherType: number): void {
    this.wp?.proxy.setWeather(weatherType).catch(() => {});
  }

  setTimeOfDay(time: number): void {
    this.wp?.proxy.setTimeOfDay(time).catch(() => {});
  }

  setSimSpeed(speed: number): void {
    this.wp?.proxy.setSimSpeed(speed).catch(() => {});
  }

  async getSimSpeed(): Promise<number> {
    if (!this.wp) return 1.0;
    return this.wp.proxy.getSimSpeed().catch(() => 1.0);
  }

  setPhysicsProfiler(enabled: boolean): void {
    this.wp?.proxy.setPhysicsProfiler(enabled).catch(() => {});
  }

  setGCConfig(config: Partial<GCControllerConfig>): void {
    this.wp?.proxy.setGCConfig(config).catch(() => {});
  }

  async getGCStats(): Promise<GCControllerStats | null> {
    if (!this.wp) return null;
    return this.wp.proxy.getGCStats().catch(() => null);
  }

  forceMajorGC(): void {
    this.wp?.proxy.forceMajorGC().catch(() => {});
  }

  async restoreFromState(stateJson: string): Promise<void> {
    if (!this.wp) throw new Error("Worker not started");
    await this.wp.proxy.restoreFromState(stateJson);
  }

  private pipeline: HotReloadPipeline | null = null;

  async hotReload(config: SimWebWorkerConfig, preserveState: boolean): Promise<void> {
    if (!import.meta.env.DEV) return;
    if (!this.pipeline) {
      this.pipeline = new HotReloadPipeline(this);
    }
    await this.pipeline.hotReload(config, preserveState);
  }

  async stop(): Promise<void> {
    if (!this.wp) return;
    try { await this.wp.proxy.shutdown(); } catch {}
    this.wp.terminate();
    this.unsubEvents?.();
    this.unsubEvents = null;
    this.wp = null;
    this.ready = false;
  }

  private async startInternal(config: SimWebWorkerConfig, cacheBust?: number): Promise<void> {
    let worker: Worker;
    if (cacheBust) {
      // Dev hot-reload: cache-bust query param forces Vite dev server to
      // re-serve the worker module. Variable pattern is fine here — Vite's
      // dev server compiles .ts on the fly and the query param is supported.
      const workerUrl = new URL("./sim-worker-web.ts", import.meta.url);
      workerUrl.searchParams.set("t", String(cacheBust));
      worker = new Worker(workerUrl, { type: "module" });
    } else {
      // NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
      // Vite only bundles worker modules when it sees this exact pattern.
      // Assigning the URL to a variable first causes Vite to emit the worker
      // as a raw unbundled asset (bare imports unresolved), breaking prod.
      worker = new Worker(new URL("./sim-worker-web.ts", import.meta.url), { type: "module" });
    }

    this.wp = wrap<SimApi>(worker);

    this.unsubEvents = this.wp.onEvents((kind, data) => {
      if (kind === "ready") {
        this.ready = true;
      }
      this.dispatchEvents(kind, data);
    });

    worker.onerror = (e: ErrorEvent) => {
      console.error("[SimWebWorker] Worker error:", e.message);
      this.dispatchEvents("error", { message: e.message });
    };

    await this.wp.proxy.init(
      this.simBuffer,
      this.inputBuffer,
      this.waterBuffer,
      this.boatBuffer,
      {
        seed: config.seed,
        gamemode: config.gamemode,
        rules: config.rules ?? DEFAULT_GAME_RULES,
        isDev: config.isDev,
      },
    );

    this.ready = true;
    this.dispatchEvents("ready", {});
  }
}
