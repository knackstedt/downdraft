// ============================================================================
// Overburden — light propagation simulation
//
// Computes per-cell light levels (0-15) each tick:
// - Daylight enters from the top and propagates down through open air
// - Light-emitting blocks (torches, lava) are sources
// - Light spreads to ALL adjacent cells (including solid blocks) with
//   attenuation: air→air = -1, air→solid = -2 (solid blocks absorb more)
// - This means surface blocks ARE illuminated by daylight from above
//
// Uses a BFS/flood-fill approach with a priority queue (higher light first).
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_CELLS, ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR,
} from "../shared/constants";
import { getBlockFromPacked } from "./fluid-sim";

// Light queue for BFS propagation (stores cell index + light level)
const lightQueue = new Int32Array(ACTIVE_GRID_CELLS * 2);
let queueHead = 0;
let queueTail = 0;

/** Check if a block is opaque (fully blocks light from passing THROUGH). */
function isOpaque(packedBlockId: number): boolean {
  const blockId = getBlockFromPacked(packedBlockId);
  if (blockId === BLOCK_AIR) return false;
  const def = getBlockDef(blockId);
  if (!def) return true;
  // Liquids attenuate but don't fully block
  if (def.category === "liquid") return false;
  // Solid + special blocks are opaque
  return def.category === "solid" || def.category === "special";
}

/** Get light emission from a block (0 if none). */
function getLightEmit(packedBlockId: number): number {
  const blockId = getBlockFromPacked(packedBlockId);
  if (blockId === BLOCK_AIR) return 0;
  const def = getBlockDef(blockId);
  if (!def) return 0;
  return def.lightEmit;
}

/** Compute attenuation when light spreads from cell A to cell B. */
function attenuation(toPackedBlockId: number): number {
  // Light entering air: -1 (normal attenuation)
  // Light entering liquid: -1 (same as air, but liquids are less common)
  // Light entering solid: -2 (solid blocks absorb more light)
  const blockId = getBlockFromPacked(toPackedBlockId);
  if (blockId === BLOCK_AIR) return 1;
  const def = getBlockDef(blockId);
  if (!def) return 2;
  if (def.category === "liquid") return 1;
  return 2; // solid/special
}

function enqueue(idx: number, level: number): void {
  lightQueue[queueTail * 2] = idx;
  lightQueue[queueTail * 2 + 1] = level;
  queueTail = (queueTail + 1) % ACTIVE_GRID_CELLS;
}

/**
 * Step the light simulation.
 * daylight: 0-15, the current daylight level (from time system)
 * fg: active grid foreground (packed with flow bits)
 * light: active grid light array (output)
 */
export function stepLightSim(
  fg: Uint16Array,
  light: Uint8Array,
  daylight: number,
): void {
  // Clear light
  light.fill(0);

  // Reset queue
  queueHead = 0;
  queueTail = 0;

  // 1. Seed daylight from the top row — air cells in the top row get full daylight
  for (let x = 0; x < ACTIVE_GRID_W; x++) {
    const idx = x;
    if (!isOpaque(fg[idx])) {
      light[idx] = daylight;
      if (daylight > 1) enqueue(idx, daylight);
    }
  }

  // 2. Seed light from emitters (torches, lava, time crystals)
  for (let i = 0; i < ACTIVE_GRID_CELLS; i++) {
    const emit = getLightEmit(fg[i]);
    if (emit > 0 && emit > light[i]) {
      light[i] = emit;
      if (emit > 1) enqueue(i, emit);
    }
  }

  // 3. Propagate daylight straight down through air columns.
  // When we hit the first solid block, illuminate it with the daylight level
  // (the surface block is lit by the sun), then stop the column.
  for (let x = 0; x < ACTIVE_GRID_W; x++) {
    for (let y = 1; y < ACTIVE_GRID_H; y++) {
      const idx = y * ACTIVE_GRID_W + x;
      const above = light[(y - 1) * ACTIVE_GRID_W + x];
      if (above === 0) break; // no light coming from above

      if (isOpaque(fg[idx])) {
        // This is the first solid block — illuminate it with the daylight
        // level (surface blocks are lit by the sun)
        if (light[idx] < above) {
          light[idx] = above;
          if (above > 1) enqueue(idx, above);
        }
        break; // stop propagating down through this column
      } else {
        // Air or liquid — light passes through with no extra attenuation
        if (light[idx] < above) {
          light[idx] = above;
          if (above > 1) enqueue(idx, above);
        }
      }
    }
  }

  // 4. BFS propagation for all light sources
  // Light spreads to ALL 4 neighbors (including solid blocks), with
  // attenuation depending on the target cell type.
  while (queueHead !== queueTail) {
    const idx = lightQueue[queueHead * 2];
    const level = lightQueue[queueHead * 2 + 1];
    queueHead = (queueHead + 1) % ACTIVE_GRID_CELLS;

    if (level <= 1) continue;

    const x = idx % ACTIVE_GRID_W;
    const y = Math.floor(idx / ACTIVE_GRID_W);

    // Spread to 4 neighbors
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < ACTIVE_GRID_W - 1 ? idx + 1 : -1,
      y > 0 ? idx - ACTIVE_GRID_W : -1,
      y < ACTIVE_GRID_H - 1 ? idx + ACTIVE_GRID_W : -1,
    ];

    for (const nIdx of neighbors) {
      if (nIdx < 0) continue;
      const atten = attenuation(fg[nIdx]);
      const newLevel = level - atten;
      if (newLevel <= 0) continue;
      if (light[nIdx] < newLevel) {
        light[nIdx] = newLevel;
        if (newLevel > 1) enqueue(nIdx, newLevel);
      }
    }
  }
}
