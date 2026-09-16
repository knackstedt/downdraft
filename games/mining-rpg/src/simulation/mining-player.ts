// ============================================================================
// Mining player physics — AABB collision against the active grid.
//
// Built on the shared GridCharacterController (module-movement-2d). This file
// supplies the mining-specific world predicates (packed-material grids with a
// background layer, hard-vs-soft solids, climbables, wiggle exclusions) plus
// the vitals bookkeeping the controller doesn't own: oxygen/drowning, biome
// gravity/heat effects, and lastDamageMaterial death causes.
//
// The player position is in world cell coords, but collision checks use the
// active grid (local coords). The caller (ChunkWorld) converts between world
// and active-local before/after calling updateMiningPlayer.
// ============================================================================

import { MAT_GRAVITY_DIR, Material, MATERIALS } from "@downdraft/library-sand";
import { createGridCharacterController, type GridCharacterState, type GridCharacterWorld } from "@downdraft/module-movement-2d";
import { Vitals } from "@downdraft/module-vitals";
import { CLIMB_SPEED, DeathCause, FALL_DAMAGE_SCALE, FALL_DAMAGE_THRESHOLD, getBiomeEffect, isCollectible, OXYGEN_DROWN_DAMAGE_PER_TICK, OXYGEN_MAX_TICKS, OXYGEN_REGEN_PER_TICK, PLAYER_H, PLAYER_W } from "../shared/constants";
import type { MiningPlayerState } from "../shared/types";

export interface MiningPlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  noclip: boolean;
}

const GRAVITY = 0.04;
const MOVE_ACCEL = 0.12;
const MAX_SPEED = 0.6;
const FRICTION = 0.85;
const JUMP_FORCE = 0.9;
// Terminal fall velocity. With GRAVITY=0.04, the player accelerates over ~1s
// (63 ticks @ 60Hz) before reaching this cap — giving falls a sense of inertia
// and weight. A full-speed fall (vy=2.5) deals lethal damage on landing.
const MAX_FALL = 2.5;
// Max movement per collision sub-step. The Y collision check is sub-stepped
// so that high fall speeds (up to MAX_FALL) can't tunnel through 1-cell-thick
// floors. Each sub-step moves at most this many cells (< 1 to be safe).
const COLLISION_STEP = 0.9;
// While clinging to a ladder/rope with no vertical input, damp velocity so the
// player eases to a stop instead of stopping instantly (feels more natural).
const CLING_DAMP = 0.5;

// Buried/trap mechanics: when solid material overlaps the player's body cells,
// they can wiggle out if partially covered, but are crushed if fully covered.
const BURY_WIGGLE_SPEED = 0.15;   // max speed when partially buried
const BURY_DAMAGE_PER_TICK = 2;   // crush damage per tick when fully buried

// Noclip (development cheat): the player flies freely through terrain — no
// gravity, no collision, no damage, no drowning. WASD moves in all 4
// directions; Space/Up = up, Down = down. Faster than normal movement so
// traversing the world is quick.
const NOCLIP_SPEED = 3.0;

// Materials that burn on contact (1 dmg/tick per overlapping cell).
const HOT = new Set<number>([
  Material.Fire, Material.Lava, Material.Plasma, Material.FuseFire, Material.BurningOil,
]);
// Toxic gases poison rather than incinerate (0.2 dmg/tick).
const GAS = new Set<number>([Material.MethaneGas, Material.SulfurGas]);

const controller = createGridCharacterController({
  width: PLAYER_W,
  height: PLAYER_H,
  gravity: GRAVITY,
  moveAccel: MOVE_ACCEL,
  maxSpeed: MAX_SPEED,
  friction: FRICTION,
  jumpForce: JUMP_FORCE,
  maxFall: MAX_FALL,
  collisionStep: COLLISION_STEP,
  fineSnap: true,
  restOnGround: true,
  stepUp: 1,
  swim: {},
  climb: { speed: CLIMB_SPEED, clingDamp: CLING_DAMP },
  noclip: {
    speed: NOCLIP_SPEED,
    // Refill oxygen while noclip is on (no drowning)
    onNoclipTick: (p) => { (p as MiningPlayerState).oxygen = OXYGEN_MAX_TICKS; },
  },
  fallDamage: {
    threshold: FALL_DAMAGE_THRESHOLD,
    scale: FALL_DAMAGE_SCALE,
    cause: DeathCause.Falling,
  },
  bury: {
    wiggleSpeed: BURY_WIGGLE_SPEED,
    crushDamage: BURY_DAMAGE_PER_TICK,
    maxClearPerTick: 2,
    cause: DeathCause.Suffocation,
  },
  // Route all controller damage (contact/fall/crush) through the shared
  // Vitals instance so clamping, death, and cause tracking live in one place.
  applyDamage: (p, amount, _kind, cause) => {
    vitalsFor(p as MiningPlayerState).damage(amount, cause as MiningCause);
  },
});

