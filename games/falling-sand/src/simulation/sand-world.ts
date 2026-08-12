import { DEFAULT_GRAVITY, DEFAULT_TEMP, FIELD } from "../shared/sim-buffer";
import {
  IS_FIRE,
  IS_HOT,
  MAT_FLAGS,
  MAT_FLAMMABLE,
  MAT_GAS,
  MAT_GRAVITY,
  MAT_GRAVITY_DIR,
  MAT_LIFETIME,
  MAT_LIQUID,
  Material,
} from "./materials";

export interface Cell {
  mat: number;
  lifetime: number;
  flags: number;
}

function pack(cell: Cell): number {
  return (cell.mat & 0xff) | ((cell.lifetime & 0xff) << 8) | ((cell.flags & 0xff) << 16);
}

function unpack(v: number): Cell {
  return {
    mat: v & 0xff,
    lifetime: (v >> 8) & 0xff,
    flags: (v >> 16) & 0xff,
  };
}

const FLAG_UPDATED = 0x04; // bit 2 — cell was updated this frame
const FLAG_SPARK = 0x08;   // bit 3 — this fire is a spark (expires to empty, not smoke)
const SHADE_MASK = 0x03;   // bits 0-1 — shade index (0-3)
// Precomputed bit position of FLAG_UPDATED within the packed uint32 flags field.
// OR-ing this into a packed cell value sets FLAG_UPDATED without re-packing.
const FLAG_UPDATED_BIT = FLAG_UPDATED << 16;

function randomShade(): number {
  return Math.floor(Math.random() * 4);
}

function initialLifetime(mat: number): number {
  return MAT_LIFETIME[mat];
}

/** Pack a cell value from raw components without allocating a Cell object. */
function packCell(mat: number, lifetime: number, flags: number): number {
  return (mat & 0xff) | ((lifetime & 0xff) << 8) | ((flags & 0xff) << 16);
}

export class SandWorld {
  W: number;
  H: number;
  grid: Uint32Array;
  // Per-cell physics fields: 4 bytes per cell [gravity:u8, temp:u8, windX:i8, windY:i8]
  fields: Uint8Array;
  frame = 0;
  // Global impulse settings (not spatial)
  horizontalImpulseChance = 0.02;
  horizontalImpulseStrength = 1;

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

  // --- Sparse active-cell tracking ---
  // activeCells holds the grid indices of all non-empty cells. activeCount is
  // the number of valid entries. Rebuilt each frame (twice — once at the start
  // to replace the FLAG_UPDATED clear scan, once before applyAging to capture
  // cells created by combustion/reactions). Iterating the active list is
  // O(active) instead of O(W*H) — a massive win when the grid is mostly empty.
  private activeCells: Uint32Array;
  private activeCount = 0;

  // --- Wind dirty flag ---
  // Set to true whenever applyImpulse writes wind fields. decayWind skips
  // entirely when false, avoiding a full-grid scan when there are no active
  // impulses/explosions.
  private hasWind = false;

  constructor(w: number, h: number) {
    this.W = w;
    this.H = h;
    const cells = w * h;
    this.grid = new Uint32Array(cells);
    this.fields = new Uint8Array(cells * 4);
    this.fireSources = new Uint8Array(cells);
    this.visitedFrame = new Uint32Array(cells);
    this.visitedC4Frame = new Uint32Array(cells);
    this.activeCells = new Uint32Array(cells);
    this.activeCount = 0;
    // Initialize fields to defaults
    for (let i = 0; i < cells * 4; i += 4) {
      this.fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }
    // Stone floor
    for (let x = 0; x < w; x++) {
      for (let y = h - 4; y < h; y++) {
        this.grid[y * w + x] = pack({ mat: Material.Stone, lifetime: 0, flags: 0 });
      }
    }
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

  // wind: i8 -128 to 127. Returns -5 to ~5.
  getWindX(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return (this.fields[(y * this.W + x) * 4 + FIELD.WIND_X] << 24) >> 24; // sign-extend i8
  }

  getWindY(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return (this.fields[(y * this.W + x) * 4 + FIELD.WIND_Y] << 24) >> 24;
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
        grid[y * W + x] = packCell(mat, lt, randomShade());
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
          grid[y * W + x] = packCell(Material.FuseFire, 15, randomShade());
        } else if (mat === Material.Oil) {
          // Oil only ignites if exposed (has an empty/gas neighbor so fire
          // can reach it). Buried oil stays inert.
          if (!this.isExposed(x, y)) continue;
          // Oil → BurningOil (flows like oil, slow decay, slow spread)
          grid[y * W + x] = packCell(Material.BurningOil, MAT_LIFETIME[Material.BurningOil], randomShade());
        } else {
          grid[y * W + x] = packCell(Material.Fire, 30, randomShade());
        }
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
    this.applyReactions();
    this.applySpecialReactions();

    // Pass 4: Movement — must iterate the full grid in spatial order
    // (bottom-to-top, alternating L/R) for correct falling-sand physics.
    const leftToRight = this.frame % 2 === 0;
    for (let y = H - 1; y >= 0; y--) {
      if (leftToRight) {
        for (let x = 0; x < W; x++) this.tryMove(x, y);
      } else {
        for (let x = W - 1; x >= 0; x--) this.tryMove(x, y);
      }
    }

    // Pass 5: Combustion — builds fireSources from the active list.
    this.applyCombustion();

    // Rebuild active list to capture cells created/destroyed by reactions,
    // movement, and combustion. This is a cheap full-grid scan (no unpack).
    this.buildActiveList();

    // Pass 6: Aging — iterates the rebuilt active list.
    this.applyAging();

    // Pass 7: Wind decay — skipped entirely when no wind exists.
    this.decayWind();
  }

