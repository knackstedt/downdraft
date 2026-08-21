// ============================================================================
// Backdrop worker — generates a low-res parallax background grid.
//
// Each backdrop chunk is half the foreground resolution (CHUNK_W/2 ×
// CHUNK_H/2) but covers the same world area as a foreground chunk. The
// worker generates a backdrop that loosely follows the real cave + lake
// generation:
//   - Caves: same worldFbm noise field as terrain.ts isCavity, with a seed
//     offset + slightly lower threshold so backdrop caves are similar but
//     not a 1:1 copy (parallax slice of the same cave system).
//   - Lakes: same LAKE_CONFIG noise + sparse hash, sampled at half-res, so
//     water/oil/lava lakes appear in the same areas (lava glows through
//     parallax).
//   - Solid walls: fBm + speckle cave-wall texture (existing aesthetic).
//
// The grid's alpha byte encodes cell type (BACKDROP_CELL_TYPE) so the
// fragment shader can apply per-type lighting. Ticks are disabled — each
// chunk is generated once and never simulated.
//
// The worker exposes:
//   init(sab) — allocate the backdrop SAB and prepare generation
//   setWindow(originCx, originCy) — set the active window and generate/load
//     all chunks in the window, writing the grid to the SAB
//   shutdown() — stop the worker
// ============================================================================

import { expose } from "@downdraft/core/worker/rpc";
import { Material } from "@downdraft/library-sand";
import {
    BACKDROP_CAVE_SEED_OFFSET,
    BACKDROP_CAVE_THRESHOLD_DELTA,
    BACKDROP_CELL_TYPE,
    BACKDROP_CHUNK_H,
    BACKDROP_CHUNK_W,
    BACKDROP_GRID_CELLS,
    BACKDROP_GRID_OFFSET,
    BACKDROP_GRID_W,
    BACKDROP_STATS_BYTES,
    BACKDROP_STATS_OFFSET,
    CHUNK_H,
    CHUNK_W,
    WORLD_SEED,
} from "../shared/constants";
import { cellHash, mulberry32, worldFbm, worldValueNoise } from "./noise";
import {
    CAVITY_CONFIG,
    LAKE_CONFIG,
    SURFACE_CONFIG,
    type LakeEntry,
} from "./ore-config";

// --- Backdrop chunk storage ---
// Each backdrop chunk stores packed RGBA colors (Uint32) per cell.
// The alpha byte encodes cell type (BACKDROP_CELL_TYPE). Keyed by "cx,cy".
interface BackdropChunk {
  cx: number;
  cy: number;
  grid: Uint32Array; // BACKDROP_CHUNK_W * BACKDROP_CHUNK_H packed RGBA cells
  generated: boolean;
}

const chunks = new Map<string, BackdropChunk>();

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

// --- Packing helpers ---

function packRGBA(r: number, g: number, b: number, a: number = 255): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

/** Unpack the cell-type alpha from a packed grid cell. */
export function backdropCellType(packed: number): number {
  return (packed >>> 24) & 0xff;
}

// --- Lake color palette (matches MATERIALS colors in physics-sand) ---

function packLakeCell(material: number): number {
  switch (material) {
    case Material.Water:
      // [0.12, 0.42, 0.85] * 255
      return packRGBA(31, 107, 217, BACKDROP_CELL_TYPE.WATER);
    case Material.Oil:
      // [0.15, 0.12, 0.08] * 255
      return packRGBA(38, 31, 20, BACKDROP_CELL_TYPE.OIL);
    case Material.Lava:
      // [0.9, 0.25, 0.05] * 255 — brightened for visibility
      return packRGBA(230, 64, 13, BACKDROP_CELL_TYPE.LAVA);
    case Material.MethaneGas:
      // Gas is invisible-ish — subtle green tint, treated as cave void
      return packRGBA(20, 40, 20, BACKDROP_CELL_TYPE.CAVE);
    case Material.SulfurGas:
      // Gas — subtle yellow tint, treated as cave void
      return packRGBA(40, 35, 15, BACKDROP_CELL_TYPE.CAVE);
    default:
      return packRGBA(0, 0, 0, BACKDROP_CELL_TYPE.CAVE);
  }
}

