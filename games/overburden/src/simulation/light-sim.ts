// ============================================================================
// Overburden — volumetric colored light propagation
//
// Computes a per-cell RGB light field (RGBA8, 0-255 per channel) on demand.
// Recompute is event-driven (block edit, emitter change, active-grid rebuild,
// or daylight-integer change) — NOT per-tick.
//
// Model:
// - The sky is a constant light producer. Sky light = SKY_LIGHT_COLOR scaled
//   by (daylight/15). It enters from the top and fills open air columns; the
//   first opaque block in a column is also lit by the sky (surface is lit).
// - Light-emitting blocks (torches, lava, ...) seed their emitter color scaled
//   by (lightEmit/15).
// - Light spreads to ALL 4 neighbors (including solid blocks) with per-channel
//   max-blend: newC = max(neighbor.C, source.C - atten). Attenuation is
//   17 (air/liquid, =1 old level) or 34 (solid/special, =2 old levels).
// - Pure-black fog-of-war is handled in the shader (unexplored cells); this
//   sim only computes the light field for explored/visible volumes.
//
// Uses a BFS/flood-fill with a ring-buffer queue (higher light first via the
// seeding order — sky + emitters are seeded at full intensity, then spread).
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_CELLS, ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR,
} from "../shared/constants";
import { getBlockFromPacked } from "./fluid-sim";

// Sky light color (cool daylight blue). Scaled by (daylight/15) at seed time.
const SKY_LIGHT_COLOR_R = 200;
const SKY_LIGHT_COLOR_G = 220;
const SKY_LIGHT_COLOR_B = 255;

// Per-level attenuation scaled to 0-255 range (15 levels → 255 max).
// air/liquid: 1 level = 17; solid/special: 2 levels = 34.
const ATTEN_AIR = 17;
const ATTEN_SOLID = 34;

// Light queue for BFS propagation (stores cell index only).
// Sized to ACTIVE_GRID_CELLS (one entry per cell max in flight).
const lightQueue = new Int32Array(ACTIVE_GRID_CELLS);
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

/** Get light emission RGB from a block (null if none). */
function getLightEmitColor(packedBlockId: number): [number, number, number] | null {
  const blockId = getBlockFromPacked(packedBlockId);
  if (blockId === BLOCK_AIR) return null;
  const def = getBlockDef(blockId);
  if (!def || def.lightEmit <= 0) return null;
  const scale = def.lightEmit / 15;
  return [
    Math.round(def.lightColor[0] * scale),
    Math.round(def.lightColor[1] * scale),
    Math.round(def.lightColor[2] * scale),
  ];
}

/** Compute attenuation when light spreads into a target cell. */
function attenuation(toPackedBlockId: number): number {
  const blockId = getBlockFromPacked(toPackedBlockId);
  if (blockId === BLOCK_AIR) return ATTEN_AIR;
  const def = getBlockDef(blockId);
  if (!def) return ATTEN_SOLID;
  if (def.category === "liquid") return ATTEN_AIR;
  return ATTEN_SOLID; // solid/special
}

function enqueue(idx: number): void {
  lightQueue[queueTail] = idx;
  queueTail = (queueTail + 1) % ACTIVE_GRID_CELLS;
}

/** Set a cell's RGB light if any channel is higher than the current value.
 *  Returns true if the cell was updated (and should be re-enqueued). */
function setLightMax(light: Uint8Array, idx: number, r: number, g: number, b: number): boolean {
  const off = idx * 4;
  let changed = false;
  if (r > light[off]) { light[off] = r; changed = true; }
  if (g > light[off + 1]) { light[off + 1] = g; changed = true; }
  if (b > light[off + 2]) { light[off + 2] = b; changed = true; }
  if (changed) light[off + 3] = 255; // mark lit (alpha)
  return changed;
}

/**
 * Recompute the full RGB light field for the active grid.
 *
 * fg: active grid foreground (packed with flow bits)
 * light: active grid light array (RGBA8, 4 * ACTIVE_GRID_CELLS bytes, output)
 * daylight: 0-15, the current daylight level (scales sky light brightness)
 */
export function recomputeLight(
  fg: Uint16Array,
  light: Uint8Array,
  daylight: number,
): void {
  // Clear light
  light.fill(0);

  // Reset queue
  queueHead = 0;
  queueTail = 0;

  // Sky light intensity (0-255 per channel), scaled by daylight.
  const skyScale = daylight / 15;
  const skyR = Math.round(SKY_LIGHT_COLOR_R * skyScale);
  const skyG = Math.round(SKY_LIGHT_COLOR_G * skyScale);
  const skyB = Math.round(SKY_LIGHT_COLOR_B * skyScale);

  // 1. Seed daylight from the top row — non-opaque cells in the top row get
  //    full sky light.
  if (daylight > 0) {
    for (let x = 0; x < ACTIVE_GRID_W; x++) {
      const idx = x;
      if (!isOpaque(fg[idx])) {
        if (setLightMax(light, idx, skyR, skyG, skyB)) {
          enqueue(idx);
        }
      }
    }

    // 2. Propagate daylight straight down through air columns.
    //    When we hit the first opaque block, illuminate it with the sky light
    //    (the surface block is lit by the sky), then stop the column.
    for (let x = 0; x < ACTIVE_GRID_W; x++) {
      for (let y = 1; y < ACTIVE_GRID_H; y++) {
        const idx = y * ACTIVE_GRID_W + x;
        const aboveOff = (y - 1) * ACTIVE_GRID_W + x;
        // Read the sky light coming from above (only sky light, not mixed).
        const aboveR = light[aboveOff * 4];
        const aboveG = light[aboveOff * 4 + 1];
        const aboveB = light[aboveOff * 4 + 2];
        if (aboveR === 0 && aboveG === 0 && aboveB === 0) break; // no light above

        if (isOpaque(fg[idx])) {
          // First solid block — illuminate it with the sky light, then stop.
          if (setLightMax(light, idx, aboveR, aboveG, aboveB)) {
            enqueue(idx);
          }
          break;
        } else {
          // Air or liquid — sky light passes through with no extra attenuation.
          if (setLightMax(light, idx, aboveR, aboveG, aboveB)) {
            enqueue(idx);
          }
        }
      }
    }
  }

  // 3. Seed light from emitters (torches, lava, campfires, crystals, ...).
  for (let i = 0; i < ACTIVE_GRID_CELLS; i++) {
    const emit = getLightEmitColor(fg[i]);
    if (emit) {
      if (setLightMax(light, i, emit[0], emit[1], emit[2])) {
        enqueue(i);
      }
    }
  }

  // 4. BFS propagation for all light sources (per-channel max-blend).
  //    Light spreads to ALL 4 neighbors (including solid blocks), with
  //    attenuation depending on the target cell type.
  while (queueHead !== queueTail) {
    const idx = lightQueue[queueHead];
    queueHead = (queueHead + 1) % ACTIVE_GRID_CELLS;

    const off = idx * 4;
    const srcR = light[off];
    const srcG = light[off + 1];
    const srcB = light[off + 2];
    // Skip if this cell's light has been fully absorbed (all channels ≤ atten).
    if (srcR <= ATTEN_AIR && srcG <= ATTEN_AIR && srcB <= ATTEN_AIR) continue;

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
      const newR = srcR > atten ? srcR - atten : 0;
      const newG = srcG > atten ? srcG - atten : 0;
      const newB = srcB > atten ? srcB - atten : 0;
      if (newR === 0 && newG === 0 && newB === 0) continue;
      if (setLightMax(light, nIdx, newR, newG, newB)) {
        enqueue(nIdx);
      }
    }
  }
}