/** Damage causes: a death-cause/material id, or tagged ambient heat. */
type MiningCause = number | { heat: number };

// Per-player vitals: health + the field-bound oxygen meter (the meter reads/
// writes p.oxygen directly so saves and the HUD keep working). lastDamage-
// Material is recorded via onDamage — ambient heat yields to contact hazards.
const playerVitals = new WeakMap<MiningPlayerState, Vitals<MiningCause, MiningPlayerState>>();

export function vitalsFor(p: MiningPlayerState): Vitals<MiningCause, MiningPlayerState> {
  let v = playerVitals.get(p);
  if (!v) {
    v = new Vitals<MiningCause, MiningPlayerState>(
      {
        maxHealth: 100,
        meters: {
          oxygen: {
            field: "oxygen",
            max: OXYGEN_MAX_TICKS,
            // Base rate 1: the "submerged" condition carries the biome's
            // oxygenDrainMul as its value, scaling the drain.
            drainRate: 1,
            drainWhen: "submerged",
            recoverRate: OXYGEN_REGEN_PER_TICK,
            depleteDamageRate: OXYGEN_DROWN_DAMAGE_PER_TICK,
            depleteDamageCause: DeathCause.Drowning,
          },
        },
        onDamage: (e, host) => {
          const c = e.cause;
          if (c === undefined) return;
          if (typeof c === "object") {
            // Ambient heat — a contact hazard already recorded this tick
            // takes priority (suffocation is the exception: heat overrides it).
            if (host.lastDamageMaterial !== 0 && host.lastDamageMaterial !== DeathCause.Suffocation) return;
            host.lastDamageMaterial = c.heat;
            return;
          }
          host.lastDamageMaterial = c;
        },
      },
      p,
    );
    playerVitals.set(p, v);
  }
  return v;
}

export function createMiningPlayer(worldX: number, worldY: number): MiningPlayerState {
  return {
    x: worldX,
    y: worldY,
    vx: 0,
    vy: 0,
    onGround: false,
    facing: 1,
    animFrame: 0,
    health: 100,
    lastDamageMaterial: 0,
    oxygen: OXYGEN_MAX_TICKS,
  };
}

function isSolidCell(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
  if (x < 0 || x >= W || y < 0 || y >= H) return true;
  const packed = grid[y * W + x];
  if (packed !== 0) {
    const def = MATERIALS[packed & 0xff];
    if (def?.solid) return true;
  }
  // Check background grid (scaffolding is solid in the background layer)
  const bgPacked = bgGrid[y * W + x];
  if (bgPacked !== 0) {
    const bgDef = MATERIALS[bgPacked & 0xff];
    if (bgDef?.solid) return true;
  }
  return false;
}

/**
 * Check if a cell is "hard" — a solid material that can NEVER fall
 * (MAT_GRAVITY_DIR === 0 AND lifetime === 0). These are the materials that
 * cause fall damage when the player lands on them: stone, walls, concrete,
 * scaffolding.
 *
 * Materials that CAN fall (grass, dirt, gravel, sand, ore — gravityDir != 0)
 * are "soft" and don't cause fall damage. This includes falling particles:
 * if the player lands on falling grass, the grass has gravityDir=1 so it's
 * treated as soft — no fall damage.
 *
 * Static solids (Stone, Wall) with a non-zero lifetime (loosened by mining)
 * are also "soft" — they're falling, so landing on them doesn't hurt.
 *
 * FLAG_UPDATED/FLAG_DETACHED can't be used because FLAG_UPDATED is cleared
 * at the end of each sim step (before player physics runs), and FLAG_DETACHED
 * is only set by mining/explosion code, not by the sim when a cell loses
 * support and starts falling. MAT_GRAVITY_DIR + lifetime reliably
 * distinguishes "can fall" from "can never fall."
 */