// --- Cave + lake detection (loosely follows terrain.ts) ---
//
// These reimplement the foreground isCavity / lakeCenterAt logic using the
// same noise fields + config so backdrop caves/lakes are in the same areas.
// The backdrop uses a seed offset + lower threshold for caves (loose match).
// The worker does NOT import terrain.ts — it stays self-contained.

/**
 * Check if a foreground world cell is inside a backdrop cavity (cave).
 * Same noise field as terrain.ts isCavity, with a seed offset + lower
 * threshold so backdrop caves are similar but slightly wider/different.
 */
export function isBackdropCavity(wx: number, wy: number, cy: number, seed: number): boolean {
  if (cy < CAVITY_CONFIG.minChunkY || cy > CAVITY_CONFIG.maxChunkY) return false;
  const noise = worldFbm(
    wx,
    wy,
    seed + BACKDROP_CAVE_SEED_OFFSET,
    CAVITY_CONFIG.noiseScale,
    CAVITY_CONFIG.octaves,
  );
  return noise > CAVITY_CONFIG.noiseThreshold + BACKDROP_CAVE_THRESHOLD_DELTA;
}

/**
 * Check if a foreground world cell is the center of a lake/gas pocket.
 * Same logic as terrain.ts lakeCenterAt (same noise + sparse hash + depth
 * gating). Sampled at half-res by the backdrop, so some centers are missed
 * — acceptable for a decorative parallax layer.
 */
export function backdropLakeAt(wx: number, wy: number, cy: number, seed: number): LakeEntry | null {
  for (const lake of LAKE_CONFIG) {
    if (cy < lake.minChunkY || cy > lake.maxChunkY) continue;
    const noise = worldFbm(wx, wy, seed, lake.noiseScale, lake.octaves);
    if (noise < lake.noiseThreshold) continue;
    const hash = cellHash(
      Math.floor(wx / CHUNK_W),
      Math.floor(wy / CHUNK_H),
      wx % CHUNK_W,
      wy % CHUNK_H,
      seed + lake.material + 7777,
    );
    if (hash < lake.fillChance) {
      return lake;
    }
  }
  return null;
}

/**
 * Compute the surface height (in foreground world Y coords) at a given
 * foreground world X. Reimplemented from terrain.ts surfaceHeightAt using
 * the same SURFACE_CONFIG so the backdrop surface band aligns with the
 * foreground surface.
 */
export function backdropSurfaceHeightAt(wx: number, seed: number): number {
  const baseSurface = Math.floor(CHUNK_H * SURFACE_CONFIG.surfaceYRatio);
  const noise = worldFbm(wx, 0, seed, SURFACE_CONFIG.noiseScale, 3);
  const variation = Math.floor((noise - 0.5) * 2 * SURFACE_CONFIG.noiseAmplitude);
  return baseSurface + variation;
}

/**
 * Carve a lake blob into the backdrop grid around a foreground world center
 * point. Full-res (1 backdrop cell = 1 foreground cell), so the radius and
 * coords are used directly. Only overwrites cave/solid cells — existing lakes
 * (especially lava) are preserved. Depth gating prevents lakes from spilling
 * across depth boundaries (same as terrain.ts carveLake).
 */
