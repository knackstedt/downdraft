// ============================================================================
// SimWebWorker — manages the simulation Web Worker from the renderer process
// Thin subclass of EntitySimWorkerHost (SAB allocation, worker spawn, event
// routing, save/load, hot reload all live in the base class).
// ============================================================================

import { EntitySimWorkerHost, type EntitySimApi, type GCControllerConfig, type GCControllerStats, type LoadOptions, type SaveOptions } from "@downdraft/core";
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

type SimApi = EntitySimApi & {
  setGamemode(mode: number): Promise<void>;
  addPlayer(playerId: number, name: string): Promise<void>;
  removePlayer(playerId: number): Promise<void>;
  setSetting(key: string, value: number | boolean): Promise<void>;
  respawnPlayer(playerId: number): Promise<void>;
  setDebugMode(enabled: boolean): Promise<void>;
  sendWorldCommand(cmd: any): Promise<void>;
  setWeather(weatherType: number): Promise<void>;
  setTimeOfDay(time: number): Promise<void>;
  setSimSpeed(speed: number): Promise<void>;
  getSimSpeed(): Promise<number>;
  setPhysicsProfiler(enabled: boolean): Promise<void>;
  setGCConfig(config: Partial<GCControllerConfig>): Promise<void>;
  getGCStats(): Promise<GCControllerStats | null>;
  forceMajorGC(): Promise<void>;
  // DevTools RPC methods (added by exposeDevToolsApi in the worker)
  __devtoolsGetManifest(): Promise<DevToolsManifest>;
  __devtoolsCallCommand(name: string, args: any[]): Promise<any>;
  __devtoolsGetSAB(): Promise<SharedArrayBuffer | null>;
  __devtoolsEval(expr: string): Promise<{ result?: any; error?: string }>;
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
  /** Subscribe to all sim events; returns an unsubscribe function. */
  subscribeEvents(cb: SimEventCallback): () => void;
  getSimBuffer(): SharedArrayBuffer;
  getInputBuffer(): SharedArrayBuffer;
  getWaterBuffer(): SharedArrayBuffer;
  getBoatBuffer(): SharedArrayBuffer;
  /** Extra SABs exposed via GameContext.extraBuffers (water + boat). */
  getExtraBuffers?(): Record<string, SharedArrayBuffer>;
  isReady(): boolean;
}

export class SimWebWorker extends EntitySimWorkerHost<SimApi, SimWebWorkerConfig> implements ISimWorker {
  /**
   * @param externalBuffers Optional pre-allocated SABs (e.g. from EngineLibrary
   *   descriptors). If provided, the worker uses these instead of allocating
   *   its own. Keys: "water", "boat" (sim/input are always self-allocated).
   */
  constructor(externalBuffers?: { water?: SharedArrayBuffer; boat?: SharedArrayBuffer }) {
    super({
      extraBuffers: {
        water: externalBuffers?.water ?? WaterChannel.allocate(),
        boat: externalBuffers?.boat ?? allocateBoatBuffer(),
      },
    });
  }

  getWaterBuffer(): SharedArrayBuffer { return this.extraBuffers.water; }
  getBoatBuffer(): SharedArrayBuffer { return this.extraBuffers.boat; }

  protected spawnWorker(cacheBust?: number): Worker {
    if (cacheBust) {
      // Dev hot-reload: cache-bust query param forces Vite dev server to
      // re-serve the worker module. Variable pattern is fine here — Vite's
      // dev server compiles .ts on the fly and the query param is supported.
      const workerUrl = new URL("./sim-worker-web.ts", import.meta.url);
      workerUrl.searchParams.set("t", String(cacheBust));
      return new Worker(workerUrl, { type: "module" });
    }
    // NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    return new Worker(new URL("./sim-worker-web.ts", import.meta.url), { type: "module" });
  }

  protected override buildWorkerConfig(config: SimWebWorkerConfig): unknown {
    return {
      seed: config.seed,
      gamemode: config.gamemode,
      rules: config.rules ?? DEFAULT_GAME_RULES,
      isDev: config.isDev,
    };
  }

  // --- Game-specific verbs (fire-and-forget RPC) ---

  addPlayer(playerId: number, name: string): void {
    this.apiSend((api) => api.addPlayer(playerId, name));
  }

  removePlayer(playerId: number): void {
    this.apiSend((api) => api.removePlayer(playerId));
  }

  setGamemode(mode: number): void {
    this.apiSend((api) => api.setGamemode(mode));
  }

  setSetting(key: string, value: number | boolean): void {
    this.apiSend((api) => api.setSetting(key, value));
  }

  respawnPlayer(playerId: number): void {
    this.apiSend((api) => api.respawnPlayer(playerId));
  }

  setDebugMode(enabled: boolean): void {
    this.apiSend((api) => api.setDebugMode(enabled));
  }

  sendWorldCommand(cmd: any): void {
    this.apiSend((api) => api.sendWorldCommand(cmd));
  }

  setWeather(weatherType: number): void {
    this.apiSend((api) => api.setWeather(weatherType));
  }

  setTimeOfDay(time: number): void {
    this.apiSend((api) => api.setTimeOfDay(time));
  }

  setSimSpeed(speed: number): void {
    this.apiSend((api) => api.setSimSpeed(speed));
  }

  async getSimSpeed(): Promise<number> {
    return (await this.apiCall((api) => api.getSimSpeed())) ?? 1.0;
  }

  setPhysicsProfiler(enabled: boolean): void {
    this.apiSend((api) => api.setPhysicsProfiler(enabled));
  }

  setGCConfig(config: Partial<GCControllerConfig>): void {
    this.apiSend((api) => api.setGCConfig(config));
  }

  async getGCStats(): Promise<GCControllerStats | null> {
    return this.apiCall((api) => api.getGCStats());
  }

  forceMajorGC(): void {
    this.apiSend((api) => api.forceMajorGC());
  }
}
