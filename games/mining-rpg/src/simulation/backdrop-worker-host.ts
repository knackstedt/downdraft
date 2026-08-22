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
//
// Flashing prevention: the worker atomically increments a version counter
// AFTER writing the grid + origin. The host uses a double-check pattern
// (read version before and after copying the grid) to ensure the grid is
// not partially written when the renderer uploads it.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import {
    BACKDROP_CHUNK_H,
    BACKDROP_CHUNK_W,
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

  // Stable copy of the grid — updated only when the worker has finished
  // writing a complete window (version double-check passes). The renderer
  // reads from this copy, never directly from the SAB (avoids flashing).
  private stableGrid: Uint32Array;
  private stableOriginX = 0;
  private stableOriginY = 0;
  private lastUploadedVersion = -1;

  constructor() {
    this.sab = new SharedArrayBuffer(BACKDROP_TOTAL_SAB_BYTES);
    this.stableGrid = new Uint32Array(BACKDROP_GRID_W * BACKDROP_GRID_H);
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  /** Get the stable backdrop grid (safe to upload — no partial writes). */
  getGrid(): Uint32Array {
    return this.stableGrid;
  }

  /** Get the stable backdrop origin X (in backdrop cell coords). */
  getOriginX(): number {
    return this.stableOriginX;
  }

  /** Get the stable backdrop origin Y (in backdrop cell coords). */
  getOriginY(): number {
    return this.stableOriginY;
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
   * Also copies the SAB grid into the stable buffer if the worker has
   * finished writing a new window (version double-check).
   */
  updateWindowIfNeeded(fgOriginCx: number, fgOriginCy: number): void {
    if (!this.ready || !this.proxy) return;
    if (fgOriginCx !== this.lastOriginCx || fgOriginCy !== this.lastOriginCy) {
      const isFirstWindow = this.lastOriginCx === Number.MIN_SAFE_INTEGER;
      if (!isFirstWindow) {
        const dxChunks = fgOriginCx - this.lastOriginCx;
        const dyChunks = fgOriginCy - this.lastOriginCy;
        this.shiftStableGrid(dxChunks, dyChunks);
      }
      this.lastOriginCx = fgOriginCx;
      this.lastOriginCy = fgOriginCy;
      this.proxy.proxy.setWindow(fgOriginCx, fgOriginCy).catch(() => {});
      // Skip refreshStableGrid this frame. The worker just received a new
      // setWindow and hasn't processed it yet — the SAB still contains data
      // for the previous window. refreshStableGrid (next frame onward) will
      // verify the SAB origin matches lastOriginCx/Cy before copying, so
      // stale data from an older window is never overwritten onto the
      // shifted grid. The shifted grid stays aligned until the worker catches
      // up and writes the new window's data.
      return;
    }
    this.refreshStableGrid();
  }

  /**
   * Shift the stable grid by (dxChunks, dyChunks) chunks and update the
   * stable origin. New edge columns/rows are filled with CAVE (0 = black).
   * This keeps the backdrop approximately aligned with the foreground while
   * the worker generates the exact content (takes ~1 frame).
   */
  private shiftStableGrid(dxChunks: number, dyChunks: number): void {
    if (dxChunks === 0 && dyChunks === 0) return;
    const dx = dxChunks * BACKDROP_CHUNK_W;
    const dy = dyChunks * BACKDROP_CHUNK_H;
    const w = BACKDROP_GRID_W;
    const h = BACKDROP_GRID_H;
    const grid = this.stableGrid;

    // Vertical shift: new[y] = old[y + dy]
    if (dy > 0) {
      for (let y = 0; y < h - dy; y++) {
        grid.copyWithin(y * w, (y + dy) * w, (y + dy + 1) * w);
      }
      grid.fill(0, (h - dy) * w, h * w);
    } else if (dy < 0) {
      const ady = -dy;
      for (let y = h - 1; y >= ady; y--) {
        grid.copyWithin(y * w, (y - ady) * w, (y - ady + 1) * w);
      }
      grid.fill(0, 0, ady * w);
    }

    // Horizontal shift: new[x] = old[x + dx]
    if (dx > 0) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        grid.copyWithin(row, row + dx, row + w);
        grid.fill(0, row + (w - dx), row + w);
      }
    } else if (dx < 0) {
      const adx = -dx;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        grid.copyWithin(row + adx, row, row + (w - adx));
        grid.fill(0, row, row + adx);
      }
    }

    this.stableOriginX += dx;
    this.stableOriginY += dy;
  }

  /**
   * Copy the SAB grid into the stable buffer using a version double-check.
   * The worker atomically increments the version AFTER writing the grid +
   * origin. We read the version before and after copying — if both match
   * and differ from the last uploaded version, the copy is consistent.
   * This prevents the renderer from uploading a partially-written grid
   * (which causes flashing when crossing chunk boundaries).
   */
  private refreshStableGrid(): void {
    const statsI32 = new Int32Array(this.sab, BACKDROP_STATS_OFFSET, 4);
    const sabGrid = new Uint32Array(this.sab, BACKDROP_GRID_OFFSET, BACKDROP_GRID_W * BACKDROP_GRID_H);

    // Read version BEFORE copying
    const v1 = Atomics.load(statsI32, 2);
    if (v1 === this.lastUploadedVersion) return; // no new data

    // Read the SAB origin. If it doesn't match the expected origin
    // (lastOriginCx * BACKDROP_CHUNK_W), the worker hasn't processed the
    // latest setWindow yet — the SAB contains data for a PREVIOUS window.
    // Copying it would overwrite the shifted grid with stale data that's
    // misaligned with the foreground. Skip and wait for the worker to catch up.
    const sabOriginX = Atomics.load(statsI32, 0);
    const sabOriginY = Atomics.load(statsI32, 1);
    const expectedX = this.lastOriginCx * BACKDROP_CHUNK_W;
    const expectedY = this.lastOriginCy * BACKDROP_CHUNK_H;
    if (sabOriginX !== expectedX || sabOriginY !== expectedY) return;

    // Copy grid + origin from SAB
    this.stableGrid.set(sabGrid);

    // Read version AFTER copying — if it changed, the worker was writing
    // concurrently; discard this copy and try again next frame.
    const v2 = Atomics.load(statsI32, 2);
    if (v1 !== v2) return;

    // Version is stable — commit the copy
    this.stableOriginX = sabOriginX;
    this.stableOriginY = sabOriginY;
    this.lastUploadedVersion = v1;
  }
}
