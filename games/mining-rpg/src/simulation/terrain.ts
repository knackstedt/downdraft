// ============================================================================
// Terrain generation — procedural depth-stratified world.
//
// Each chunk is generated deterministically from (cx, cy, seed):
//   - Surface band (cy=0): grass + dirt with noise-based height variation
//   - Stone body: solid stone with noise-based cavities (caves)
//   - Ore veins: depth-gated noise blobs within stone (tin, copper, iron, etc.)
//   - Underground lakes: carved cavities filled with water/oil/lava by depth
//   - Gas pockets: carved cavities filled with methane/sulfur gas (deep)
//
// All cells start frozen (wakeTick = 0). The simulation unfreezes cells when
// they are dug or disturbed.
// ============================================================================

import { Material, packCell } from "@downdraft/library-sand";
import { CHUNK_H, CHUNK_W } from "../shared/constants";
import type { Chunk } from "../shared/types";
import { cellHash, mulberry32, worldFbm, worldValueNoise } from "./noise";
import {
    CAVITY_CONFIG,
    LAKE_CONFIG,
    ORE_CONFIG,
    SURFACE_CONFIG,
    type LakeEntry,
    type OreEntry,
} from "./ore-config";

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/**
 * Compute the surface height (in world Y coords) at a given world X.
 * Uses fBm noise for gentle rolling hills.
 */
function surfaceHeightAt(wx: number, seed: number): number {
  const baseSurface = Math.floor(CHUNK_H * SURFACE_CONFIG.surfaceYRatio);
  const noise = worldFbm(
    wx,
    0,
    seed,
    SURFACE_CONFIG.noiseScale,
    3,
  );
  // noise is ~0-1, center it around 0 and scale by amplitude
  const variation = Math.floor((noise - 0.5) * 2 * SURFACE_CONFIG.noiseAmplitude);
  return baseSurface + variation;
}

/**
 * Check if a world cell should be part of an ore vein.
 * Returns the ore material if yes, 0 otherwise.
 */
function oreAt(wx: number, wy: number, cy: number, seed: number): number {
  for (const ore of ORE_CONFIG) {
    if (cy < ore.minChunkY || cy > ore.maxChunkY) continue;

    const noise = worldFbm(wx, wy, seed, ore.noiseScale, ore.octaves);
    if (noise < ore.noiseThreshold) continue;

    // Additional rarity check using cell hash
    const hash = cellHash(
      Math.floor(wx / CHUNK_W),
      Math.floor(wy / CHUNK_H),
      wx % CHUNK_W,
      wy % CHUNK_H,
      seed + ore.material,
    );
    if (hash < ore.rarity) {
      return ore.material;
    }
  }
  return 0;
}

/**
 * Check if a world cell is inside a cavity (cave).
 * Cavities are empty pockets in the stone body, shaped by noise.
 */
function isCavity(wx: number, wy: number, cy: number, seed: number): boolean {
  if (cy < CAVITY_CONFIG.minChunkY || cy > CAVITY_CONFIG.maxChunkY) return false;
  const noise = worldFbm(wx, wy, seed, CAVITY_CONFIG.noiseScale, CAVITY_CONFIG.octaves);
  return noise > CAVITY_CONFIG.noiseThreshold;
}

/**
 * Check if a world cell is the center of a lake/gas pocket.
 * Lake centers are sparse — determined by a low-probability hash check.
 * If this cell is a lake center, the lake is carved as a blob around it.
 */
function lakeCenterAt(
  wx: number,
  wy: number,
  cy: number,
  seed: number,
): LakeEntry | null {
  for (const lake of LAKE_CONFIG) {
    if (cy < lake.minChunkY || cy > lake.maxChunkY) continue;

    // Check noise threshold for lake region
    const noise = worldFbm(wx, wy, seed, lake.noiseScale, lake.octaves);
    if (noise < lake.noiseThreshold) continue;

    // Sparse center check
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
 * Carve a circular lake/pocket around a center point.
 * Fills cells within the radius with the lake material (overwriting stone).
 * Does not overwrite existing non-stone cells (preserves ores/cavities at edges).
 */
function carveLake(
  grid: Uint32Array,
  cx: number,
  cy: number,
  centerX: number,
  centerY: number,
  radius: number,
  material: number,
  seed: number,
  shade: () => number,
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, centerX - radius);
  const x1 = Math.min(CHUNK_W - 1, centerX + radius);
  const y0 = Math.max(0, centerY - radius);
  const y1 = Math.min(CHUNK_H - 1, centerY + radius);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      // Use noise to make the lake blob irregular
      const distNoise = worldValueNoise(
        cx * CHUNK_W + x,
        cy * CHUNK_H + y,
        seed + material * 31,
        0.15,
      );
      const effectiveR2 = r2 * (0.7 + distNoise * 0.6);
      if (dx * dx + dy * dy <= effectiveR2) {
        const idx = y * CHUNK_W + x;
        const existing = grid[idx] & 0xff;
        // Only carve into stone (don't overwrite ores or existing liquids)
        if (existing === Material.Stone || existing === Material.Dirt) {
          grid[idx] = packCell(material, 0, shade());
        }
      }
    }
  }
}

