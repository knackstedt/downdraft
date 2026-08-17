// ============================================================================
// Mining player physics — AABB collision against the active grid.
//
// Adapted from falling-sand's player.ts. The player position is in world cell
// coords, but collision checks use the active grid (local coords). The caller
// (ChunkWorld) converts between world and active-local before/after calling
// updateMiningPlayer.
// ============================================================================

import { Material, MATERIALS } from "@downdraft/library-sand";
import { CLIMB_SPEED, isCollectible, PLAYER_H, PLAYER_W } from "../shared/constants";
import type { MiningPlayerState } from "../shared/types";

export interface MiningPlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
}

const GRAVITY = 0.08;
const MOVE_ACCEL = 0.12;
const MAX_SPEED = 0.6;
const FRICTION = 0.85;
const JUMP_FORCE = 1.25;
// Terminal fall velocity. With GRAVITY=0.08, the player accelerates over ~1s
// (31 ticks) before reaching this cap — giving falls a sense of inertia and
// weight instead of snapping to max speed in 0.33s.
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
const BURY_MATERIAL = Material.Stone; // death cause for crushing

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
  };
}

function isSolid(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
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

function boxHitsSolid(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, px: number, py: number): boolean {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (isSolid(grid, bgGrid, W, H, x, y)) return true;
    }
  }
  return false;
}

function countLiquid(grid: Uint32Array, W: number, H: number, px: number, py: number): number {
  let n = 0;
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const packed = grid[y * W + x];
      if (packed === 0) continue;
      if (MATERIALS[packed & 0xff]?.liquid) n++;
    }
  }
  return n;
}

/**
 * Count climbable cells (ladders/ropes) overlapping the player's body AABB.
 * While > 0, the player is "on a climbable" — gravity is suspended and up/down
 * moves the player vertically. Ladders/ropes are non-solid, so the player
 * already passes through them via the normal collision check; this only adds
 * the climb behavior.
 */
function countClimbable(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, px: number, py: number): number {
  let n = 0;
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      // Check foreground grid
      const packed = grid[y * W + x];
      if (packed !== 0 && MATERIALS[packed & 0xff]?.climbable) n++;
      // Check background grid (ladders/ropes are in the background)
      const bgPacked = bgGrid[y * W + x];
      if (bgPacked !== 0 && MATERIALS[bgPacked & 0xff]?.climbable) n++;
    }
  }
  return n;
}

/**
 * Count how many solid cells overlap the player's body AABB.
 * Returns { solid, total } where total is the number of cells in the AABB.
 */
function countSolidOverlap(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, px: number, py: number): { solid: number; total: number } {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  let solid = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      total++;
      if (isSolid(grid, bgGrid, W, H, x, y)) solid++;
    }
  }
  return { solid, total };
}

/**
 * Clear solid cells overlapping the player's body so they can wiggle out.
 * Only clears a few cells per tick (slow escape). Prioritizes cells in the
 * direction the player is trying to move.
 */
