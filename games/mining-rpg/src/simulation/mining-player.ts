// ============================================================================
// Mining player physics — AABB collision against the active grid.
//
// Adapted from falling-sand's player.ts. The player position is in world cell
// coords, but collision checks use the active grid (local coords). The caller
// (ChunkWorld) converts between world and active-local before/after calling
// updateMiningPlayer.
// ============================================================================

import { Material, MATERIALS } from "@downdraft/library-sand";
import { isCollectible, PLAYER_H, PLAYER_W } from "../shared/constants";
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
const MAX_FALL = 0.8;

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

function isSolid(grid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
  if (x < 0 || x >= W || y < 0 || y >= H) return true;
  const packed = grid[y * W + x];
  if (packed === 0) return false;
  const def = MATERIALS[packed & 0xff];
  return !!def?.solid;
}

function boxHitsSolid(grid: Uint32Array, W: number, H: number, px: number, py: number): boolean {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (isSolid(grid, W, H, x, y)) return true;
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
 * Count how many solid cells overlap the player's body AABB.
 * Returns { solid, total } where total is the number of cells in the AABB.
 */
function countSolidOverlap(grid: Uint32Array, W: number, H: number, px: number, py: number): { solid: number; total: number } {
  const x0 = Math.floor(px - PLAYER_W / 2);
  const x1 = Math.floor(px + PLAYER_W / 2);
  const y0 = Math.floor(py);
  const y1 = Math.floor(py + PLAYER_H - 1);
  let solid = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      total++;
      if (isSolid(grid, W, H, x, y)) solid++;
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

  // Check how buried the player is at the start of this tick
  const overlap = countSolidOverlap(grid, W, H, px, py);
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

  // Jump
  if (input.jump && p.onGround) {
    p.vy = -JUMP_FORCE;
    p.onGround = false;
  }
  // Swim up
  if (input.up && inLiquid) p.vy -= 0.05;
  if (input.down && inLiquid) p.vy += 0.05;

  // Gravity
  p.vy += GRAVITY - buoyancy;
  if (inLiquid) p.vy *= 0.92;
  p.vy = Math.min(MAX_FALL, p.vy);

  // Move X with collision
  const newX = px + p.vx;
  if (!boxHitsSolid(grid, W, H, newX, py)) {
    px = newX;
  } else if (partiallyBuried && Math.abs(p.vx) > 0.01) {
    // Partially buried: wiggle clear a few cells in the movement direction
    const dirX = p.vx > 0 ? 1 : -1;
    const cleared = wiggleClear(grid, W, H, px, py, dirX, 2);
    if (cleared > 0 && !boxHitsSolid(grid, W, H, newX, py)) {
      px = newX;
    } else {
      p.vx = 0;
    }
  } else {
    // Try stepping up 1 cell
    if (p.onGround && !boxHitsSolid(grid, W, H, newX, py - 1)) {
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

  // Move Y with collision
  const newY = py + p.vy;
  if (!boxHitsSolid(grid, W, H, px, newY)) {
    py = newY;
    p.onGround = false;
  } else {
    if (p.vy > 0) p.onGround = true;
    p.vy = 0;
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
