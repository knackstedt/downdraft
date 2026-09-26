import {
    FLAG_ANCHORED,
    FLAG_POPPED,
    FLAG_SPARK,
    FLAG_UPDATED,
    FLAG_UPDATED_BIT,
    pack,
    packCell,
    SHADE_MASK,
    unpack,
    type Cell
} from "./cell";
import { DEFAULT_GRAVITY, DEFAULT_TEMP, FIELD } from "./fields";
import { FluidGrid } from "./fluid-grid";
import {
    IS_ACID_IMMUNE,
    IS_FIRE,
    IS_HOT,
    MAT_DENSITY,
    MAT_FLAGS,
    MAT_FLAMMABLE,
    MAT_GAS,
    MAT_GRAVITY,
    MAT_GRAVITY_DIR,
    MAT_HAS_REACTIONS,
    MAT_LIFETIME,
    MAT_LIQUID,
    MAT_SOLID,
    Material
} from "./materials";
import { PARTICLE_TYPES, ParticleSystem } from "./particles";
import { SandRNG } from "./rng";
import { RuleEngine } from "./rules/rule-engine";
export { MAT_GRAVITY, MAT_GRAVITY_DIR } from "./materials";

function initialLifetime(mat: number): number {
  return MAT_LIFETIME[mat];
}

/** Ticks a Gravel cell must remain stationary (and stably supported) before
 *  re-settling to Stone. Long so mined debris stays loose and collectible for
 *  a while instead of visibly snapping back to solid stone within a second.
 *  At 60Hz, 600 ticks ≈ 10 seconds. */
export const GRAVEL_SETTLE_TICKS = 600;
/** Settle ticks used when a Gravel/Stone is disturbed by adjacent gravel
 *  movement. Short so the cell re-settles quickly if still supported, but
 *  gives it time to start falling if gravel flowed out from under it. */
export const GRAVEL_DISTURB_SETTLE_TICKS = 2;

// 4-neighbor offsets for disturbAdjacent
const DIR_DX = [0, 0, -1, 1];
const DIR_DY = [-1, 1, 0, 0];

export class SandWorld {
  W: number;
  H: number;
  grid: Uint32Array;
  // Per-cell physics fields: 4 bytes per cell [gravity:u8, temp:u8, windX:i8, windY:i8]
  fields: Uint8Array;
  frame = 0;
  // --- Strip mode (multi-threaded sand step) ---
  // When strip mode is enabled, this SandWorld only processes cells in
  // [stripStartX, stripEndX). It can READ the full grid (backed by SAB) but
  // only WRITES to cells in [writeXMin, writeXMax). Cross-strip writes are
  // skipped (trySwap/tryShove return false), and the coordinator's boundary
  // cleanup pass handles them after all workers finish.
  // Defaults: full grid (no restriction) — zero overhead when strip mode is off.
  stripStartX = 0;
  stripEndX = 0; // set to W in constructor
  writeXMin = 0;
  writeXMax = 0; // set to W in constructor
  // Fast xorshift32 PRNG — replaces Math.random() in hot loops.
  private rng: SandRNG;
  // Data-driven rule engine — replaces hardcoded if-else in applyReactions().
  private ruleEngine: RuleEngine;
  // Particle system for explosion visuals (flying debris, blast rings).
  private particles: ParticleSystem;
  // Global impulse settings (not spatial)
  horizontalImpulseChance = 0.02;
  horizontalImpulseStrength = 1;
  // Interlace mode: process every Nth row per frame (halves movement cost
  // for low-end devices). The row offset alternates each frame so all rows
  // are processed over N frames. Default 1 = disabled (process all rows).
  interlaceScale = 1;
  interlaceEnabled = false;
  // Additional flag bits (in the flags byte, bits 16-23) that consumers want
  // preserved across the per-frame FLAG_UPDATED clear in buildActiveListAndClearFlags.
  // The physics engine only uses bits 0-3 and 5 (shade 0-1, FLAG_UPDATED 2,
  // FLAG_SPARK 3, FLAG_POPPED 5); bits 4, 6-7 are available for game-specific
  // flags (e.g. a game's FLAG_DETACHED at bit 4).
  // Set this mask so those bits survive the clear. Defaults to 0 (no extra bits).
  preserveFlagsMask = 0;
  // Flag bits OR'd into the flags of cells disturbed by disturbAdjacent()
  // (Stone→LooseStone conversions when gravel flows out from under them).
  // Disturbed cells also get FLAG_UPDATED, but applyAging clears FLAG_UPDATED
  // before the chunk-world's expireWakeTicks() can detect them in frozen
  // chunks. Setting a persistent flag here (e.g. a game's FLAG_DETACHED)
  // ensures expireWakeTicks can re-activate frozen chunks that contain
  // disturbed cells. Defaults to 0 (no extra flags). Must be a subset of
  // preserveFlagsMask so the flag survives the per-frame clear.
  disturbedFlags = 0;

  // --- Reusable per-frame buffers (avoid allocations in hot paths) ---
  // fireSources: marks cells that are fire/lava at the start of applyCombustion.
  // visitedFrame: frame-tagged marker used in place of per-frame Sets for the
  //   ignitedFuse / ignitedOil de-duplication. A cell is "visited this frame"
  //   when visitedFrame[i] === this.frame. Shared between the fuse and
  //   burning-oil passes — safe because the two passes target different
  //   materials (Fuse vs Oil), so a cell marked in one pass is guarded out by
  //   the material-type check in the other before the visited check runs.
  private fireSources: Uint8Array;
  private visitedFrame: Uint32Array;
  // Separate frame-tagged visited array for C4 flood-fill (detonateC4).
  // Avoids clobbering the combustion pass's visitedFrame and avoids
  // allocating a Set on every detonation.
  private visitedC4Frame: Uint32Array;
  // Separate frame-tagged visited array for antimatter annihilation flood-fill.
  // Avoids clobbering the C4 / combustion visited arrays.
  private visitedAntimatterFrame: Uint32Array;

  // --- Sparse active-cell tracking ---
  // activeCells holds the grid indices of all non-empty cells. activeCount is
  // the number of valid entries. Rebuilt each frame (twice — once at the start
  // to replace the FLAG_UPDATED clear scan, once before applyAging to capture
  // cells created by combustion/reactions). Iterating the active list is
  // O(active) instead of O(W*H) — a massive win when the grid is mostly empty.
  private activeCells: Uint32Array;
  private activeCount = 0;

  // --- Active Y bounds ---
  // min/max rows that contain non-empty cells. The movement pass only
  // iterates [minActiveY, maxActiveY] instead of [0, H-1]. For a sparse
  // grid (e.g. a 50-cell-tall sand pile in a 512×512 world), this cuts
  // movement from O(W*H) to O(W*activeHeight).
  private minActiveY = 0;
  private maxActiveY = 0;

  // --- Chunk dirty bitmap ---
  // 1 bit per CHUNK_SIZE×CHUNK_SIZE block. Set when a cell in that chunk
  // changes. The movement pass skips chunks that aren't dirty, avoiding
  // scanning large empty regions within the active Y bounds.
  private static readonly CHUNK_SIZE = 16;
  private numChunksX = 0;
  private numChunksY = 0;
  private chunkDirty: Uint8Array;

  // --- Coarse-grid fluid simulation ---
  // Replaces the old per-cell wind field system. Provides pressure relaxation
  // and sustained airflow at 1/4 resolution. Per-cell wind is sampled from
  // this grid via bilinear interpolation in tryMove().
  private fluid: FluidGrid;

  // --- Chunk freeze support ---
  // Optional per-cell skip mask (length = W*H). When set, cells whose skipMask
  // entry is non-zero are excluded from the active-cell list and the movement
  // pass — they are "frozen" and do not participate in the simulation this
  // frame. Used by the game's chunk world to skip inactive (frozen) chunks.
  // null = no skipping (backward compatible with the original single-grid sim).
  skipMask: Uint8Array | null = null;
  // Per-column active cell count — SAB-backed when multi-threaded.
  // Written by each worker during buildActiveListAndClearFlags (only its own
  // strip's columns). Read by the coordinator after all workers finish to
  // rebalance strip boundaries for load balancing.
  histogram: Uint32Array | null = null;
  // Per-cell "deferred move" marker (length = W*H, SAB-backed when
  // multi-threaded). Set by movement functions (trySwap/tryFlow/etc.) when a
  // move is blocked SOLELY by the strip write guard — i.e. the destination is
  // in an adjacent strip and the move would have been valid if not for the
  // guard. The coordinator's boundary cleanup pass reads this to know which
  // cells need a cross-strip move attempt, and clears it after processing.
  //
  // Without this, the boundary cleanup would re-run the FULL tryMove on every
  // boundary cell — re-rolling friction/flicker/impulse RNG gates and giving
  // boundary cells a second movement chance that interior cells don't get.
  // This caused "fast falling" artifacts at strip boundaries: sand in boundary
  // columns fell ~1.3× faster because edge friction (30% skip/frame) was
  // effectively rolled twice (9% skip).
  //
  // null = no deferred tracking (single-threaded / non-SAB mode — no boundary
  // cleanup needed).
  deferredMask: Uint8Array | null = null;
  // When true, tryMove is running in the boundary cleanup pass. This skips all
  // RNG-based movement gates (friction, gas flicker, horizontal impulse, wind)
  // — those already had their chance during the worker pass — and only
  // processes cells marked in deferredMask. Write bounds are restricted to the
  // adjacent strip so only cross-strip moves are attempted.
  boundaryPass = false;

  constructor(w: number, h: number, options?: {
    sab?: SharedArrayBuffer;
    gridOffset?: number;
    fieldsOffset?: number;
    skipMaskOffset?: number;
    deferredMaskOffset?: number;
    histogramOffset?: number;
    skipStoneFloor?: boolean;
  }) {
    this.W = w;
    this.H = h;
    const cells = w * h;
    this.rng = new SandRNG();
    this.ruleEngine = new RuleEngine();
    this.particles = new ParticleSystem(512);
    this.fluid = new FluidGrid(w, h);
    // Grid + fields can be backed by a SharedArrayBuffer for multi-threaded
    // sand step. When SAB is provided, all workers share the same grid data.
    // Otherwise, regular ArrayBuffer (single-threaded, tests, backward compat).
    if (options?.sab) {
      const gridBytes = cells * 4;
      this.grid = new Uint32Array(options.sab, options.gridOffset ?? 0, cells);
      this.fields = new Uint8Array(options.sab, options.fieldsOffset ?? gridBytes, cells * 4);
      // Optional SAB-backed skip mask — shared between coordinator and workers.
      if (options.skipMaskOffset !== undefined) {
        this.skipMask = new Uint8Array(options.sab, options.skipMaskOffset, cells);
      }
      // Optional SAB-backed deferred-move mask — shared between workers and
      // the coordinator. Each worker writes only to its own strip's cells
      // (the source cell of a blocked move is always within the strip), so
      // there are no races. The coordinator reads it in the boundary cleanup.
      if (options.deferredMaskOffset !== undefined) {
        this.deferredMask = new Uint8Array(options.sab, options.deferredMaskOffset, cells);
      }
      // Optional SAB-backed per-column active cell histogram — used by the
      // coordinator to rebalance strip boundaries for load balancing.
      // Each worker writes only to its own strip's columns (no races).
      if (options.histogramOffset !== undefined) {
        this.histogram = new Uint32Array(options.sab, options.histogramOffset, w);
      }
    } else {
      this.grid = new Uint32Array(cells);
      this.fields = new Uint8Array(cells * 4);
    }
    // Strip mode defaults: full grid (no restriction). Set by SandStepPool
    // when creating per-worker SandWorld instances.
    this.stripStartX = 0;
    this.stripEndX = w;
    this.writeXMin = 0;
    this.writeXMax = w;
    // Per-worker local arrays (not shared — each worker has its own)
    this.fireSources = new Uint8Array(cells);
    this.visitedFrame = new Uint32Array(cells);
    this.visitedC4Frame = new Uint32Array(cells);
    this.visitedAntimatterFrame = new Uint32Array(cells);
    this.activeCells = new Uint32Array(cells);
    this.activeCount = 0;
    // Chunk dirty bitmap — 1 byte per chunk (not bit-packed for simplicity).
    this.numChunksX = Math.ceil(w / SandWorld.CHUNK_SIZE);
    this.numChunksY = Math.ceil(h / SandWorld.CHUNK_SIZE);
    this.chunkDirty = new Uint8Array(this.numChunksX * this.numChunksY);
    // Initialize fields to defaults
    for (let i = 0; i < cells * 4; i += 4) {
      this.fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }
    if (!options?.skipStoneFloor) {
      // Stone floor
      for (let x = 0; x < w; x++) {
        for (let y = h - 4; y < h; y++) {
          this.grid[y * w + x] = pack({ mat: Material.Stone, lifetime: 0, flags: 0 });
        }
      }
      // Mark the stone floor chunks as dirty so the first movement pass processes them.
      this.minActiveY = h - 4;
      this.maxActiveY = h - 1;
      for (let cy = 0; cy < this.numChunksY; cy++) {
        for (let cx = 0; cx < this.numChunksX; cx++) {
          this.chunkDirty[cy * this.numChunksX + cx] = 1;
        }
      }
    }
  }

  /** Configure strip mode for multi-threaded sand step. */
  setStripBounds(stripStartX: number, stripEndX: number): void {
    this.stripStartX = stripStartX;
    this.stripEndX = stripEndX;
    this.writeXMin = stripStartX;
    this.writeXMax = stripEndX;
  }

  /** Check if a cell at X coordinate can be written (within write bounds). */
  canWriteX(x: number): boolean {
    return x >= this.writeXMin && x < this.writeXMax;
  }

  /** Check if a grid index can be written (within strip write bounds). */
  canWriteIdx(idx: number): boolean {
    const x = idx % this.W;
    return x >= this.writeXMin && x < this.writeXMax;
  }

  /** Get the active Y bounds [minY, maxY] — used by SandStepPool for boundary cleanup. */
  getActiveYBounds(): { minY: number; maxY: number } {
    return { minY: this.minActiveY, maxY: this.maxActiveY };
  }

  /** Re-seed the PRNG for deterministic test mode. */
  reseed(seed: number): void {
    this.rng.reseed(seed);
  }

  /** PRNG accessor for the rule engine. */
  getRng(): SandRNG {
    return this.rng;
  }

  /** Active cell list accessor for the rule engine. */
  getActiveCells(): Uint32Array {
    return this.activeCells;
  }

  /** Active cell count accessor for the rule engine. */
  getActiveCount(): number {
    return this.activeCount;
  }

  /** Particle system accessor for the worker to transfer to SAB. */
  getParticles(): ParticleSystem {
    return this.particles;
  }

  /** Mark the chunk containing (x, y) as dirty. Called on every cell write. */
  private markChunkDirty(x: number, y: number): void {
    const cx = (x / SandWorld.CHUNK_SIZE) | 0;
    const cy = (y / SandWorld.CHUNK_SIZE) | 0;
    this.chunkDirty[cy * this.numChunksX + cx] = 1;
    // Update Y bounds — the movement pass only scans [minActiveY, maxActiveY].
    if (y < this.minActiveY) this.minActiveY = y;
    if (y > this.maxActiveY) this.maxActiveY = y;
  }

  // --- Field accessors ---
  // gravity: u8 0-255, 128 = 1.0×. Returns multiplier 0-2.
  getGravity(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 1.0;
    return this.fields[(y * this.W + x) * 4 + FIELD.GRAVITY] / 128;
  }

  // temp: u8 0-255, 128 = 1.0. Returns 0-2.
  getTemperature(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 1.0;
    return this.fields[(y * this.W + x) * 4 + FIELD.TEMP] / 128;
  }

  // Wind velocity from the coarse-grid fluid simulation. Returns cells/frame.
  getWindX(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return this.fluid.sampleVelX(x, y);
  }

  getWindY(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return this.fluid.sampleVelY(x, y);
  }