function wiggleClear(grid: Uint32Array, W: number, H: number, px: number, py: number, dirX: number, maxClear: number): number {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  let cleared = 0;
  // Clear from the leading edge (in the direction of movement) first
  const xs = dirX > 0 ? [x1, x1 - 1, x0] : dirX < 0 ? [x0, x0 + 1, x1] : [x0, x1];
  for (const x of xs) {
    if (cleared >= maxClear) break;
    for (let y = y0; y <= y1; y++) {
      if (cleared >= maxClear) break;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const idx = y * W + x;
      const packed = grid[idx];
      if (packed === 0) continue;
      const mat = packed & 0xff;
      if (mat === Material.Wall) continue; // can't wiggle through walls
      // Don't destroy collectible materials (ore, dirt, gravel, loose stone).
      // The player must collect them (if inventory has space) or suffocate.
      // Without this, wiggleClear would destroy debris without collecting it,
      // wasting materials and preventing suffocation when inventory is full.
      if (isCollectible(mat)) continue;
      const def = MATERIALS[mat];
      if (!def?.solid) continue;
      grid[idx] = 0; // clear the cell so the player can move
      cleared++;
    }
  }
  return cleared;
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
): void {
  // Work in local coords
  let px = localX;
  let py = localY;

  const liquidCount = countLiquid(grid, W, H, px, py);
  const inLiquid = liquidCount >= 2;
  const buoyancy = inLiquid ? Math.min(0.06, liquidCount * 0.008) : 0;
  // Climbable (ladder/rope) overlap — suspends gravity and enables climbing.
  // Checks both foreground and background grids (ladders/ropes are in the bg).
  const climbCount = countClimbable(grid, bgGrid, W, H, px, py);
  const onClimb = climbCount > 0;

  // Check how buried the player is at the start of this tick
  const overlap = countSolidOverlap(grid, bgGrid, W, H, px, py);
  const fullyBuried = overlap.solid >= overlap.total; // every body cell is solid
  const partiallyBuried = overlap.solid > 0 && !fullyBuried;

  // If fully buried, take crush damage
  if (fullyBuried) {
    p.health = Math.max(0, p.health - BURY_DAMAGE_PER_TICK);
    p.lastDamageMaterial = BURY_MATERIAL;
  }

  // Horizontal movement
  if (input.left) {
    p.vx -= MOVE_ACCEL;
    p.facing = -1;
  }
  if (input.right) {
    p.vx += MOVE_ACCEL;
    p.facing = 1;
  }
  if (!input.left && !input.right) p.vx *= FRICTION;
  // Cap speed: if partially buried, the player can only wiggle slowly
  const speedCap = partiallyBuried ? BURY_WIGGLE_SPEED : MAX_SPEED;
  p.vx = Math.max(-speedCap, Math.min(speedCap, p.vx));

  // Jump (from ground or while clinging to a climbable — dismount upward)
  if (input.jump && (p.onGround || onClimb)) {
    p.vy = -JUMP_FORCE;
    p.onGround = false;
  }
  // Climb: while overlapping a ladder/rope, up/down moves vertically and
  // gravity is suspended. With no vertical input the player clings (dampens).
  if (onClimb) {
    if (input.up) {
      p.vy = -CLIMB_SPEED;
    } else if (input.down) {
      p.vy = CLIMB_SPEED;
    } else {
      p.vy *= CLING_DAMP;
    }
  }
  // Swim up
  if (input.up && inLiquid) p.vy -= 0.05;
  if (input.down && inLiquid) p.vy += 0.05;

  // Gravity — suspended while clinging/climbing up a ladder (onClimb && !down).
  // Climbing down lets gravity assist so the player accelerates downward
  // naturally off the bottom of a ladder.
  // Also suspended when onGround (and not jumping — jumping already set
  // onGround=false above). This prevents the 1-cell jitter where gravity
  // pulls the player down a fraction each tick, they collide, snap, and
  // repeat. The player stays planted on the ground until they jump or the
  // ground is removed (detected in the Y-move section below).
  if (onClimb && !input.down) {
    // no gravity
  } else if (p.onGround) {
    // Resting on ground — don't apply gravity
    p.vy = 0;
  } else {
    p.vy += GRAVITY - buoyancy;
  }
  if (inLiquid) p.vy *= 0.92;
  p.vy = Math.min(MAX_FALL, p.vy);

  // Move X with collision
  const newX = px + p.vx;
  if (!boxHitsSolid(grid, bgGrid, W, H, newX, py)) {
    px = newX;
  } else if (partiallyBuried && Math.abs(p.vx) > 0.01) {
    // Partially buried: wiggle clear a few cells in the movement direction
    const dirX = p.vx > 0 ? 1 : -1;
    const cleared = wiggleClear(grid, W, H, px, py, dirX, 2);
    if (cleared > 0 && !boxHitsSolid(grid, bgGrid, W, H, newX, py)) {
      px = newX;
    } else {
      p.vx = 0;
    }
  } else {
    // Try stepping up 1 cell
    if (p.onGround && !boxHitsSolid(grid, bgGrid, W, H, newX, py - 1)) {
      px = newX;
      py -= 1;
    } else {
      p.vx = 0;
    }
  }

  // Clamp X to active grid
  if (px < PLAYER_W / 2) {
    px = PLAYER_W / 2;
    p.vx = 0;
  }
  if (px > W - PLAYER_W / 2 - 1) {
    px = W - PLAYER_W / 2 - 1;
    p.vx = 0;
  }

  // Move Y with collision — sub-stepped so high fall speeds (up to MAX_FALL)
  // can't tunnel through 1-cell-thick floors. When a downward collision is
  // detected, a binary-search fine-snap places the player's feet exactly on
  // the ground surface (no gap, no settle jitter). When vy=0 and the player
  // was on ground, check if the ground is still below — if it was mined/removed
  // the player starts falling.
  {
    const totalDy = p.vy;
    if (totalDy === 0) {
      // No vertical velocity — if we were on ground, verify the ground is
      // still there. If it was removed (mined, exploded, flowed away), start
      // falling. This also keeps onGround=true while resting (no oscillation).
      if (p.onGround) {
        const feetY = Math.floor(py + PLAYER_H);
        const fx0 = Math.floor(px - PLAYER_W / 2);
        const fx1 = Math.floor(px + PLAYER_W / 2);
        let groundBelow = false;
        for (let x = fx0; x <= fx1; x++) {
          if (isSolid(grid, bgGrid, W, H, x, feetY)) { groundBelow = true; break; }
        }
        p.onGround = groundBelow;
      }
    } else {
      const steps = Math.ceil(Math.abs(totalDy) / COLLISION_STEP);
      const stepDy = totalDy / steps;
      p.onGround = false;
      for (let s = 0; s < steps; s++) {
        const newY = py + stepDy;
        if (!boxHitsSolid(grid, bgGrid, W, H, px, newY)) {
          py = newY;
        } else {
          if (p.vy > 0) {
            p.onGround = true;
            // Fine-snap: binary search between the last safe position (py)
            // and the colliding position (newY) to find the closest resting
            // position. 5 iterations → precision ~0.028 cells (invisible).
            let lo = py, hi = newY;
            for (let i = 0; i < 5; i++) {
              const mid = (lo + hi) * 0.5;
              if (boxHitsSolid(grid, bgGrid, W, H, px, mid)) hi = mid;
              else lo = mid;
            }
            py = lo;
          }
          p.vy = 0;
          break;
        }
      }
    }
  }

  // Clamp Y
  if (py < 0) {
    py = 0;
    p.vy = 0;
  }
  if (py > H - PLAYER_H) {
    py = H - PLAYER_H;
    p.vy = 0;
    p.onGround = true;
  }

  // Animation
  if (Math.abs(p.vx) > 0.01 || !p.onGround) p.animFrame++;
  else p.animFrame = 0;

  // Damage from fire/lava/gas contact
  const cx = Math.floor(px);
  for (let dy = 0; dy < PLAYER_H; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx;
      const gy = Math.floor(py) + dy;
      if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
      const m = grid[gy * W + gx] & 0xff;
      if (
        m === Material.Fire ||
        m === Material.Lava ||
        m === Material.Plasma ||
        m === Material.FuseFire ||
        m === Material.BurningOil ||
        m === Material.MethaneGas ||
        m === Material.SulfurGas
      ) {
        p.health = Math.max(0, p.health - 1);
        p.lastDamageMaterial = m;
      }
    }
  }

  // Write back local coords (caller converts to world)
  // We store local coords back into p.x/p.y temporarily; the caller overwrites
  // them with world coords after this function returns.
  p.x = px;
  p.y = py;
}
