// ============================================================================
// SimWebWorker — manages the simulation Web Worker from the renderer process.
// Allocates SharedArrayBuffers, spawns the worker, and routes events.
// Uses the RPC layer (wrap/exposeEvents) for typed async communication.
// ============================================================================

import { allocateInputBuffer, allocateSimBuffer, type LoadOptions, type SaveOptions } from "@downdraft/core";
import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import type { OpfsSaveStoreOptions } from "@downdraft/library-persistence/browser";
import type { SandboxSimMessage, SimCommand } from "@sandbox/shared/types";

export type SimEventCallback = (msg: SandboxSimMessage) => void;

export interface SimWebWorkerConfig {
  seed: number;
  isDev?: boolean;
}

type SimApi = {
  init(simBuffer: SharedArrayBuffer, inputBuffer: SharedArrayBuffer, config: any): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number }>;
  load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean>;
  initSaveStore(opts: OpfsSaveStoreOptions): Promise<void>;
  sendCommand(cmd: SimCommand): Promise<void>;
  restoreFromState(stateJson: string): Promise<void>;
  shutdown(): Promise<void>;
};

export class SimWebWorker {
  private simBuffer: SharedArrayBuffer;
  private inputBuffer: SharedArrayBuffer;
  private wp: WorkerProxy<SimApi> | null = null;
  private eventCallbacks: Set<SimEventCallback> = new Set();
  private unsubEvents: (() => void) | null = null;
  private ready = false;

  constructor() {
    this.simBuffer = allocateSimBuffer();
    this.inputBuffer = allocateInputBuffer();
  }

  getSimBuffer(): SharedArrayBuffer { return this.simBuffer; }
  getInputBuffer(): SharedArrayBuffer { return this.inputBuffer; }
  isReady(): boolean { return this.ready; }

  onEvent(cb: SimEventCallback): void { this.eventCallbacks.add(cb); }
  offEvent(cb: SimEventCallback): void { this.eventCallbacks.delete(cb); }

  private dispatchEvents(kind: string, data: any): void {
    const msg = { kind, data } as SandboxSimMessage;
    for (const cb of this.eventCallbacks) {
      try { cb(msg); } catch (err) {
        console.error("[SimWebWorker] Event callback error:", err);
      }
    }
  }

  async start(config: SimWebWorkerConfig): Promise<void> {
    // NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    const worker = new Worker(new URL("./sim-worker-web.ts", import.meta.url), { type: "module" });
    this.wp = wrap<SimApi>(worker);

    this.unsubEvents = this.wp.onEvents((kind, data) => {
      if (kind === "ready") this.ready = true;
      this.dispatchEvents(kind, data);
    });

    worker.onerror = (e: ErrorEvent) => {
      console.error("[SimWebWorker] Worker error:", e.message);
      this.dispatchEvents("error", { message: e.message });
    };

    await this.wp.proxy.init(this.simBuffer, this.inputBuffer, {
      seed: config.seed,
      isDev: config.isDev,
    });

    this.ready = true;
    this.dispatchEvents("ready", {});
  }

  async save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean } | null> {
    if (!this.wp) return null;
    try { return await this.wp.proxy.save(slotName, opts); }
    catch (err) { console.error("[SimWebWorker] Save failed:", err); return null; }
  }

  async load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean> {
    if (!this.wp) return false;
    try { return await this.wp.proxy.load(slotName, stateJson, opts); }
    catch (err) { console.error("[SimWebWorker] Load failed:", err); return false; }
  }

  async initSaveStore(opts: OpfsSaveStoreOptions): Promise<void> {
    if (!this.wp) throw new Error("Worker not started");
    await this.wp.proxy.initSaveStore(opts);
  }

  sendCommand(cmd: SimCommand): void {
    this.wp?.proxy.sendCommand(cmd).catch(() => {});
  }

  pause(): void {
    this.wp?.proxy.pause().catch(() => {});
  }

  resume(): void {
    this.wp?.proxy.resume().catch(() => {});
  }

  async restoreFromState(stateJson: string): Promise<void> {
    if (!this.wp) throw new Error("Worker not started");
    await this.wp.proxy.restoreFromState(stateJson);
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
}