function carveBackdropLake(
  grid: Uint32Array,
  chunkCx: number,
  chunkCy: number,
  centerWX: number,
  centerWY: number,
  fgRadius: number,
  material: number,
  minChunkY: number,
  maxChunkY: number,
  seed: number,
): void {
  const r = Math.max(1, Math.floor(fgRadius));
  const r2 = r * r;
  const chunkWorldX = chunkCx * CHUNK_W;
  const chunkWorldY = chunkCy * CHUNK_H;
  // Center in backdrop-local coords (1 backdrop cell = 1 foreground cell)
  const lcx = centerWX - chunkWorldX;
  const lcy = centerWY - chunkWorldY;
  const x0 = Math.max(0, Math.floor(lcx - r));
  const x1 = Math.min(BACKDROP_CHUNK_W - 1, Math.ceil(lcx + r));
  const y0 = Math.max(0, Math.floor(lcy - r));
  const y1 = Math.min(BACKDROP_CHUNK_H - 1, Math.ceil(lcy + r));

  for (let y = y0; y <= y1; y++) {
    const cellWY = chunkWorldY + y;
    // Depth gate: skip cells outside the lake's valid chunk-Y range
    const cellCY = Math.floor(cellWY / CHUNK_H);
    if (cellCY < minChunkY || cellCY > maxChunkY) continue;
    for (let x = x0; x <= x1; x++) {
      const dx = x - lcx;
      const dy = y - lcy;
      // Noise for irregular shape (world coords → deterministic across
      // chunk boundaries, same as terrain.ts carveLake)
      const cellWX = chunkWorldX + x;
      const distNoise = worldValueNoise(cellWX, cellWY, seed + material * 31, 0.15);
      const effectiveR2 = r2 * (0.7 + distNoise * 0.6);
      if (dx * dx + dy * dy <= effectiveR2) {
        const idx = y * BACKDROP_CHUNK_W + x;
        // Don't overwrite existing lava lakes (lava is deepest, preserve it)
        const existingAlpha = (grid[idx] >>> 24) & 0xff;
        if (existingAlpha === BACKDROP_CELL_TYPE.LAVA) continue;
        grid[idx] = packLakeCell(material);
      }
    }
  }
}

// --- Solid cave-wall texture (existing aesthetic, alpha now = SOLID) ---

// Foreground DEFAULT_SHADES for Stone (from palette.ts) — same 4 discrete
// shade variants the foreground uses. The backdrop assigns one per cell using
// a per-cell hash (deterministic, matches the foreground's random shade
// assignment pattern).
const BACKDROP_SHADES = [0.82, 0.91, 1.0, 1.08];

/**
 * Generate the solid cave-wall texture color for a backdrop cell.
 * Uses the EXACT foreground Stone color [0.45, 0.45, 0.48] = (115, 115, 122)
 * with the same 4 discrete shade variants as the foreground DEFAULT_SHADES
 * [0.82, 0.91, 1.0, 1.08]. The shade is assigned per-cell using a deterministic
 * hash (same pattern as the foreground's `Math.floor(rng() * 4)`).
 * Packed with alpha = BACKDROP_CELL_TYPE.SOLID.
 */
function solidWallColor(
  wx: number,
  wy: number,
  cx: number,
  cy: number,
  seed: number,
  _speckleRng: () => number,
): number {
  // Foreground Stone: [0.45, 0.45, 0.48] = (115, 115, 122) — use exactly.
  const baseR = 115;
  const baseG = 115;
  const baseB = 122;

  // Assign one of 4 discrete shade variants per cell — same as the foreground.
  // Use a per-cell hash with chunk + local coords (deterministic, stable).
  const lx = wx - cx * CHUNK_W;
  const ly = wy - cy * CHUNK_H;
  const shadeIdx = Math.floor(cellHash(cx, cy, lx, ly, seed) * 4);
  const brightness = BACKDROP_SHADES[shadeIdx];

  const r = Math.min(255, Math.round(baseR * brightness));
  const g = Math.min(255, Math.round(baseG * brightness));
  const b = Math.min(255, Math.round(baseB * brightness));

  return packRGBA(r, g, b, BACKDROP_CELL_TYPE.SOLID);
}

/**
 * Generate a backdrop chunk that loosely follows the foreground cave + lake
 * generation:
 *   1. Fill with solid cave-wall texture (alpha = SOLID)
 *   2. Surface band (cy=0): cells above surface → sky/void (alpha = CAVE)
 *   3. Above-surface chunks (cy<0): all sky/void (alpha = CAVE)
 *   4. Carve caves using isBackdropCavity (alpha = CAVE, dark RGB)
 *   5. Carve lakes using backdropLakeAt + carveBackdropLake (water/oil/lava)
 */
