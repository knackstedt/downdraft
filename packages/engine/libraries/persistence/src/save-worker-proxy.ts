// ============================================================================
// SaveWorkerProxy — ISaveStore implementation that delegates to a dedicated
// save Web Worker via the engine's RPC layer.
// ============================================================================
//
// The renderer creates this proxy when "worker" mode is selected. The proxy
// spawns the save worker, calls init(), and forwards all ISaveStore methods
// via postMessage (with ArrayBuffer transfer for zero-copy blob/thumbnail
// transfer).

import type {
    ISaveStore,
    LoadOptions,
    LoadResult,
    SaveGenerationInfo,
    SaveOptions,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveWarning,
} from "@downdraft/engine";
import { wrap, type WorkerProxy } from "@downdraft/engine/worker/rpc";
import type { OpfsSaveStoreOptions } from "./opfs-save-store";
import type { SaveWorkerApi } from "./save-worker";

export interface SaveWorkerProxyOptions {
  /** Options for the OpfsSaveStore inside the worker. */
  storeOptions: OpfsSaveStoreOptions;
  /** Worker URL (if not provided, defaults to ./save-worker.ts). */
  workerUrl?: URL;
}

export class SaveWorkerProxy implements ISaveStore {
  private wp: WorkerProxy<SaveWorkerApi> | null = null;
  private warningCallbacks: Array<(w: SaveWarning) => void> = [];
  private initialized = false;

  constructor(private opts: SaveWorkerProxyOptions) {}

  /**
   * Spawn the worker and initialize the OpfsSaveStore inside it.
   * Must be called before any save/load operation.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    const worker = this.opts.workerUrl
      ? new Worker(this.opts.workerUrl, { type: "module" })
      : new Worker(new URL("./save-worker.ts", import.meta.url), { type: "module" });
    this.wp = wrap<SaveWorkerApi>(worker);

    await this.wp.proxy.init(this.opts.storeOptions);
    this.initialized = true;
  }

  private ensureInit(): WorkerProxy<SaveWorkerApi> {
    if (!this.wp || !this.initialized) {
      throw new Error("SaveWorkerProxy not initialized — call init() first");
    }
    return this.wp;
  }

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    return this.ensureInit().proxy.save(slot, state, opts);
  }

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    return this.ensureInit().proxy.load(slot, opts);
  }

  async listSaves(): Promise<SaveSlotInfo[]> {
    return this.ensureInit().proxy.listSaves();
  }

  async listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    return this.ensureInit().proxy.listGenerations(slot);
  }

  async deleteSave(slot: string): Promise<boolean> {
    return this.ensureInit().proxy.deleteSave(slot);
  }

  async deleteGeneration(slot: string, gen: number): Promise<boolean> {
    return this.ensureInit().proxy.deleteGeneration(slot, gen);
  }

  async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    return this.ensureInit().proxy.setThumbnail(slot, data);
  }

  async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    return this.ensureInit().proxy.getThumbnail(slot);
  }

  async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    return this.ensureInit().proxy.setProperties(slot, props);
  }

  async getProperties(slot: string): Promise<Record<string, unknown>> {
    return this.ensureInit().proxy.getProperties(slot);
  }

  onWarning(cb: (warning: SaveWarning) => void): () => void {
    this.warningCallbacks.push(cb);
    // Note: the worker forwards warnings via events; the proxy would need
    // to subscribe to events and forward. For now, warnings are logged in
    // the worker. A future improvement can wire up event forwarding.
    return () => {
      const idx = this.warningCallbacks.indexOf(cb);
      if (idx >= 0) this.warningCallbacks.splice(idx, 1);
    };
  }

  /** Terminate the worker and clean up. */
  async shutdown(): Promise<void> {
    if (this.wp) {
      try { await this.wp.proxy.shutdown(); } catch {}
      this.wp.terminate();
      this.wp = null;
    }
    this.initialized = false;
  }
}
