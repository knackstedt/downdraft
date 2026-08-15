// ============================================================================
// BackdropWorkerHost — manages the backdrop Web Worker and its shared SAB.
//
// The renderer creates this host alongside the MiningWorkerHost. The host
// spawns a worker that generates low-res backdrop chunks. When the foreground
// active grid origin changes (player crosses a chunk boundary), the renderer
// calls setWindow() to regenerate the backdrop window.
//
// The backdrop SAB is separate from the foreground SAB. The renderer reads
// the backdrop grid + origin from this SAB each frame.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import {
    BACKDROP_GRID_H,
    BACKDROP_GRID_OFFSET,
    BACKDROP_GRID_W,
    BACKDROP_STATS_OFFSET,
    BACKDROP_TOTAL_SAB_BYTES,
} from "../shared/constants";

type BackdropWorkerApi = {
  init(sab: SharedArrayBuffer): Promise<void>;
  setWindow(originCx: number, originCy: number): Promise<void>;
  shutdown(): Promise<void>;
};

export class BackdropWorkerHost {
  private sab: SharedArrayBuffer;
  private proxy: WorkerProxy<BackdropWorkerApi> | null = null;
  private worker: Worker | null = null;
  private ready = false;
  // Last window set to the worker (chunk coords of top-left)
  private lastOriginCx = Number.MIN_SAFE_INTEGER;
  private lastOriginCy = Number.MIN_SAFE_INTEGER;

  constructor() {
    this.sab = new SharedArrayBuffer(BACKDROP_TOTAL_SAB_BYTES);
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  /** Get the backdrop grid as a Uint32Array view. */
  getGrid(): Uint32Array {
    return new Uint32Array(this.sab, BACKDROP_GRID_OFFSET, BACKDROP_GRID_W * BACKDROP_GRID_H);
  }

  /** Get the backdrop origin X (in backdrop cell coords). */
  getOriginX(): number {
    return new Int32Array(this.sab, BACKDROP_STATS_OFFSET, 1)[0];
  }

  /** Get the backdrop origin Y (in backdrop cell coords). */
  getOriginY(): number {
    return new Int32Array(this.sab, BACKDROP_STATS_OFFSET + 4, 1)[0];
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const workerUrl = new URL("./backdrop-worker.ts", import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.proxy = wrap<BackdropWorkerApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[BackdropWorkerHost] Worker error:", e.message);
    };

    await this.proxy.proxy.init(this.sab);
    this.ready = true;
  }

  async stop(): Promise<void> {
    if (this.proxy) {
      try {
        await this.proxy.proxy.shutdown();
      } catch {}
      this.proxy.terminate();
    }
    this.proxy = null;
    this.worker = null;
    this.ready = false;
  }

  /**
   * Update the backdrop window if the foreground origin has changed.
   * Called each frame with the foreground's chunk origin.
   */
  updateWindowIfNeeded(fgOriginCx: number, fgOriginCy: number): void {
    if (!this.ready || !this.proxy) return;
    // The backdrop uses the same chunk grid but at half resolution.
    // Since backdrop chunks are half the size, the same chunk coords map
    // to the same world area. We use the same origin chunk coords.
    if (fgOriginCx !== this.lastOriginCx || fgOriginCy !== this.lastOriginCy) {
      this.lastOriginCx = fgOriginCx;
      this.lastOriginCy = fgOriginCy;
      this.proxy.proxy.setWindow(fgOriginCx, fgOriginCy).catch(() => {});
    }
  }
}
