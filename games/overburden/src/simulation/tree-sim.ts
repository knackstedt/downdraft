// ============================================================================
// Overburden — tree life-cycle simulation
//
// Daily simulation of fruit, seeds, and sapling growth:
//   - Fruiting trees spawn fruit with 10% chance per leaf per day. Fruit lives
//     2 days on the tree, then falls to the ground and despawns after 1 day.
//   - All trees spawn seeds with 3% chance per leaf per day. Seeds stay on the
//     tree 7 days, then fall and scatter ±seedScatterRange blocks left/right.
//     Fallen seeds stay on the ground 1 day, then plant a sapling (if valid
//     ground) or despawn.
//   - Saplings grow 1 wood block/day upward + expand their canopy each day
//     (trunk + canopy simultaneously). When the trunk reaches the target
//     height, the sapling matures into a normal tree.
//
// Fruits and seeds are spinning 2D world drop entities (rendered by DropPass),
// NOT foreground blocks. They hang on tree leaves, then fall via the drop
// physics system. Both fruit and seeds are pick-uppable by proximity (the
// drop pickup system handles this). Seeds that aren't picked up auto-plant
// when they land on valid ground.
//
// Saplings are background blocks (like adult trees) that grow into wood +
// leaves. The species is encoded in the vfx plane.
//
// All RNG is deterministic via pseudoRandom(x, y, day, salt) so e2e tests are
// reproducible. The daily scan runs once per in-game day (18000 ticks).
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import { BLOCK_AIR, BLOCK_DIRT, BLOCK_GRASS, BLOCK_SAPLING } from "../shared/constants";
import type { Season } from "../shared/crops";
import { encodeDropItem } from "../shared/drop-registry";
import { pseudoRandom } from "../shared/pseudo-random";
import {
    getSpeciesByIndex,
    getSpeciesByLeafBlock,
    getSpeciesIndex,
    isLeafBlock,
    isSaplingBlock,
    makeTaggedBlock,
} from "../shared/tree-species";

// --- vfx encoding (saplings only) ---
// Sapling blocks: bits 0-3 = species index, bits 4-7 = target trunk height,
//   bits 8-11 = current trunk height, bits 12-19 = days elapsed.
// (Fruits and seeds no longer use vfx — they're drop entities with their own
// state fields on DropEntity.)

const SAPLING_SPECIES_MASK = 0xF;
const SAPLING_TARGET_SHIFT = 4;
const SAPLING_TARGET_MASK = 0xF;
const SAPLING_CURRENT_SHIFT = 8;
const SAPLING_CURRENT_MASK = 0xF;
const SAPLING_DAYS_SHIFT = 12;
const SAPLING_DAYS_MASK = 0xFF;

export function packSaplingVfx(speciesIdx: number, targetH: number, currentH: number, days: number): number {
  return (speciesIdx & SAPLING_SPECIES_MASK) |
    ((targetH & SAPLING_TARGET_MASK) << SAPLING_TARGET_SHIFT) |
    ((currentH & SAPLING_CURRENT_MASK) << SAPLING_CURRENT_SHIFT) |
    ((days & SAPLING_DAYS_MASK) << SAPLING_DAYS_SHIFT);
}

function unpackSaplingVfx(v: number): { speciesIdx: number; targetH: number; currentH: number; days: number } {
  return {
    speciesIdx: v & SAPLING_SPECIES_MASK,
    targetH: (v >> SAPLING_TARGET_SHIFT) & SAPLING_TARGET_MASK,
    currentH: (v >> SAPLING_CURRENT_SHIFT) & SAPLING_CURRENT_MASK,
    days: (v >> SAPLING_DAYS_SHIFT) & SAPLING_DAYS_MASK,
  };
}

// --- Ground validation ---
function isValidGround(blockId: number): boolean {
  const b = blockId & 0xFF;
  return b === BLOCK_GRASS || b === BLOCK_DIRT;
}

// --- Is a foreground cell solid (blocks falling)? ---
function isSolidFg(blockId: number): boolean {
  const b = blockId & 0xFF;
  if (b === BLOCK_AIR) return false;
  const def = getBlockDef(b);
  return !!def && def.category === "solid";
}

// --- Drop entity interface (matches DropEntity in blockheads-worker.ts) ---
export interface TreeDropEntity {
  x: number; y: number; vx: number; vy: number;
  spin: number; spinSpeed: number; itemCode: number;
  count: number; lifetime: number; onGround: boolean;
  kind: number; speciesIdx: number; age: number; fallen: boolean;
}