export function generateBackdropChunk(cx: number, cy: number, seed: number): BackdropChunk {
  const grid = new Uint32Array(BACKDROP_CHUNK_W * BACKDROP_CHUNK_H);
  const chunk: BackdropChunk = { cx, cy, grid, generated: true };

  // Per-chunk seed for speckle variation
  const speckleRng = mulberry32(cx * 73856 + cy * 19349 + seed);

  // --- Step 1: Fill with solid cave-wall texture ---
  for (let ly = 0; ly < BACKDROP_CHUNK_H; ly++) {
    for (let lx = 0; lx < BACKDROP_CHUNK_W; lx++) {
      // Full-res: 1 backdrop cell = 1 foreground cell
      const wx = cx * CHUNK_W + lx;
      const wy = cy * CHUNK_H + ly;
      grid[ly * BACKDROP_CHUNK_W + lx] = solidWallColor(wx, wy, cx, cy, seed, speckleRng);
    }
  }

  // --- Step 2: Surface band (cy=0) → sky above surface ---
  if (cy === 0) {
    for (let lx = 0; lx < BACKDROP_CHUNK_W; lx++) {
      const wx = cx * CHUNK_W + lx;
      const surfaceY = backdropSurfaceHeightAt(wx, seed);
      for (let ly = 0; ly < BACKDROP_CHUNK_H; ly++) {
        if (ly < surfaceY) {
          // Sky (void) — dark, lit by ambient in shader
          grid[ly * BACKDROP_CHUNK_W + lx] = packRGBA(5, 5, 8, BACKDROP_CELL_TYPE.CAVE);
        }
      }
    }
  }

  // --- Step 3: Above-surface chunks (cy<0) → all sky/void ---
  if (cy < 0) {
    grid.fill(packRGBA(5, 5, 8, BACKDROP_CELL_TYPE.CAVE));
    return chunk;
  }

  // --- Step 4: Carve caves (loosely follows terrain.ts isCavity) ---
  for (let ly = 0; ly < BACKDROP_CHUNK_H; ly++) {
    for (let lx = 0; lx < BACKDROP_CHUNK_W; lx++) {
      const wx = cx * CHUNK_W + lx;
      const wy = cy * CHUNK_H + ly;
      if (isBackdropCavity(wx, wy, cy, seed)) {
        const idx = ly * BACKDROP_CHUNK_W + lx;
        // Don't carve into sky (already CAVE from step 2)
        const existingAlpha = (grid[idx] >>> 24) & 0xff;
        if (existingAlpha === BACKDROP_CELL_TYPE.CAVE) continue;
        // Cave void — dark, lit by diffused volumetric light in shader
        grid[idx] = packRGBA(5, 5, 8, BACKDROP_CELL_TYPE.CAVE);
      }
    }
  }

  // --- Step 5: Carve lakes / gas pockets (loosely follows terrain.ts) ---
  // Iterate candidate lake centers in a neighborhood extending by the max
  // lake radius beyond the chunk borders. Full-res: step by 1. Each center
  // carves only the cells that fall within THIS backdrop chunk.
  const maxLakeRadius = LAKE_CONFIG.reduce((m, l) => Math.max(m, l.maxSize), 0);
  const chunkWorldX = cx * CHUNK_W;
  const chunkWorldY = cy * CHUNK_H;
  const startWX = chunkWorldX - maxLakeRadius;
  const endWX = chunkWorldX + CHUNK_W + maxLakeRadius;
  const startWY = chunkWorldY - maxLakeRadius;
  const endWY = chunkWorldY + CHUNK_H + maxLakeRadius;
  for (let wy = startWY; wy < endWY; wy++) {
    for (let wx = startWX; wx < endWX; wx++) {
      // Use the center cell's own chunk Y for the depth-range check
      const centerCy = Math.floor(wy / CHUNK_H);
      const lake = backdropLakeAt(wx, wy, centerCy, seed);
      if (!lake) continue;
      // Determine lake radius (deterministic from the center's chunk + local
      // coords — same as terrain.ts)
      const centerCx = Math.floor(wx / CHUNK_W);
      const centerLx = wx - centerCx * CHUNK_W;
      const centerLy = wy - centerCy * CHUNK_H;
      const sizeHash = cellHash(centerCx, centerCy, centerLx, centerLy, seed + lake.material + 9999);
      const radius = lake.minSize + sizeHash * (lake.maxSize - lake.minSize);
      carveBackdropLake(
        grid, cx, cy, wx, wy, Math.floor(radius),
        lake.material, lake.minChunkY, lake.maxChunkY, seed,
      );
    }
  }

  return chunk;
}

