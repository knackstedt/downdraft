// ============================================================================
// Sand step pool — multi-threaded coordinator for SandWorld.step().
//
// Runs inside the mining worker. Spawns N sand-step workers, each processing
// a vertical strip of the grid. The grid + fields are backed by a single
// SharedArrayBuffer shared across all workers.
//
// Per step:
//   1. Dispatch step messages to all workers (postMessage, fire-and-forget).
//   2. Wait for all workers to report done (Promise.all of message events).
//   3. Boundary cleanup: re-run the movement pass on the 1-cell-wide columns
//      at each strip boundary so cross-strip moves (trySwap/tryFlow that were
//      skipped by write guards) get a chance to execute.
//
// The boundary cleanup runs on the coordinator's own SandWorld instance
// (full-grid bounds, no strip restriction) but only iterates the boundary
// columns. This is O(boundaryColumns * H) — typically 3*(N-1) columns —
// much cheaper than the full O(W*H) step.
// ============================================================================

import { SandWorld } from "./sand-world";

export interface SandStepPoolOptions {
  W: number;
  H: number;
  numWorkers: number;
  // The SAB backing the grid + fields + skip mask. If not provided, the pool allocates one.
  sab?: SharedArrayBuffer;
  gridOffset?: number;
  fieldsOffset?: number;
  skipMaskOffset?: number;
  histogramOffset?: number;
  // Game-specific config forwarded to each worker's SandWorld.
  preserveFlagsMask?: number;
  disturbedFlags?: number;
  // Worker script URL (the sand-step-worker.ts compiled output).
  // If not provided, defaults to resolving sand-step-worker.ts relative to
  // this module via import.meta.url (works with Vite's worker bundling).
  workerUrl?: string;
}

export class SandStepPool {
  private workers: Worker[] = [];
  private W: number;
  private H: number;
  private numWorkers: number;
  private sab: SharedArrayBuffer;
  private gridOffset: number;
  private fieldsOffset: number;
  private skipMaskOffset: number;
  private histogramOffset: number;
  private strips: { startX: number; endX: number }[] = [];
  // The coordinator's own SandWorld for boundary cleanup. It shares the same
  // SAB-backed grid as the workers but has full-grid write bounds.
  private boundaryWorld: SandWorld;
  private workerUrl: string;
  private initialized = false;
  // Rebalance throttle: only rebalance every N steps to avoid overhead.
  private stepCount = 0;
  private readonly REBALANCE_INTERVAL = 8;

  constructor(opts: SandStepPoolOptions) {
    this.W = opts.W;
    this.H = opts.H;
    this.numWorkers = Math.max(1, opts.numWorkers);
    const cells = opts.W * opts.H;
    const gridBytes = cells * 4;
    const fieldsBytes = cells * 4;
    const skipMaskBytes = cells; // 1 byte per cell
    const histogramBytes = opts.W * 4; // 1 uint32 per column
    if (opts.sab) {
      this.sab = opts.sab;
      this.gridOffset = opts.gridOffset ?? 0;
      this.fieldsOffset = opts.fieldsOffset ?? gridBytes;
      this.skipMaskOffset = opts.skipMaskOffset ?? (gridBytes + fieldsBytes);
      this.histogramOffset = opts.histogramOffset ?? (gridBytes + fieldsBytes + skipMaskBytes);
    } else {
      // Allocate a SAB for grid + fields + skip mask + histogram.
      this.sab = new SharedArrayBuffer(gridBytes + fieldsBytes + skipMaskBytes + histogramBytes);
      this.gridOffset = 0;
      this.fieldsOffset = gridBytes;
      this.skipMaskOffset = gridBytes + fieldsBytes;
      this.histogramOffset = gridBytes + fieldsBytes + skipMaskBytes;
    }
    // Compute strip boundaries — divide W into numWorkers roughly-equal strips.
    this.strips = this.computeStrips(opts.W, this.numWorkers);
    // Coordinator's boundary cleanup world — full grid bounds, SAB-backed.
    this.boundaryWorld = new SandWorld(opts.W, opts.H, {
      sab: this.sab,
      gridOffset: this.gridOffset,
      fieldsOffset: this.fieldsOffset,
      skipMaskOffset: this.skipMaskOffset,
      histogramOffset: this.histogramOffset,
      skipStoneFloor: true,
    });
    if (opts.preserveFlagsMask !== undefined) this.boundaryWorld.preserveFlagsMask = opts.preserveFlagsMask;
    if (opts.disturbedFlags !== undefined) this.boundaryWorld.disturbedFlags = opts.disturbedFlags;
    // Default worker URL: resolve relative to this module (Vite handles this).
    this.workerUrl = opts.workerUrl ?? new URL("./sand-step-worker.ts", import.meta.url).href;
  }

