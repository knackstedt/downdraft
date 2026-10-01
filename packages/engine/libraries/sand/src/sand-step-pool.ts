// ============================================================================
// Sand step pool — multi-threaded coordinator for SandWorld.step().
//
// Runs inside the mining worker. Spawns N sand-step workers, each processing
// a vertical strip of the grid. The grid + fields + deferred mask are backed
// by a single SharedArrayBuffer shared across all workers.
//
// Per step:
//   1. Dispatch step messages to all workers (postMessage, fire-and-forget).
//   2. Wait for all workers to report done (Promise.all of message events).
//   3. Boundary cleanup: re-run the movement pass on boundary columns, but
//      ONLY for cells whose cross-strip move was deferred by the write guard
//      (marked in the shared deferredMask). Write bounds are restricted to
//      the adjacent strip so only cross-strip moves are attempted, and RNG
//      gates are skipped (boundaryPass mode) to avoid giving boundary cells
//      an unfair second movement chance.
//
// The boundary cleanup runs on the coordinator's own SandWorld instance
// but only iterates the boundary columns and only the deferred cells within
// them. This is O(boundaryColumns * H) — typically 2*(N-1) columns —
// much cheaper than the full O(W*H) step.
// ============================================================================

import { MAT_GRAVITY, MAT_GRAVITY_DIR, SandWorld } from "./sand-world";

