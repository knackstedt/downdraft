// ============================================================================
// SimWebWorker — manages the simulation Web Worker from the renderer process
// Allocates SharedArrayBuffers, spawns the worker, and routes events.
// Uses the RPC layer (wrap/exposeEvents) for typed async communication.
// ============================================================================

import { HotReloadPipeline, type GCControllerConfig, type GCControllerStats, type IHotReloadable } from "@downdraft/core";
import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { allocateBoatBuffer } from "@shared/boat-buffer";
import { DEFAULT_GAME_RULES } from "@shared/constants";
import { allocateInputBuffer, allocateSimBuffer, allocateWaterBuffer } from "@shared/sim-buffer";
import { SimToMainMessage } from "@shared/types";

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
  save(slotName: string): Promise<{ slotName: string; stateJson: string }>;
  load(slotName: string, stateJson?: string): Promise<boolean>;
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
};

export class SimWebWorker implements IHotReloadable {
  private simBuffer: SharedArrayBuffer;
  private inputBuffer: SharedArrayBuffer;
  private waterBuffer: SharedArrayBuffer;
  private boatBuffer: SharedArrayBuffer;
  private wp: WorkerProxy<SimApi> | null = null;
  private eventCallbacks: Set<SimEventCallback> = new Set();
  private unsubEvents: (() => void) | null = null;
  private ready: boolean = false;

  constructor() {
    this.simBuffer = allocateSimBuffer();
    this.inputBuffer = allocateInputBuffer();
    this.waterBuffer = allocateWaterBuffer();
    this.boatBuffer = allocateBoatBuffer();
  }

  getSimBuffer(): SharedArrayBuffer { return this.simBuffer; }
  getInputBuffer(): SharedArrayBuffer { return this.inputBuffer; }
  getWaterBuffer(): SharedArrayBuffer { return this.waterBuffer; }
  getBoatBuffer(): SharedArrayBuffer { return this.boatBuffer; }

  isReady(): boolean { return this.ready; }

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

  async save(slotName: string): Promise<{ slotName: string; stateJson: string } | null> {
    if (!this.wp) return null;
    try {
      return await this.wp.proxy.save(slotName);
    } catch (err) {
      console.error("[SimWebWorker] Save failed:", err);
      return null;
    }
  }

  async load(slotName: string, stateJson?: string): Promise<boolean> {
    if (!this.wp) return false;
    try {
      return await this.wp.proxy.load(slotName, stateJson);
    } catch (err) {
      console.error("[SimWebWorker] Load failed:", err);
      return false;
    }
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
    const workerUrl = new URL("./sim-worker-web.ts", import.meta.url);
    if (cacheBust) {
      workerUrl.searchParams.set("t", String(cacheBust));
    }
    const worker = new Worker(workerUrl, { type: "module" });

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