  // --- Field painting ---
  paintField(cx: number, cy: number, fieldType: number, value: number, radius: number): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        if (x < 0 || x >= this.W || y < 0 || y >= this.H) continue;
        this.fields[(y * this.W + x) * 4 + fieldType] = value & 0xff;
      }
    }
  }

  paintFieldLine(x0: number, y0: number, x1: number, y1: number, fieldType: number, value: number, radius: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (true) {
      this.paintField(x, y, fieldType, value, radius);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  getCell(x: number, y: number): Cell {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return { mat: Material.Empty, lifetime: 0, flags: 0 };
    return unpack(this.grid[y * this.W + x]);
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    this.grid[y * this.W + x] = pack(cell);
  }

  paintMaterial(cx: number, cy: number, mat: number, radius: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const r2 = radius * radius;
    const lt = initialLifetime(mat);
    for (let y = cy - radius; y <= cy + radius; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || x >= W) continue;
        const ddx = x - cx, ddy = y - cy;
        if (ddx * ddx + ddy * ddy > r2) continue;
        const curMat = grid[y * W + x] & 0xff;
        if (curMat === Material.Stone || curMat === Material.Wall) continue;
        grid[y * W + x] = packCell(mat, lt, this.rng.randomShade());
        this.markChunkDirty(x, y);
      }
    }
  }

  paintLine(x0: number, y0: number, x1: number, y1: number, mat: number, radius: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (true) {
      this.paintMaterial(x, y, mat, radius);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  igniteLine(x0: number, y0: number, x1: number, y1: number, radius: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (true) {
      this.ignite(x, y, radius);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  ignite(cx: number, cy: number, radius: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const r2 = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || x >= W) continue;
        const ddx = x - cx, ddy = y - cy;
        if (ddx * ddx + ddy * ddy > r2) continue;
        const mat = grid[y * W + x] & 0xff;
        if (!(MAT_FLAGS[mat] & MAT_FLAMMABLE)) continue;
        // Fuse gets FuseFire (yellow, stays put, deterministic spread)
        if (mat === Material.Fuse) {
          grid[y * W + x] = packCell(Material.FuseFire, 15, this.rng.randomShade());
        } else if (mat === Material.Oil) {
          // Oil only ignites if exposed (has an empty/gas neighbor so fire
          // can reach it). Buried oil stays inert.
          if (!this.isExposed(x, y)) continue;
          // Oil → BurningOil (flows like oil, slow decay, slow spread)
          grid[y * W + x] = packCell(Material.BurningOil, MAT_LIFETIME[Material.BurningOil], this.rng.randomShade());
        } else {
          grid[y * W + x] = packCell(Material.Fire, 30, this.rng.randomShade());
        }
        this.markChunkDirty(x, y);
      }
    }
  }

  // ===========================================================================
  // Main step
  // ===========================================================================

  step(): void {
    this.frame++;
    const W = this.W, H = this.H;

    // Pass 1: Clear FLAG_UPDATED (preserving shade + spark bits) AND build the
    // active-cell list in a single full-grid scan. This replaces the old
    // separate FLAG_UPDATED clear loop — the scan is very cheap (bit-and +
    // comparison per cell, no unpack or MATERIALS lookup).
    this.buildActiveListAndClearFlags();

    // Pass 2-3: Reactions iterate only the active list (O(active) instead of
    // O(W*H)). Cells created during these passes won't be in the active list —
    // same semantics as the old full-grid scan (one pass per frame).
    // Pass 2: Data-driven rule engine (replaces the old applyReactions()).
    this.ruleEngine.execute(this);
    // Pass 3: Special reactions (complex logic not yet migrated to rules).
    this.applySpecialReactions();

    // Pass 4: Movement — must iterate in spatial order (bottom-to-top,
    // alternating L/R) for correct falling-sand physics. We skip empty rows
    // outside [minActiveY, maxActiveY] and empty chunks within those bounds.
    // In interlace mode, we process every Nth row (offset by frame % N) to
    // halve movement cost on low-end devices.
    // Strip mode: iterate only [stripStartX, stripEndX) in the X dimension.
    const leftToRight = this.frame % 2 === 0;
    const chunkSize = SandWorld.CHUNK_SIZE;
    const numChunksX = this.numChunksX;
    const chunkDirty = this.chunkDirty;
    const interlace = this.interlaceEnabled ? this.interlaceScale : 1;
    const interlaceOffset = this.frame % interlace;
    const moveX0 = this.stripStartX;
    const moveX1 = this.stripEndX;
    for (let y = this.maxActiveY; y >= this.minActiveY; y--) {
      // Interlace: skip rows not in this frame's subset
      if (interlace > 1 && (y % interlace) !== interlaceOffset) continue;
      // Skip entire rows that are in non-dirty chunks.
      const chunkY = (y / chunkSize) | 0;
      const rowBase = chunkY * numChunksX;
      let rowHasDirty = false;
      for (let cx = 0; cx < numChunksX; cx++) {
        if (chunkDirty[rowBase + cx]) { rowHasDirty = true; break; }
      }
      if (!rowHasDirty) continue;
      if (leftToRight) {
        for (let x = moveX0; x < moveX1; x++) {
          if (!chunkDirty[rowBase + ((x / chunkSize) | 0)]) continue;
          this.tryMove(x, y);
        }
      } else {
        for (let x = moveX1 - 1; x >= moveX0; x--) {
          if (!chunkDirty[rowBase + ((x / chunkSize) | 0)]) continue;
          this.tryMove(x, y);
        }
      }
    }

    // Pass 5: Combustion — builds fireSources from the active list.
    this.applyCombustion();

    // Rebuild active list to capture cells created/destroyed by reactions,
    // movement, and combustion. Uses the Y bounds from Pass 1 (expanded by a
    // margin) to avoid a full O(W*H) grid scan — cells can only move a few
    // positions per frame, so the active Y range can't expand beyond that.
    this.buildActiveList();

    // Pass 6: Aging — iterates the rebuilt active list.
    this.applyAging();

    // Pass 7: Fluid grid step — pressure relaxation + velocity update.
    // Skipped entirely when no impulses/pressure exist (dirty flag).
    this.fluid.step();

    // Pass 8: Update explosion particles.
    this.particles.update();
  }

  /**
   * Boundary cleanup movement pass — used by SandStepPool after all strip
   * workers finish. Re-runs tryMove on the specified columns so cross-strip
   * writes (which were skipped by write guards during the parallel step) get
   * a chance to execute.
   *
   * When boundaryPass is true on this world, tryMove only processes cells
   * marked in deferredMask (cells whose cross-strip move was blocked by the
   * write guard) and skips all RNG-based movement gates. The caller must set
   * writeXMin/writeXMax to the adjacent strip's bounds so only cross-strip
   * moves are attempted.
   *
   * This is a movement-only pass — reactions, combustion, and aging already
   * ran in the workers. We only handle the cross-strip movement writes that
   * were skipped at the boundaries.
   */
  runBoundaryMovement(cols: number[], minY: number, maxY: number, leftToRight: boolean): void {
    // Sort columns in the iteration order matching the main movement pass.
    const sorted = cols.slice().sort((a, b) => leftToRight ? a - b : b - a);
    for (let y = maxY; y >= minY; y--) {
      sorted.forEach((x) => {
        this.tryMove(x, y);
      });
    }
  }

  /**
   * Build the active-cell list (indices of all non-empty cells) and clear
   * FLAG_UPDATED in a single pass. Merges the old separate FLAG_UPDATED clear
   * loop with active-list construction. Also detects non-zero wind fields so
   * that externally-set wind (e.g. by tests or future field-painting code) is
   * detected even when applyImpulse wasn't called.
   *
   * Static solids (MAT_GRAVITY_DIR === 0: Stone, Wall, Dirt, etc.) are
   * excluded from the active list and chunkDirty bitmap. They can never move,
   * have no reactions, and no lifetimes — including them bloats the active
   * list to ~300k cells in a terrain-heavy world, making every active-list
   * iteration (ruleEngine, applySpecialReactions, applyAging, applyCombustion)
   * 5-10× slower. The tryMove loop also benefits: chunks with only static
   * solids aren't marked dirty, so the loop skips them entirely instead of
   * visiting every cell just to early-return at gravityDir === 0.
   *
   * FLAG_UPDATED is still cleared for ALL cells (including static solids) —
   * the clearMask operation is outside the filter and runs unconditionally.
   */
  private buildActiveListAndClearFlags(): void {
    const grid = this.grid;
    const fields = this.fields;
    const active = this.activeCells;
    const W = this.W, H = this.H;
    const clearMask = ~((0xff & ~(SHADE_MASK | FLAG_SPARK | FLAG_ANCHORED | FLAG_POPPED | this.preserveFlagsMask)) << 16);
    const skip = this.skipMask;
    const chunkDirty = this.chunkDirty;
    const numChunksX = this.numChunksX;
    const chunkSize = SandWorld.CHUNK_SIZE;
    // Strip mode: only scan [stripStartX, stripEndX) in the X dimension.
    // Flag clearing covers [stripStartX-1, stripEndX+1) to handle halo cells
    // at strip boundaries (overlap ensures all flags are cleared).
    const sx0 = this.stripStartX;
    const sx1 = this.stripEndX;
    const clearX0 = sx0 > 0 ? sx0 - 1 : 0;
    const clearX1 = sx1 < W ? sx1 + 1 : W;
    // Reset chunk dirty bitmap and Y bounds — rebuilt from the scan.
    chunkDirty.fill(0);
    // Per-column active cell histogram — clear our strip's columns then
    // count during the scan. SAB-backed; each worker only writes its own
    // columns so there are no races. The coordinator reads it after all
    // workers finish to rebalance strip boundaries.
    const histogram = this.histogram;
    if (histogram !== null) {
      for (let x = sx0; x < sx1; x++) histogram[x] = 0;
    }
    // Clear the deferred-move mask for this strip's columns. Each worker only
    // clears its own strip (no cross-strip writes). The mask is set during the
    // movement pass and read by the coordinator's boundary cleanup after all
    // workers finish.
    const deferred = this.deferredMask;
    let minY = H, maxY = 0;
    let count = 0;
    for (let y = 0; y < H; y++) {
      const rowBase = y * W;
      // Clear flags for the extended range (strip + 1-cell halo)
      for (let x = clearX0; x < clearX1; x++) {
        grid[rowBase + x] &= clearMask;
      }
      // Build active list only for the strip range
      for (let x = sx0; x < sx1; x++) {
        const i = rowBase + x;
        if (deferred !== null) deferred[i] = 0;
        if (grid[i] !== 0 && !(skip !== null && skip[i] !== 0)) {
          const mat = grid[i] & 0xff;
          // Static solids (gravityDir=0) are included if their lifetime field
          // is non-zero (loosened by mining — lifetime is the settle timer).
          if (MAT_GRAVITY_DIR[mat] === 0 && !MAT_HAS_REACTIONS[mat]) {
            if (((grid[i] >> 8) & 0xff) === 0) continue;
          }
          active[count++] = i;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          const cx = (x / chunkSize) | 0;
          const cy = (y / chunkSize) | 0;
          chunkDirty[cy * numChunksX + cx] = 1;
          if (histogram !== null) histogram[x]++;
        }
      }
    }
    this.activeCount = count;
    this.minActiveY = minY;
    this.maxActiveY = maxY;
  }

  /** Build the active-cell list without clearing flags (for mid-frame rebuild).
   *  Like buildActiveListAndClearFlags, excludes static solids (gravityDir=0)
   *  from the active list and chunkDirty bitmap.
   *
   *  Optimized: only scans rows within [minActiveY - margin, maxActiveY + margin]
   *  instead of the full grid. The margin covers cells that moved during the
   *  movement pass (particles move at most ~5 cells/frame; reactions affect
   *  only 8-connected neighbors). This reduces the scan from O(W*H) to
   *  O(W * activeHeight) — typically a 2-4x speedup. */
  private buildActiveList(): void {
    const grid = this.grid;
    const active = this.activeCells;
    const W = this.W, H = this.H;
    const skip = this.skipMask;
    const chunkDirty = this.chunkDirty;
    const numChunksX = this.numChunksX;
    const chunkSize = SandWorld.CHUNK_SIZE;
    // Reset chunk dirty bitmap and Y bounds — rebuilt from the scan.
    chunkDirty.fill(0);
    let minY = H, maxY = 0;
    let count = 0;

    // Only scan rows near the Pass 1 active Y range. Cells can move at most
    // ~5 cells per frame (liquid flow) and reactions affect 8-connected
    // neighbors (1 cell). A margin of 8 covers all cases with room to spare.
    const margin = 8;
    const startY = Math.max(0, this.minActiveY - margin);
    const endY = Math.min(H - 1, this.maxActiveY + margin);

    for (let y = startY; y <= endY; y++) {
      const rowBase = y * W;
      for (let x = this.stripStartX; x < this.stripEndX; x++) {
        const i = rowBase + x;
        if (grid[i] !== 0 && !(skip !== null && skip[i] !== 0)) {
          const mat = grid[i] & 0xff;
          if (MAT_GRAVITY_DIR[mat] === 0 && !MAT_HAS_REACTIONS[mat]) {
            if (((grid[i] >> 8) & 0xff) === 0) continue;
          }
          active[count++] = i;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          const cx = (x / chunkSize) | 0;
          const cy = (y / chunkSize) | 0;
          chunkDirty[cy * numChunksX + cx] = 1;
        }
      }
    }
    this.activeCount = count;
    this.minActiveY = minY;
    this.maxActiveY = maxY;
  }

  private tryMove(x: number, y: number): void {
    const W = this.W, H = this.H;
    const idx = y * W + x;
    const packed = this.grid[idx];
    if (packed === 0) return;

    // Frozen cells (chunk freeze optimization) do not initiate movement.
    const skip = this.skipMask;
    if (skip !== null && skip[idx] !== 0) return;

    // Inline unpack — avoid allocating a Cell object on every cell visit
    const mat = packed & 0xff;
    if (mat === Material.Empty) return;
    const flags = (packed >> 16) & 0xff;
    if (flags & FLAG_UPDATED) return;

    // Boundary cleanup pass: only process cells whose cross-strip move was
    // deferred by the write guard during the worker pass. Cells that didn't
    // attempt a cross-strip move (friction-blocked, obstacle-blocked, or
    // already moved) have no deferred marker and are skipped — this prevents
    // the cleanup from re-rolling RNG gates and giving boundary cells an
    // unfair second movement chance.
    if (this.boundaryPass) {
      const deferred = this.deferredMask;
      if (deferred === null || deferred[idx] === 0) return;
    }

    // Spark-flagged fire (visual flames emitted by BurningOil) rises straight
    // up without horizontal drift — the fire should stay above its fuel source
    // (the BurningOil cell), not scatter sideways. Horizontal wind, impulse,
    // and gas drift are skipped for these particles.
    const isSparkFire = mat === Material.Fire && (flags & FLAG_SPARK) !== 0;

    // Typed-array lookups instead of MATERIALS[mat]?.property
    const gravityDir = MAT_GRAVITY_DIR[mat];
    // Static solids (gravityDir === 0: Stone, Wall, Concrete) are frozen
    // UNLESS their lifetime field is non-zero (set by mining as a settle
    // timer). This lets mined Stone fall as Stone — no material conversion.
    // The lifetime field is repurposed as both the "loosened" flag and the
    // settle timer: lifetime > 0 = loosened (can fall, will re-freeze when
    // it lands); lifetime === 0 = frozen static solid.
    if (gravityDir === 0) {
      const lifetime = (packed >> 8) & 0xff;
      if (lifetime === 0) return;
      // Duplicator stores the locked material id in its lifetime field, but
      // it must NEVER fall — it's a permanent static solid. Skip the
      // "loosened static solid" fall path entirely for Duplicator.
      // Void is also a permanent static solid that must never fall.
      if (mat === Material.Duplicator || mat === Material.Void) return;
      // Loosened static solid — fall downward (default direction)
    } else {
      // Normal falling material — check gravity field below
    }

    // FuseFire stays put so it can deterministically spread to adjacent fuse
    // cells. Without this, the fire gas floats away before it can propagate.
    if (mat === Material.FuseFire) return;

    // Anchored fire (FLAG_ANCHORED) stays put on the fuel surface (e.g. wax)
    // so it can keep spreading to adjacent fuel. Without this, the fire gas
    // rises and drifts away before it can propagate.
    if (mat === Material.Fire && (flags & FLAG_ANCHORED) !== 0) return;

    // BurningOil flows like a liquid (gravity: 1, density: 0.8). The
    // burning-oil pass in applyCombustion handles controlled spread to
    // adjacent oil cells, and visual flames are emitted as separate Fire
    // particles (FLAG_SPARK) above the BurningOil — those rise straight up
    // (wind/diagonal movement skipped for spark fire) so they don't scatter
    // even when the BurningOil itself flows.
    // Inline field reads — avoid 4× bounds-checked method calls per cell.
    // tryMove is only called within [0,W)×[0,H) so bounds checks are redundant.
    const fi = idx * 4;
    const gravity = this.fields[fi + FIELD.GRAVITY] / 128;
    // Sample wind from the coarse-grid fluid simulation (bilinear interpolation).
    const windX = this.fluid.sampleVelX(x, y);
    const windY = this.fluid.sampleVelY(x, y);

    // Apply gravity multiplier — at 0 gravity, nothing falls
    if (gravity <= 0) return;

    const matFlags = MAT_FLAGS[mat];
    // For loosened static solids (gravityDir=0 but lifetime>0), fall downward.
    const dy = gravityDir !== 0 ? gravityDir : 1;
    const isLiquid = (matFlags & MAT_LIQUID) !== 0;
    const isGas = (matFlags & MAT_GAS) !== 0;
    const matGravity = MAT_GRAVITY[mat];

    // In the boundary cleanup pass, skip all RNG-based movement gates (wind,
    // friction, gas flicker, horizontal impulse). These already had their
    // chance during the worker pass — re-rolling them would give boundary
    // cells an unfair second movement attempt. The cell is only here because
    // a cross-strip move was deferred by the write guard; we attempt only
    // gravity/diagonal/flow moves into the adjacent strip.
    if (!this.boundaryPass) {
      // --- Wind: apply horizontal/vertical force from the fluid grid ---
      // The fluid grid provides float velocities; scale to cell-frame units.
      // A velocity of ~1.0 means "move every frame" (100% chance).
      // Spark fire (visual flames from BurningOil/fuse) skips wind entirely —
      // the emit impulse gives it a fixed horizontal component at birth, and
      // sampling that back here moves it diagonally (up-left/up-right) in a
      // straight streak for its whole short life. Sparks rise straight up via
      // gas gravity instead. The upward impulse still pushes neighboring
      // smoke/gas up via the fluid grid; it just doesn't steer the spark itself.
      // BurningOil also skips wind — its own spark emission creates upward wind
      // in the fluid grid above it, which would blow the BurningOil itself
      // upward off the oil surface. BurningOil flows via gravity only (sinks,
      // spreads horizontally on the oil surface).
      const windMag = Math.abs(windX) + Math.abs(windY);
      if (!isSparkFire && mat !== Material.BurningOil && windMag > 0.05) {
        const wdx = windX > 0 ? 1 : windX < 0 ? -1 : 0;
        const wdy = windY > 0 ? 1 : windY < 0 ? -1 : 0;
        // Scale chance with wind magnitude: 1.0 = 100% move chance.
        const windChance = Math.min(1, windMag);
        if (this.rng.random() < windChance) {
          // Strong wind can shove into occupied cells (displace liquids/gases)
          if (windMag >= 1.5) {
            if (this.tryShove(x, y, x + wdx, y + wdy, packed)) return;
          } else {
            if (this.trySwap(x, y, x + wdx, y + wdy, packed, mat, matGravity, isGas)) return;
          }
        }
      }

      // --- Edge friction ---
      const hasLeft = x > 0 && this.grid[y * W + (x - 1)] !== 0;
      const hasRight = x < W - 1 && this.grid[y * W + (x + 1)] !== 0;
      const isExterior = !hasLeft || !hasRight;

      // Honey: very thick — high friction, barely flows
      if (mat === Material.Honey && isExterior && this.rng.random() < 0.7) return;
      // Tar: extremely viscous — even higher friction than honey, oozes slowly.
      if (mat === Material.Tar && isExterior && this.rng.random() < 0.85) return;

      // Exterior particles have a chance to skip falling (friction).
      if (isExterior && !isGas) {
        const frictionChance = 0.3 / Math.max(1, matGravity);
        if (this.rng.random() < frictionChance) return;
      }

      // --- Gas flicker: random chance to not move at all ---
      // Prevents gasses from rising in uniform horizontal lines. Each particle
      // has a chance to "flicker" in place, creating organic, non-uniform spread.
      if (isGas) {
        const flickerChance = (mat === Material.Fire || mat === Material.FuseFire) ? 0.35 : 0.25;
        if (this.rng.random() < flickerChance) return;
      }

      // --- Density-scaled horizontal impulse ---
      // Lighter materials (low gravity) get more impulse; denser materials get less.
      // Sand (gravity 1) → full impulse, Water (gravity 2) → half, Lava (gravity 3) → third
      // Gasses (fire/smoke/steam) also get impulse so they drift sideways while rising.
      // Spark fire (visual flames from BurningOil) skips this — no horizontal drift.
      if (this.horizontalImpulseChance > 0 && !isSparkFire) {
        const scaledChance = this.horizontalImpulseChance / Math.max(1, matGravity);
        if (this.rng.random() < scaledChance) {
          const nudgeDir = this.rng.random() < 0.5 ? -1 : 1;
          const nudge = nudgeDir * Math.max(1, Math.round(this.horizontalImpulseStrength));
          if (this.trySwap(x, y, x + nudge, y + dy, packed, mat, matGravity, isGas)) return;
        }
      }
    } // end if (!this.boundaryPass)

    // 1. Try gravity direction
    if (this.trySwap(x, y, x, y + dy, packed, mat, matGravity, isGas)) {
      if (mat === Material.Gravel && ((packed >> 8) & 0xff) !== GRAVEL_DISTURB_SETTLE_TICKS) this.disturbAdjacent(x, y);
      return;
    }

    // Rubber: bouncy — try to bounce upward when blocked from below
    if (mat === Material.Rubber) {
      // Check if we're resting on something (can't fall)
      const belowY = y + dy;
      const blocked = belowY < 0 || belowY >= H || this.grid[belowY * W + x] !== 0;
      if (blocked) {
        // Bounce: try to move up or sideways
        if (this.rng.random() < 0.5) {
          if (this.trySwap(x, y, x, y - dy, packed, mat, matGravity, isGas)) return;
        }
        const bounceDir = this.rng.random() < 0.5 ? -1 : 1;
        if (this.trySwap(x, y, x + bounceDir * 2, y, packed, mat, matGravity, isGas)) return;
        if (this.trySwap(x, y, x + bounceDir, y, packed, mat, matGravity, isGas)) return;
      }
    }

    // Diagonal movement (gravity direction + horizontal). Spark fire (visual
    // flames from BurningOil) skips this — if it can't rise straight up, it
    // stays put and decays via lifetime rather than sliding sideways.
    if (!isSparkFire) {
      const dir = this.rng.random() < 0.5 ? -1 : 1;
      if (this.trySwap(x, y, x + dir, y + dy, packed, mat, matGravity, isGas)) {
        if (mat === Material.Gravel && ((packed >> 8) & 0xff) !== GRAVEL_DISTURB_SETTLE_TICKS) this.disturbAdjacent(x, y);
        return;
      }
      if (this.trySwap(x, y, x - dir, y + dy, packed, mat, matGravity, isGas)) {
        if (mat === Material.Gravel && ((packed >> 8) & 0xff) !== GRAVEL_DISTURB_SETTLE_TICKS) this.disturbAdjacent(x, y);
        return;
      }
    }

    // Gravel: flows horizontally like a liquid when unsupported, but settles
    // firmly in place when supported from below. Unlike a true liquid, gravel
    // only flows when there's empty space below the adjacent cell (it "spills"
    // downhill), and stops as soon as it's resting on something. This creates
    // realistic pile behavior — gravel spreads into low spots then freezes.
    if (mat === Material.Gravel) {
      // Only "real" gravel (from mining, lifetime=GRAVEL_SETTLE_TICKS or 0)
      // disturbs adjacent Stone when it moves. Freshly-disturbed Stone that
      // became Gravel (lifetime=GRAVEL_DISTURB_SETTLE_TICKS) does NOT disturb
      // — otherwise each falling disturbed cell would disturb its neighbors,
      // which would become Gravel, fall, disturb THEIR neighbors, causing an
      // unbounded cascade of stone destruction across the map.
      const canDisturb = ((packed >> 8) & 0xff) !== GRAVEL_DISTURB_SETTLE_TICKS;
      const flowDir = this.rng.random() < 0.5 ? -1 : 1;
      if (this.tryGravelFlow(x, y, flowDir)) {
        if (canDisturb) this.disturbAdjacent(x, y);
        return;
      }
      if (this.tryGravelFlow(x, y, -flowDir)) {
        if (canDisturb) this.disturbAdjacent(x, y);
        return;
      }
      // Gravel is settled (supported below, can't spread) — stop moving.
      return;
    }

    if (isLiquid) {
      // Buoyancy: a less-dense liquid rises through a denser liquid above it.
      // This is the mirror of the "heavy liquid sinks through lighter liquid
      // below" code at the end of tryMove. Without active rising, oil dropped
      // into water spreads horizontally at the bottom but never reaches the
      // surface — the passive sinking mechanism is too slow because the
      // bottom-to-top movement pass lets oil spread sideways before the water
      // above gets a chance to sink through it.
      if (dy > 0) {
        const above = y - 1;
        if (above >= 0) {
          const aboveIdx = above * W + x;
          const abovePacked = this.grid[aboveIdx];
          if (abovePacked !== 0) {
            const aboveMat = abovePacked & 0xff;
            if (!((abovePacked >> 16) & FLAG_UPDATED) &&
                (MAT_FLAGS[aboveMat] & MAT_LIQUID) &&
                MAT_DENSITY[aboveMat] > MAT_DENSITY[mat]) {
              this.grid[aboveIdx] = packed | FLAG_UPDATED_BIT;
              this.grid[idx] = abovePacked | FLAG_UPDATED_BIT;
              return;
            }
          }
        }
      }

      const flowDir = this.rng.random() < 0.5 ? -1 : 1;
      if (this.tryFlow(x, y, flowDir, 5)) return;
      if (this.tryFlow(x, y, -flowDir, 5)) return;
      // Density-based horizontal spread: a less-dense liquid (e.g. oil) can
      // push through a denser liquid (e.g. water) to spread across its
      // surface. Without this, oil rises to the top of water in a column but
      // can't spread sideways because tryFlow only enters empty cells.
      if (this.tryDensityFlow(x, y, flowDir, mat, packed)) return;
      if (this.tryDensityFlow(x, y, -flowDir, mat, packed)) return;
    }

    // Gas: wider horizontal drift (up to 3 cells) for organic spread.
    if (isGas) {
      const driftDir = this.rng.random() < 0.5 ? -1 : 1;
      if (this.tryFlow(x, y, driftDir, 3)) return;
      if (this.tryFlow(x, y, -driftDir, 3)) return;
    }

    // 5. Liquids: sink through gas below (heavy liquid displaces light gas upward)
    if (isLiquid && dy > 0) {
      const below = y + 1;
      if (below < H) {
        const belowIdx = below * W + x;
        const belowPacked = this.grid[belowIdx];
        if (belowPacked !== 0) {
          const belowMat = belowPacked & 0xff;
          const belowFlags = MAT_FLAGS[belowMat];
          // Heavy liquid sinks through a lighter gas or a less-dense liquid.
          // Density is a separate property from gravity (movement speed):
          // mercury (13.5) sinks through water (1.0), lava (3.0) through
          // water, honey (1.4) through water, etc.
          if (!((belowPacked >> 16) & FLAG_UPDATED) &&
              ((belowFlags & MAT_GAS) || ((belowFlags & MAT_LIQUID) && MAT_DENSITY[mat] > MAT_DENSITY[belowMat]))) {
            this.grid[belowIdx] = packed | FLAG_UPDATED_BIT;
            this.grid[idx] = belowPacked | FLAG_UPDATED_BIT;
            return;
          }
        }
      }
    }

    // Glitter: suspends in water (tries to float up when in water)
    if (mat === Material.Glitter) {
      if (y + 1 < H && (this.grid[(y + 1) * W + x] & 0xff) === Material.Water) {
        // Stay suspended — don't sink further
        if (this.rng.random() < 0.8) return;
      }
    }
  }

  /**
   * Try to move/swap the cell at (x,y) into (nx,ny).
   *
   * The caller (tryMove) passes the already-read `srcPacked` plus pre-fetched
   * srcMat/srcGravity/srcIsGas so the source cell is not re-read or re-unpacked
   * on every call — tryMove calls this up to ~6 times per cell. The moved cell
   * is written with FLAG_UPDATED set via a direct bit-OR on `srcPacked` (no
   * object spread / re-pack).
   */
  private trySwap(
    x: number, y: number, nx: number, ny: number,
    srcPacked: number, srcMat: number, srcGravity: number, srcIsGas: boolean,
  ): boolean {
    const W = this.W, H = this.H;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
    // Strip mode write guard: don't write to cells outside our strip.
    // The coordinator's boundary cleanup handles deferred cross-strip moves.
    if (nx < this.writeXMin || nx >= this.writeXMax) {
      // Mark the source cell as deferred so the boundary cleanup knows to
      // re-attempt this cross-strip move. Only set during the worker pass
      // (not during the boundary cleanup itself).
      if (!this.boundaryPass) {
        const dm = this.deferredMask;
        if (dm !== null) dm[y * W + x] = 1;
      }
      return false;
    }
    const destIdx = ny * W + nx;
    const srcIdx = y * W + x;
    const destPacked = this.grid[destIdx];

    if (destPacked === 0) {
      // Empty: simple move
      this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
      this.grid[srcIdx] = 0;
      return true;
    }

    // Non-gas displacing gas: solids and liquids are denser than gas, so a
    // falling (or rising) solid/liquid pushes the gas aside and the gas swaps
    // into the source cell. Without this, smoke/steam would block sand and
    // water from falling — the gas has no gravity-driven way to yield. A gas
    // that already moved this frame is left alone (it will yield next frame).
    if (!srcIsGas) {
      const destMat = destPacked & 0xff;
      if ((MAT_FLAGS[destMat] & MAT_GAS) && !((destPacked >> 16) & FLAG_UPDATED)) {
        this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
        this.grid[srcIdx] = destPacked | FLAG_UPDATED_BIT;
        return true;
      }
    }

    // Gas-to-gas displacement: a lighter gas (higher gravity for upward, i.e.
    // rises faster) can push through a slower gas. This lets fire (gravity 4)
    // rise through smoke (gravity 3) so they separate instead of mixing.
    // Without this, smoke from a bottom-up burn would overtake the fire front
    // and suffocate it (fire trapped below its own smoke, can't reach fuel).
    if (srcIsGas) {
      const destMat = destPacked & 0xff;
      if ((MAT_FLAGS[destMat] & MAT_GAS) && srcGravity > MAT_GRAVITY[destMat]) {
        // Swap: source moves to dest, dest moves to source
        this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
        this.grid[srcIdx] = destPacked | FLAG_UPDATED_BIT;
        return true;
      }
    }

    // Solid-liquid density displacement: a denser material sinks through a
    // less-dense one. Sand (density 2.0) sinks through water (1.0) but not
    // through mercury (13.5). Water (1.0) sinks through wood (0.6), making
    // wood float. Only applies to solid-liquid pairs — solids don't flow
    // through each other, and gas displacement is handled above. Structural
    // barriers (static solids with density >= 2.0, e.g. stone/wall/concrete)
    // are immovable — nothing sinks through them regardless of density.
    if (!srcIsGas) {
      const destMat = destPacked & 0xff;
      const destFlags = MAT_FLAGS[destMat];
      if ((destFlags & (MAT_SOLID | MAT_LIQUID)) && !((destPacked >> 16) & FLAG_UPDATED)) {
        const srcIsSolid = (MAT_FLAGS[srcMat] & MAT_SOLID) !== 0;
        const destIsSolid = (destFlags & MAT_SOLID) !== 0;
        // One must be solid, the other liquid (not solid-solid or liquid-liquid).
        // Structural barriers (static + dense) are immovable. A loosened
        // static solid (lifetime > 0, set by mining) is NOT a barrier — it
        // can fall, so other cells can sink through it.
        const destIsBarrier = destIsSolid && MAT_GRAVITY_DIR[destMat] === 0 &&
          MAT_DENSITY[destMat] >= 2.0 &&
          ((destPacked >> 8) & 0xff) === 0;
        if (srcIsSolid !== destIsSolid &&
            !destIsBarrier &&
            MAT_DENSITY[srcMat] > MAT_DENSITY[destMat]) {
          this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
          this.grid[srcIdx] = destPacked | FLAG_UPDATED_BIT;
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Like trySwap, but can also displace liquids/gases: if the destination is
   * occupied by a liquid or gas, the two cells swap (the pushed particle moves
   * into the source cell). Solids and walls block the shove. Used by strong
   * wind/impulse forces to push particles through dense media.
   *
   * The caller passes the already-read `srcPacked` so the source is not
   * re-read; the moved cell is written via a direct bit-OR (no spread/re-pack).
   */
  private tryShove(x: number, y: number, nx: number, ny: number, srcPacked: number): boolean {
    const W = this.W, H = this.H;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
    // Strip mode write guard
    if (nx < this.writeXMin || nx >= this.writeXMax) {
      if (!this.boundaryPass) {
        const dm = this.deferredMask;
        if (dm !== null) dm[y * W + x] = 1;
      }
      return false;
    }
    const destIdx = ny * W + nx;
    const srcIdx = y * W + x;
    const destPacked = this.grid[destIdx];
    // Empty destination: normal swap
    if (destPacked === 0) {
      this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
      this.grid[srcIdx] = 0;
      return true;
    }
    // Occupied: only displace liquids/gases (not solids, walls, or already-updated cells)
    const destMat = destPacked & 0xff;
    const destFlags = MAT_FLAGS[destMat];
    if (!(destFlags & (MAT_LIQUID | MAT_GAS))) return false;
    if ((destPacked >> 16) & FLAG_UPDATED) return false;
    // Swap the two cells
    this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
    this.grid[srcIdx] = destPacked | FLAG_UPDATED_BIT;
    return true;
  }

  private tryFlow(x: number, y: number, dir: number, maxSteps: number): boolean {
    const W = this.W, H = this.H;
    const srcIdx = y * W + x;
    // Read the source once and pre-compute the moved value (FLAG_UPDATED set).
    // The old code re-unpacked the source twice per move via
    // `pack({ ...unpack(packed), flags: unpack(packed).flags | FLAG_UPDATED })`.
    const movedPacked = this.grid[srcIdx] | FLAG_UPDATED_BIT;
    for (let step = 1; step <= maxSteps; step++) {
      const nx = x + dir * step;
      if (nx < 0 || nx >= W) return false;
      // Strip mode write guard
      if (nx < this.writeXMin || nx >= this.writeXMax) {
        if (!this.boundaryPass) {
          const dm = this.deferredMask;
          if (dm !== null) dm[srcIdx] = 1;
        }
        return false;
      }
      const destIdx = y * W + nx;
      if (this.grid[destIdx] !== 0) return false;

      const belowY = y + 1;
      if (belowY < H) {
        const belowIdx = belowY * W + nx;
        if (this.grid[belowIdx] === 0) {
          this.grid[belowIdx] = movedPacked;
          this.grid[srcIdx] = 0;
          return true;
        }
      }

      if (step === maxSteps) {
        this.grid[destIdx] = movedPacked;
        this.grid[srcIdx] = 0;
        return true;
      }
    }
    return false;
  }

  /**
   * Density-based horizontal flow for liquids: a less-dense liquid can swap
   * with an adjacent denser liquid. This lets oil (density 0.8) spread across
   * the surface of water (density 1.0). Without this, oil rises to the top of
   * water in a vertical column but can't spread horizontally because tryFlow
   * only moves into empty cells, and the adjacent cells at the surface are
   * water, not empty.
   *
   * Only fires when the source is strictly less dense than the destination
   * (so same-density liquids don't churn). Solids, gases, and already-updated
   * cells are not displaced.
   */
  private tryDensityFlow(
    x: number, y: number, dir: number,
    srcMat: number, srcPacked: number,
  ): boolean {
    const W = this.W;
    const nx = x + dir;
    if (nx < 0 || nx >= W) return false;
    // Strip mode write guard
    if (nx < this.writeXMin || nx >= this.writeXMax) {
      if (!this.boundaryPass) {
        const dm = this.deferredMask;
        if (dm !== null) dm[y * W + x] = 1;
      }
      return false;
    }
    const destIdx = y * W + nx;
    const destPacked = this.grid[destIdx];
    if (destPacked === 0) return false; // empty — tryFlow already handled this
    const destMat = destPacked & 0xff;
    // Only displace liquids (not solids, gases, or already-updated cells)
    if (!(MAT_FLAGS[destMat] & MAT_LIQUID)) return false;
    if ((destPacked >> 16) & FLAG_UPDATED) return false;
    // Source must be strictly less dense than destination
    if (MAT_DENSITY[srcMat] >= MAT_DENSITY[destMat]) return false;
    // Swap: less-dense liquid moves sideways, denser liquid takes its place
    this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
    this.grid[y * W + x] = destPacked | FLAG_UPDATED_BIT;
    return true;
  }

  /**
   * When a gravel cell vacates position (x, y), disturb adjacent Stone and
   * LooseStone cells so they don't float in the air when their support flows
   * away.
   *
   * - Stone (re-settled or natural) → gravity field set + short settle timer
   *   in the lifetime field, so it falls as Stone if unsupported. No material
   *   conversion — it stays Stone and re-freezes (gravity cleared) when it
   *   lands.
   * - LooseStone (legacy cells from old saves) → settle timer reset to the
   *   short disturbed value, gravity ensured, so it keeps falling instead of
   *   re-settling prematurely.
   *
   * The disturbed settle timer is GRAVEL_DISTURB_SETTLE_TICKS (2 ticks). If the
   * cell is still supported after gravel moves, it re-settles (gravity cleared)
   * in 2 ticks. If gravel removed its support, the cell starts falling
   * (FLAG_UPDATED keeps the timer reset to 2 via applyAging) and won't settle
   * until it lands.
   */
  private disturbAdjacent(x: number, y: number): void {
    const W = this.W, H = this.H;
    // Check 4-neighbors (the cell above is most critical — it lost support)
    // Set disturbedFlags (in addition to FLAG_UPDATED) so the chunk-world's
    // expireWakeTicks can detect disturbed cells in frozen chunks even after
    // applyAging clears FLAG_UPDATED. disturbedFlags is persistent (included
    // in preserveFlagsMask by the game).
    const extra = this.disturbedFlags | FLAG_UPDATED;
    for (let i = 0; i < 4; i++) {
      const nx = x + DIR_DX[i];
      const ny = y + DIR_DY[i];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      // Strip mode write guard: skip neighbors outside our write bounds.
      if (nx < this.writeXMin || nx >= this.writeXMax) continue;
      const nIdx = ny * W + nx;
      const nPacked = this.grid[nIdx];
      if (nPacked === 0) continue;
      const nMat = nPacked & 0xff;
      const nFlags = (nPacked >> 16) & 0xff;
      const nFi = nIdx * 4;

      if (nMat === Material.Stone) {
        // Set gravity field + settle timer so Stone falls as Stone if
        // unsupported. No material conversion. Re-freezes when it lands.
        this.grid[nIdx] = (nMat & 0xff) | ((GRAVEL_DISTURB_SETTLE_TICKS & 0xff) << 8) | (((nFlags | extra) & 0xff) << 16);
        this.fields[nFi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      } else if (nMat === Material.LooseStone) {
        // Legacy LooseStone (old saves): reset settle timer to short value
        const shade = nFlags & SHADE_MASK;
        this.grid[nIdx] = packCell(Material.LooseStone, GRAVEL_DISTURB_SETTLE_TICKS, shade | extra);
        this.fields[nFi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      }
    }
  }

  /**
   * Gravel flow: like liquid flow, but gravel only moves horizontally to an
   * adjacent cell if that cell is empty AND the cell below the destination is
   * also empty (i.e. it "spills downhill" into a low spot). If the destination
   * at the same level is empty but supported below, gravel still moves there
   * (spreading along a flat surface), but only for a limited distance so it
   * forms realistic piles rather than spreading infinitely like water.
   *
   * This creates the "flows like a liquid but settles in place" behavior:
   * gravel pours into gaps, spreads to fill low spots, then stops once it's
   * resting on something with no downhill path.
   */
  private tryGravelFlow(x: number, y: number, dir: number): boolean {
    const W = this.W, H = this.H;
    const srcIdx = y * W + x;
    const movedPacked = this.grid[srcIdx] | FLAG_UPDATED_BIT;

    // Step 1: try to spill into the adjacent cell at the same level
    const nx = x + dir;
    if (nx < 0 || nx >= W) return false;
    // Strip mode write guard
    if (nx < this.writeXMin || nx >= this.writeXMax) {
      if (!this.boundaryPass) {
        const dm = this.deferredMask;
        if (dm !== null) dm[srcIdx] = 1;
      }
      return false;
    }
    const destIdx = y * W + nx;
    if (this.grid[destIdx] !== 0) return false;

    // Check if there's a drop below the destination (downhill spill).
    // If so, gravel falls into the gap — this is the primary flow mode.
    const belowY = y + 1;
    if (belowY < H) {
      const belowDestIdx = belowY * W + nx;
      if (this.grid[belowDestIdx] === 0) {
        // Downhill: gravel spills into the gap and falls
        this.grid[belowDestIdx] = movedPacked;
        this.grid[srcIdx] = 0;
        return true;
      }
    }

    // Same-level spread: gravel moves to an adjacent empty cell that's
    // supported below. Limit spread distance to 2 cells so gravel forms
    // piles rather than spreading infinitely like a liquid.
    // Only spread if the gravel is NOT supported directly below (i.e. it's
    // on an edge and could fall off). This prevents gravel on a flat floor
    // from spreading forever.
    const srcBelowIdx = (y + 1) * W + x;
    const srcSupported = (y + 1 >= H) || this.grid[srcBelowIdx] !== 0;
    if (srcSupported) {
      // Gravel is supported below — only spread if the destination is also
      // NOT supported (gravel flows off the edge of a pile).
      if (belowY < H) {
        const belowDestIdx = belowY * W + nx;
        if (this.grid[belowDestIdx] !== 0) {
          // Destination is supported too — no flow needed, gravel settles
          return false;
        }
      }
    }

    // Spread to the adjacent cell
    this.grid[destIdx] = movedPacked;
    this.grid[srcIdx] = 0;
    return true;
  }

  // ===========================================================================
  // Special reactions for new materials
  // ===========================================================================

  private applySpecialReactions(): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const fields = this.fields;
    const active = this.activeCells;
    const count = this.activeCount;
    // Strip mode write bounds — neighbor writes outside this range are skipped.
    const wxMin = this.writeXMin, wxMax = this.writeXMax;

    for (let a = 0; a < count; a++) {
      const idx = active[a];
      const packed = grid[idx];
      if (packed === 0) continue; // cell was destroyed earlier this frame

      const mat = packed & 0xff;
      if (mat === Material.Empty) continue;
      const lifetime = (packed >> 8) & 0xff;
      const flags = (packed >> 16) & 0xff;

      // Inline field read — no bounds check needed (idx is always valid)
      const fi = idx * 4;
      const temp = fields[fi + FIELD.TEMP] / 128;

      const x = idx % W;
      const y = (idx / W) | 0;

      // --- Antimatter: on contact with any non-empty, non-antimatter,
      // non-wall, non-duplicator material, annihilates the ENTIRE contiguous
      // antimatter cluster PLUS all contiguous other material (8-connected
      // flood-fill through non-empty cells). Wall and Duplicator are barriers
      // (not annihilated, flood-fill stops at them). Empty cells stop the
      // flood-fill. A fire explosion marks the contact point. ---
      if (mat === Material.Antimatter) {
        // Find a contact neighbor (the trigger for annihilation).
        let contactX = -1, contactY = -1;
        for (let dy = -1; dy <= 1 && contactX < 0; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat !== Material.Empty && nMat !== Material.Antimatter &&
                nMat !== Material.Wall && nMat !== Material.Duplicator &&
                nMat !== Material.Void) {
              contactX = nx; contactY = ny; break;
            }
          }
        }
        if (contactX >= 0) {
          this.annihilateAntimatter(x, y, contactX, contactY);
        }
        continue;
      }

      // --- Plasma: damages everything around, decays quickly ---
      if (mat === Material.Plasma) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat !== Material.Empty && nMat !== Material.Plasma && nMat !== Material.Wall) {
              if (this.rng.random() < 0.3) {
                grid[ny * W + nx] = packCell(Material.Fire, 10, this.rng.randomShade());
              }
            }
          }
        }
        continue;
      }

      // --- Mystery (???): oscillating reaction ---
      // Changes color/behavior in a sine wave pattern based on frame count
      if (mat === Material.Mystery) {
        const phase = Math.sin(this.frame * 0.1 + x * 0.3 + y * 0.2);
        if (phase > 0.9 && this.rng.random() < 0.1) {
          // Emit plasma occasionally (same X, always in strip)
          if (y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.Plasma, 20, this.rng.randomShade());
          }
        }
        if (phase < -0.9 && this.rng.random() < 0.05) {
          // Absorb nearby particles
          const MYSTERY_DIRS = [1, 0, -1, 0, 0, 1, 0, -1]; // [dx0,dy0, dx1,dy1, ...]
          const di = Math.floor(this.rng.random() * 4) * 2;
          const dx = MYSTERY_DIRS[di], dy = MYSTERY_DIRS[di + 1];
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax) {
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat !== Material.Empty && nMat !== Material.Wall && nMat !== Material.Mystery) {
              grid[ny * W + nx] = 0;
            }
          }
        }
        continue;
      }

      // --- Gasoline: slowly vaporizes into gas vapor ---
      if (mat === Material.Gasoline) {
        if (this.rng.random() < 0.005) {
          // Same X as source, always in strip
          if (y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.GasVapor, 200, this.rng.randomShade());
            // Small chance to consume the gasoline
            if (this.rng.random() < 0.3) grid[idx] = 0;
          }
        }
        continue;
      }

      // --- Salt + Water → Brine ---
      if (mat === Material.Salt) {
        // Single 8-neighbor scan for water + snow
        let waterNi = -1, hasSnow = false;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Water) { waterNi = ny * W + nx; }
            else if (nMat === Material.Snow) { hasSnow = true; }
          }
        }
        if (waterNi >= 0 && this.rng.random() < 0.1) {
          grid[idx] = packCell(Material.Brine, 0, this.rng.randomShade());
          grid[waterNi] = packCell(Material.Brine, 0, this.rng.randomShade());
          continue;
        }
        // Salt dissolves snow: 1 salt grain melts up to 10 snow cells nearby
        if (hasSnow) {
          // Remove the salt grain
          grid[idx] = 0;
          // Dissolve up to 10 snow cells in a radius
          let dissolved = 0;
          for (let ry = y - 3; ry <= y + 3 && dissolved < 10; ry++) {
            for (let rx = x - 3; rx <= x + 3 && dissolved < 10; rx++) {
              if (rx < 0 || rx >= W || ry < 0 || ry >= H) continue;
              if (rx < wxMin || rx >= wxMax) continue;
              const ridx = ry * W + rx;
              if ((grid[ridx] & 0xff) === Material.Snow) {
                grid[ridx] = packCell(Material.Water, 0, this.rng.randomShade());
                dissolved++;
              }
            }
          }
          continue;
        }
        // High temp: salt → molten salt (destructive liquid)
        if (temp > 1.8 && this.rng.random() < 0.02) {
          grid[idx] = packCell(Material.MoltenSalt, 0, this.rng.randomShade());
          continue;
        }
      }

      // --- Molten Salt: destroys neighbors, cools to salt in low temp ---
      if (mat === Material.MoltenSalt) {
        if (temp < 0.5 && this.rng.random() < 0.05) {
          grid[idx] = packCell(Material.Salt, 0, this.rng.randomShade());
          continue;
        }
        // Single 8-neighbor scan for water + dry ice
        let waterNi = -1, dryIceNi = -1;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Water) { waterNi = ny * W + nx; }
            else if (nMat === Material.DryIce) { dryIceNi = ny * W + nx; }
          }
        }
        // Contact with water → violent impulse explosion (steam pressure, not destruction)
        if (waterNi >= 0) {
          this.applyImpulse(x, y, 6, 100);
          // Convert water to steam, molten salt cools to salt
          grid[waterNi] = packCell(Material.Steam, 80, this.rng.randomShade());
          if (this.rng.random() < 0.3) {
            grid[idx] = packCell(Material.Salt, 0, this.rng.randomShade());
          }
          continue;
        }
        // Contact with dry ice → violent impulse explosion (thermal shock)
        if (dryIceNi >= 0) {
          this.applyImpulse(x, y, 6, 100);
          // Consume the dry ice, cool molten salt to salt
          grid[dryIceNi] = 0;
          if (this.rng.random() < 0.5) {
            grid[idx] = packCell(Material.Salt, 0, this.rng.randomShade());
          }
          continue;
        }
        // Ignite flammable neighbors on contact (molten salt is very hot)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            const ni = ny * W + nx;
            const nMat = grid[ni] & 0xff;
            if ((MAT_FLAGS[nMat] & MAT_FLAMMABLE) && this.rng.random() < 0.15) {
              if (nMat === Material.Oil) {
                // Oil needs air exposure to ignite — molten salt touching
                // buried oil heats it but can't sustain a flame without oxygen.
                if (!this.isExposed(nx, ny)) continue;
                grid[ni] = packCell(Material.BurningOil, MAT_LIFETIME[Material.BurningOil], this.rng.randomShade());
              } else {
                grid[ni] = packCell(Material.Fire, 30, this.rng.randomShade());
              }
            }
          }
        }
        continue;
      }

      // --- Concrete Powder + Water → Concrete ---
      if (mat === Material.ConcretePowder) {
        let waterNi = -1;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.Water) { waterNi = ny * W + nx; break; }
          }
          if (waterNi >= 0) break;
        }
        if (waterNi >= 0 && this.rng.random() < 0.2) {
          grid[idx] = packCell(Material.Concrete, 0, this.rng.randomShade());
          // Consume the water
          grid[waterNi] = 0;
          continue;
        }
      }

      // --- Snow: melts to water when in contact with hot materials or at
      // high ambient temperature. Hot neighbors: fire, fusefire, burning
      // oil, lava, molten salt, plasma. ---
      if (mat === Material.Snow) {
        // Single 8-neighbor scan using IS_HOT lookup table
        let hasHot = false;
        for (let dy = -1; dy <= 1 && !hasHot; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (IS_HOT[grid[ny * W + nx] & 0xff]) { hasHot = true; break; }
          }
        }
        if (hasHot) {
          // Direct contact with a hot material — melts quickly.
          if (this.rng.random() < 0.3) {
            grid[idx] = packCell(Material.Water, 0, this.rng.randomShade());
            continue;
          }
        } else if (temp > 1.3 && this.rng.random() < (temp - 1.3) * 0.05) {
          // High ambient temperature — melts gradually.
          grid[idx] = packCell(Material.Water, 0, this.rng.randomShade());
          continue;
        }
      }

      // --- Dry Ice: sublimates into CO2 gas (smoke-like, no water) ---
      if (mat === Material.DryIce) {
        if (this.rng.random() < 0.02) {
          if (y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.Smoke, 60, this.rng.randomShade());
            if (this.rng.random() < 0.5) grid[idx] = 0;
          }
        }
        continue;
      }

      // --- Liquid Nitrogen: cools neighbors, slowly evaporates into cold vapor ---
      if (mat === Material.LiquidNitrogen) {
        // Cool down nearby fire/lava
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            const nMat = grid[ni] & 0xff;
            if (IS_HOT[nMat]) {
              grid[ni] = nMat === Material.Lava
                ? packCell(Material.Stone, 0, this.rng.randomShade())
                : 0;
            }
          }
        }
        // Slowly evaporate into ColdVapor — a visible white-ish gas that
        // doesn't rise (cold vapor is denser than air) and dissipates over
        // ~30 seconds. Low probability so the liquid phase lasts a while
        // before converting. Previously converted to Steam (which condensed
        // to Water) or dissipated directly to empty (invisible).
        if (this.rng.random() < 0.005) {
          grid[idx] = packCell(Material.ColdVapor, 255, this.rng.randomShade());
        }
        continue;
      }

      // --- Seed: grows into tree on dirt, progressively from the bottom up ---
      // lifetime === 0: a normal falling seed. When it lands on dirt/grass,
      //   it plants a Root and spawns a "growing tip" seed above with
      //   lifetime = trunkHeight.
      // lifetime > 0: a growing tip. Each frame it places TreeWood at its
      //   current position and moves one cell up (lifetime - 1). When
      //   lifetime reaches 1 or the cell above is blocked, it places the
      //   leaf canopy and is consumed — the tree is fully grown.
      if (mat === Material.Seed) {
        if (lifetime > 0) {
          // Growing tip — place TreeWood at current position
          grid[idx] = packCell(Material.TreeWood, 0, this.rng.randomShade());
          if (lifetime > 1 && y > 0 && grid[(y - 1) * W + x] === 0) {
            // Grow one cell higher next frame
            grid[(y - 1) * W + x] = packCell(Material.Seed, lifetime - 1, this.rng.randomShade());
          } else {
            // Reached target height or blocked — grow leaf canopy here
            this.growCanopy(x, y);
          }
          continue;
        }
        // Falling seed — check if it landed on dirt/grass
        if (y + 1 < H) {
          const belowMat = grid[(y + 1) * W + x] & 0xff;
          if (belowMat === Material.Dirt || belowMat === Material.Grass) {
            if (this.rng.random() < 0.05) {
              // Plant root and start growing upward
              grid[idx] = packCell(Material.Root, 0, this.rng.randomShade());
              const trunkHeight = 8 + Math.floor(this.rng.random() * 8);
              if (y > 0 && grid[(y - 1) * W + x] === 0) {
                grid[(y - 1) * W + x] = packCell(Material.Seed, trunkHeight, this.rng.randomShade());
              } else {
                // Can't grow upward (blocked at base) — just grow a canopy
                this.growCanopy(x, y);
              }
            }
          }
        }
        continue;
      }

      // --- Grass: spreads on top of dirt ---
      if (mat === Material.Grass) {
        if (y + 1 < H && (grid[(y + 1) * W + x] & 0xff) === Material.Dirt) {
          // Spread sideways on dirt surface
          if (this.rng.random() < 0.02) {
            const dir = this.rng.random() < 0.5 ? -1 : 1;
            const nx = x + dir;
            if (nx >= 0 && nx < W) {
              if (y + 1 < H && (grid[(y + 1) * W + nx] & 0xff) === Material.Dirt && grid[y * W + nx] === 0) {
                grid[y * W + nx] = packCell(Material.Grass, 0, this.rng.randomShade());
              }
            }
          }
        }
        continue;
      }

      // --- Nanobots: randomly move around and slowly eat through materials ---
      if (mat === Material.Nanobots) {
        // Pick a random direction to move/eat (inline the 8 dirs to avoid array alloc)
        const NANOBOT_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
        const di = Math.floor(this.rng.random() * 8) * 2;
        const dx = NANOBOT_DIRS[di], dy = NANOBOT_DIRS[di + 1];
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax) {
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (nMat === Material.Empty) {
            // Move into empty space
            grid[ni] = packCell(mat, lifetime, flags | FLAG_UPDATED);
            grid[idx] = 0;
          } else if (nMat !== Material.Nanobots && nMat !== Material.Wall &&
                     nMat !== Material.Antimatter) {
            // Eat through the material — slowly destroy it (5% chance per frame)
            if (this.rng.random() < 0.05) {
              grid[ni] = 0;
            }
          }
        }
        continue;
      }

      // --- Magic Powder: random color flicker, explodes on flesh, decays like fire ---
      if (mat === Material.MagicPowder) {
        // Random shade flicker each frame (independent per particle, no spatial pattern)
        if (this.rng.random() < 0.5) {
          const newShade = Math.floor(this.rng.random() * 4);
          grid[idx] = packCell(mat, lifetime, (flags & ~SHADE_MASK) | newShade | FLAG_UPDATED);
        }
        // Explodes on contact with flesh
        let hasFlesh = false;
        for (let dy = -1; dy <= 1 && !hasFlesh; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.Flesh) { hasFlesh = true; break; }
          }
        }
        if (hasFlesh && this.rng.random() < 0.3) {
          this.explode(x, y, 4);
          continue;
        }
        // Emit fireflies in a random direction (not always upward)
        if (this.rng.random() < 0.02) {
          const dx = Math.floor(this.rng.random() * 3) - 1;
          const dy = Math.floor(this.rng.random() * 3) - 1;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax && grid[ny * W + nx] === 0) {
            grid[ny * W + nx] = packCell(Material.Fireflies, 255, this.rng.randomShade());
          }
        }
        continue;
      }

      // --- Popcorn: pops like fireworks near fire/lava/molten salt or high heat ---
      if (mat === Material.Popcorn) {
        // Already-popped popcorn (FLAG_POPPED) never pops again — prevents an
        // infinite creation loop where scattered popcorn re-triggers the pop
        // reaction and spawns ever more popcorn.
        if (flags & FLAG_POPPED) continue;
        // Single 8-neighbor scan using IS_HOT lookup table
        let hasHot = temp > 1.3;
        for (let dy = -1; dy <= 1 && !hasHot; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (IS_HOT[grid[ny * W + nx] & 0xff]) { hasHot = true; break; }
          }
        }
        if (hasHot && this.rng.random() < 0.3) {
          // Fireworks pop: radial impulse + scatter popcorn particles outward.
          // All resulting popcorn (scattered + original) is marked FLAG_POPPED
          // so it won't pop again — each kernel pops exactly once.
          this.applyImpulse(x, y, 4, 60);
          // Scatter popcorn particles in random directions (marked FLAG_POPPED)
          const POPCORN_DIRS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];
          for (let di = 0; di < 16; di += 2) {
            if (this.rng.random() < 0.6) {
              const nx = x + POPCORN_DIRS[di], ny = y + POPCORN_DIRS[di + 1];
              if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax && grid[ny * W + nx] === 0) {
                grid[ny * W + nx] = packCell(Material.Popcorn, 0, FLAG_POPPED | this.rng.randomShade());
              }
            }
          }
          // Mark the original kernel as popped so it doesn't re-pop next frame.
          grid[idx] = packCell(Material.Popcorn, 0, (flags & ~FLAG_UPDATED) | FLAG_POPPED);
          // Sometimes launch a popped popcorn particle upward
          if (this.rng.random() < 0.5 && y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.Popcorn, 0, FLAG_POPPED | this.rng.randomShade());
          }
        }
        continue;
      }

      // --- Dynamite: detonated by fire or fuse, chain-detonates connected sticks ---
      if (mat === Material.Dynamite) {
        // Single 8-neighbor scan for fire-class + fuse
        let hasFireOrFuse = false;
        for (let dy = -1; dy <= 1 && !hasFireOrFuse; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (IS_FIRE[nMat] || nMat === Material.Fuse) { hasFireOrFuse = true; break; }
          }
        }
        // 100% trigger chance — dynamite is unstable, it should detonate
        // immediately when lit, not sit there for frames while fire spreads.
        if (hasFireOrFuse) {
          this.detonateDynamite(x, y);
        }
        continue;
      }

      // --- C4: only detonates when a burning fuse is adjacent.
      // C4 itself burns like wax (flammable, slow burn) but does NOT explode from fire alone.
      // Chain-detonates all connected C4 via flood fill. ---
      if (mat === Material.C4) {
        // C4 only detonates when adjacent to FuseFire (fire from a burning fuse).
        // Regular fire does NOT trigger C4 — only fuse fire does.
        let fuseBurning = false;
        for (let dy = -1; dy <= 1 && !fuseBurning; dy++) {
          for (let dx = -1; dx <= 1 && !fuseBurning; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.FuseFire) { fuseBurning = true; break; }
          }
        }
        if (fuseBurning && this.rng.random() < 0.3) {
          this.detonateC4(x, y);
        }
        continue;
      }

      // --- Acid: eats adjacent materials, 50% consumed per eat ---
      // Each frame, acid scans its 8 neighbors for a non-immune material.
      // If found, it destroys the neighbor and has a 50% chance of being
      // consumed itself. This gives a ~2:1 ratio (2 material eaten per 1
      // acid consumed), so 1000 sand + 1000 acid → ~500 acid remaining.
      // Acid does NOT eat: Empty, Wall, Acid, Base. Base is handled by the
      // neutralization reaction (base section below).
      if (mat === Material.Acid) {
        // First: check for adjacent Base — neutralization takes priority
        // (acid + base → salt + steam). Fast reaction — 50% chance per frame.
        let baseNi = -1;
        for (let dy = -1; dy <= 1 && baseNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.Base) { baseNi = ny * W + nx; break; }
          }
        }
        if (baseNi >= 0 && this.rng.random() < 0.5) {
          // Neutralization: acid + base → salt + steam
          grid[idx] = packCell(Material.Salt, 0, this.rng.randomShade());
          grid[baseNi] = packCell(Material.Steam, 80, this.rng.randomShade());
          continue;
        }
        // Otherwise: eat an adjacent non-immune material
        if (this.rng.random() < 0.15) {
          // Pick a random neighbor to eat (avoids eating all 8 at once)
          const eatDir = Math.floor(this.rng.random() * 8);
          const EAT_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
          const EAT_DY = [-1, -1, -1, 0, 0, 1, 1, 1];
          const nx = x + EAT_DX[eatDir];
          const ny = y + EAT_DY[eatDir];
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax) {
            const ni = ny * W + nx;
            const nMat = grid[ni] & 0xff;
            if (!IS_ACID_IMMUNE[nMat]) {
              // Eat the neighbor
              grid[ni] = 0;
              // 50% chance the acid is consumed by the reaction
              if (this.rng.random() < 0.5) {
                grid[idx] = 0;
              }
            }
          }
        }
        continue;
      }

      // --- Base: neutralizes acid on contact (acid + base → salt + steam) ---
      // Mirrors the acid-side check so the reaction triggers from either
      // material's perspective. Without this, if only acid checks for base,
      // a base cell surrounded by acid might not react if none of the acid
      // cells happen to scan it this frame.
      if (mat === Material.Base) {
        let acidNi = -1;
        for (let dy = -1; dy <= 1 && acidNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.Acid) { acidNi = ny * W + nx; break; }
          }
        }
        if (acidNi >= 0 && this.rng.random() < 0.5) {
          // Neutralization: base + acid → steam + salt
          grid[idx] = packCell(Material.Steam, 80, this.rng.randomShade());
          grid[acidNi] = packCell(Material.Salt, 0, this.rng.randomShade());
          continue;
        }
      }

      // --- Flour: dust explosion when suspended near fire ---
      if (mat === Material.Flour) {
        let hasFire = false;
        for (let dy = -1; dy <= 1 && !hasFire; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (IS_FIRE[grid[ny * W + nx] & 0xff]) { hasFire = true; break; }
          }
        }
        if (hasFire && this.rng.random() < 0.15) {
          this.explode(x, y, 3);
        }
        continue;
      }

      // --- Hydrogen: explodes near fire ---
      if (mat === Material.Hydrogen) {
        let hasFire = false;
        for (let dy = -1; dy <= 1 && !hasFire; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (IS_FIRE[grid[ny * W + nx] & 0xff]) { hasFire = true; break; }
          }
        }
        if (hasFire && this.rng.random() < 0.3) {
          this.explode(x, y, 4);
        }
        continue;
      }

      // --- Glitter: suspends in water, floats in air ---
      // (handled in tryMove via low gravity — no special reaction needed)

      // --- Fireflies: random flicker + organic flight, spread out (no buoyancy) ---
      if (mat === Material.Fireflies) {
        // Flicker: each firefly independently picks a random shade each frame.
        // Uses cell.lifetime as a per-particle phase seed so neighbors don't sync.
        if (this.rng.random() < 0.5) {
          const newShade = Math.floor(this.rng.random() * 4);
          grid[idx] = packCell(mat, lifetime, (flags & ~SHADE_MASK) | newShade | FLAG_UPDATED);
        }

        // Flight: pure random walk in all 8 directions + occasional darts.
        // No gravity/buoyancy — they spread out evenly in all directions.
        if (this.rng.random() < 0.7) {
          let dx: number, dy: number;
          if (this.rng.random() < 0.2) {
            // Dart: 2-3 cell jump for organic burst movement
            dx = Math.floor(this.rng.random() * 7) - 3;
            dy = Math.floor(this.rng.random() * 7) - 3;
          } else {
            // Normal: 1-cell step in any of 8 directions (uniform)
            dx = Math.floor(this.rng.random() * 3) - 1;
            dy = Math.floor(this.rng.random() * 3) - 1;
          }
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[ny * W + nx] === 0) {
            grid[ny * W + nx] = packCell(mat, lifetime, flags | FLAG_UPDATED);
            grid[idx] = 0;
          }
        }
        continue;
      }

      // --- Toast: made from bread near fire (future), burns like wood ---
      // --- Wax: slow burning (handled by combustion + aging) ---
      // --- Rubber: bouncy (handled in tryMove) ---

      // ===============================================================
      // Game-specific reactions
      // Minimal physical reactions; most "mixing" is analyzer-driven
      // effect-vector math in the game, not cell transforms here.
      // ===============================================================

      // --- Ether + Fire → EtherealVapor (glowing gas byproduct) ---
      if (mat === Material.Ether) {
        let fireNi = -1;
        for (let dy = -1; dy <= 1 && fireNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (IS_FIRE[grid[ny * W + nx] & 0xff]) { fireNi = ny * W + nx; break; }
          }
        }
        if (fireNi >= 0 && this.rng.random() < 0.3) {
          grid[idx] = packCell(Material.EtherealVapor, 120, this.rng.randomShade());
          grid[fireNi] = packCell(Material.Smoke, 40, this.rng.randomShade());
          continue;
        }
        // High temp: ether evaporates to ethereal vapor
        if (temp > 1.4 && this.rng.random() < (temp - 1.4) * 0.03) {
          grid[idx] = packCell(Material.EtherealVapor, 120, this.rng.randomShade());
          continue;
        }
      }

      // --- Sulfur + Water → corrosive reaction (produces AlchemicalSlag slowly) ---
      if (mat === Material.Sulfur) {
        let waterNi = -1;
        for (let dy = -1; dy <= 1 && waterNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.Water) { waterNi = ny * W + nx; break; }
          }
        }
        if (waterNi >= 0 && temp > 1.0 && this.rng.random() < 0.04) {
          grid[idx] = packCell(Material.AlchemicalSlag, 0, this.rng.randomShade());
          grid[waterNi] = 0; // consume the water
          continue;
        }
      }

      // --- Blood + BoneDust → necrotic reaction (slow, produces Slag) ---
      if (mat === Material.Blood) {
        let boneNi = -1;
        for (let dy = -1; dy <= 1 && boneNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.BoneDust) { boneNi = ny * W + nx; break; }
          }
        }
        if (boneNi >= 0 && this.rng.random() < 0.02) {
          grid[idx] = packCell(Material.AlchemicalSlag, 0, this.rng.randomShade());
          grid[boneNi] = 0;
          continue;
        }
      }

      // --- MushroomSpores + Water → grows into Plant (mild toxic reaction) ---
      if (mat === Material.MushroomSpores) {
        let waterNi = -1;
        for (let dy = -1; dy <= 1 && waterNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if ((grid[ny * W + nx] & 0xff) === Material.Water) { waterNi = ny * W + nx; break; }
          }
        }
        if (waterNi >= 0 && this.rng.random() < 0.03) {
          grid[idx] = packCell(Material.Plant, 0, this.rng.randomShade());
          continue;
        }
      }

      // --- PhoenixFeather near fire/lava: glows brighter, resists burning ---
      // (flammable but long burnTime already set; here we just let it shimmer)
      // --- DragonScale: very dense, sinks through liquids (handled by density) ---

      // --- LiquidShadow + light source (fire/plasma) → dissipates to smoke ---
      if (mat === Material.LiquidShadow) {
        let lightNi = -1;
        for (let dy = -1; dy <= 1 && lightNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Fire || nMat === Material.Plasma || nMat === Material.StarShard) {
              lightNi = ny * W + nx; break;
            }
          }
        }
        if (lightNi >= 0 && this.rng.random() < 0.08) {
          grid[idx] = packCell(Material.Smoke, 80, this.rng.randomShade());
          continue;
        }
      }

      // --- VoidEssence + any organic (Blood/Flesh/Plant) → violent annihilation ---
      if (mat === Material.VoidEssence) {
        let organicNi = -1;
        for (let dy = -1; dy <= 1 && organicNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Blood || nMat === Material.Flesh || nMat === Material.Plant ||
                nMat === Material.TrollBlood) {
              organicNi = ny * W + nx; break;
            }
          }
        }
        if (organicNi >= 0 && this.rng.random() < 0.05) {
          grid[organicNi] = 0;
          grid[idx] = packCell(Material.AlchemicalSlag, 0, this.rng.randomShade());
          this.applyImpulse(x, y, 3, 40);
          continue;
        }
      }

      // --- TimeSand + high temp → brief plasma flash (reality-bending) ---
      if (mat === Material.TimeSand && temp > 1.6 && this.rng.random() < 0.02) {
        grid[idx] = packCell(Material.Plasma, 20, this.rng.randomShade());
        continue;
      }

      // --- StarShard: emits fireflies when in contact with ether/ethereal vapor ---
      if (mat === Material.StarShard) {
        let etherNi = -1;
        for (let dy = -1; dy <= 1 && etherNi < 0; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Ether || nMat === Material.EtherealVapor) {
              etherNi = ny * W + nx; break;
            }
          }
        }
        if (etherNi >= 0 && this.rng.random() < 0.04) {
          // Emit a firefly into a random empty neighbor
          const rdx = Math.floor(this.rng.random() * 3) - 1;
          const rdy = Math.floor(this.rng.random() * 3) - 1;
          const ex = x + rdx, ey = y + rdy;
          if (ex >= 0 && ex < W && ey >= 0 && ey < H && ex >= wxMin && ex < wxMax && grid[ey * W + ex] === 0) {
            grid[ey * W + ex] = packCell(Material.Fireflies, 255, this.rng.randomShade());
          }
        }
      }

      // --- Spore: floating mold spore. Germinates into Mold when adjacent to
      // a food material (wood/plant/leaf/tree wood/root/grass). The spore is
      // consumed (becomes Mold at its current position). Otherwise it drifts
      // as a gas (handled by tryMove) and slowly dissipates via lifetime. ---
      if (mat === Material.Spore) {
        let hasFood = false;
        for (let dy = -1; dy <= 1 && !hasFood; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Wood || nMat === Material.Plant || nMat === Material.Leaf ||
                nMat === Material.TreeWood || nMat === Material.Root || nMat === Material.Grass) {
              hasFood = true; break;
            }
          }
        }
        if (hasFood && this.rng.random() < 0.2) {
          grid[idx] = packCell(Material.Mold, 0, this.rng.randomShade());
          continue;
        }
        continue;
      }

      // --- Mold: grows on wood/plant/leaf/tree wood/root/grass. Spreads very
      // slowly to an adjacent food cell (converts it to Mold). When no food
      // remains adjacent, releases a spore cloud into surrounding empty cells
      // and dies (clears to empty). Static solid (gravityDir=0) kept in the
      // active list via MAT_HAS_REACTIONS. ---
      if (mat === Material.Mold) {
        // Collect food neighbors + empty/gas neighbors (for spore release).
        let foodNi = -1;
        let foodCount = 0;
        let emptyCount = 0;
        const MOLD_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
        for (let di = 0; di < 16; di += 2) {
          const nx = x + MOLD_DIRS[di], ny = y + MOLD_DIRS[di + 1];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < wxMin || nx >= wxMax) continue;
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (nMat === Material.Wood || nMat === Material.Plant || nMat === Material.Leaf ||
              nMat === Material.TreeWood || nMat === Material.Root || nMat === Material.Grass) {
            foodCount++;
            if (foodNi < 0) foodNi = ni;
          } else if (nMat === Material.Empty || (MAT_FLAGS[nMat] & MAT_GAS)) {
            emptyCount++;
          }
        }
        if (foodCount > 0) {
          // Spread slowly: ~2% chance per frame to convert one food neighbor
          // to Mold. At 60fps that's ~0.8 seconds per spread step — slow
          // enough to be visible as creeping growth, fast enough to spread
          // across a food block in reasonable time.
          if (foodNi >= 0 && this.rng.random() < 0.02) {
            grid[foodNi] = packCell(Material.Mold, 0, this.rng.randomShade());
          }
        } else if (emptyCount > 0) {
          // No food left — release a spore cloud and die. Spawn a few Spore
          // particles into surrounding empty/gas cells, then clear self.
          for (let di = 0; di < 16; di += 2) {
            if (this.rng.random() < 0.6) {
              const nx = x + MOLD_DIRS[di], ny = y + MOLD_DIRS[di + 1];
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              if (nx < wxMin || nx >= wxMax) continue;
              const ni = ny * W + nx;
              const nMat = grid[ni] & 0xff;
              if (nMat === Material.Empty || (MAT_FLAGS[nMat] & MAT_GAS)) {
                grid[ni] = packCell(Material.Spore, MAT_LIFETIME[Material.Spore], this.rng.randomShade());
              }
            }
          }
          grid[idx] = 0;
        }
        continue;
      }

      // --- Glitch: randomly swaps places with a neighboring non-empty cell.
      // Any non-empty neighbor (any material except Empty) is a valid swap
      // target. The swapped-in material takes the glitch's old position and
      // vice versa. Falls like a normal solid when it can't swap. ---
      if (mat === Material.Glitch) {
        if (this.rng.random() < 0.3) {
          // Pick a random 8-direction and swap with whatever is there.
          const GLITCH_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
          const di = Math.floor(this.rng.random() * 8) * 2;
          const nx = x + GLITCH_DIRS[di], ny = y + GLITCH_DIRS[di + 1];
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax) {
            const ni = ny * W + nx;
            const nPacked = grid[ni];
            if (nPacked !== 0 && !((nPacked >> 16) & FLAG_UPDATED)) {
              // Swap: glitch moves to neighbor, neighbor moves to glitch's spot.
              // Both marked FLAG_UPDATED so neither is reprocessed this frame.
              grid[ni] = packed | FLAG_UPDATED_BIT;
              grid[idx] = nPacked | FLAG_UPDATED_BIT;
              continue;
            }
          }
        }
        continue;
      }

      // --- Duplicator: static solid that clones the first material to touch
      // it. The locked material id is stored in the lifetime field
      // (0 = not yet locked). Each frame, if locked, it spawns the locked
      // material into an adjacent empty cell. Does not move, does not react
      // otherwise (acid-immune, skipped by antimatter). ---
      if (mat === Material.Duplicator) {
        const locked = lifetime; // 0 = not locked; otherwise = material id
        if (locked === 0) {
          // Not yet locked — scan neighbors for a material to lock onto.
          // Skip Empty, Wall, other Duplicators, Antimatter (would be
          // catastrophically destructive), Acid, and Base — the duplicator
          // should not react with these at all (like Wall). Cloning acid
          // would spread corrosion through the duplicator; cloning base is
          // equally undesirable.
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              if (nx < wxMin || nx >= wxMax) continue;
              const nMat = grid[ny * W + nx] & 0xff;
              if (nMat !== Material.Empty && nMat !== Material.Wall &&
                  nMat !== Material.Duplicator && nMat !== Material.Antimatter &&
                  nMat !== Material.Acid && nMat !== Material.Base) {
                // Lock onto this material (store its id in the lifetime field).
                grid[idx] = packCell(Material.Duplicator, nMat, flags & ~FLAG_UPDATED);
                break;
              }
            }
            if (((grid[idx] >> 8) & 0xff) !== 0) break;
          }
        } else {
          // Locked — spawn the locked material into an adjacent empty cell,
          // and slowly propagate the lock to adjacent unlocked Duplicators.
          // Low chance per frame so it produces a steady trickle, not a flood.
          if (this.rng.random() < 0.15) {
            const DUP_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
            const di = Math.floor(this.rng.random() * 8) * 2;
            const nx = x + DUP_DIRS[di], ny = y + DUP_DIRS[di + 1];
            if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax) {
              const ni = ny * W + nx;
              if (grid[ni] === 0) {
                const spawnMat = locked;
                grid[ni] = packCell(spawnMat, MAT_LIFETIME[spawnMat], this.rng.randomShade());
              }
            }
          }
          // Propagate lock to adjacent unlocked Duplicators — same low chance
          // so the lock creeps across a duplicator cluster slowly.
          if (this.rng.random() < 0.15) {
            const PROP_DIRS = [1, 0, -1, 0, 0, 1, 0, -1];
            const di = Math.floor(this.rng.random() * 4) * 2;
            const nx = x + PROP_DIRS[di], ny = y + PROP_DIRS[di + 1];
            if (nx >= 0 && nx < W && ny >= 0 && ny < H && nx >= wxMin && nx < wxMax) {
              const ni = ny * W + nx;
              const nPacked = grid[ni];
              // Only lock an adjacent Duplicator that is NOT yet locked
              // (lifetime === 0). Don't overwrite an existing lock — a
              // duplicator that already locked onto a different material
              // keeps its own lock.
              if ((nPacked & 0xff) === Material.Duplicator &&
                  ((nPacked >> 8) & 0xff) === 0) {
                grid[ni] = packCell(Material.Duplicator, locked, nPacked >> 16 & 0xff);
              }
            }
          }
        }
        continue;
      }

      // --- Void: a static solid that swallows up any material that touches
      // it. Each frame, every adjacent non-empty cell (except Wall, other
      // Void, and Duplicator — those are permanent barriers) is destroyed
      // (set to empty). The void itself is never consumed. Acid-immune,
      // antimatter barrier, never falls. MAT_HAS_REACTIONS keeps it active. ---
      if (mat === Material.Void) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (nx < wxMin || nx >= wxMax) continue;
            const ni = ny * W + nx;
            const nMat = grid[ni] & 0xff;
            // Swallow everything except Empty, Wall, Void, Duplicator, and
            // Antimatter (those are permanent — void doesn't eat itself or
            // other exotic barriers).
            if (nMat !== Material.Empty && nMat !== Material.Wall &&
                nMat !== Material.Void && nMat !== Material.Duplicator &&
                nMat !== Material.Antimatter) {
              grid[ni] = 0;
            }
          }
        }
        continue;
      }
    }
  }

  /**
   * Apply a radial impulse: immediately shoves particles outward from (cx, cy)
   * and sets per-cell wind fields for ongoing push. This pushes particles away
   * without destroying them. The fluid grid handles velocity decay via its step().
   *
   * Immediate displacement: process rings from outermost to innermost so outer
   * particles move first, creating space for inner ones. Each particle is
   * shoved one cell radially outward (displacing liquids/gases via tryShove).
   *
   * Wind field: sets radial wind with linear falloff for continued push over
   * the next several frames.
   */
  private applyImpulse(cx: number, cy: number, radius: number, strength: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const fields = this.fields;

    // --- Phase 1: Immediate radial displacement (outer ring → inner ring) ---
    // Process from the outermost ring inward so outer particles shove out first,
    // creating space for inner particles to follow.
    for (let ring = radius; ring >= 1; ring--) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        for (let x = cx - ring; x <= cx + ring; x++) {
          // Only process cells on the current ring boundary (skip inner cells)
          const dx = x - cx, dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (Math.round(dist) !== ring) continue;
          if (x < 0 || x >= W || y < 0 || y >= H) continue;

          const idx = y * W + x;
          const packed = grid[idx];
          if (packed === 0) continue;
          const flags = (packed >> 16) & 0xff;
          if (flags & FLAG_UPDATED) continue;
          // Don't move walls or static solids
          const mat = packed & 0xff;
          if (mat === Material.Wall || mat === Material.Stone) continue;

          // Shove one step radially outward
          const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
          const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
          this.tryShove(x, y, x + stepX, y + stepY, packed);
        }
      }
    }

    // --- Phase 2: Apply impulse to the fluid grid for ongoing push ---
    // The fluid grid handles pressure relaxation and velocity decay, replacing
    // the old per-cell wind field system.
    this.fluid.applyImpulse(cx, cy, radius, 0, 0); // pressure impulse for shockwave
    // Radial velocity impulse — each cell gets pushed outward
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius || dist < 0.5) continue;
        const falloff = 1 - dist / radius;
        const mag = strength * falloff * 0.02; // scale to fluid grid velocity units
        const ux = dx / dist, uy = dy / dist;
        this.fluid.applyImpulse(x, y, 1, ux * mag, uy * mag);
      }
    }
  }

  /** Create an explosion: fire + smoke in a radius */
  private explode(cx: number, cy: number, radius: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const wxMin = this.writeXMin, wxMax = this.writeXMax;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (dist > radius * radius) continue;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        // Strip mode write guard — explosions don't cross strip boundaries.
        // The coordinator's boundary cleanup re-runs explosions that span strips.
        if (x < wxMin || x >= wxMax) continue;
        const mat = grid[y * W + x] & 0xff;
        if (mat === Material.Wall) continue;
        // Don't destroy C4 or Dynamite in the blast — let detonateC4 /
        // detonateDynamite handle chain reactions via flood-fill.
        if (mat === Material.C4 || mat === Material.Dynamite) continue;
        if (dist < radius * radius * 0.3) {
          // Core: fire
          grid[y * W + x] = packCell(Material.Fire, 20, this.rng.randomShade());
        } else {
          // Outer: smoke or empty
          if (this.rng.random() < 0.5) {
            grid[y * W + x] = packCell(Material.Smoke, 60, this.rng.randomShade());
          } else {
            grid[y * W + x] = 0;
          }
        }
      }
    }

    // --- Spawn explosion particles ---
    // Projectile particles: flying debris in all directions
    const numProjectiles = Math.min(8, 3 + radius);
    for (let i = 0; i < numProjectiles; i++) {
      const angle = (i / numProjectiles) * Math.PI * 2 + this.rng.random() * 0.5;
      const speed = 1 + this.rng.random() * 2;
      this.particles.spawn(
        cx, cy,
        PARTICLE_TYPES.PROJECTILE,
        0xffaa3300, // orange-red
        1 + this.rng.random(),
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        20 + Math.floor(this.rng.random() * 20),
      );
    }
    // Circle particles: expanding blast rings
    const numCircles = Math.min(3, 1 + Math.floor(radius / 2));
    for (let i = 0; i < numCircles; i++) {
      this.particles.spawn(
        cx, cy,
        PARTICLE_TYPES.CIRCLE,
        0xffff6600, // bright orange
        radius * 0.5,
        0, 0,
        15 + i * 5,
      );
    }
  }

  /** Annihilate antimatter: flood-fill all 8-connected non-empty cells from
   *  the antimatter cluster at (ax, ay) through the contacted material at
   *  (cx, cy). Destroys every connected non-empty cell except Wall and
   *  Duplicator (which act as barriers and are left intact). Empty cells
   *  stop the flood-fill. A fire explosion marks the contact point.
   *
   *  This implements "eliminates all contiguous antimatter and all contiguous
   *  other material, except empty" — the entire connected non-empty region
   *  touching the antimatter cluster is annihilated. */
  private annihilateAntimatter(ax: number, ay: number, cx: number, cy: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const visited = this.visitedAntimatterFrame;
    const frame = this.frame;
    const wxMin = this.writeXMin, wxMax = this.writeXMax;
    // Flood-fill from the antimatter seed cell through all 8-connected
    // non-empty cells. Wall and Duplicator are barriers (skipped, not
    // destroyed). Empty cells are not traversed.
    const stack: number[] = [ay * W + ax];
    const cells: number[] = [];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (visited[idx] === frame) continue;
      visited[idx] = frame;
      const px = idx % W;
      const py = (idx / W) | 0;
      const m = grid[idx] & 0xff;
      // Stop at empty, wall, duplicator, or void (barriers)
      if (m === Material.Empty || m === Material.Wall || m === Material.Duplicator ||
          m === Material.Void) continue;
      cells.push(idx);
      // Push 8 neighbors (only those within write bounds — cross-strip
      // annihilation is handled by the coordinator's boundary cleanup)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < wxMin || nx >= wxMax) continue;
          stack.push(ny * W + nx);
        }
      }
    }
    // Annihilate every cell in the connected region.
    for (let i = 0; i < cells.length; i++) {
      grid[cells[i]] = 0;
    }
    // Fire explosion at the contact point (visual + ignites nearby flammables).
    this.explode(cx, cy, 3);
  }

  /** Detonate C4 at (cx, cy) and flood-fill all connected C4 for chain reaction */
  private detonateC4(cx: number, cy: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    // Collect all connected C4 cells (8-connected flood fill).
    // Use a frame-tagged visited array instead of allocating a Set every call.
    // We use a dedicated visitedC4Frame array to avoid clobbering the
    // combustion pass's visitedFrame.
    const visited = this.visitedC4Frame;
    const frame = this.frame;
    const stack: number[] = [cy * W + cx];
    const c4Cells: number[] = [];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (visited[idx] === frame) continue;
      visited[idx] = frame;
      const px = idx % W;
      const py = (idx / W) | 0;
      if ((grid[idx] & 0xff) !== Material.C4) continue;
      c4Cells.push(idx);
      // Check 8 neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          stack.push(ny * W + nx);
        }
      }
    }
    // Explode each C4 cell
    for (let i = 0; i < c4Cells.length; i++) {
      const idx = c4Cells[i];
      const px = idx % W;
      const py = (idx / W) | 0;
      this.explode(px, py, 8);
    }
  }

  /** Detonate Dynamite at (cx, cy) and flood-fill all connected Dynamite for
   *  chain reaction. Collects all 8-connected Dynamite cells, explodes once at
   *  the center of mass (radius scaled to the cluster size), then consumes all
   *  cells. Exploding once instead of per-cell avoids massive lag on large
   *  dynamite clusters. */
  private detonateDynamite(cx: number, cy: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const visited = this.visitedC4Frame;
    const frame = this.frame;
    const stack: number[] = [cy * W + cx];
    const dynoCells: number[] = [];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (visited[idx] === frame) continue;
      visited[idx] = frame;
      const px = idx % W;
      const py = (idx / W) | 0;
      if ((grid[idx] & 0xff) !== Material.Dynamite) continue;
      dynoCells.push(idx);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          stack.push(ny * W + nx);
        }
      }
    }
    if (dynoCells.length === 0) return;

    // Explode once at the center of mass. Radius scales with cluster size
    // (6 base + 1 per extra stick, capped at 12) so a single big blast
    // covers the whole cluster — much cheaper than N separate explosions.
    let sumX = 0, sumY = 0;
    for (let i = 0; i < dynoCells.length; i++) {
      sumX += dynoCells[i] % W;
      sumY += (dynoCells[i] / W) | 0;
    }
    const centerX = Math.round(sumX / dynoCells.length);
    const centerY = Math.round(sumY / dynoCells.length);
    const radius = Math.min(12, 6 + dynoCells.length - 1);
    this.explode(centerX, centerY, radius);

    // Consume all dynamite cells — explode() skips them, so we must destroy
    // them explicitly. Convert to fire so the blast looks right.
    for (let i = 0; i < dynoCells.length; i++) {
      grid[dynoCells[i]] = packCell(Material.Fire, 20, this.rng.randomShade());
    }
  }

  /** Grow a leaf canopy around (x, y) — the top of the tree trunk.
   *  Called when the growing seed tip reaches its target height or is blocked. */
  private growCanopy(x: number, y: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const wxMin = this.writeXMin, wxMax = this.writeXMax;
    const canopyRadius = 3 + Math.floor(this.rng.random() * 2);
    for (let dy = -canopyRadius; dy <= 0; dy++) {
      for (let dx = -canopyRadius; dx <= canopyRadius; dx++) {
        const lx = x + dx, ly = y + dy - canopyRadius;
        if (lx < 0 || lx >= W || ly < 0 || ly >= H) continue;
        if (lx < wxMin || lx >= wxMax) continue;
        const dist = dx * dx + dy * dy;
        if (dist > canopyRadius * canopyRadius) continue;
        if (grid[ly * W + lx] !== 0) continue;
        if (this.rng.random() < 0.7) {
          grid[ly * W + lx] = packCell(Material.Leaf, 0, this.rng.randomShade());
        }
      }
    }
  }

  private findNeighbor(x: number, y: number, mat: number): { x: number; y: number } | null {
    const W = this.W, H = this.H;
    const grid = this.grid;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if ((grid[ny * W + nx] & 0xff) === mat) return { x: nx, y: ny };
      }
    }
    return null;
  }

  /**
   * Check if a cell is "exposed" — has at least one neighbor that is empty
   * or a gas (so fire/heat can reach it). Used to prevent buried oil from
   * igniting when it's encased in solid/liquid material.
   */
  private isExposed(x: number, y: number): boolean {
    const W = this.W, H = this.H;
    const grid = this.grid;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nMat = grid[ny * W + nx] & 0xff;
        if (nMat === Material.Empty) return true;
        if (MAT_FLAGS[nMat] & MAT_GAS) return true;
      }
    }
    return false;
  }

  private applyCombustion(): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const fields = this.fields;
    const active = this.activeCells;
    const count = this.activeCount;
    // Strip mode write bounds
    const wxMin = this.writeXMin, wxMax = this.writeXMax;

    // Snapshot which cells are fire/lava at the start of this pass.
    // Only these cells can spread fire — newly ignited cells wait until next frame.
    // This prevents instant cascade through fuse/gunpowder chains in a single pass.
    // (Reused per-frame buffer — avoids a Uint8Array allocation every step.)
    // Build from the active list instead of scanning the full grid.
    const fireSources = this.fireSources;
    // Only clear the entries we'll use (the active cells). The rest are already 0
    // from the previous frame's clear, but to be safe we clear all active entries.
    for (let a = 0; a < count; a++) fireSources[active[a]] = 0;
    let fireCount = 0;
    for (let a = 0; a < count; a++) {
      const idx = active[a];
      const m = grid[idx] & 0xff;
      if (m === Material.Fire || m === Material.FuseFire || m === Material.BurningOil || m === Material.Lava) {
        fireSources[idx] = 1;
        fireCount++;
      }
    }
    // Early-out: no fire sources means no combustion spread, fuse burn, or
    // burning-oil passes needed.
    if (fireCount === 0) return;

    // --- Fire spread pass ---
    // Iterate only the fire-source cells (from the active list) instead of
    // scanning the full grid.
    for (let a = 0; a < count; a++) {
      const idx = active[a];
      if (!fireSources[idx]) continue;
      const srcPacked = grid[idx];
      const srcMat = srcPacked & 0xff;
      // Spark-flagged fire (visual flames emitted by BurningOil/fuse) does NOT
      // ignite oil — the burning-oil pass handles controlled oil-to-oil spread.
      // Without this, the visual flames would ignite adjacent oil in all 8
      // directions (including diagonals), causing the fire to "burst" outward
      // instead of creeping slowly from the ignition site.
      const srcIsSpark = srcMat === Material.Fire && ((srcPacked >> 16) & FLAG_SPARK) !== 0;
      const x = idx % W;
      const y = (idx / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < wxMin || nx >= wxMax) continue;
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (!(MAT_FLAGS[nMat] & MAT_FLAMMABLE)) continue;
          if (nMat === Material.Gunpowder) {
            grid[ni] = packCell(Material.Fire, 15, this.rng.randomShade());
            continue;
          }
          // Gas vapor and hydrogen: explosive
          if (nMat === Material.GasVapor || nMat === Material.Hydrogen) {
            grid[ni] = packCell(Material.Fire, 20, this.rng.randomShade());
            this.explode(nx, ny, 3);
            continue;
          }
          // Flour: dust explosion
          if (nMat === Material.Flour) {
            this.explode(nx, ny, 3);
            continue;
          }
          // Dynamite: chain detonate via flood-fill (same as applySpecialReactions)
          if (nMat === Material.Dynamite) {
            this.detonateDynamite(nx, ny);
            continue;
          }
          const baseChance = srcMat === Material.Lava ? 0.1 : 0.08;
          // Rubber is hard to ignite — low continual burn/spread chance.
          // Oil is a slow-burning liquid fuel: low per-frame spread chance
          // so the flame creeps gradually across the surface rather than
          // flashing instantly. BurningOil→oil spread is handled by the
          // dedicated burning-oil pass below (with decay-linked chance),
          // so skip oil neighbors here when the source is BurningOil.
          // Spark-flagged fire (visual flames from BurningOil) also skips
          // oil — only "real" fire sources (lava, regular fire from burning
          // wood/gunpowder, etc.) can ignite oil via this pass.
          if ((srcMat === Material.BurningOil || srcIsSpark) && nMat === Material.Oil) continue;
          // Oil needs air exposure to ignite — fire/lava touching buried oil
          // heats it but can't sustain a flame without oxygen.
          if (nMat === Material.Oil && !this.isExposed(nx, ny)) continue;
          const matMult =
            nMat === Material.Rubber ? 0.3 :
            nMat === Material.Oil ? 0.3 :
            nMat === Material.Wax ? 2.5 :  // wax spreads fire extremely fast
            1.0;
          // Per-cell temperature scales fire spread rate (inline field read)
          const nTemp = fields[ni * 4 + FIELD.TEMP] / 128;
          const chance = baseChance * nTemp * matMult;
          if (this.rng.random() < chance) {
            // Fuse gets FuseFire (yellow, stays put, deterministic spread)
            if (nMat === Material.Fuse) {
              grid[ni] = packCell(Material.FuseFire, 15, this.rng.randomShade());
            } else if (nMat === Material.Oil) {
              // Oil → BurningOil (stays put, slow decay, slow spread)
              grid[ni] = packCell(Material.BurningOil, MAT_LIFETIME[Material.BurningOil], this.rng.randomShade());
            } else if (nMat === Material.Wax) {
              // Wax burns very slowly — long fire lifetime + FLAG_ANCHORED so
              // the flame stays put on the wax surface and keeps spreading.
              grid[ni] = packCell(Material.Fire, 200, FLAG_ANCHORED | this.rng.randomShade());
            } else {
              grid[ni] = packCell(Material.Fire, 30, this.rng.randomShade());
            }
          }
        }
      }
    }

    // --- Deterministic fuse burn ---
    // FuseFire deterministically ignites ALL adjacent fuse cells when its
    // lifetime drops to the threshold. The fire has a short lifetime
    // (FUSE_FIRE_LIFETIME) so the flame trail is brief. The burn speed is
    // controlled by the lifetime: each cell burns for FUSE_FIRE_LIFETIME frames
    // before passing the flame onward.
    //
    // FuseFire is a separate material (Material.FuseFire) so it's reliably
    // identified even at the end of the trail where all adjacent fuse has been
    // consumed. No flag bits needed.
    //
    // To prevent single-frame cascades, we use a frame-tagged visited array
    // (this.visitedFrame) instead of allocating a Set every step. A cell is
    // "visited this frame" when visitedFrame[i] === this.frame.
    const FUSE_FIRE_LIFETIME = 15;
    const FUSE_SPREAD_THRESHOLD = 3;
    const frame = this.frame;
    const visitedFrame = this.visitedFrame;
    for (let a = 0; a < count; a++) {
      const idx = active[a];
      const packed = grid[idx];
      const mat = packed & 0xff;
      if (mat !== Material.FuseFire) continue;
      const lifetime = (packed >> 8) & 0xff;
      if (lifetime === 0) continue;
      const x = idx % W;
      const y = (idx / W) | 0;

      // Emit sparks every frame — small fire particles that fly upward with
      // random spread. Sparks use Material.Fire (red) so they're visually
      // distinct from the yellow fuse fire and fly freely (FuseFire is
      // anchored, Fire is not).
      for (let s = 0; s < 3; s++) {
        if (this.rng.random() < 0.5) {
          const sx = x + Math.floor(this.rng.random() * 3) - 1;
          const sy = y - 1 - Math.floor(this.rng.random() * 2); // 1-2 cells above
          if (sx >= 0 && sx < W && sy >= 0 && sy < H && sx >= wxMin && sx < wxMax && grid[sy * W + sx] === 0) {
            // Sparks: very short lifetime, expire to empty (not smoke) so they
            // don't accumulate and suffocate the burn when going upward.
            grid[sy * W + sx] = packCell(Material.Fire, 6, this.rng.randomShade() | FLAG_SPARK);
            // Upward impulse only — sparks rise straight up (wind is skipped for
            // spark fire in tryMove). The impulse still pushes neighboring
            // smoke/gas upward via the fluid grid. No horizontal drift: a fixed
            // at-birth drift caused sparks to streak diagonally up-left/up-right.
            this.fluid.applyImpulse(sx, sy, 2, 0, -0.8); // strong upward
          }
        }
      }

      // Spread to adjacent fuse cells only when near end of lifetime
      if (lifetime > FUSE_SPREAD_THRESHOLD) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < wxMin || nx >= wxMax) continue;
          const ni = ny * W + nx;
          if (visitedFrame[ni] === frame) continue;
          if ((grid[ni] & 0xff) === Material.Fuse) {
            grid[ni] = packCell(Material.FuseFire, FUSE_FIRE_LIFETIME, this.rng.randomShade());
            visitedFrame[ni] = frame;
          }
        }
      }
    }

    // --- Burning oil pass ---
    // BurningOil flows like a liquid (gravity: 1, density: 0.8) on the oil
    // surface. Each frame it:
    //   1. Emits normal Fire particles upward (visual flames that rise and
    //      decay to smoke like regular fire).
    //   2. Slowly spreads to adjacent oil. The spread chance scales with
    //      decay progress — early in its life it barely spreads, but as it
    //      burns down the chance increases, so the fire creeps outward
    //      gradually rather than flashing instantly.
    // The ignitedOil de-dup uses the same frame-tagged visitedFrame array as
    // the fuse pass above. Safe to share: the two passes target different
    // materials (Fuse vs Oil), so a cell marked in one pass is guarded out by
    // the material-type check in the other before the visited check runs.
    const BURNING_OIL_LIFETIME = MAT_LIFETIME[Material.BurningOil];
    for (let a = 0; a < count; a++) {
      const idx = active[a];
      const packed = grid[idx];
      const mat = packed & 0xff;
      if (mat !== Material.BurningOil) continue;
      const lifetime = (packed >> 8) & 0xff;
      const x = idx % W;
      const y = (idx / W) | 0;

      // Emit fire particles above: visual flames that rise from the burning
      // oil surface with slight horizontal variation for a natural look.
      // Marked with FLAG_SPARK so they:
      //   1. Expire to empty (not smoke) — smoke would accumulate and
      //      suffocate the burn. The BurningOil itself already produces smoke
      //      when it decays.
      //   2. Are skipped by the fire spread pass for oil ignition (see below)
      //      — the burning-oil pass handles controlled oil-to-oil spread.
      //      Without this, the visual flames would ignite adjacent oil in all
      //      directions (including diagonals), causing the fire to "burst"
      //      instead of creeping slowly outward.
      //   3. Skip diagonal rising in tryMove (isSparkFire) — they rise straight
      //      up or drift horizontally via gas drift, but don't shoot off in
      //      diagonal directions.
      for (let s = 0; s < 2; s++) {
        if (this.rng.random() < 0.4) {
          const sx = x + Math.floor(this.rng.random() * 3) - 1; // -1, 0, or +1
          const sy = y - 1 - Math.floor(this.rng.random() * 2); // 1-2 cells above
          if (sx >= 0 && sx < W && sy >= 0 && sy < H && sx >= wxMin && sx < wxMax && grid[sy * W + sx] === 0) {
            grid[sy * W + sx] = packCell(Material.Fire, 20, this.rng.randomShade() | FLAG_SPARK);
            // Upward impulse only — sparks rise straight up (wind is skipped for
            // spark fire in tryMove). The impulse still pushes neighboring
            // smoke/gas upward via the fluid grid. No horizontal drift: a fixed
            // at-birth drift caused sparks to streak diagonally up-left/up-right.
            this.fluid.applyImpulse(sx, sy, 2, 0, -0.5);
          }
        }
      }

      // Spread to adjacent oil: slow chance that increases with decay.
      // decayProgress goes 0→1 as lifetime goes 200→0.
      const decayProgress = 1 - (lifetime / BURNING_OIL_LIFETIME);
      const spreadChance = 0.02 + 0.04 * decayProgress; // 2% early → 6% late
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < wxMin || nx >= wxMax) continue;
          const ni = ny * W + nx;
          if (visitedFrame[ni] === frame) continue;
          // Oil only ignites if it has air exposure (empty/gas neighbor) —
          // burning oil flowing into buried oil won't ignite it without oxygen.
          if ((grid[ni] & 0xff) === Material.Oil && this.isExposed(nx, ny) && this.rng.random() < spreadChance) {
            grid[ni] = packCell(Material.BurningOil, BURNING_OIL_LIFETIME, this.rng.randomShade());
            visitedFrame[ni] = frame;
          }
        }
      }
    }

    // Clear fireSources for the active cells we marked (so next frame's
    // buildActiveListAndClearFlags doesn't inherit stale marks). We only
    // touch the active cells — the rest are already 0.
    for (let a = 0; a < count; a++) fireSources[active[a]] = 0;
  }

  private applyAging(): void {
    const grid = this.grid;
    const active = this.activeCells;
    const count = this.activeCount;

    for (let a = 0; a < count; a++) {
      const i = active[a];
      const packed = grid[i];
      if (packed === 0) continue; // cell was destroyed earlier this frame

      // Inline unpack — avoid allocating a Cell object
      let mat = packed & 0xff;
      let lifetime = (packed >> 8) & 0xff;
      let flags = (packed >> 16) & 0xff;

      // Gravel (and legacy LooseStone): re-settle to Stone when stationary AND
      // supported by stable ground. The lifetime field is a settle timer, set
      // when the stone is dislodged by mining (GRAVEL_SETTLE_TICKS) or disturbed
      // by adjacent gravel movement (GRAVEL_DISTURB_SETTLE_TICKS). When the
      // cell moves (FLAG_UPDATED), the timer keeps its current value. When
      // stationary, the timer only counts down if the cell is supported from
      // below by a STABLE material — otherwise it's floating and must not
      // re-settle (it needs to keep trying to fall). This prevents Gravel from
      // freezing mid-air when friction or random chance prevents it from moving
      // for a few ticks.
      //
      // Stable support = a solid that won't move out from under us:
      //   - Static solids (gravityDir === 0: Stone, Wall, Concrete) with
      //     lifetime === 0 (not loosened).
      //   - Gravity-affected solids (ore, dirt, etc.) at rest: gravity field
      //     === 0 (not falling) and lifetime === 0 (not loosened/decaying).
      // Liquids, gases, and loosened/falling cells are NOT stable support —
      // they can flow or fall away, leaving re-settled stone floating.
      //
      // LooseStone (mat 63) is kept in the condition for backwards compat with
      // old saves that still contain LooseStone cells; no new LooseStone is
      // created — all stone-debris conversions produce Gravel.
      // Stone (mat 3) is included: when a Stone cell's gravity field is set
      // (by mining), it falls. When it lands and is stably supported, it
      // re-freezes (gravity field cleared) — no material conversion needed.
      if (mat === Material.Gravel || mat === Material.LooseStone || mat === Material.Stone) {
        if (!(flags & FLAG_UPDATED) && lifetime > 0) {
          // Check if supported from below by a stable cell or grid boundary.
          // A cell is stable support if it won't move out from under us:
          //   - Static solids (gravityDir === 0: Stone, Wall, Concrete) with
          //     lifetime === 0 (not loosened by mining).
          //   - Gravity-affected solids (gravityDir !== 0 but solid: ore,
          //     dirt, etc.) that are at rest — gravity field === 0 (not
          //     falling) and lifetime === 0 (not loosened/decaying). Ore is
          //     generated with gravity=0 so it stays embedded until mined;
          //     without this, stone resting on ore never settles because ore
          //     has gravityDir=1.
          // Liquids, gases, and loosened/falling cells do NOT count — they
          // can move out from under us.
          const belowIdx = i + this.W;
          let supported: boolean;
          if (belowIdx >= this.grid.length) {
            supported = true; // grid boundary = stable floor
          } else {
            const belowPacked = this.grid[belowIdx];
            if (belowPacked === 0) {
              supported = false;
            } else {
              const belowMat = belowPacked & 0xff;
              const belowLifetime = (belowPacked >> 8) & 0xff;
              if (MAT_GRAVITY_DIR[belowMat] === 0) {
                // Static solid — stable if not loosened
                supported = belowLifetime === 0;
              } else if (MAT_FLAGS[belowMat] & MAT_SOLID) {
                // Gravity-affected solid at rest — stable if not falling
                // (gravity field cleared) and not loosened/decaying.
                supported = this.fields[belowIdx * 4 + FIELD.GRAVITY] === 0 &&
                  belowLifetime === 0;
              } else {
                // Liquid/gas — never stable support
                supported = false;
              }
            }
          }
          if (supported) {
            lifetime--;
            if (lifetime === 0) {
              // Re-settle: convert back to Stone (static, no gravity).
              // For Gravel/LooseStone: change material to Stone.
              // For Stone: just clear the lifetime (already Stone, now frozen).
              // Also clear FLAG_DETACHED so the renderer stops drawing the
              // warm tint + amber outline, and the cell re-freezes (no longer
              // collectible / unfrozen). Without this, re-settled stone stays
              // visually distinct from original stone and gets absorbed into
              // the player's inventory when walked near.
              mat = Material.Stone;
              lifetime = 0;
              flags &= ~0x10; // clear FLAG_DETACHED (bit 4 of flags byte)
            }
          }
          // If not stably supported, don't count down — keep trying to fall
        }
        const newFlags = flags & ~FLAG_UPDATED;
        const newPacked = (mat & 0xff) | ((lifetime & 0xff) << 8) | ((newFlags & 0xff) << 16);
        if (newPacked !== packed) grid[i] = newPacked;
        continue;
      }

      if (lifetime > 0) {
        // Randomized decay: fire/smoke/steam sometimes skip a tick so
        // individual particles last variable amounts of time.
        if (mat === Material.Fire) {
          // Anchored fire (from wax) decays very slowly so the flame
          // persists and keeps spreading. Normal fire decays fast.
          if (flags & FLAG_ANCHORED) {
            if (this.rng.random() < 0.15) lifetime--;
          } else {
            if (this.rng.random() < 0.7) lifetime--;
          }
        } else if (mat === Material.FuseFire) {
          // FuseFire decays deterministically for consistent burn speed
          lifetime--;
        } else if (mat === Material.BurningOil) {
          // BurningOil decays very slowly so the fire sits on the oil surface
          // for a long time, giving it time to spread to neighbors gradually.
          if (this.rng.random() < 0.15) lifetime--;
        } else if (mat === Material.Smoke) {
          if (this.rng.random() < 0.8) lifetime--;
        } else if (mat === Material.Steam) {
          if (this.rng.random() < 0.75) lifetime--;
        } else if (mat === Material.MagicPowder) {
          if (this.rng.random() < 0.7) lifetime--;
        } else if (mat === Material.ColdVapor) {
          // Cold vapor dissipates very slowly — ~30 seconds at 60fps.
          // lifetime 255 / 0.14 chance ≈ 1800 frames ≈ 30s.
          if (this.rng.random() < 0.14) lifetime--;
        } else if (mat === Material.Seed) {
          // Growing seeds (lifetime > 0) manage their own lifetime in the
          // seed growth reaction — don't decrement here.
        } else if (mat === Material.Duplicator) {
          // Duplicator's lifetime field stores the locked material id (0 = not
          // locked). It must NOT decay — the lock is permanent. Don't decrement.
        } else {
          lifetime--;
        }
        if (lifetime === 0) {
          if (mat === Material.Fire) {
            // Sparks and anchored fire (wax) expire to empty, not smoke.
            // Sparks: marked with FLAG_SPARK (bit 3).
            // Anchored fire: marked with FLAG_ANCHORED (bit 4) — smoke would
            // accumulate and suffocate the spreading flame.
            if (flags & (FLAG_SPARK | FLAG_ANCHORED)) {
              grid[i] = 0;
              continue;
            }
            mat = Material.Smoke;
            lifetime = 120;
          } else if (mat === Material.FuseFire) {
            // FuseFire expires to empty (not smoke) — smoke would accumulate
            // below the rising fire and suffocate the burn trail.
            grid[i] = 0;
            continue;
          } else if (mat === Material.BurningOil) {
            // BurningOil expires to smoke — the oil is consumed.
            mat = Material.Smoke;
            lifetime = 60;
          } else if (mat === Material.Smoke) {
            grid[i] = 0;
            continue;
          } else if (mat === Material.Steam) {
            if (this.rng.random() < 0.7) {
              mat = Material.Water;
              lifetime = 0;
            } else {
              grid[i] = 0;
              continue;
            }
          } else if (mat === Material.GasVapor) {
            // Expired vapor → empty
            grid[i] = 0;
            continue;
          } else if (mat === Material.ColdVapor) {
            // Cold vapor fully dissipated → empty
            grid[i] = 0;
            continue;
          } else if (mat === Material.Hydrogen) {
            grid[i] = 0;
            continue;
          } else if (mat === Material.Spore) {
            // Spore that never germinated dissipates to empty.
            grid[i] = 0;
            continue;
          } else if (mat === Material.Plasma) {
            // Plasma → fire then smoke
            mat = Material.Fire;
            lifetime = 15;
          } else if (mat === Material.Fireflies) {
            // Fireflies don't expire (lifetime stays at max)
            lifetime = 255;
          } else if (mat === Material.Nanobots) {
            lifetime = 255;
          } else if (mat === Material.Wood || mat === Material.Plant || mat === Material.Oil ||
                     mat === Material.Flesh || mat === Material.Leaf || mat === Material.TreeWood ||
                     mat === Material.Root || mat === Material.Grass || mat === Material.Toast ||
                     mat === Material.Plastic || mat === Material.Wax || mat === Material.Fuse ||
                     mat === Material.Rubber || mat === Material.C4 || mat === Material.Glitter ||
                     mat === Material.MagicPowder) {
            mat = Material.Smoke;
            lifetime = 60;
          }
        }
      }
      // Clear FLAG_UPDATED and write back. Only write if the packed value
      // actually changed — avoids unnecessary memory writes when nothing
      // happened (e.g. static solids with lifetime=0).
      const newFlags = flags & ~FLAG_UPDATED;
      const newPacked = (mat & 0xff) | ((lifetime & 0xff) << 8) | ((newFlags & 0xff) << 16);
      if (newPacked !== packed) {
        grid[i] = newPacked;
      }
    }
  }
}