/**
 * Generate a chunk's grid + fields.
 *
 * Generation order:
 *   1. Fill with stone (underground) or sky+grass+dirt (surface)
 *   2. Carve cavities (caves) — set to empty
 *   3. Place ore veins (overwrite stone with ore material)
 *   4. Carve lakes/gas pockets (overwrite stone with liquid/gas)
 *
 * All cells start frozen (wakeTick = 0).
 */
export function generateChunk(cx: number, cy: number, seed: number): Chunk {
  const cells = CHUNK_W * CHUNK_H;
  const grid = new Uint32Array(cells);
  const fields = new Uint8Array(cells * 4);
  const wakeTick = new Uint32Array(cells); // all frozen

  // Initialize fields to defaults (gravity=128, temp=128)
  for (let i = 0; i < cells * 4; i += 4) {
    fields[i + 0] = 128; // gravity
    fields[i + 1] = 128; // temp
  }

  // Use a per-chunk PRNG for shade randomization (deterministic)
  const rng = mulberry32(cx * 73856093 + cy * 19349663 + seed);
  const shade = () => Math.floor(rng() * 4);

  // --- Step 1: Base terrain (sky / grass / dirt / stone) ---
  if (cy < 0) {
    // Above-surface chunks: empty sky
    // grid is already zero-filled
  } else if (cy === 0) {
    // Surface chunk: sky → grass → dirt → stone
    for (let x = 0; x < CHUNK_W; x++) {
      const wx = cx * CHUNK_W + x;
      const surfaceY = surfaceHeightAt(wx, seed);
      for (let y = 0; y < CHUNK_H; y++) {
        const idx = y * CHUNK_W + x;
        if (y < surfaceY) {
          // Sky (empty)
          grid[idx] = 0;
        } else if (y < surfaceY + SURFACE_CONFIG.grassDepth) {
          // Grass layer
          grid[idx] = packCell(Material.Grass, 0, shade());
        } else if (y < surfaceY + SURFACE_CONFIG.grassDepth + SURFACE_CONFIG.dirtDepth) {
          // Dirt layer
          grid[idx] = packCell(Material.Dirt, 0, shade());
        } else {
          // Stone
          grid[idx] = packCell(Material.Stone, 0, shade());
        }
      }
    }
  } else {
    // Underground chunks: solid stone
    for (let i = 0; i < cells; i++) {
      grid[i] = packCell(Material.Stone, 0, shade());
    }
  }

  // --- Step 2: Carve cavities (caves) ---
  if (cy >= CAVITY_CONFIG.minChunkY) {
    for (let y = 0; y < CHUNK_H; y++) {
      for (let x = 0; x < CHUNK_W; x++) {
        const wx = cx * CHUNK_W + x;
        const wy = cy * CHUNK_H + y;
        const idx = y * CHUNK_W + x;
        // Don't carve cavities in the sky or grass/dirt layers
        const mat = grid[idx] & 0xff;
        if (mat !== Material.Stone) continue;
        if (isCavity(wx, wy, cy, seed)) {
          grid[idx] = 0; // empty cave
        }
      }
    }
  }

  // --- Step 3: Place ore veins ---
  if (cy >= 0) {
    for (let y = 0; y < CHUNK_H; y++) {
      for (let x = 0; x < CHUNK_W; x++) {
        const idx = y * CHUNK_W + x;
        const mat = grid[idx] & 0xff;
        // Only place ores in stone (not in cavities, dirt, or existing ores)
        if (mat !== Material.Stone) continue;

        const wx = cx * CHUNK_W + x;
        const wy = cy * CHUNK_H + y;
        const oreMat = oreAt(wx, wy, cy, seed);
        if (oreMat !== 0) {
          grid[idx] = packCell(oreMat, 0, shade());
        }
      }
    }
  }

  // --- Step 4: Carve lakes / gas pockets ---
  if (cy >= 0) {
    for (let y = 0; y < CHUNK_H; y++) {
      for (let x = 0; x < CHUNK_W; x++) {
        const wx = cx * CHUNK_W + x;
        const wy = cy * CHUNK_H + y;
        const lake = lakeCenterAt(wx, wy, cy, seed);
        if (lake) {
          // Determine lake radius (deterministic from position)
          const sizeHash = cellHash(cx, cy, x, y, seed + lake.material + 9999);
          const radius = lake.minSize + sizeHash * (lake.maxSize - lake.minSize);
          carveLake(grid, cx, cy, x, y, Math.floor(radius), lake.material, seed, shade);
        }
      }
    }
  }

  return {
    cx,
    cy,
    grid,
    fields,
    wakeTick,
    generated: true,
    dirty: false,
    active: false,
  };
}

export { chunkKey };

// --- Exported helpers for testing ---

    export { isCavity, lakeCenterAt, oreAt, surfaceHeightAt };
    export type { LakeEntry, OreEntry };

