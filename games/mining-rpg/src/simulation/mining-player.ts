// ============================================================================
// Mining player physics — AABB collision against the active grid.
//
// Adapted from falling-sand's player.ts. The player position is in world cell
// coords, but collision checks use the active grid (local coords). The caller
// (ChunkWorld) converts between world and active-local before/after calling
// updateMiningPlayer.
// ============================================================================

import { Material, MATERIALS } from "@downdraft/library-sand";
import { PLAYER_H, PLAYER_W } from "../shared/constants";
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
const JUMP_FORCE = 0.55;
const MAX_FALL = 0.8;

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
  p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx));

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
      }
    }
  }

  // Write back local coords (caller converts to world)
  // We store local coords back into p.x/p.y temporarily; the caller overwrites
  // them with world coords after this function returns.
  p.x = px;
  p.y = py;
}