// --- Block world interface (minimal subset of BlockWorld needed) ---
export interface TreeBlockWorld {
  activeForeground: Uint16Array;
  activeBackground: Uint16Array;
  activeVfx: Uint32Array;
  /** Active grid origin in chunk coords (for computing world-coord tree tags). */
  getActiveOriginCx(): number;
  getActiveOriginCy(): number;
  setActiveBackground(ax: number, ay: number, blockId: number): void;
  setActiveVfx(ax: number, ay: number, value: number): void;
}

// --- Tree tag computation (matches terrain-gen.ts logic) ---
// The tag is stored in the upper 8 bits of the background Uint16 so felling
// flood-fill stays within one tree. Sapling-grown trees must use a non-zero
// tag derived from world coords, just like terrain-gen trees, so they don't
// fall back to the tag-0 "fell everything" path.
const CHUNK_W = 64;
const CHUNK_H = 64;

function computeTreeTag(worldX: number, worldY: number): number {
  let tag = (Math.imul(worldX, 31) + Math.imul(worldY, 17)) & 0xFF;
  if (tag === 0) tag = 1; // 0 = untagged/old-save fallback, never use it
  return tag;
}

// ============================================================================
// forceFruitSpawnTick — roll the fruit-spawn dice for all fruit-capable leaves
// ============================================================================
// Scans the active grid's background leaf blocks and spawns fruit drop entities
// with the same 10% chance per leaf as the daily tick, but uses a distinct RNG
// salt ("force-fruit") so the roll is independent of the daily tick. This is
// triggered by the F7 debug keybind to immediately populate trees with fruit
// without waiting for the next daily tick.
//
// Only fruiting species (fruitItem !== undefined) are considered. Seeds and
// sapling growth are NOT triggered — this is fruit-only.
//
// @param bg     active background plane (same size)
// @param tick   current sim tick (used for deterministic RNG)
// @param W      grid width (ACTIVE_GRID_W)
// @param H      grid height (ACTIVE_GRID_H)
// @param drops  drop entity array (fruits are added here)
// @returns the number of fruit drops spawned
// ============================================================================
export function forceFruitSpawnTick(
  bg: Uint16Array,
  tick: number,
  W: number,
  H: number,
  drops: TreeDropEntity[],
): number {
  let spawned = 0;

  // Build a Set of occupied leaf cells (for O(1) "has drop at" checks).
  const occupiedCells = new Set<number>();
  for (const d of drops) {
    if (d.kind > 0) occupiedCells.add(Math.floor(d.y) * W + Math.floor(d.x));
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const bgBlock = bg[idx] & 0xFF;
      if (!isLeafBlock(bgBlock)) continue;

      const species = getSpeciesByLeafBlock(bgBlock);
      if (!species || species.fruitItem === undefined) continue;

      // 10% chance per leaf per tick. Uses `tick` (not `day`) as the RNG seed
      // so each F7 press rolls fresh dice — different leaves pass each time.
      // The occupiedCells check prevents spawning on leaves that already have
      // fruit, so multiple presses progressively fill up the tree.
      const roll = pseudoRandom(x, y, tick, "force-fruit");
      if (roll <= 0.10 && !occupiedCells.has(idx) && drops.length < 512) {
        const code = encodeDropItem(species.fruitItem);
        if (code > 0) {
          drops.push({
            x: x + 0.5, y: y + 0.5, vx: 0, vy: 0,
            spin: pseudoRandom(x, y, tick, "force-fruit-spin") * Math.PI * 2,
            spinSpeed: 1.5 + pseudoRandom(x, y, tick, "force-fruit-spinspeed") * 2,
            itemCode: code, count: 1, lifetime: Infinity,
            onGround: true, kind: 1, speciesIdx: 0, age: 0, fallen: false,
          });
          occupiedCells.add(idx);
          spawned++;
        }
      }
    }
  }

  return spawned;
}

