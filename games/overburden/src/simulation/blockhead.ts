// ============================================================================
// Overburden — blockhead entity (physics, attributes, animation state)
//
// Adapted from mining-rpg's MiningPlayer pattern:
// - AABB collision against foreground solid blocks in the active grid
// - Gravity, friction, acceleration, jump
// - Climbable blocks (ladder/rope) suspend gravity + enable vertical movement
// - Liquid blocks slow movement + drain air bar
// - 6 attribute bars: health, happiness, hunger, energy, environment, air
// ============================================================================

import { getBlockMask } from "../shared/block-registry";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_LAVA, BLOCK_WATER,
    MASK_CLIMBABLE, MASK_LIQUID, MASK_SOLID,
} from "../shared/constants";
import type { BlockheadAnimState, BlockheadState } from "../shared/types";
import { getBlockFromPacked } from "./fluid-sim";

// --- Physics constants ---
const GRAVITY = 0.04;
const MOVE_ACCEL = 0.08;
const MAX_SPEED = 0.35;
const FRICTION = 0.85;
const JUMP_FORCE = 0.225;
const MAX_FALL = 2.5;
const COLLISION_STEP = 0.9;
const CLIMB_SPEED = 0.25;
const SWIM_SPEED = 0.18;
const LIQUID_DRAG = 0.7;
const NOCLIP_SPEED = 3.0;

// --- Blockhead dimensions (in blocks) ---
// The blockhead is 1 block wide and 1.95 blocks tall — slightly under 2 so
// it fits through 2-block-high gaps without intermittent collision from
// floating-point rounding. The visual box is still rendered at 2 tall.
export const BH_W = 0.7;
export const BH_H = 1.95;

// --- Input structure (read from SAB each tick) ---
export interface BlockheadInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  noclip: boolean;
  // Mining/placing target (world coords, -1 = no action)
  mineX: number;
  mineY: number;
  placeX: number;
  placeY: number;
  placeBlockId: number;
}

export function createDefaultInput(): BlockheadInput {
  return {
    left: false, right: false, up: false, down: false,
    jump: false, noclip: false,
    mineX: -1, mineY: -1, placeX: -1, placeY: -1, placeBlockId: 0,
  };
}

// --- Factory ---
export function createBlockhead(worldX: number, worldY: number): BlockheadState {
  return {
    id: 0,
    x: worldX,
    y: worldY,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: false,
    health: 100,
    happiness: 100,
    hunger: 100,
    energy: 100,
    environment: 100,
    air: 100,
    animState: "idle",
    animTime: 0,
  };
}

// --- Helpers ---

/** Check if a block ID is solid (blocks movement). */
function isSolidBlock(packedBlockId: number): boolean {
  const blockId = getBlockFromPacked(packedBlockId);
  if (blockId === BLOCK_AIR) return false;
  return (getBlockMask(blockId) & MASK_SOLID) !== 0;
}

/** Check if a block ID is climbable (ladder, rope). */
function isClimbableBlock(packedBlockId: number): boolean {
  const blockId = getBlockFromPacked(packedBlockId);
  return (getBlockMask(blockId) & MASK_CLIMBABLE) !== 0;
}

/** Check if a block ID is liquid (water, lava). */
function isLiquidBlock(packedBlockId: number): boolean {
  const blockId = getBlockFromPacked(packedBlockId);
  return (getBlockMask(blockId) & MASK_LIQUID) !== 0;
}

/** Check if a block ID is a damaging liquid (lava). */
function isDamagingBlock(packedBlockId: number): boolean {
  const blockId = getBlockFromPacked(packedBlockId);
  return blockId === BLOCK_LAVA;
}

/**
 * Check if the AABB (x, y, x+BH_W, y+BH_H) overlaps any solid block
 * in the active grid. Coordinates are in active-grid space.
 */
function boxHitsSolid(
  x: number, y: number,
  fg: Uint16Array,
): boolean {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.floor(x + BH_W - 0.001);
  const y1 = Math.floor(y + BH_H - 0.001);
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
      if (isSolidBlock(fg[cy * ACTIVE_GRID_W + cx])) return true;
    }
  }
  return false;
}

/** Count liquid cells overlapping the AABB. */
function countLiquid(x: number, y: number, fg: Uint16Array): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.floor(x + BH_W - 0.001);
  const y1 = Math.floor(y + BH_H - 0.001);
  let count = 0;
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
      if (isLiquidBlock(fg[cy * ACTIVE_GRID_W + cx])) count++;
    }
  }
  return count;
}

