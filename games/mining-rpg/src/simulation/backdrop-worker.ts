// ============================================================================
// Backdrop worker — generates a low-res parallax background grid.
//
// Each backdrop chunk is half the foreground resolution (CHUNK_W/2 ×
// CHUNK_H/2). The worker generates a "loosely random" procedural cave-wall
// texture using fBm noise + random speckle. Ticks are disabled — each chunk
// is generated once and never simulated.
//
// The worker exposes:
//   init(sab) — allocate the backdrop SAB and prepare generation
//   setWindow(originCx, originCy) — set the active window and generate/load
//     all chunks in the window, writing the grid to the SAB
//   shutdown() — stop the worker
// ============================================================================

import { expose } from "@downdraft/core/worker/rpc";
import {
    BACKDROP_CHUNK_H,
    BACKDROP_CHUNK_W,
    BACKDROP_GRID_CELLS,
    BACKDROP_GRID_OFFSET,
    BACKDROP_GRID_W,
    BACKDROP_STATS_BYTES,
    BACKDROP_STATS_OFFSET,
    WORLD_SEED
} from "../shared/constants";
import { fbm2D, mulberry32 } from "./noise";

// --- Backdrop chunk storage ---
// Each backdrop chunk stores packed RGBA colors (Uint32) per cell.
// Keyed by "cx,cy" string.
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

// --- Backdrop color palette ---
// The backdrop is a dark cave-wall texture with subtle color variation by depth.
// We use a base color that darkens slightly with depth, plus noise-based
// brightness variation and random speckle for texture.

function packRGBA(r: number, g: number, b: number, a: number = 255): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

/**
 * Generate a backdrop chunk. The texture is a dark cave-wall with:
 * - Base color that shifts from brownish (shallow) to dark blue-gray (deep)
 * - fBm noise for large-scale brightness variation (rock formations)
 * - Fine-grained speckle for texture detail
 * - Occasional brighter veins (mineral deposits visible in the wall)
 */
function generateBackdropChunk(cx: number, cy: number, seed: number): BackdropChunk {
  const grid = new Uint32Array(BACKDROP_CHUNK_W * BACKDROP_CHUNK_H);
  const chunk: BackdropChunk = { cx, cy, grid, generated: true };

  // Depth-based color shift: shallow = warm brown, deep = cold dark blue-gray
  const depth = cy; // chunk Y is a rough depth indicator
  const warmth = Math.max(0, 1 - depth / 20); // 1 at surface, 0 at depth 20+
  const baseR = Math.round(40 + warmth * 25); // 40-65
  const baseG = Math.round(35 + warmth * 15); // 35-50
  const baseB = Math.round(40 - warmth * 5 + (1 - warmth) * 15); // 35-55

  // Per-chunk seed for speckle variation
  const speckleRng = mulberry32(cx * 73856 + cy * 19349 + seed);

  for (let ly = 0; ly < BACKDROP_CHUNK_H; ly++) {
    for (let lx = 0; lx < BACKDROP_CHUNK_W; lx++) {
      const wx = cx * BACKDROP_CHUNK_W + lx;
      const wy = cy * BACKDROP_CHUNK_H + ly;

      // Large-scale noise (rock formations) — low frequency
      const largeNoise = fbm2D(wx * 0.03, wy * 0.03, seed, 3, 2.0, 0.5);
      // Medium-scale noise (cracks/veins) — medium frequency
      const medNoise = fbm2D(wx * 0.08, wy * 0.08, seed + 1000, 2, 2.0, 0.5);
      // Fine speckle
      const speckle = speckleRng();

      // Brightness modulation: base ± noise
      let brightness = 0.7 + largeNoise * 0.5 + medNoise * 0.2;
      // Add speckle: dark pits and bright spots
      if (speckle < 0.15) {
        brightness *= 0.5; // dark pit
      } else if (speckle > 0.92) {
        brightness *= 1.3; // bright speck (mineral fleck)
      }
      brightness = Math.max(0.2, Math.min(1.3, brightness));

      // Occasional mineral veins (brighter lines following medium noise)
      const vein = Math.abs(medNoise - 0.5);
      let veinBoost = 0;
      if (vein < 0.03) {
        veinBoost = 30; // bright vein
      }

      const r = Math.min(255, Math.round(baseR * brightness + veinBoost));
      const g = Math.min(255, Math.round(baseG * brightness + veinBoost * 0.8));
      const b = Math.min(255, Math.round(baseB * brightness + veinBoost * 0.5));

      grid[ly * BACKDROP_CHUNK_W + lx] = packRGBA(r, g, b, 255);
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

  // Write origin stats
  statsI32[0] = originCx * BACKDROP_CHUNK_W;
  statsI32[1] = originCy * BACKDROP_CHUNK_H;
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