function isHardSolidCell(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
  if (x < 0 || x >= W || y < 0 || y >= H) return true; // out of bounds = wall
  const packed = grid[y * W + x];
  if (packed !== 0) {
    const mat = packed & 0xff;
    const def = MATERIALS[mat];
    if (def?.solid && MAT_GRAVITY_DIR[mat] === 0) {
      // Static solid — check if it's been loosened (lifetime > 0)
      return ((packed >> 8) & 0xff) === 0;
    }
  }
  // Background grid: scaffolding is solid and static (gravityDir=0).
  // Background cells don't have lifetimes, so gravityDir=0 alone is sufficient.
  const bgPacked = bgGrid[y * W + x];
  if (bgPacked !== 0) {
    const bgMat = bgPacked & 0xff;
    const bgDef = MATERIALS[bgMat];
    if (bgDef?.solid && MAT_GRAVITY_DIR[bgMat] === 0) return true;
  }
  return false;
}

/** Grid world adapter over the packed-material foreground + background grids. */
export function miningWorld(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number): GridCharacterWorld {
  return {
    w: W,
    h: H,
    isSolid: (x, y) => isSolidCell(grid, bgGrid, W, H, x, y),
    isHardSolid: (x, y) => isHardSolidCell(grid, bgGrid, W, H, x, y),
    isLiquid(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const packed = grid[y * W + x];
      if (packed === 0) return false;
      return !!MATERIALS[packed & 0xff]?.liquid;
    },
    isClimbable(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const packed = grid[y * W + x];
      if (packed !== 0 && MATERIALS[packed & 0xff]?.climbable) return true;
      const bgPacked = bgGrid[y * W + x];
      return bgPacked !== 0 && !!MATERIALS[bgPacked & 0xff]?.climbable;
    },
    // Wiggle escape can clear any solid except walls and collectibles (ore,
    // dirt, gravel, loose stone must be collected, not destroyed — otherwise
    // wiggleClear would waste materials and prevent suffocation when the
    // inventory is full).
    canWiggleClear(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const packed = grid[y * W + x];
      if (packed === 0) return false;
      const mat = packed & 0xff;
      if (mat === Material.Wall) return false;
      if (isCollectible(mat)) return false;
      return !!MATERIALS[mat]?.solid;
    },
    clearCell(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      grid[y * W + x] = 0;
    },
    // Fire/lava/plasma/burning oil are instant-contact hazards (1 dmg/tick).
    // Toxic gases are slower — 0.2 dmg/tick gives the player time to escape.
    damageAt(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return 0;
      const packed = grid[y * W + x];
      if (packed === 0) return 0;
      const m = packed & 0xff;
      if (HOT.has(m)) return { damage: 1, cause: m };
      if (GAS.has(m)) return { damage: 0.2, cause: m };
      return 0;
    },
  };
}

/**
 * Update the player's physics. The player's x/y are in active-grid-local coords
 * (the caller converts from/to world coords before/after this call).
 */
export function updateMiningPlayer(
  p: MiningPlayerState,
  input: MiningPlayerInput,
  grid: Uint32Array,
  bgGrid: Uint32Array,
  W: number,
  H: number,
  localX: number,
  localY: number,
  depthCells: number,
): void {
  // Work in local coords
  p.x = localX;
  p.y = localY;

  // Biome effects based on depth (meters below surface)
  const depthMeters = depthCells; // 1 cell ≈ 1m
  const biome = getBiomeEffect(depthMeters);

  const world = miningWorld(grid, bgGrid, W, H);
  controller.update(p as GridCharacterState, input, world, { gravityMul: biome.gravityMul });
  const px = p.x;
  const py = p.y;

  // Noclip skips all damage bookkeeping (the controller already returned
  // after free-flight + oxygen refill).
  if (input.noclip) { p.x = px; p.y = py; return; }

  // Biome heat damage — passive damage in the deepest biomes (Silver Depths
  // and below). Simulates ambient geothermal heat. The tagged {heat} cause
  // lets vitals.onDamage keep contact hazards (lava/fire) at higher priority;
  // Lava is recorded since there's no dedicated "heat" death cause.
  if (biome.heatDmgPerTick > 0) {
    vitalsFor(p).damage(biome.heatDmgPerTick, { heat: Material.Lava });
  }

  // Drowning — the oxygen meter drains while the player's head is submerged
  // (condition value scales the drain by biome oxygenDrainMul), deals drown
  // damage per tick at 0, and fast-refills when the head is above liquid.
  const headSubmerged = controller.isHeadInLiquid(world, px, py);
  vitalsFor(p).update(1, { submerged: headSubmerged ? biome.oxygenDrainMul : 0 });

  // Write back local coords (caller converts to world)
  // We store local coords back into p.x/p.y temporarily; the caller overwrites
  // them with world coords after this function returns.
  p.x = px;
  p.y = py;
}