  private computeStrips(W: number, n: number): { startX: number; endX: number }[] {
    const strips: { startX: number; endX: number }[] = [];
    const base = Math.floor(W / n);
    const rem = W % n;
    let x = 0;
    for (let i = 0; i < n; i++) {
      const w = base + (i < rem ? 1 : 0);
      strips.push({ startX: x, endX: x + w });
      x += w;
    }
    return strips;
  }

  /**
   * Compute balanced strip boundaries from the per-column active cell
   * histogram. Uses a prefix-sum to find N boundaries that split the total
   * active cell count as evenly as possible. This equalizes per-worker load
   * regardless of where particles cluster in the X dimension.
   *
   * Each strip gets at least 1 column (guards against degenerate cases where
   * most columns are empty).
   */
  private computeBalancedStrips(histogram: Uint32Array, n: number): { startX: number; endX: number }[] {
    const W = histogram.length;
    // Prefix sum of active cells per column.
    const prefix = new Float64Array(W + 1);
    let total = 0;
    for (let x = 0; x < W; x++) {
      total += histogram[x];
      prefix[x + 1] = total;
    }
    // If the grid is (nearly) empty, fall back to equal-width strips.
    if (total < n) return this.computeStrips(W, n);
    const strips: { startX: number; endX: number }[] = [];
    const targetPerStrip = total / n;
    let x = 0;
    for (let i = 0; i < n; i++) {
      const target = (i + 1) * targetPerStrip;
      // Find the column x where prefix[x+1] first reaches the target.
      // Binary search for efficiency (W can be 640+).
      let lo = x, hi = W;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (prefix[mid + 1] < target) lo = mid + 1;
        else hi = mid;
      }
      let endX = lo;
      // Ensure at least 1 column per strip.
      if (endX <= x) endX = x + 1;
      // Ensure the last strip reaches W.
      if (i === n - 1) endX = W;
      // Don't exceed W.
      if (endX > W) endX = W;
      strips.push({ startX: x, endX });
      x = endX;
    }
    return strips;
  }

  /** Initialize all workers. Must be called before step(). */
  async init(): Promise<void> {
    if (this.initialized) return;
    const initPromises: Promise<void>[] = [];
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(this.workerUrl, { type: "module" });
      this.workers.push(worker);
      const strip = this.strips[i];
      initPromises.push(new Promise<void>((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data.type === "ready") {
            worker.removeEventListener("message", handler);
            resolve();
          }
        };
        worker.addEventListener("message", handler);
        worker.postMessage({
          type: "init",
          sab: this.sab,
          gridOffset: this.gridOffset,
          fieldsOffset: this.fieldsOffset,
          skipMaskOffset: this.skipMaskOffset,
          histogramOffset: this.histogramOffset,
          W: this.W,
          H: this.H,
          stripStartX: strip.startX,
          stripEndX: strip.endX,
          preserveFlagsMask: this.boundaryWorld.preserveFlagsMask,
          disturbedFlags: this.boundaryWorld.disturbedFlags,
        });
      }));
    }
    await Promise.all(initPromises);
    this.initialized = true;
  }

  /** Get the SAB-backed skip mask (coordinator writes to it, workers read). */
  getSkipMask(): Uint8Array {
    return this.boundaryWorld.skipMask!;
  }

  /** Copy an external skip mask into the SAB-backed skip mask. */
  setSkipMask(mask: Uint8Array): void {
    const sabMask = this.boundaryWorld.skipMask;
    if (sabMask) {
      sabMask.set(mask.subarray(0, this.W * this.H));
    }
  }

  /** Sync config to all workers. Called when interlace/impulse settings change. */
  private lastConfig = {
    interlaceEnabled: false,
    interlaceScale: 1,
    horizontalImpulseChance: 0.02,
    horizontalImpulseStrength: 1,
  };

  updateConfig(config: {
    interlaceEnabled?: boolean;
    interlaceScale?: number;
    horizontalImpulseChance?: number;
    horizontalImpulseStrength?: number;
  }): void {
    if (config.interlaceEnabled !== undefined) this.lastConfig.interlaceEnabled = config.interlaceEnabled;
    if (config.interlaceScale !== undefined) this.lastConfig.interlaceScale = config.interlaceScale;
    if (config.horizontalImpulseChance !== undefined) this.lastConfig.horizontalImpulseChance = config.horizontalImpulseChance;
    if (config.horizontalImpulseStrength !== undefined) this.lastConfig.horizontalImpulseStrength = config.horizontalImpulseStrength;
    // Also update the boundary world
    this.boundaryWorld.interlaceEnabled = this.lastConfig.interlaceEnabled;
    this.boundaryWorld.interlaceScale = this.lastConfig.interlaceScale;
    this.boundaryWorld.horizontalImpulseChance = this.lastConfig.horizontalImpulseChance;
    this.boundaryWorld.horizontalImpulseStrength = this.lastConfig.horizontalImpulseStrength;
  }

  /**
   * Run one sand step across all workers + boundary cleanup.
   * Returns a promise that resolves when all workers + cleanup are done.
   */
  async step(frame: number): Promise<void> {
    if (!this.initialized) await this.init();
    // Dispatch step to all workers. The skip mask + histogram are in the SAB —
    // workers read/write them directly, no need to post.
    const stepPromises: Promise<void>[] = [];
    for (let i = 0; i < this.workers.length; i++) {
      const worker = this.workers[i];
      const strip = this.strips[i];
      stepPromises.push(new Promise<void>((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data.type === "done") {
            worker.removeEventListener("message", handler);
            resolve();
          }
        };
        worker.addEventListener("message", handler);
        worker.postMessage({
          type: "step",
          frame,
          stripStartX: strip.startX,
          stripEndX: strip.endX,
          interlaceEnabled: this.lastConfig.interlaceEnabled,
          interlaceScale: this.lastConfig.interlaceScale,
          horizontalImpulseChance: this.lastConfig.horizontalImpulseChance,
          horizontalImpulseStrength: this.lastConfig.horizontalImpulseStrength,
        });
      }));
    }
    await Promise.all(stepPromises);
    // Boundary cleanup: re-run movement on the 1-cell-wide columns at each
    // strip boundary. The workers skipped cross-strip writes; this pass lets
    // particles at the boundary move into the adjacent strip.
    this.runBoundaryCleanup(frame);
    // Periodically rebalance strip boundaries based on the per-column active
    // cell histogram (written by workers during buildActiveListAndClearFlags).
    // The histogram is in the SAB — no postMessage needed. New boundaries take
    // effect on the next step (passed in the step message).
    this.stepCount++;
    if (this.stepCount % this.REBALANCE_INTERVAL === 0 && this.numWorkers > 1) {
      const histogram = this.boundaryWorld.histogram;
      if (histogram) {
        this.strips = this.computeBalancedStrips(histogram, this.numWorkers);
      }
    }
  }

  /**
   * Boundary cleanup: re-run the movement pass on boundary columns.
   *
   * For each interior strip boundary (between strip i and i+1), we process:
   *   - The last column of strip i (writeXMax-1) — can now write into strip i+1.
   *   - The first column of strip i+1 (writeXMin) — can now write into strip i.
   * We temporarily set the boundary world's write bounds to cover both strips
   * so trySwap/tryFlow can cross the boundary.
   *
   * This is a movement-only pass — reactions, combustion, and aging already
   * ran in the workers. We only need to handle the movement writes that were
   * skipped at the boundaries.
   */
  private runBoundaryCleanup(frame: number): void {
    if (this.numWorkers <= 1) return; // no boundaries with a single worker
    this.boundaryWorld.frame = frame;
    // For each interior boundary, process the 2 columns around it.
    // We set write bounds to the full grid so trySwap can cross.
    this.boundaryWorld.writeXMin = 0;
    this.boundaryWorld.writeXMax = this.W;
    // Process bottom-to-top (same as the main movement pass).
    const leftToRight = frame % 2 === 0;
    // We need the active Y bounds. The workers updated the shared grid but
    // not the coordinator's minActiveY/maxActiveY. We approximate by scanning
    // the boundary columns for non-empty cells. This is cheap (2*N columns).
    let minY = this.H, maxY = 0;
    const grid = this.boundaryWorld.grid;
    for (let bi = 0; bi < this.strips.length - 1; bi++) {
      const leftEnd = this.strips[bi].endX - 1; // last col of left strip
      const rightStart = this.strips[bi + 1].startX; // first col of right strip
      for (let y = 0; y < this.H; y++) {
        if (grid[y * this.W + leftEnd] !== 0 || grid[y * this.W + rightStart] !== 0) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minY > maxY) return; // no active cells at boundaries
    // Run tryMove on the boundary columns. We use the private method via
    // a public wrapper. Since tryMove is private, we add a public method
    // to SandWorld for boundary cleanup.
    const cols: number[] = [];
    for (let bi = 0; bi < this.strips.length - 1; bi++) {
      cols.push(this.strips[bi].endX - 1);
      cols.push(this.strips[bi + 1].startX);
    }
    this.boundaryWorld.runBoundaryMovement(cols, minY, maxY, leftToRight);
    // Reset write bounds to full grid (already set above, but be explicit).
  }

  /** Get the shared grid (for the chunk-world to read/write directly). */
  getGrid(): Uint32Array {
    return this.boundaryWorld.grid;
  }

  /** Get the boundary world (the coordinator's SandWorld — shared SAB grid). */
  getBoundaryWorld(): SandWorld {
    return this.boundaryWorld;
  }

  /** Get the shared fields array. */
  getFields(): Uint8Array {
    return this.boundaryWorld.fields;
  }

  /** Get the SAB backing the grid + fields. */
  getSAB(): SharedArrayBuffer {
    return this.sab;
  }

  /** Shut down all workers. */
  shutdown(): void {
    for (const worker of this.workers) {
      worker.postMessage({ type: "shutdown" });
      worker.terminate();
    }
    this.workers = [];
    this.initialized = false;
  }
}