  /**
   * Build the active-cell list (indices of all non-empty cells) and clear
   * FLAG_UPDATED in a single pass. Merges the old separate FLAG_UPDATED clear
   * loop with active-list construction. Also detects non-zero wind fields so
   * that externally-set wind (e.g. by tests or future field-painting code) is
   * detected even when applyImpulse wasn't called.
   */
  private buildActiveListAndClearFlags(): void {
    const grid = this.grid;
    const fields = this.fields;
    const active = this.activeCells;
    const n = this.W * this.H;
    const clearMask = ~((0xff & ~(SHADE_MASK | FLAG_SPARK)) << 16);
    let count = 0;
    let windDetected = false;
    for (let i = 0; i < n; i++) {
      grid[i] &= clearMask;
      if (grid[i] !== 0) {
        active[count++] = i;
      }
      // Check wind fields (every 4th byte pair) — cheap branch-predicted check
      const fi = i * 4;
      if (!windDetected && (fields[fi + FIELD.WIND_X] !== 0 || fields[fi + FIELD.WIND_Y] !== 0)) {
        windDetected = true;
      }
    }
    this.activeCount = count;
    if (windDetected) this.hasWind = true;
  }

  /** Build the active-cell list without clearing flags (for mid-frame rebuild). */
  private buildActiveList(): void {
    const grid = this.grid;
    const active = this.activeCells;
    const n = this.W * this.H;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (grid[i] !== 0) {
        active[count++] = i;
      }
    }
    this.activeCount = count;
  }

  private tryMove(x: number, y: number): void {
    const W = this.W, H = this.H;
    const idx = y * W + x;
    const packed = this.grid[idx];
    if (packed === 0) return;

    // Inline unpack — avoid allocating a Cell object on every cell visit
    const mat = packed & 0xff;
    if (mat === Material.Empty) return;
    const flags = (packed >> 16) & 0xff;
    if (flags & FLAG_UPDATED) return;

    // Typed-array lookups instead of MATERIALS[mat]?.property
    const gravityDir = MAT_GRAVITY_DIR[mat];
    if (gravityDir === 0) return;

    // FuseFire stays put so it can deterministically spread to adjacent fuse
    // cells. Without this, the fire gas floats away before it can propagate.
    if (mat === Material.FuseFire) return;

    // Inline field reads — avoid 4× bounds-checked method calls per cell.
    // tryMove is only called within [0,W)×[0,H) so bounds checks are redundant.
    const fi = idx * 4;
    const gravity = this.fields[fi + FIELD.GRAVITY] / 128;
    const windX = (this.fields[fi + FIELD.WIND_X] << 24) >> 24;
    const windY = (this.fields[fi + FIELD.WIND_Y] << 24) >> 24;

    // Apply gravity multiplier — at 0 gravity, nothing falls
    if (gravity <= 0) return;

    const matFlags = MAT_FLAGS[mat];
    const dy = gravityDir;
    const isLiquid = (matFlags & MAT_LIQUID) !== 0;
    const isGas = (matFlags & MAT_GAS) !== 0;
    const matGravity = MAT_GRAVITY[mat];

    // --- Wind: apply horizontal/vertical force from per-cell wind field ---
    if (windX !== 0 || windY !== 0) {
      const wdx = windX > 0 ? 1 : windX < 0 ? -1 : 0;
      const wdy = windY > 0 ? 1 : windY < 0 ? -1 : 0;
      // Scale chance with wind magnitude: 30 = 100% move chance.
      // Strong impulses (100+) reliably push particles every frame.
      const windChance = Math.min(1, (Math.abs(windX) + Math.abs(windY)) / 30);
      if (Math.random() < windChance) {
        // Strong wind can shove into occupied cells (displace liquids/gases)
        const windMag = Math.abs(windX) + Math.abs(windY);
        if (windMag >= 50) {
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
    if (mat === Material.Honey && isExterior && Math.random() < 0.7) return;

    // Exterior particles have a chance to skip falling (friction).
    if (isExterior && !isGas) {
      const frictionChance = 0.3 / Math.max(1, matGravity);
      if (Math.random() < frictionChance) return;
    }

    // --- Gas flicker: random chance to not move at all ---
    // Prevents gasses from rising in uniform horizontal lines. Each particle
    // has a chance to "flicker" in place, creating organic, non-uniform spread.
    if (isGas) {
      const flickerChance = (mat === Material.Fire || mat === Material.FuseFire) ? 0.35 : 0.25;
      if (Math.random() < flickerChance) return;
    }

    // --- Density-scaled horizontal impulse ---
    // Lighter materials (low gravity) get more impulse; denser materials get less.
    // Sand (gravity 1) → full impulse, Water (gravity 2) → half, Lava (gravity 3) → third
    // Gasses (fire/smoke/steam) also get impulse so they drift sideways while rising.
    if (this.horizontalImpulseChance > 0) {
      const scaledChance = this.horizontalImpulseChance / Math.max(1, matGravity);
      if (Math.random() < scaledChance) {
        const nudgeDir = Math.random() < 0.5 ? -1 : 1;
        const nudge = nudgeDir * Math.max(1, Math.round(this.horizontalImpulseStrength));
        if (this.trySwap(x, y, x + nudge, y + dy, packed, mat, matGravity, isGas)) return;
      }
    }

    // 1. Try gravity direction
    if (this.trySwap(x, y, x, y + dy, packed, mat, matGravity, isGas)) return;

    // Rubber: bouncy — try to bounce upward when blocked from below
    if (mat === Material.Rubber) {
      // Check if we're resting on something (can't fall)
      const belowY = y + dy;
      const blocked = belowY < 0 || belowY >= H || this.grid[belowY * W + x] !== 0;
      if (blocked) {
        // Bounce: try to move up or sideways
        if (Math.random() < 0.5) {
          if (this.trySwap(x, y, x, y - dy, packed, mat, matGravity, isGas)) return;
        }
        const bounceDir = Math.random() < 0.5 ? -1 : 1;
        if (this.trySwap(x, y, x + bounceDir * 2, y, packed, mat, matGravity, isGas)) return;
        if (this.trySwap(x, y, x + bounceDir, y, packed, mat, matGravity, isGas)) return;
      }
    }

    const dir = Math.random() < 0.5 ? -1 : 1;
    if (this.trySwap(x, y, x + dir, y + dy, packed, mat, matGravity, isGas)) return;
    if (this.trySwap(x, y, x - dir, y + dy, packed, mat, matGravity, isGas)) return;

    if (isLiquid) {
      const flowDir = Math.random() < 0.5 ? -1 : 1;
      if (this.tryFlow(x, y, flowDir, 5)) return;
      if (this.tryFlow(x, y, -flowDir, 5)) return;
    }

    // Gas: wider horizontal drift (up to 3 cells) for organic spread
    if (isGas) {
      const driftDir = Math.random() < 0.5 ? -1 : 1;
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
          // Heavy liquid sinks through a lighter gas or a less-dense liquid
          // (density = gravity). Mercury (gravity 4) sinks through water (2),
          // brine (2.5), honey (1.5), lava (3), molten salt (3), etc.
          if (!((belowPacked >> 16) & FLAG_UPDATED) &&
              ((belowFlags & MAT_GAS) || ((belowFlags & MAT_LIQUID) && matGravity > MAT_GRAVITY[belowMat]))) {
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
        if (Math.random() < 0.8) return;
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
    // rise through smoke (gravity 2) so they separate instead of mixing.
    if (srcIsGas) {
      const destMat = destPacked & 0xff;
      if ((MAT_FLAGS[destMat] & MAT_GAS) && srcGravity > MAT_GRAVITY[destMat]) {
        // Swap: source moves to dest, dest moves to source
        this.grid[destIdx] = srcPacked | FLAG_UPDATED_BIT;
        this.grid[srcIdx] = destPacked | FLAG_UPDATED_BIT;
        return true;
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

  private applyReactions(): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    const fields = this.fields;
    const active = this.activeCells;
    const count = this.activeCount;

    for (let a = 0; a < count; a++) {
      const idx = active[a];
      const packed = grid[idx];
      if (packed === 0) continue; // cell was destroyed earlier this frame

      const mat = packed & 0xff;
      if (mat === Material.Empty) continue;

      // Inline field read — no bounds check needed (idx is always valid)
      const fi = idx * 4;
      const temp = fields[fi + FIELD.TEMP] / 128;

      if (mat === Material.Water) {
        // Single 8-neighbor scan: check for lava, fire-class, and plant at once
        // instead of up to 4 separate findNeighbor calls (4×8 = 32 neighbor
        // unpacks → 1×8 = 8 with direct grid reads).
        const x = idx % W;
        const y = (idx / W) | 0;
        let lavaIdx = -1, fireIdx = -1, hasPlant = false;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const ni = ny * W + nx;
            const nMat = grid[ni] & 0xff;
            if (nMat === Material.Lava) { lavaIdx = ni; }
            else if (IS_FIRE[nMat]) { fireIdx = ni; }
            else if (nMat === Material.Plant) { hasPlant = true; }
          }
        }

        if (lavaIdx >= 0) {
          grid[idx] = packCell(Material.Steam, 120, randomShade());
          grid[lavaIdx] = packCell(Material.Stone, 0, randomShade());
          continue;
        }
        // Contact with fire/fusefire/burning oil: water boils into steam and
        // extinguishes the flame. Lava is handled above (cools to stone);
        // fire-class materials turn to smoke (consumed by the water).
        if (fireIdx >= 0 && Math.random() < 0.25) {
          grid[idx] = packCell(Material.Steam, 120, randomShade());
          grid[fireIdx] = packCell(Material.Smoke, 40, randomShade());
          continue;
        }
        // High temperature: water evaporates into steam
        if (temp > 1.5 && Math.random() < (temp - 1.5) * 0.02) {
          grid[idx] = packCell(Material.Steam, 120, randomShade());
          continue;
        }
        if (hasPlant && Math.random() < 0.02) {
          grid[idx] = packCell(Material.Plant, 0, randomShade());
          continue;
        }
      }

      // Low temperature: fire/fusefire/burningoil dies faster
      if (IS_FIRE[mat] && temp < 0.5) {
        if (Math.random() < (0.5 - temp) * 0.1) {
          grid[idx] = packCell(Material.Smoke, 60, randomShade());
          continue;
        }
      }
    }
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

      // --- Antimatter: eliminates any normal neighbor, small explosion ---
      if (mat === Material.Antimatter) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat !== Material.Empty && nMat !== Material.Antimatter && nMat !== Material.Wall) {
              // Annihilate both
              grid[ny * W + nx] = 0;
              grid[idx] = 0;
              // Create fire explosion
              this.explode(x, y, 3);
              break;
            }
          }
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
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat !== Material.Empty && nMat !== Material.Plasma && nMat !== Material.Wall) {
              if (Math.random() < 0.3) {
                grid[ny * W + nx] = packCell(Material.Fire, 10, randomShade());
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
        if (phase > 0.9 && Math.random() < 0.1) {
          // Emit plasma occasionally
          if (y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.Plasma, 20, randomShade());
          }
        }
        if (phase < -0.9 && Math.random() < 0.05) {
          // Absorb nearby particles
          const MYSTERY_DIRS = [1, 0, -1, 0, 0, 1, 0, -1]; // [dx0,dy0, dx1,dy1, ...]
          const di = Math.floor(Math.random() * 4) * 2;
          const dx = MYSTERY_DIRS[di], dy = MYSTERY_DIRS[di + 1];
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
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
        if (Math.random() < 0.005) {
          if (y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.GasVapor, 200, randomShade());
            // Small chance to consume the gasoline
            if (Math.random() < 0.3) grid[idx] = 0;
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
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Water) { waterNi = ny * W + nx; }
            else if (nMat === Material.Snow) { hasSnow = true; }
          }
        }
        if (waterNi >= 0 && Math.random() < 0.1) {
          grid[idx] = packCell(Material.Brine, 0, randomShade());
          grid[waterNi] = packCell(Material.Brine, 0, randomShade());
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
              const ridx = ry * W + rx;
              if ((grid[ridx] & 0xff) === Material.Snow) {
                grid[ridx] = packCell(Material.Water, 0, randomShade());
                dissolved++;
              }
            }
          }
          continue;
        }
        // High temp: salt → molten salt (destructive liquid)
        if (temp > 1.8 && Math.random() < 0.02) {
          grid[idx] = packCell(Material.MoltenSalt, 0, randomShade());
          continue;
        }
      }

      // --- Molten Salt: destroys neighbors, cools to salt in low temp ---
      if (mat === Material.MoltenSalt) {
        if (temp < 0.5 && Math.random() < 0.05) {
          grid[idx] = packCell(Material.Salt, 0, randomShade());
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
            const nMat = grid[ny * W + nx] & 0xff;
            if (nMat === Material.Water) { waterNi = ny * W + nx; }
            else if (nMat === Material.DryIce) { dryIceNi = ny * W + nx; }
          }
        }
        // Contact with water → violent impulse explosion (steam pressure, not destruction)
        if (waterNi >= 0) {
          this.applyImpulse(x, y, 6, 100);
          // Convert water to steam, molten salt cools to salt
          grid[waterNi] = packCell(Material.Steam, 80, randomShade());
          if (Math.random() < 0.3) {
            grid[idx] = packCell(Material.Salt, 0, randomShade());
          }
          continue;
        }
        // Contact with dry ice → violent impulse explosion (thermal shock)
        if (dryIceNi >= 0) {
          this.applyImpulse(x, y, 6, 100);
          // Consume the dry ice, cool molten salt to salt
          grid[dryIceNi] = 0;
          if (Math.random() < 0.5) {
            grid[idx] = packCell(Material.Salt, 0, randomShade());
          }
          continue;
        }
        // Ignite flammable neighbors on contact (molten salt is very hot)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            const nMat = grid[ni] & 0xff;
            if ((MAT_FLAGS[nMat] & MAT_FLAMMABLE) && Math.random() < 0.15) {
              if (nMat === Material.Oil) {
                // Oil needs air exposure to ignite — molten salt touching
                // buried oil heats it but can't sustain a flame without oxygen.
                if (!this.isExposed(nx, ny)) continue;
                grid[ni] = packCell(Material.BurningOil, MAT_LIFETIME[Material.BurningOil], randomShade());
              } else {
                grid[ni] = packCell(Material.Fire, 30, randomShade());
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
            if ((grid[ny * W + nx] & 0xff) === Material.Water) { waterNi = ny * W + nx; break; }
          }
          if (waterNi >= 0) break;
        }
        if (waterNi >= 0 && Math.random() < 0.2) {
          grid[idx] = packCell(Material.Concrete, 0, randomShade());
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
          if (Math.random() < 0.3) {
            grid[idx] = packCell(Material.Water, 0, randomShade());
            continue;
          }
        } else if (temp > 1.3 && Math.random() < (temp - 1.3) * 0.05) {
          // High ambient temperature — melts gradually.
          grid[idx] = packCell(Material.Water, 0, randomShade());
          continue;
        }
      }

      // --- Dry Ice: sublimates into CO2 gas (smoke-like, no water) ---
      if (mat === Material.DryIce) {
        if (Math.random() < 0.02) {
          if (y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.Smoke, 60, randomShade());
            if (Math.random() < 0.5) grid[idx] = 0;
          }
        }
        continue;
      }

      // --- Liquid Nitrogen: cools neighbors, evaporates ---
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
                ? packCell(Material.Stone, 0, randomShade())
                : 0;
            }
          }
        }
        if (Math.random() < 0.01) {
          grid[idx] = packCell(Material.Steam, 40, randomShade());
        }
        continue;
      }

      // --- Seed: grows into tree on dirt ---
      if (mat === Material.Seed) {
        if (y + 1 < H) {
          const belowMat = grid[(y + 1) * W + x] & 0xff;
          if (belowMat === Material.Dirt || belowMat === Material.Grass) {
            if (Math.random() < 0.05) {
              this.growTree(x, y);
              continue;
            }
          }
        }
        continue;
      }

      // --- Grass: spreads on top of dirt ---
      if (mat === Material.Grass) {
        if (y + 1 < H && (grid[(y + 1) * W + x] & 0xff) === Material.Dirt) {
          // Spread sideways on dirt surface
          if (Math.random() < 0.02) {
            const dir = Math.random() < 0.5 ? -1 : 1;
            const nx = x + dir;
            if (nx >= 0 && nx < W) {
              if (y + 1 < H && (grid[(y + 1) * W + nx] & 0xff) === Material.Dirt && grid[y * W + nx] === 0) {
                grid[y * W + nx] = packCell(Material.Grass, 0, randomShade());
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
        const di = Math.floor(Math.random() * 8) * 2;
        const dx = NANOBOT_DIRS[di], dy = NANOBOT_DIRS[di + 1];
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (nMat === Material.Empty) {
            // Move into empty space
            grid[ni] = packCell(mat, lifetime, flags | FLAG_UPDATED);
            grid[idx] = 0;
          } else if (nMat !== Material.Nanobots && nMat !== Material.Wall &&
                     nMat !== Material.Antimatter) {
            // Eat through the material — slowly destroy it (5% chance per frame)
            if (Math.random() < 0.05) {
              grid[ni] = 0;
            }
          }
        }
        continue;
      }

      // --- Magic Powder: random color flicker, explodes on flesh, decays like fire ---
      if (mat === Material.MagicPowder) {
        // Random shade flicker each frame (independent per particle, no spatial pattern)
        if (Math.random() < 0.5) {
          const newShade = Math.floor(Math.random() * 4);
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
        if (hasFlesh && Math.random() < 0.3) {
          this.explode(x, y, 4);
          continue;
        }
        // Emit fireflies in a random direction (not always upward)
        if (Math.random() < 0.02) {
          const dx = Math.floor(Math.random() * 3) - 1;
          const dy = Math.floor(Math.random() * 3) - 1;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[ny * W + nx] === 0) {
            grid[ny * W + nx] = packCell(Material.Fireflies, 255, randomShade());
          }
        }
        continue;
      }

      // --- Popcorn: pops like fireworks near fire/lava/molten salt or high heat ---
      if (mat === Material.Popcorn) {
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
        if (hasHot && Math.random() < 0.3) {
          // Fireworks pop: radial impulse + scatter popcorn particles outward
          this.applyImpulse(x, y, 4, 60);
          // Scatter popcorn particles in random directions
          const POPCORN_DIRS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];
          for (let di = 0; di < 16; di += 2) {
            if (Math.random() < 0.6) {
              const nx = x + POPCORN_DIRS[di], ny = y + POPCORN_DIRS[di + 1];
              if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[ny * W + nx] === 0) {
                grid[ny * W + nx] = packCell(Material.Popcorn, 0, randomShade());
              }
            }
          }
          // The original kernel becomes popcorn (already is) — sometimes launches up
          if (Math.random() < 0.5 && y > 0 && grid[(y - 1) * W + x] === 0) {
            grid[(y - 1) * W + x] = packCell(Material.Popcorn, 0, randomShade());
          }
        }
        continue;
      }

      // --- Dynamite: detonated by fire or fuse ---
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
        if (hasFireOrFuse && Math.random() < 0.2) {
          this.explode(x, y, 6);
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
        if (fuseBurning && Math.random() < 0.3) {
          this.detonateC4(x, y);
        }
        continue;
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
        if (hasFire && Math.random() < 0.15) {
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
        if (hasFire && Math.random() < 0.3) {
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
        if (Math.random() < 0.5) {
          const newShade = Math.floor(Math.random() * 4);
          grid[idx] = packCell(mat, lifetime, (flags & ~SHADE_MASK) | newShade | FLAG_UPDATED);
        }

        // Flight: pure random walk in all 8 directions + occasional darts.
        // No gravity/buoyancy — they spread out evenly in all directions.
        if (Math.random() < 0.7) {
          let dx: number, dy: number;
          if (Math.random() < 0.2) {
            // Dart: 2-3 cell jump for organic burst movement
            dx = Math.floor(Math.random() * 7) - 3;
            dy = Math.floor(Math.random() * 7) - 3;
          } else {
            // Normal: 1-cell step in any of 8 directions (uniform)
            dx = Math.floor(Math.random() * 3) - 1;
            dy = Math.floor(Math.random() * 3) - 1;
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
    }
  }

  /**
   * Apply a radial impulse: immediately shoves particles outward from (cx, cy)
   * and sets per-cell wind fields for ongoing push. This pushes particles away
   * without destroying them. The wind decays each frame via decayWind().
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

    // --- Phase 2: Set wind fields for ongoing push ---
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius || dist < 0.5) continue;
        // Falloff: strongest at center, weaker at edge
        const falloff = 1 - dist / radius;
        const mag = strength * falloff;
        const ux = dx / dist, uy = dy / dist;
        const fi = (y * W + x) * 4;
        // Add to existing wind (clamped to i8 range), sign-extended for proper arithmetic
        const curWx = (fields[fi + FIELD.WIND_X] << 24) >> 24;
        const curWy = (fields[fi + FIELD.WIND_Y] << 24) >> 24;
        const newWx = Math.max(-127, Math.min(127, Math.round(curWx + ux * mag)));
        const newWy = Math.max(-127, Math.min(127, Math.round(curWy + uy * mag)));
        fields[fi + FIELD.WIND_X] = newWx & 0xff;
        fields[fi + FIELD.WIND_Y] = newWy & 0xff;
      }
    }
    // Mark that wind fields exist so decayWind doesn't skip the scan.
    this.hasWind = true;
  }

  /** Decay all wind fields toward 0 each frame so impulses fade over time. */
  private decayWind(): void {
    // Skip the full-grid scan entirely when no wind was set this frame or
    // all wind has already decayed to 0.
    if (!this.hasWind) return;
    const W = this.W, H = this.H;
    const fields = this.fields;
    const n = W * H * 4;
    let anyWind = false;
    for (let i = 0; i < n; i += 4) {
      if (fields[i + FIELD.WIND_X] !== 0) {
        const v = (fields[i + FIELD.WIND_X] << 24) >> 24;
        // Decay by ~25% per frame, minimum step of 1
        const dec = Math.abs(v) >= 4 ? Math.trunc(v * 0.75) : v > 0 ? v - 1 : v < 0 ? v + 1 : 0;
        fields[i + FIELD.WIND_X] = dec & 0xff;
        if (dec !== 0) anyWind = true;
      }
      if (fields[i + FIELD.WIND_Y] !== 0) {
        const v = (fields[i + FIELD.WIND_Y] << 24) >> 24;
        const dec = Math.abs(v) >= 4 ? Math.trunc(v * 0.75) : v > 0 ? v - 1 : v < 0 ? v + 1 : 0;
        fields[i + FIELD.WIND_Y] = dec & 0xff;
        if (dec !== 0) anyWind = true;
      }
    }
    // Clear the flag if all wind has decayed to 0 — next frame's scan is skipped.
    if (!anyWind) this.hasWind = false;
  }

  /** Create an explosion: fire + smoke in a radius */
  private explode(cx: number, cy: number, radius: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (dist > radius * radius) continue;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const mat = grid[y * W + x] & 0xff;
        if (mat === Material.Wall) continue;
        // Don't destroy C4 in the blast — let detonateC4 handle chain reactions
        if (mat === Material.C4) continue;
        if (dist < radius * radius * 0.3) {
          // Core: fire
          grid[y * W + x] = packCell(Material.Fire, 20, randomShade());
        } else {
          // Outer: smoke or empty
          if (Math.random() < 0.5) {
            grid[y * W + x] = packCell(Material.Smoke, 60, randomShade());
          } else {
            grid[y * W + x] = 0;
          }
        }
      }
    }
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

  /** Grow a tree from a seed at (x, y) on dirt */
  private growTree(x: number, y: number): void {
    const W = this.W, H = this.H;
    const grid = this.grid;
    // Remove seed, place root
    grid[y * W + x] = packCell(Material.Root, 0, randomShade());
    // Grow trunk upward
    const trunkHeight = 8 + Math.floor(Math.random() * 8);
    let topY = y;
    for (let i = 1; i <= trunkHeight; i++) {
      const ty = y - i;
      if (ty < 0) break;
      if (grid[ty * W + x] !== 0) break;
      grid[ty * W + x] = packCell(Material.TreeWood, 0, randomShade());
      topY = ty;
    }
    // Grow leaves canopy
    const canopyRadius = 3 + Math.floor(Math.random() * 2);
    for (let dy = -canopyRadius; dy <= 0; dy++) {
      for (let dx = -canopyRadius; dx <= canopyRadius; dx++) {
        const lx = x + dx, ly = topY + dy - canopyRadius;
        if (lx < 0 || lx >= W || ly < 0 || ly >= H) continue;
        const dist = dx * dx + dy * dy;
        if (dist > canopyRadius * canopyRadius) continue;
        if (grid[ly * W + lx] !== 0) continue;
        if (Math.random() < 0.7) {
          grid[ly * W + lx] = packCell(Material.Leaf, 0, randomShade());
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
      const srcMat = grid[idx] & 0xff;
      const x = idx % W;
      const y = (idx / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (!(MAT_FLAGS[nMat] & MAT_FLAMMABLE)) continue;
          if (nMat === Material.Gunpowder) {
            grid[ni] = packCell(Material.Fire, 15, randomShade());
            continue;
          }
          // Gas vapor and hydrogen: explosive
          if (nMat === Material.GasVapor || nMat === Material.Hydrogen) {
            grid[ni] = packCell(Material.Fire, 20, randomShade());
            this.explode(nx, ny, 3);
            continue;
          }
          // Flour: dust explosion
          if (nMat === Material.Flour) {
            this.explode(nx, ny, 3);
            continue;
          }
          // Dynamite: chain detonate
          if (nMat === Material.Dynamite) {
            this.explode(nx, ny, 6);
            continue;
          }
          const baseChance = srcMat === Material.Lava ? 0.1 : 0.08;
          // Rubber is hard to ignite — low continual burn/spread chance.
          // Oil is a slow-burning liquid fuel: low per-frame spread chance
          // so the flame creeps gradually across the surface rather than
          // flashing instantly. BurningOil→oil spread is handled by the
          // dedicated burning-oil pass below (with decay-linked chance),
          // so skip oil neighbors here when the source is BurningOil.
          if (srcMat === Material.BurningOil && nMat === Material.Oil) continue;
          // Oil needs air exposure to ignite — fire/lava touching buried oil
          // heats it but can't sustain a flame without oxygen.
          if (nMat === Material.Oil && !this.isExposed(nx, ny)) continue;
          const matMult =
            nMat === Material.Rubber ? 0.3 :
            nMat === Material.Oil ? 0.3 :
            1.0;
          // Per-cell temperature scales fire spread rate (inline field read)
          const nTemp = fields[ni * 4 + FIELD.TEMP] / 128;
          const chance = baseChance * nTemp * matMult;
          if (Math.random() < chance) {
            // Fuse gets FuseFire (yellow, stays put, deterministic spread)
            if (nMat === Material.Fuse) {
              grid[ni] = packCell(Material.FuseFire, 15, randomShade());
            } else if (nMat === Material.Oil) {
              // Oil → BurningOil (stays put, slow decay, slow spread)
              grid[ni] = packCell(Material.BurningOil, MAT_LIFETIME[Material.BurningOil], randomShade());
            } else {
              grid[ni] = packCell(Material.Fire, 30, randomShade());
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
      if (lifetime > FUSE_SPREAD_THRESHOLD || lifetime === 0) continue;
      const x = idx % W;
      const y = (idx / W) | 0;

      // Emit sparks: small fire particles that fly upward with random spread.
      // Sparks use Material.Fire (red) so they're visually distinct from the
      // yellow fuse fire and fly freely (FuseFire is anchored, Fire is not).
      for (let s = 0; s < 3; s++) {
        if (Math.random() < 0.5) {
          const sx = x + Math.floor(Math.random() * 3) - 1;
          const sy = y - 1 - Math.floor(Math.random() * 2); // 1-2 cells above
          if (sx >= 0 && sx < W && sy >= 0 && sy < H && grid[sy * W + sx] === 0) {
            // Sparks: very short lifetime, expire to empty (not smoke) so they
            // don't accumulate and suffocate the burn when going upward.
            grid[sy * W + sx] = packCell(Material.Fire, 6, randomShade() | FLAG_SPARK);
            // Give the spark upward wind + random horizontal drift
            const fi = (sy * W + sx) * 4;
            const driftX = Math.floor(Math.random() * 7) - 3; // -3 to 3
            fields[fi + FIELD.WIND_X] = driftX & 0xff;
            fields[fi + FIELD.WIND_Y] = (-30) & 0xff; // strong upward
            this.hasWind = true;
          }
        }
      }

      // Spread to adjacent fuse cells
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (visitedFrame[ni] === frame) continue;
          if ((grid[ni] & 0xff) === Material.Fuse) {
            grid[ni] = packCell(Material.FuseFire, FUSE_FIRE_LIFETIME, randomShade());
            visitedFrame[ni] = frame;
          }
        }
      }
    }

    // --- Burning oil pass ---
    // BurningOil stays put on the oil surface. Each frame it:
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

      // Emit fire particles upward: normal Fire (not sparks) that rise and
      // decay to smoke, giving visual flames above the burning oil surface.
      for (let s = 0; s < 2; s++) {
        if (Math.random() < 0.4) {
          const sx = x + Math.floor(Math.random() * 3) - 1;
          const sy = y - 1 - Math.floor(Math.random() * 2); // 1-2 cells above
          if (sx >= 0 && sx < W && sy >= 0 && sy < H && grid[sy * W + sx] === 0) {
            grid[sy * W + sx] = packCell(Material.Fire, 20, randomShade());
            // Give the flame upward wind + random horizontal drift
            const fi = (sy * W + sx) * 4;
            const driftX = Math.floor(Math.random() * 5) - 2; // -2 to 2
            fields[fi + FIELD.WIND_X] = driftX & 0xff;
            fields[fi + FIELD.WIND_Y] = (-20) & 0xff; // upward
            this.hasWind = true;
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
          const ni = ny * W + nx;
          if (visitedFrame[ni] === frame) continue;
          // Oil only ignites if it has air exposure (empty/gas neighbor) —
          // burning oil flowing into buried oil won't ignite it without oxygen.
          if ((grid[ni] & 0xff) === Material.Oil && this.isExposed(nx, ny) && Math.random() < spreadChance) {
            grid[ni] = packCell(Material.BurningOil, BURNING_OIL_LIFETIME, randomShade());
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

      if (lifetime > 0) {
        // Randomized decay: fire/smoke/steam sometimes skip a tick so
        // individual particles last variable amounts of time.
        if (mat === Material.Fire) {
          if (Math.random() < 0.7) lifetime--;
        } else if (mat === Material.FuseFire) {
          // FuseFire decays deterministically for consistent burn speed
          lifetime--;
        } else if (mat === Material.BurningOil) {
          // BurningOil decays very slowly so the fire sits on the oil surface
          // for a long time, giving it time to spread to neighbors gradually.
          if (Math.random() < 0.15) lifetime--;
        } else if (mat === Material.Smoke) {
          if (Math.random() < 0.8) lifetime--;
        } else if (mat === Material.Steam) {
          if (Math.random() < 0.75) lifetime--;
        } else if (mat === Material.MagicPowder) {
          if (Math.random() < 0.7) lifetime--;
        } else {
          lifetime--;
        }
        if (lifetime === 0) {
          if (mat === Material.Fire) {
            // Sparks expire to empty, not smoke. Sparks are marked with
            // FLAG_SPARK (bit 3) to distinguish them from regular fire.
            if (flags & FLAG_SPARK) {
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
            if (Math.random() < 0.7) {
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
          } else if (mat === Material.Hydrogen) {
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
