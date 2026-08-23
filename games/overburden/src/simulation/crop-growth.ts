// ============================================================================
// Overburden — crop growth simulation
//
// Scans the active grid for crop blocks and advances them through growth
// stages over time. Follows the same pattern as vine-sim.ts: runs every N
// ticks, collects growth targets first, then applies them.
//
// Growth rules:
//   - A crop block (stage 0-2) advances to the next stage after
//     crop.stageTicks[stage] ticks have elapsed since it was planted.
//   - Crops only grow in their growSeasons (if non-empty) and when the cell
//     has light (daylight or torchlight).
//   - Mushrooms grow in any season and prefer darkness (grow even without
//     light).
//   - In winter, crops with low coldTolerance may die (revert to air) if
//     they're not in a sheltered (indoor) position.
//   - Mushrooms can spread: a mature mushroom has a chance per cycle to
//     place a seed-stage mushroom in an adjacent empty cell that has
//     compost farmland below it.
//
// Crop age tracking: since blocks don't store per-cell metadata, we track
// crop plant time in a Map keyed by "x,y" in active grid coords. This is
// rebuilt when the active grid rebuilds (crops in unloaded chunks lose their
// age, but they also stop growing — and when the grid comes back, they
// resume from the current tick as if freshly planted, which is acceptable
// for a block game).
// ============================================================================

import { BLOCK_AIR, BLOCK_COMPOST_FARMLAND, BLOCK_FARMLAND } from "../shared/constants";
import {
    getCropByBlock,
    isCropBlock, isWildCropBlock,
    WILD_CROPS,
    type Season,
} from "../shared/crops";

// Run crop growth every N ticks (~2s at 30tps).
const CROP_GROWTH_INTERVAL = 60;
// Chance per cycle that a mature mushroom spreads to an adjacent cell.
const MUSHROOM_SPREAD_CHANCE = 0.15;
// Chance per cycle in winter that a cold-sensitive crop dies.
const WINTER_KILL_CHANCE = 0.3;

/** Tracks when each crop cell was planted (active grid coords "x,y" → tick). */
const cropPlantTick = new Map<string, number>();

/** Tracks wild crop harvest time for regrow ("x,y" → tick when harvested). */
const wildHarvestTick = new Map<string, number>();

/** Deterministic roll in [0,1) from (x, y, tick, salt). */
function cropRoll(x: number, y: number, tick: number, salt: number): number {
  let h = 2166136261 ^ x;
  h = Math.imul(h, 16777619) ^ y;
  h = Math.imul(h, 16777619) ^ tick;
  h = Math.imul(h, 16777619) ^ salt;
  return ((h >>> 0) % 100000) / 100000;
}

/** Record that a crop was planted at active-grid (x, y) at the given tick. */
export function recordCropPlant(x: number, y: number, tick: number): void {
  cropPlantTick.set(`${x},${y}`, tick);
}

/** Record that a wild crop was harvested at (x, y) at the given tick. */
export function recordWildHarvest(x: number, y: number, tick: number): void {
  wildHarvestTick.set(`${x},${y}`, tick);
}

/** Clear all crop tracking (called when active grid rebuilds). */
export function clearCropTracking(): void {
  cropPlantTick.clear();
  wildHarvestTick.clear();
}

/**
 * Step crop growth for the active grid. Mutates `fg` in place.
 * Returns true if any crop grew or died (so the caller can mark light dirty).
 *
 * @param fg       active foreground plane
 * @param bg       active background plane (for shelter check)
 * @param light    active light plane (for light level check)
 * @param tick     current sim tick
 * @param season   current season
 * @param W        grid width
 * @param H        grid height
 */