/** Check if the blockhead's head (top row) is submerged in liquid. */
function isHeadInLiquid(x: number, y: number, fg: Uint16Array): boolean {
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + BH_W - 0.001);
  const headY = Math.floor(y);
  if (headY < 0 || headY >= ACTIVE_GRID_H) return false;
  for (let cx = x0; cx <= x1; cx++) {
    if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
    if (isLiquidBlock(fg[headY * ACTIVE_GRID_W + cx])) return true;
  }
  return false;
}

/** Count climbable cells overlapping the AABB. */
function countClimbable(x: number, y: number, fg: Uint16Array): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.floor(x + BH_W - 0.001);
  const y1 = Math.floor(y + BH_H - 0.001);
  let count = 0;
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
      if (isClimbableBlock(fg[cy * ACTIVE_GRID_W + cx])) count++;
    }
  }
  return count;
}

/** Check if any cell in the AABB is damaging (lava). */
function touchesDamaging(x: number, y: number, fg: Uint16Array): boolean {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.floor(x + BH_W - 0.001);
  const y1 = Math.floor(y + BH_H - 0.001);
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
      if (isDamagingBlock(fg[cy * ACTIVE_GRID_W + cx])) return true;
    }
  }
  return false;
}

// --- Main physics update ---
// Coordinates: bh.x/bh.y are in active-grid space (0..ACTIVE_GRID_W).
// The fg array is the active grid foreground.
export function updateBlockhead(
  bh: BlockheadState,
  input: BlockheadInput,
  fg: Uint16Array,
  dt: number,
): void {
  const ax = bh.x;
  const ay = bh.y;

  // --- Noclip mode (debug) ---
  if (input.noclip) {
    bh.vx = 0;
    bh.vy = 0;
    if (input.left) { bh.vx = -NOCLIP_SPEED; bh.facing = -1; }
    if (input.right) { bh.vx = NOCLIP_SPEED; bh.facing = 1; }
    if (input.up) bh.vy = -NOCLIP_SPEED;
    if (input.down) bh.vy = NOCLIP_SPEED;
    bh.x += bh.vx;
    bh.y += bh.vy;
    bh.onGround = false;
    bh.animState = "fall";
    bh.animTime += dt;
    return;
  }

  // --- Environment detection ---
  const liquidCount = countLiquid(ax, ay, fg);
  const climbCount = countClimbable(ax, ay, fg);
  const inLiquid = liquidCount > 0;
  const onLadder = climbCount > 0;
  const headSubmerged = isHeadInLiquid(ax, ay, fg);

  // --- Damage ---
  if (touchesDamaging(ax, ay, fg)) {
    bh.health -= 2;
  }

  // --- Air bar (drowning) ---
  if (headSubmerged) {
    bh.air -= 0.5;
    if (bh.air <= 0) {
      bh.air = 0;
      bh.health -= 1;
    }
  } else {
    bh.air = Math.min(100, bh.air + 2);
  }

  // --- Horizontal movement ---
  let accel = MOVE_ACCEL;
  let maxSpd = MAX_SPEED;
  if (inLiquid) {
    accel *= LIQUID_DRAG;
    maxSpd *= SWIM_SPEED / MAX_SPEED;
  }

  if (input.left) {
    bh.vx -= accel;
    bh.facing = -1;
  }
  if (input.right) {
    bh.vx += accel;
    bh.facing = 1;
  }

  // Friction
  if (!input.left && !input.right) {
    bh.vx *= FRICTION;
    if (Math.abs(bh.vx) < 0.01) bh.vx = 0;
  }

  // Clamp horizontal speed
  bh.vx = Math.max(-maxSpd, Math.min(maxSpd, bh.vx));

  // --- Vertical movement ---
  // Climbing (ladder/rope): suspend gravity, allow up/down
  if (onLadder) {
    bh.vy = 0;
    if (input.up) bh.vy = -CLIMB_SPEED;
    if (input.down) bh.vy = CLIMB_SPEED;
  } else if (inLiquid) {
    // Swimming: buoyancy counteracts gravity, can swim up/down
    if (input.up || input.jump) {
      bh.vy = -SWIM_SPEED;
    } else if (input.down) {
      bh.vy = SWIM_SPEED;
    } else {
      // Slow sink
      bh.vy += GRAVITY * 0.3;
      if (bh.vy > MAX_FALL * 0.3) bh.vy = MAX_FALL * 0.3;
    }
  } else {
    // Normal gravity
    if (input.jump && bh.onGround) {
      bh.vy = -JUMP_FORCE;
      bh.onGround = false;
    }
    bh.vy += GRAVITY;
    if (bh.vy > MAX_FALL) bh.vy = MAX_FALL;
  }

  // --- Collision: X axis ---
  const stepX = bh.vx;
  const newX = bh.x + stepX;
  if (!boxHitsSolid(newX, bh.y, fg)) {
    bh.x = newX;
  } else {
    // Try stepping up 1 block (auto-step)
    if (bh.onGround && !boxHitsSolid(newX, bh.y - 1, fg)) {
      bh.x = newX;
      bh.y -= 1;
    } else {
      bh.vx = 0;
    }
  }

  // --- Collision: Y axis (sub-stepped to prevent tunneling) ---
  const stepY = bh.vy;
  const steps = Math.max(1, Math.ceil(Math.abs(stepY) / COLLISION_STEP));
  const subStep = stepY / steps;
  let landed = false;
  for (let i = 0; i < steps; i++) {
    const testY = bh.y + subStep;
    if (!boxHitsSolid(bh.x, testY, fg)) {
      bh.y = testY;
    } else {
      if (subStep < 0) {
        // Hit ceiling
        bh.vy = 0;
      } else {
        // Landed on ground
        bh.vy = 0;
        landed = true;
      }
      break;
    }
  }
  bh.onGround = landed;

  // --- Animation state ---
  const moving = Math.abs(bh.vx) > 0.05;
  if (onLadder && (input.up || input.down)) {
    bh.animState = "climb";
  } else if (inLiquid) {
    bh.animState = "swim";
  } else if (!bh.onGround) {
    bh.animState = "fall";
  } else if (moving) {
    bh.animState = "walk";
  } else {
    bh.animState = "idle";
  }
  bh.animTime += dt;

  // --- Attribute decay (slow) ---
  bh.hunger -= 0.002;
  bh.energy -= 0.001;
  if (bh.hunger <= 0) {
    bh.hunger = 0;
    bh.health -= 0.1;
  }
  if (bh.energy <= 0) {
    bh.energy = 0;
  }
  bh.health = Math.max(0, Math.min(100, bh.health));
  bh.hunger = Math.max(0, Math.min(100, bh.hunger));
  bh.energy = Math.max(0, Math.min(100, bh.energy));
  bh.happiness = Math.max(0, Math.min(100, bh.happiness));
  bh.environment = Math.max(0, Math.min(100, bh.environment));
}