// ============================================================================
// stepTreeDaily — run the daily tree life-cycle simulation
// ============================================================================
// Scans the active grid once per in-game day. Does three things:
// 1. Spawns fruit + seed drop entities on background leaf blocks
// 2. Ages existing fruit/seed drop entities (fall, scatter, despawn, plant)
// 3. Grows saplings (background blocks) — paused in winter
//
// Sapling-grown trees are tagged with a per-tree group ID (stored in the
// upper 8 bits of the background Uint16) computed from world coords, so
// felling flood-fill stays within one tree — just like terrain-gen trees.
//
// @param fg     active foreground plane (Uint16Array, W * H cells)
// @param bg     active background plane (same size)
// @param vfx    active vfx plane (Uint32Array, same size — sapling state)
// @param tick   current sim tick (used for deterministic RNG via day number)
// @param season current season (sapling growth pauses in winter)
// @param W      grid width (ACTIVE_GRID_W)
// @param H      grid height (ACTIVE_GRID_H)
// @param drops  drop entity array (fruits/seeds are added/removed here)
// @param world  BlockWorld (for setting sapling blocks + vfx)
// @returns true if any blocks changed (caller marks light dirty)
// ============================================================================
export function stepTreeDaily(
  fg: Uint16Array,
  bg: Uint16Array,
  vfx: Uint32Array,
  tick: number,
  season: Season,
  W: number,
  H: number,
  drops: TreeDropEntity[],
  world: TreeBlockWorld,
): boolean {
  const day = Math.floor(tick / 18000);
  let changed = false;

  // Build a Set of occupied leaf cells (for O(1) "has drop at" checks).
  // Only tree drops (kind > 0) are relevant; regular world drops don't
  // block fruit/seed spawning.
  const occupiedCells = new Set<number>();
  for (const d of drops) {
    if (d.kind > 0) occupiedCells.add(Math.floor(d.y) * W + Math.floor(d.x));
  }

  // --- Phase 1: Scan background leaf blocks for fruit + seed spawning ---
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const bgBlock = bg[idx] & 0xFF;
      if (!isLeafBlock(bgBlock)) continue;

      const species = getSpeciesByLeafBlock(bgBlock);
      if (!species) continue;
      const speciesIdx = getSpeciesIndex(species);

      // Fruit spawn: 10% chance per leaf per day (only for fruiting species)
      if (species.fruitItem !== undefined) {
        const roll = pseudoRandom(x, y, day, "fruit");
        if (roll <= 0.10 && !occupiedCells.has(idx) && drops.length < 512) {
          const code = encodeDropItem(species.fruitItem);
          if (code > 0) {
            drops.push({
              x: x + 0.5, y: y + 0.5, vx: 0, vy: 0,
              spin: pseudoRandom(x, y, day, "fruit-spin") * Math.PI * 2,
              spinSpeed: 1.5 + pseudoRandom(x, y, day, "fruit-spinspeed") * 2,
              itemCode: code, count: 1, lifetime: Infinity,
              onGround: true, kind: 1, speciesIdx: 0, age: 0, fallen: false,
            });
            occupiedCells.add(idx);
          }
        }
      }

      // Seed spawn: 3% chance per leaf per day (all species)
      const seedRoll = pseudoRandom(x, y, day, "seed");
      if (seedRoll <= 0.03 && !occupiedCells.has(idx) && drops.length < 512) {
        drops.push({
          x: x + 0.5, y: y + 0.5, vx: 0, vy: 0,
          spin: pseudoRandom(x, y, day, "seed-spin") * Math.PI * 2,
          spinSpeed: 1.5 + pseudoRandom(x, y, day, "seed-spinspeed") * 2,
          itemCode: 33, // DROP_SEED
          count: 1, lifetime: Infinity,
          onGround: true, kind: 2, speciesIdx, age: 0, fallen: false,
        });
        occupiedCells.add(idx);
      }
    }
  }

  // --- Phase 2: Age + fall/scatter/despawn/plant fruit + seed drops ---
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    if (d.kind === 0) continue; // skip regular drops

    d.age++;

    if (d.kind === 1) {
      // Fruit: fall at age 2, despawn at age 3 (2 on tree + 1 on ground)
      if (!d.fallen && d.age >= 2) {
        d.fallen = true;
        d.onGround = false; // start falling via physics
      } else if (d.fallen && d.age >= 3) {
        // Despawn after 1 day on the ground
        drops.splice(i, 1);
      }
    } else if (d.kind === 2) {
      // Seed: fall + scatter at age 7, plant/despawn at age 8
      if (!d.fallen && d.age >= 7) {
        d.fallen = true;
        d.onGround = false; // start falling via physics
        // Scatter: pick random X offset and teleport horizontally
        const species = getSpeciesByIndex(d.speciesIdx);
        const range = species.seedScatterRange;
        const scatterRoll = pseudoRandom(Math.floor(d.x), Math.floor(d.y), day, "scatter");
        const offsetX = Math.floor(scatterRoll * (2 * range + 1)) - range;
        d.x = Math.max(0, Math.min(W - 0.01, d.x + offsetX));
      } else if (d.fallen && d.age >= 8) {
        // Plant or despawn: check ground below
        const gx = Math.floor(d.x);
        const gy = Math.floor(d.y);
        const belowY = gy + 1;
        const groundBlock = (belowY < H) ? fg[belowY * W + gx] : BLOCK_AIR;
        if (isValidGround(groundBlock)) {
          // Plant a sapling in the background at (gx, gy) if it's air
          if ((bg[gy * W + gx] & 0xFF) === BLOCK_AIR) {
            const species = getSpeciesByIndex(d.speciesIdx);
            const heightRoll = pseudoRandom(gx, gy, day, "saplingHeight");
            const targetH = species.trunkMin +
              Math.floor(heightRoll * (species.trunkMax - species.trunkMin + 1));
            world.setActiveBackground(gx, gy, BLOCK_SAPLING);
            world.setActiveVfx(gx, gy, packSaplingVfx(d.speciesIdx, targetH, 0, 0));
            changed = true;
          }
        }
        // Remove the seed regardless (planted or couldn't plant)
        drops.splice(i, 1);
      }
    }
  }

  // --- Phase 3: Grow saplings (background) ---
  // Sapling growth pauses in winter (consistent with crop growth pausing
  // outside its growSeasons). Existing fruit/seeds still age (Phase 2).
  const canGrow = season !== "winter";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const bgBlock = bg[idx] & 0xFF;
      if (!isSaplingBlock(bgBlock)) continue;

      const v = vfx[idx];
      const { speciesIdx, targetH, currentH, days } = unpackSaplingVfx(v);
      const species = getSpeciesByIndex(speciesIdx);
      const newDays = days + 1;
      let newCurrentH = currentH;

      // Compute the tree tag from the sapling's world coords so that
      // sapling-grown wood + leaves are grouped for felling.
      const worldX = x + world.getActiveOriginCx() * CHUNK_W;
      const worldY = y + world.getActiveOriginCy() * CHUNK_H;
      const treeTag = computeTreeTag(worldX, worldY);

      // Grow trunk: +1 wood block/day upward until reaching targetH.
      // The trunk can overwrite leaf blocks in its path (the canopy may have
      // placed leaves where the trunk will grow — the trunk grows through).
      if (canGrow && currentH < targetH) {
        const trunkY = y - currentH - 1; // grow upward (y decreases)
        if (trunkY >= 0) {
          const trunkCell = bg[trunkY * W + x] & 0xFF;
          if (trunkCell === BLOCK_AIR || isLeafBlock(trunkCell)) {
            world.setActiveBackground(x, trunkY, makeTaggedBlock(species.woodBlock, treeTag));
            newCurrentH = currentH + 1;
            changed = true;
          }
        }
      }

      // Grow canopy: re-run placeCanopy for the current trunk height.
      // tryPlaceLeaf only places into BLOCK_AIR cells, so existing leaves
      // aren't overwritten — new canopy cells are added as the trunk grows.
      if (canGrow) {
        const trunkTopLy = y - newCurrentH;
        if (trunkTopLy >= 0) {
          species.placeCanopy(bg, W, H, x, y, trunkTopLy, newCurrentH, species.leafBlock, treeTag);
        }
      }

      // Check maturation: trunk reached target height, OR the trunk can't
      // grow any further (hit the grid ceiling) — mature at current height
      // so the sapling doesn't stay stuck forever.
      const hitCeiling = currentH < targetH && (y - currentH - 1) < 0;
      if (newCurrentH >= targetH || hitCeiling) {
        // Convert sapling block to the species' wood block (base becomes trunk base)
        world.setActiveBackground(x, y, makeTaggedBlock(species.woodBlock, treeTag));
        world.setActiveVfx(x, y, 0);
        changed = true;
      } else {
        // Update sapling vfx with new growth state
        world.setActiveVfx(x, y, packSaplingVfx(speciesIdx, targetH, newCurrentH, newDays));
        changed = true;
      }
    }
  }

  return changed;
}
