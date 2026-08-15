// ============================================================================
// Terrain generation — Phase 1 stub (flat stone/dirt).
// Full procedural generation with ores, lakes, and gases comes in Phase 2.
// ============================================================================

import { Material, packCell, randomShade } from "@downdraft/library-sand";
import { CHUNK_H, CHUNK_W } from "../shared/constants";
import type { Chunk } from "../shared/types";

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/**
 * Generate a chunk's grid + fields.
 * Phase 1: flat terrain — surface grass/dirt on cy=0, stone below.
 * All cells start frozen (wakeTick = 0).
 */
export function generateChunk(cx: number, cy: number, _seed: number): Chunk {
  const cells = CHUNK_W * CHUNK_H;
  const grid = new Uint32Array(cells);
  const fields = new Uint8Array(cells * 4);
  const wakeTick = new Uint32Array(cells); // all frozen

  // Initialize fields to defaults (gravity=128, temp=128)
  for (let i = 0; i < cells * 4; i += 4) {
    fields[i + 0] = 128; // gravity
    fields[i + 1] = 128; // temp
  }

  if (cy === 0) {
    // Surface chunk: top rows are empty (sky), then grass, then dirt
    const surfaceY = Math.floor(CHUNK_H * 0.3); // surface at ~30% down
    for (let x = 0; x < CHUNK_W; x++) {
      for (let y = 0; y < CHUNK_H; y++) {
        const idx = y * CHUNK_W + x;
        if (y < surfaceY) {
          // Sky (empty)
          grid[idx] = 0;
        } else if (y === surfaceY) {
          // Grass layer
          grid[idx] = packCell(Material.Grass, 0, randomShade());
        } else if (y < surfaceY + 5) {
          // Dirt layer
          grid[idx] = packCell(Material.Dirt, 0, randomShade());
        } else {
          // Stone
          grid[idx] = packCell(Material.Stone, 0, randomShade());
        }
      }
    }
  } else if (cy < 0) {
    // Above-surface chunks: empty sky (all zeros)
    // grid is already zero-filled from Uint32Array constructor
  } else {
    // Underground chunks: solid stone (Phase 1 stub)
    for (let i = 0; i < cells; i++) {
      grid[i] = packCell(Material.Stone, 0, randomShade());
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