export interface SandStepPoolOptions {
  W: number;
  H: number;
  numWorkers: number;
  // The SAB backing the grid + fields + skip mask + deferred mask. If not provided, the pool allocates one.
  sab?: SharedArrayBuffer;
  gridOffset?: number;
  fieldsOffset?: number;
  skipMaskOffset?: number;
  deferredMaskOffset?: number;
  histogramOffset?: number;
  // Game-specific config forwarded to each worker's SandWorld.
  preserveFlagsMask?: number;
  disturbedFlags?: number;
  // Gravity overrides for materials that are static by default (gravityDir=0)
  // but need to fall in the game's context. Patched in each sand-step worker.
  gravityOverrides?: { mat: number; gravityDir: number; gravity: number }[];
  // Worker script URL (the sand-step-worker.ts compiled output).
  // If not provided, workers are created via the inline
  // `new Worker(new URL("./sand-step-worker.ts", import.meta.url))` pattern
  // in init() so that Vite can properly bundle the nested worker.
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
  private deferredMaskOffset: number;
  private histogramOffset: number;
  private strips: { startX: number; endX: number }[] = [];
  // The coordinator's own SandWorld for boundary cleanup. It shares the same
  // SAB-backed grid as the workers but has full-grid write bounds.
  private boundaryWorld: SandWorld;
  private workerUrl: string | null;
  private initialized = false;
  // In-flight init() promise — deduplicates concurrent init() calls so that
  // two callers (e.g. loadGrid + onTick racing) share one initialization
  // instead of each spawning a full set of workers. Without this, concurrent
  // init() calls each push numWorkers workers into `this.workers`, leaving
  // workers.length > strips.length and crashing step() on `strip.startX`.
  private initPromise: Promise<void> | null = null;
  private gravityOverrides: { mat: number; gravityDir: number; gravity: number }[] | undefined;
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
    const deferredMaskBytes = cells; // 1 byte per cell
    const histogramBytes = opts.W * 4; // 1 uint32 per column
    // The histogram is a Uint32Array view — its byte offset must stay
    // 4-aligned even when `cells` is odd (skip/deferred are 1B per cell).
    const align4 = (n: number) => (n + 3) & ~3;
    if (opts.sab) {
      this.sab = opts.sab;
      this.gridOffset = opts.gridOffset ?? 0;
      this.fieldsOffset = opts.fieldsOffset ?? gridBytes;
      this.skipMaskOffset = opts.skipMaskOffset ?? (gridBytes + fieldsBytes);
      this.deferredMaskOffset = opts.deferredMaskOffset ?? (gridBytes + fieldsBytes + skipMaskBytes);
      this.histogramOffset = opts.histogramOffset ?? align4(gridBytes + fieldsBytes + skipMaskBytes + deferredMaskBytes);
    } else {
      // Allocate a SAB for grid + fields + skip mask + deferred mask + histogram.
      this.gridOffset = 0;
      this.fieldsOffset = gridBytes;
      this.skipMaskOffset = gridBytes + fieldsBytes;
      this.deferredMaskOffset = gridBytes + fieldsBytes + skipMaskBytes;
      this.histogramOffset = align4(gridBytes + fieldsBytes + skipMaskBytes + deferredMaskBytes);
      this.sab = new SharedArrayBuffer(this.histogramOffset + histogramBytes);
    }
    // Compute strip boundaries — divide W into numWorkers roughly-equal strips.
    this.strips = this.computeStrips(opts.W, this.numWorkers);
    // Coordinator's boundary cleanup world — full grid bounds, SAB-backed.
    this.boundaryWorld = new SandWorld(opts.W, opts.H, {
      sab: this.sab,
      gridOffset: this.gridOffset,
      fieldsOffset: this.fieldsOffset,
      skipMaskOffset: this.skipMaskOffset,
      deferredMaskOffset: this.deferredMaskOffset,
      histogramOffset: this.histogramOffset,
      skipStoneFloor: true,
    });
    if (opts.preserveFlagsMask !== undefined) this.boundaryWorld.preserveFlagsMask = opts.preserveFlagsMask;
    if (opts.disturbedFlags !== undefined) this.boundaryWorld.disturbedFlags = opts.disturbedFlags;
    // Apply gravity overrides to the coordinator's boundary world too.
    if (opts.gravityOverrides) {
      this.gravityOverrides = opts.gravityOverrides;
      opts.gravityOverrides.forEach((o) => {
        MAT_GRAVITY_DIR[o.mat] = o.gravityDir;
        if (o.gravity !== 0) MAT_GRAVITY[o.mat] = o.gravity;
      });
    }
    // Custom worker URL — when provided, workers are created from this URL.
    // When not provided, init() uses the inline `new Worker(new URL(...))`
    // pattern so Vite can bundle the nested worker for production builds.
    this.workerUrl = opts.workerUrl ?? null;
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
    // Deduplicate concurrent init() calls. If two callers race into init()
    // (e.g. loadGrid's pool recreation overlapping with onTick's
    // `if (!this.initialized) await this.init()`), they share the same
    // initialization promise instead of each spawning numWorkers workers.
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.runInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async runInit(): Promise<void> {
    const initPromises: Promise<void>[] = [];
    for (let i = 0; i < this.numWorkers; i++) {
      // Use inline `new Worker(new URL(...))` when no custom URL is provided
      // so Vite can detect and bundle the nested worker for production builds.
      // Assigning the URL to a variable first breaks Vite's worker bundling.
      const worker = this.workerUrl
        ? new Worker(this.workerUrl, { type: "module" })
        : new Worker(new URL("./sand-step-worker.ts", import.meta.url), { type: "module" });
      this.workers.push(worker);
      const strip = this.strips[i];
      initPromises.push(new Promise<void>((resolve, reject) => {
        const onWorkerError = (e: ErrorEvent) => {
          reject(new Error(`sand-step-worker ${i} error: ${e.message ?? "undefined"} file=${e.filename ?? "none"}`));
        };
        worker.addEventListener("error", onWorkerError);
        const handler = (e: MessageEvent) => {
          if (e.data.type === "ready") {
            worker.removeEventListener("message", handler);
            worker.removeEventListener("error", onWorkerError);
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
          deferredMaskOffset: this.deferredMaskOffset,
          histogramOffset: this.histogramOffset,
          W: this.W,
          H: this.H,
          stripStartX: strip.startX,
          stripEndX: strip.endX,
          preserveFlagsMask: this.boundaryWorld.preserveFlagsMask,
          disturbedFlags: this.boundaryWorld.disturbedFlags,
          gravityOverrides: this.gravityOverrides,
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
   * Boundary cleanup: re-run the movement pass on boundary columns, but ONLY
   * for cells whose cross-strip move was deferred by the write guard during
   * the worker pass (marked in the shared deferredMask).
   *
   * For each interior strip boundary (between strip i and i+1), we process:
   *   - The last column of strip i — can now write into strip i+1.
   *   - The first column of strip i+1 — can now write into strip i.
   *
   * Key differences from the old approach (which re-ran the FULL tryMove on
   * every boundary cell with full-grid write bounds):
   *
   * 1. Only deferred cells are processed. Cells that didn't attempt a
   *    cross-strip move (friction-blocked, obstacle-blocked, or already moved)
   *    are skipped. This prevents the cleanup from re-rolling RNG gates
   *    (friction, flicker, impulse, wind) and giving boundary cells an unfair
   *    second movement chance — the root cause of "fast falling" artifacts at
   *    strip boundaries.
   *
   * 2. Write bounds are restricted to the adjacent strip for each column, so
   *    only cross-strip moves are attempted. Within-strip moves (which the
   *    worker already handled) are blocked by the write guard.
   *
   * 3. The boundaryPass flag on the boundary world skips all RNG-based
   *    movement gates in tryMove — those already had their chance during the
   *    worker pass.
   *
   * This is a movement-only pass — reactions, combustion, and aging already
   * ran in the workers. We only handle the cross-strip movement writes that
   * were skipped at the boundaries.
   */
  private runBoundaryCleanup(frame: number): void {
    if (this.numWorkers <= 1) return; // no boundaries with a single worker
    const bw = this.boundaryWorld;
    bw.frame = frame;
    bw.boundaryPass = true;
    const grid = bw.grid;
    const deferred = bw.deferredMask;
    if (deferred === null) {
      // No deferred mask (non-SAB mode) — nothing to do.
      bw.boundaryPass = false;
      return;
    }
    const W = this.W;
    const H = this.H;
    // Process each interior boundary pair separately so we can restrict
    // write bounds to the adjacent strip for each column.
    for (let bi = 0; bi < this.strips.length - 1; bi++) {
      const leftStrip = this.strips[bi];
      const rightStrip = this.strips[bi + 1];
      const leftCol = leftStrip.endX - 1;  // last col of left strip
      const rightCol = rightStrip.startX;   // first col of right strip

      // Process the left boundary column — can only write into the right strip.
      bw.writeXMin = rightStrip.startX;
      bw.writeXMax = rightStrip.endX;
      this.processBoundaryColumn(bw, grid, deferred, leftCol, W, H);

      // Process the right boundary column — can only write into the left strip.
      bw.writeXMin = leftStrip.startX;
      bw.writeXMax = leftStrip.endX;
      this.processBoundaryColumn(bw, grid, deferred, rightCol, W, H);
    }
    // Reset boundary pass state.
    bw.boundaryPass = false;
    bw.writeXMin = 0;
    bw.writeXMax = W;
    // Clear the deferred mask on all boundary columns — the mask is also
    // cleared at the start of the next frame by buildActiveListAndClearFlags,
    // but clearing here prevents any stale markers from affecting a potential
    // second cleanup call within the same frame.
    for (let bi = 0; bi < this.strips.length - 1; bi++) {
      const leftCol = this.strips[bi].endX - 1;
      const rightCol = this.strips[bi + 1].startX;
      for (let y = 0; y < H; y++) {
        deferred[y * W + leftCol] = 0;
        deferred[y * W + rightCol] = 0;
      }
    }
  }

  /**
   * Process a single boundary column: find the Y range of cells with the
   * deferred marker, then run tryMove on them bottom-to-top (matching the
   * main movement pass order). Only deferred cells are processed — tryMove
   * early-returns for cells without the marker when boundaryPass is true.
   */
  private processBoundaryColumn(
    bw: SandWorld, grid: Uint32Array, deferred: Uint8Array,
    col: number, W: number, H: number,
  ): void {
    let minY = H, maxY = 0;
    let hasDeferred = false;
    for (let y = 0; y < H; y++) {
      const idx = y * W + col;
      if (grid[idx] !== 0 && deferred[idx] !== 0) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        hasDeferred = true;
      }
    }
    if (!hasDeferred) return;
    // Process bottom-to-top (same as the main movement pass). tryMove
    // early-returns for non-deferred cells when boundaryPass is true, so
    // iterating the full [minY, maxY] range is cheap.
    bw.runBoundaryMovement([col], minY, maxY, true);
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
    this.workers.forEach((worker) => {
      worker.postMessage({ type: "shutdown" });
      worker.terminate();
    });
    this.workers = [];
    this.initialized = false;
    // Clear any in-flight init promise so a subsequent init() can rebuild
    // workers from scratch after shutdown.
    this.initPromise = null;
  }
}