function ensureChunk(cx: number, cy: number, seed: number): BackdropChunk {
  const key = chunkKey(cx, cy);
  let chunk = chunks.get(key);
  if (!chunk || !chunk.generated) {
    chunk = generateBackdropChunk(cx, cy, seed);
    chunks.set(key, chunk);
  }
  return chunk;
}

// --- SAB writing ---

let sabRef: SharedArrayBuffer | null = null;
let gridU32: Uint32Array | null = null;
let statsI32: Int32Array | null = null;
let running = false;

const ACTIVE_RADIUS = 2; // matches ACTIVE_RADIUS_CHUNKS
const WINDOW_CHUNKS = 2 * ACTIVE_RADIUS + 1; // 5

function writeWindowToSAB(originCx: number, originCy: number, seed: number): void {
  if (!gridU32 || !statsI32) return;

  // Clear the grid
  gridU32.fill(0, BACKDROP_GRID_OFFSET / 4, BACKDROP_GRID_OFFSET / 4 + BACKDROP_GRID_CELLS);

  // Copy each chunk in the window into the active grid
  for (let dcy = 0; dcy < WINDOW_CHUNKS; dcy++) {
    for (let dcx = 0; dcx < WINDOW_CHUNKS; dcx++) {
      const cx = originCx + dcx;
      const cy = originCy + dcy;
      const chunk = ensureChunk(cx, cy, seed);

      const dstX = dcx * BACKDROP_CHUNK_W;
      const dstY = dcy * BACKDROP_CHUNK_H;

      for (let ly = 0; ly < BACKDROP_CHUNK_H; ly++) {
        const srcStart = ly * BACKDROP_CHUNK_W;
        const dstStart = ((dstY + ly) * BACKDROP_GRID_W + dstX) | 0;
        gridU32.set(
          chunk.grid.subarray(srcStart, srcStart + BACKDROP_CHUNK_W),
          (BACKDROP_GRID_OFFSET / 4) + dstStart,
        );
      }
    }
  }

  // Write origin stats (backdrop cell coords = originCx * BACKDROP_CHUNK_W).
  // With parallax=1.0, the backdrop aligns 1:1 with the foreground — the
  // origin is the backdrop cell position of the grid start, which is the
  // foreground chunk origin in half-res coords.
  statsI32[0] = originCx * BACKDROP_CHUNK_W;
  statsI32[1] = originCy * BACKDROP_CHUNK_H;
  // Atomically increment the version counter AFTER writing grid + origin.
  // The renderer uses a double-check pattern (read version before and after
  // reading the grid) to avoid uploading a partially-written grid (flashing).
  Atomics.add(statsI32, 2, 1);
}

expose({
  async init(sab: SharedArrayBuffer): Promise<void> {
    sabRef = sab;
    gridU32 = new Uint32Array(sab);
    statsI32 = new Int32Array(sab, BACKDROP_STATS_OFFSET, BACKDROP_STATS_BYTES / 4);
    running = true;
  },

  setWindow(originCx: number, originCy: number): void {
    if (!running) return;
    writeWindowToSAB(originCx, originCy, WORLD_SEED);
  },

  shutdown(): void {
    running = false;
    chunks.clear();
  },
});