export function stepCropGrowth(
  fg: Uint16Array,
  bg: Uint16Array,
  light: Uint8Array,
  tick: number,
  season: Season,
  W: number,
  H: number,
): boolean {
  if (tick % CROP_GROWTH_INTERVAL !== 0) return false;

  const changes: { x: number; y: number; newBlock: number }[] = [];
  const kills: { x: number; y: number }[] = [];
  const spreads: { x: number; y: number; block: number }[] = [];
  const wildRegrows: { x: number; y: number; block: number }[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const blockId = fg[idx] & 0xFF;

      // --- Crop growth ---
      if (isCropBlock(blockId)) {
        const entry = getCropByBlock(blockId);
        if (!entry) continue;
        const { crop, stage } = entry;

        // Already mature — no further growth (mushrooms may spread, handled below).
        if (stage >= 3) {
          // Mushroom spreading
          if (crop.canSpread && crop.isMushroom) {
            if (cropRoll(x, y, tick, crop.id.charCodeAt(0)) < MUSHROOM_SPREAD_CHANCE) {
              const spreadDirs = [[0, -1], [1, 0], [-1, 0], [0, 1]];
              // Use a very different salt for the direction roll so it doesn't
              // correlate with the spread-chance roll.
              const dir = spreadDirs[Math.floor(cropRoll(x, y, tick, 0x5EA5) * 4)];
              const nx = x + dir[0];
              const ny = y + dir[1];
              if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                const nIdx = ny * W + nx;
                if ((fg[nIdx] & 0xFF) === BLOCK_AIR) {
                  // Check for compost farmland below the target
                  const belowY = ny + 1;
                  if (belowY < H) {
                    const below = fg[belowY * W + nx] & 0xFF;
                    if (below === BLOCK_COMPOST_FARMLAND) {
                      spreads.push({ x: nx, y: ny, block: crop.stages[0] });
                    }
                  }
                }
              }
            }
          }
          continue;
        }

        // Check season: crop only grows in its growSeasons (if specified).
        const inSeason = crop.growSeasons.length === 0 || crop.growSeasons.includes(season);

        // Winter kill: cold-sensitive crops may die in winter.
        if (season === "winter" && crop.coldTolerance < 0.5) {
          // Sheltered = has a block above (roof/ceiling)
          const above = y > 0 ? (fg[(y - 1) * W + x] & 0xFF) : BLOCK_AIR;
          const sheltered = above !== BLOCK_AIR;
          if (!sheltered && cropRoll(x, y, tick, 777) < WINTER_KILL_CHANCE) {
            kills.push({ x, y });
            continue;
          }
        }

        if (!inSeason) continue; // paused outside growing season

        // Light check: non-mushrooms need light to grow.
        if (!crop.isMushroom) {
          const lightLevel = light[idx] ?? 0;
          if (lightLevel < 4) continue; // too dark
        }

        // Age check: has enough time passed since planting?
        const plantTick = cropPlantTick.get(`${x},${y}`) ?? tick;
        const ageTicks = tick - plantTick;
        const required = crop.stageTicks[stage];
        if (ageTicks >= required) {
          changes.push({ x, y, newBlock: crop.stages[stage + 1] });
        }
      }

      // --- Wild crop regrow ---
      if (isWildCropBlock(blockId)) {
        // Wild crops don't have growth stages — they're either present or
        // absent. Regrow is handled by checking harvested cells (below).
        // But if a wild crop block exists, it's already grown.
      }
    }
  }

  // Check for wild crop regrow: cells that were harvested and have
  // grass/farmland below should regrow after regrowTicks.
  for (const [key, harvestTick] of wildHarvestTick) {
    const parts = key.split(",");
    const x = parseInt(parts[0]);
    const y = parseInt(parts[1]);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const idx = y * W + x;
    if ((fg[idx] & 0xFF) !== BLOCK_AIR) {
      // Cell is occupied — remove from tracking.
      wildHarvestTick.delete(key);
      continue;
    }
    // Find which wild crop was here — we use a deterministic pick based on
    // position so the same wild crop type regrows that was harvested.
    const belowY = y + 1;
    if (belowY >= H) continue;
    const below = fg[belowY * W + x] & 0xFF;
    if (below !== 2 && below !== BLOCK_FARMLAND) continue; // grass or farmland
    const tickAge = tick - harvestTick;
    for (const wc of WILD_CROPS) {
      if (tickAge >= wc.regrowTicks) {
        wildRegrows.push({ x, y, block: wc.blockId });
        wildHarvestTick.delete(key);
        break;
      }
    }
  }

  let changed = false;

  // Apply growth stage changes
  for (const c of changes) {
    const idx = c.y * W + c.x;
    fg[idx] = c.newBlock;
    // Update plant tick to current tick (so next stage starts counting)
    cropPlantTick.set(`${c.x},${c.y}`, tick);
    changed = true;
  }

  // Apply kills (crop dies → air)
  for (const k of kills) {
    const idx = k.y * W + k.x;
    fg[idx] = BLOCK_AIR;
    cropPlantTick.delete(`${k.x},${k.y}`);
    changed = true;
  }

  // Apply mushroom spreads
  for (const s of spreads) {
    const idx = s.y * W + s.x;
    if ((fg[idx] & 0xFF) === BLOCK_AIR) {
      fg[idx] = s.block;
      cropPlantTick.set(`${s.x},${s.y}`, tick);
      changed = true;
    }
  }

  // Apply wild regrows
  for (const r of wildRegrows) {
    const idx = r.y * W + r.x;
    if ((fg[idx] & 0xFF) === BLOCK_AIR) {
      fg[idx] = r.block;
      changed = true;
    }
  }

  return changed;
}
