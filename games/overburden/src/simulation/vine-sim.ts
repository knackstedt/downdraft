// ============================================================================
// Overburden — vine growth simulation
//
// Vines (kiwi, grape) climb on trees (background plane, layer 3), walls
// (foreground plane, layer 2), or trellis (foreground plane, layer 1). They
// grow upward during the sim tick: a vine block at (x, y) grows into the empty
// cell at (x, y-1) in the SAME plane, provided there is a support block
// adjacent to that target cell in the same plane:
//   - background plane: support = any tree block (wood/leaves of any species)
//   - foreground plane: support = any solid wall block OR a trellis block
//
// Vines do NOT grow on other vines (so they don't spiral infinitely); they
// only extend while a real support is within reach above/around them. Growth
// is self-limiting: once the vine reaches the top of its support (tree canopy
// or wall top), there's no support above and it stops.
//
// Growth is staggered (deterministic per cell + tick) so vines extend
// gradually rather than all at once, and the scan runs every N ticks (not
// every tick) for performance.
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import { BLOCK_AIR } from "../shared/constants";
import { isTreeBlock, isVineBlock } from "../shared/tree-species";

// Run vine growth every N ticks (≈1s at 30tps). Scanning 200k cells every
// tick would be wasteful; vines are slow-growing.
const VINE_GROWTH_INTERVAL = 30;
// Per-cycle probability that a given vine head extends by one block.
const VINE_GROWTH_CHANCE = 0.5;

/** Deterministic roll in [0,1) from (x, y, tick, salt). */
function vineRoll(x: number, y: number, tick: number, salt: number): number {
  let h = 2166136261 ^ x;
  h = Math.imul(h, 16777619) ^ y;
  h = Math.imul(h, 16777619) ^ tick;
  h = Math.imul(h, 16777619) ^ salt;
  return ((h >>> 0) % 100000) / 100000;
}

/** Is `id` a valid foreground support for a vine (wall or trellis)? */
function isFgSupport(id: number): boolean {
  const b = id & 0xFF;
  if (b === BLOCK_AIR) return false;
  if (isVineBlock(b)) return false; // vines don't climb on vines
  if (isTreeBlock(b)) return false; // trees are in the bg plane, not fg support
  const def = getBlockDef(b);
  // Solid walls (stone, dirt, wood placed by player, etc.) + trellis.
  return !!def && (def.category === "solid" || def.category === "special");
}

/** Is `id` a valid background support for a vine (a tree)? */
function isBgSupport(id: number): boolean {
  const b = id & 0xFF;
  if (isVineBlock(b)) return false; // vines don't climb on vines
  return isTreeBlock(b);
}

/**
 * Step vine growth for the active grid. Mutates `fg`/`bg` in place.
 * Returns true if any vine grew (so the caller can mark light dirty).
 *
 * @param fg  active foreground plane (Uint16Array, ACTIVE_GRID_W * ACTIVE_GRID_H)
 * @param bg  active background plane (same size)
 * @param tick current sim tick (used for staggered growth + interval gating)
 * @param W   grid width (ACTIVE_GRID_W)
 * @param H   grid height (ACTIVE_GRID_H)
 */
export function stepVineGrowth(
  fg: Uint16Array,
  bg: Uint16Array,
  tick: number,
  W: number,
  H: number,
): boolean {
  if (tick % VINE_GROWTH_INTERVAL !== 0) return false;

  // Collect growth targets first, then apply — avoids cascade-in-one-pass
  // where a newly-grown vine head would be re-scanned and grow again.
  // Store the full Uint16 value (including tree tag in upper bits) so new
  // vine cells inherit the tree tag from the source vine. This ensures
  // felling a tree removes all its vines, including ones that grew later.
  const growth: { plane: "fg" | "bg"; x: number; y: number; value: number }[] = [];

  // Scan background plane: vines climbing trees.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const packed = bg[idx];
      const id = packed & 0xFF;
      if (!isVineBlock(id)) continue;
      const ty = y - 1; // grow upward (y decreases upward)
      if (ty < 0) continue;
      const tIdx = ty * W + x;
      if ((bg[tIdx] & 0xFF) !== BLOCK_AIR) continue;
      // Support adjacent to the target cell in the bg plane?
      const left = x > 0 ? (bg[ty * W + (x - 1)] & 0xFF) : BLOCK_AIR;
      const right = x < W - 1 ? (bg[ty * W + (x + 1)] & 0xFF) : BLOCK_AIR;
      const above = ty > 0 ? (bg[(ty - 1) * W + x] & 0xFF) : BLOCK_AIR;
      if (!isBgSupport(left) && !isBgSupport(right) && !isBgSupport(above)) continue;
      if (vineRoll(x, ty, tick, id) > VINE_GROWTH_CHANCE) continue;
      growth.push({ plane: "bg", x, y: ty, value: packed });
    }
  }

  // Scan foreground plane: vines climbing walls/trellis.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const packed = fg[idx];
      const id = packed & 0xFF;
      if (!isVineBlock(id)) continue;
      const ty = y - 1;
      if (ty < 0) continue;
      const tIdx = ty * W + x;
      if ((fg[tIdx] & 0xFF) !== BLOCK_AIR) continue;
      const left = x > 0 ? (fg[ty * W + (x - 1)] & 0xFF) : BLOCK_AIR;
      const right = x < W - 1 ? (fg[ty * W + (x + 1)] & 0xFF) : BLOCK_AIR;
      const above = ty > 0 ? (fg[(ty - 1) * W + x] & 0xFF) : BLOCK_AIR;
      if (!isFgSupport(left) && !isFgSupport(right) && !isFgSupport(above)) continue;
      if (vineRoll(x, ty, tick, id) > VINE_GROWTH_CHANCE) continue;
      growth.push({ plane: "fg", x, y: ty, value: packed });
    }
  }

  if (growth.length === 0) return false;

  for (const g of growth) {
    const idx = g.y * W + g.x;
    if (g.plane === "fg") {
      if ((fg[idx] & 0xFF) === BLOCK_AIR) fg[idx] = g.value;
    } else {
      if ((bg[idx] & 0xFF) === BLOCK_AIR) bg[idx] = g.value;
    }
  }
  return true;
}