// --- Mining ---
// Returns the block ID that was mined (0 if nothing mined), or -1 if still in progress.
// The worker tracks per-block damage in a separate map.
export function getMineTarget(
  bh: BlockheadState,
  mouseX: number,
  mouseY: number,
  fg: Uint16Array,
): { x: number; y: number; blockId: number } | null {
  // Simple: mine the block at the mouse position if it's within reach
  const bhCx = bh.x + BH_W / 2;
  const bhCy = bh.y + BH_H / 2;
  const dx = mouseX - bhCx;
  const dy = mouseY - bhCy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const REACH = 6; // 6 blocks reach
  if (dist > REACH) return null;

  const mx = Math.floor(mouseX);
  const my = Math.floor(mouseY);
  if (mx < 0 || mx >= ACTIVE_GRID_W || my < 0 || my >= ACTIVE_GRID_H) return null;
  const packedBlockId = fg[my * ACTIVE_GRID_W + mx];
  const blockId = getBlockFromPacked(packedBlockId);
  if (blockId === BLOCK_AIR) return null;
  if (blockId === BLOCK_WATER || blockId === BLOCK_LAVA) return null;
  return { x: mx, y: my, blockId };
}

// --- Animation helpers ---
export function getAnimFrame(bh: BlockheadState): number {
  // Convert animTime to a walk-cycle frame number
  const cycleSpeed = 8; // frames per second
  return Math.floor(bh.animTime * cycleSpeed) % 4;
}

export function animStateToPose(state: BlockheadAnimState): string {
  return state;
}
