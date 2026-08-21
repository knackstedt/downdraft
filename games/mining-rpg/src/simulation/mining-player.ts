// ============================================================================
// Mining player physics — AABB collision against the active grid.
//
// Adapted from falling-sand's player.ts. The player position is in world cell
// coords, but collision checks use the active grid (local coords). The caller
// (ChunkWorld) converts between world and active-local before/after calling
// updateMiningPlayer.
// ============================================================================

import { MAT_GRAVITY_DIR, Material, MATERIALS } from "@downdraft/library-sand";
import { CLIMB_SPEED, DeathCause, FALL_DAMAGE_SCALE, FALL_DAMAGE_THRESHOLD, isCollectible, OXYGEN_DROWN_DAMAGE_PER_TICK, OXYGEN_MAX_TICKS, OXYGEN_REGEN_PER_TICK, PLAYER_H, PLAYER_W } from "../shared/constants";
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
 * Check if the player's HEAD is submerged in liquid. The head is the top row
 * of the player's AABB (py = top). Only head submersion causes drowning —
 * standing waist-deep in water is safe. Returns true if any cell in the top
 * row of the AABB is a liquid material.
 */
function isHeadInLiquid(grid: Uint32Array, W: number, H: number, px: number, py: number): boolean {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y = Math.floor(py); // top row = head
  if (y < 0 || y >= H) return false;
  for (let x = x0; x <= x1; x++) {
    if (x < 0 || x >= W) continue;
    const packed = grid[y * W + x];
    if (packed === 0) continue;
    if (MATERIALS[packed & 0xff]?.liquid) return true;
  }
  return false;
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
function isHardSolid(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
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

/**
 * Count how many "hard" solid cells (can never fall) overlap the player's
 * body AABB. Used for the crush-damage check: only being fully encased in
 * hard materials (stone, walls) causes suffocation.
 */
function countHardSolidOverlap(grid: Uint32Array, bgGrid: Uint32Array, W: number, H: number, px: number, py: number): { solid: number; total: number } {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  let solid = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      total++;
      if (isHardSolid(grid, bgGrid, W, H, x, y)) solid++;
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

  // --- Noclip (development cheat) ---
  // When active: free flight through terrain. No gravity, no collision, no
  // damage, no drowning. WASD + Space/Up = up, Down = down. The player still
  // faces left/right so mining/building works normally while noclip is on.
  if (input.noclip) {
    let vx = 0;
    let vy = 0;
    if (input.left) { vx -= 1; p.facing = -1; }
    if (input.right) { vx += 1; p.facing = 1; }
    if (input.up || input.jump) vy -= 1;
    if (input.down) vy += 1;
    // Normalize diagonal so speed is consistent in all directions
    const len = Math.hypot(vx, vy);
    if (len > 0) {
      vx = (vx / len) * NOCLIP_SPEED;
      vy = (vy / len) * NOCLIP_SPEED;
    }
    px += vx;
    py += vy;
    // Clamp to active grid bounds (don't fly out of the simulated window —
    // the active grid rebuilds as the player crosses chunk boundaries, so
    // this just prevents rendering garbage outside the grid).
    px = Math.max(PLAYER_W / 2, Math.min(W - PLAYER_W / 2 - 1, px));
    py = Math.max(0, Math.min(H - PLAYER_H, py));
    p.vx = vx;
    p.vy = vy;
    p.onGround = false;
    p.animFrame++;
    // Refill oxygen while noclip is on (no drowning)
    p.oxygen = OXYGEN_MAX_TICKS;
    p.x = px;
    p.y = py;
    return;
  }

  const liquidCount = countLiquid(grid, W, H, px, py);
  const inLiquid = liquidCount >= 2;
  const buoyancy = inLiquid ? Math.min(0.06, liquidCount * 0.008) : 0;
  // Climbable (ladder/rope) overlap — suspends gravity and enables climbing.
  // Checks both foreground and background grids (ladders/ropes are in the bg).
  const climbCount = countClimbable(grid, bgGrid, W, H, px, py);
  const onClimb = climbCount > 0;

  // Check how buried the player is at the start of this tick.
  // - partiallyBuried: ANY solid overlap (including falling particles) →
  //   restricts movement to wiggle speed so the player can push through debris.
  // - fullyBuried: ALL body cells are HARD solid (can never fall — stone,
  //   walls, etc.) → crush damage. Falling debris (grass, gravel, ore) landing
  //   on the player won't crush them — only a static cave-in does.
  const overlap = countSolidOverlap(grid, bgGrid, W, H, px, py);
  const hardOverlap = countHardSolidOverlap(grid, bgGrid, W, H, px, py);
  const fullyBuried = hardOverlap.solid >= hardOverlap.total;
  const partiallyBuried = overlap.solid > 0 && !fullyBuried;

  // If fully buried, take crush damage
  if (fullyBuried) {
    p.health = Math.max(0, p.health - BURY_DAMAGE_PER_TICK);
    p.lastDamageMaterial = DeathCause.Suffocation;
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
  //
  // Fall damage is only applied when the player lands on "hard" materials
  // (MAT_GRAVITY_DIR === 0: stone, walls, scaffolding). "Soft" materials
  // (grass, dirt, gravel — gravityDir != 0) cushion the fall. This prevents
  // instant death from landing on falling particles (e.g. falling grass),
  // which can't be distinguished from static grass by flags (FLAG_UPDATED is
  // cleared at the end of each sim step, FLAG_DETACHED is only set by
  // mining/explosion — not by the sim when a cell loses support).
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
            // Fall damage: if the player landed with high vertical velocity,
            // apply damage proportional to the excess speed above the safe
            // landing threshold. The velocity is captured before zeroing.
            const fallSpeed = p.vy;
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
            // Apply fall damage only if the player landed on "hard" material
            // (MAT_GRAVITY_DIR === 0: stone, walls, scaffolding). "Soft"
            // materials (grass, dirt, gravel — gravityDir != 0) cushion
            // the fall. This prevents instant death from landing on falling
            // particles (e.g. falling grass) which can't be distinguished
            // from static grass by flags alone.
            if (fallSpeed > FALL_DAMAGE_THRESHOLD) {
              // Check the cells directly below the player's feet — if ANY
              // is a hard solid, the fall damage applies.
              const feetY = Math.floor(py + PLAYER_H);
              const fx0 = Math.floor(px - PLAYER_W / 2);
              const fx1 = Math.floor(px + PLAYER_W / 2);
              let landedOnHard = false;
              for (let x = fx0; x <= fx1; x++) {
                if (isHardSolid(grid, bgGrid, W, H, x, feetY)) { landedOnHard = true; break; }
              }
              if (landedOnHard) {
                const excess = fallSpeed - FALL_DAMAGE_THRESHOLD;
                const damage = Math.round(excess * excess * FALL_DAMAGE_SCALE);
                if (damage > 0) {
                  p.health = Math.max(0, p.health - damage);
                  p.lastDamageMaterial = DeathCause.Falling;
                }
              }
            }
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

  // Damage from fire/lava/gas contact.
  // Fire/lava/plasma/burning oil are instant-contact hazards (1 dmg/tick =
  // 60 dmg/sec, kills in ~1.7s). Toxic gases are slower — they poison rather
  // than incinerate, giving the player time to escape (0.2 dmg/tick = 12
  // dmg/sec, kills in ~8s).
  const cx = Math.floor(px);
  for (let dy = 0; dy < PLAYER_H; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx;
      const gy = Math.floor(py) + dy;
      if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
      const m = grid[gy * W + gx] & 0xff;
      const isGas = m === Material.MethaneGas || m === Material.SulfurGas;
      if (
        m === Material.Fire ||
        m === Material.Lava ||
        m === Material.Plasma ||
        m === Material.FuseFire ||
        m === Material.BurningOil ||
        isGas
      ) {
        // Gas damage accumulates fractionally (0.2/tick) so it's tracked
        // with a float; health is floored for display. Non-gas hazards
        // deal 1/tick as before.
        const dmg = isGas ? 0.2 : 1;
        p.health = Math.max(0, p.health - dmg);
        p.lastDamageMaterial = m;
      }
    }
  }

  // Drowning — oxygen bar ticks down while the player's head is submerged in
  // liquid. Once depleted, the player takes damage per tick until they surface
  // or die. Oxygen regenerates quickly when the head is above liquid.
  const headSubmerged = isHeadInLiquid(grid, W, H, px, py);
  if (headSubmerged) {
    p.oxygen = Math.max(0, (p.oxygen ?? OXYGEN_MAX_TICKS) - 1);
    if (p.oxygen === 0) {
      // Out of breath — take drowning damage
      p.health = Math.max(0, p.health - OXYGEN_DROWN_DAMAGE_PER_TICK);
      p.lastDamageMaterial = DeathCause.Drowning;
    }
  } else {
    // Regenerate oxygen when above liquid (fast refill)
    p.oxygen = Math.min(OXYGEN_MAX_TICKS, (p.oxygen ?? OXYGEN_MAX_TICKS) + OXYGEN_REGEN_PER_TICK);
  }

  // Write back local coords (caller converts to world)
  // We store local coords back into p.x/p.y temporarily; the caller overwrites
  // them with world coords after this function returns.
  p.x = px;
  p.y = py;
}
