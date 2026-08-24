// ============================================================================
// Overburden — blockhead entity (physics, attributes, animation state)
//
// Adapted from mining-rpg's MiningPlayer pattern:
// - AABB collision against foreground solid blocks in the active grid
// - Gravity, friction, acceleration, jump
// - Climbable blocks (ladder/rope) suspend gravity + enable vertical movement
// - Liquid blocks slow movement + drain air bar
// - Wall climbing: press up against a solid wall to climb slowly
// - Back wall climbing: press up near a background wall to climb even slower
// - Crawling: move horizontally through 1-block-high gaps at reduced speed
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
// "Monkey" movement: wall climbing, back wall climbing, crawling
const WALL_CLIMB_SPEED = 0.12;   // climbing a solid foreground wall (slow)
const BG_WALL_CLIMB_SPEED = 0.06; // climbing a background wall (slower)
const CRAWL_SPEED = 0.15;         // crawling through 1-high gaps
const CRAWL_ACCEL = 0.04;
// Stamina (energy) drain while climbing. When energy reaches 0, the blockhead
// can no longer climb or hold onto walls and falls/slides instead.
const WALL_CLIMB_STAMINA = 0.8;  // energy/sec while actively climbing up
const WALL_HOLD_STAMINA = 0.4;   // energy/sec while holding position on a wall

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
    mantleActive: false,
    mantleTime: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleToX: 0,
    mantleToY: 0,
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

/**
 * Check if there's a solid wall adjacent to the blockhead on the given side.
 * side: -1 = left wall, +1 = right wall.
 * Checks the column of blocks immediately next to the blockhead's AABB.
 */
function hasWallAt(x: number, y: number, fg: Uint16Array, side: number): boolean {
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + BH_H - 0.001);
  // Check the column immediately adjacent to the blockhead's AABB edge.
  // AABB spans [x, x+BH_W). The adjacent column is:
  //   left:  floor(x) - 1   (column just left of the AABB's left edge)
  //   right: floor(x+BH_W-0.001) + 1  (column just right of the AABB's right edge)
  let wallX: number;
  if (side < 0) {
    wallX = Math.floor(x) - 1;
  } else {
    wallX = Math.floor(x + BH_W - 0.001) + 1;
  }
  if (wallX < 0 || wallX >= ACTIVE_GRID_W) return false;
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
    if (isSolidBlock(fg[cy * ACTIVE_GRID_W + wallX])) return true;
  }
  return false;
}

/**
 * Check if there's a background block (backwall) at the blockhead's position.
 * Any non-air background block counts as a climbable back wall.
 */
function hasBackWall(x: number, y: number, bg: Uint16Array): boolean {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.floor(x + BH_W - 0.001);
  const y1 = Math.floor(y + BH_H - 0.001);
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
      if ((bg[cy * ACTIVE_GRID_W + cx] & 0xFF) !== BLOCK_AIR) return true;
    }
  }
  return false;
}

/**
 * Check if the blockhead is in a crawling situation: there's a solid block
 * directly above (ceiling at 1 block high) and solid ground below.
 */
function isCrawling(x: number, y: number, fg: Uint16Array): boolean {
  // Ceiling: check if there's a solid block at y-1 (just above head)
  const x0 = Math.floor(x);
  const x1 = Math.floor(x + BH_W - 0.001);
  const ceilY = Math.floor(y - 0.01);
  if (ceilY < 0 || ceilY >= ACTIVE_GRID_H) return false;
  for (let cx = x0; cx <= x1; cx++) {
    if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
    if (isSolidBlock(fg[ceilY * ACTIVE_GRID_W + cx])) {
      // Also need ground below to be crawling (not falling)
      const groundY = Math.floor(y + BH_H + 0.01);
      if (groundY >= 0 && groundY < ACTIVE_GRID_H) {
        for (let gx = x0; gx <= x1; gx++) {
          if (gx < 0 || gx >= ACTIVE_GRID_W) continue;
          if (isSolidBlock(fg[groundY * ACTIVE_GRID_W + gx])) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check if the blockhead can mantle onto a ledge on the given side.
 * side: -1 = mantle left, +1 = mantle right.
 *
 * Mantle condition: the blockhead's head is at or just below the top of a
 * wall, and there's a solid surface to stand on at the top, with air above it.
 * This lets the blockhead vault over the top of a wall when climbing.
 */
function canMantle(x: number, y: number, fg: Uint16Array, side: number): boolean {
  // The blockhead's head is at y (top of AABB). The wall top is the first
  // non-solid cell above the wall. We need:
  // 1. A solid block at the wall column, at the blockhead's foot level or below
  // 2. Air at the blockhead's head level on the wall side (the top of the wall)
  // 3. A solid surface one cell below the head on the wall side (the ledge)
  // 4. Air above that (room to stand — blockhead is 2 tall)

  let wallX: number;
  if (side < 0) {
    // Left wall: column at the blockhead's left edge
    wallX = Math.floor(x) - 1;
  } else {
    // Right wall: column at the blockhead's right edge
    wallX = Math.floor(x + BH_W - 0.001) + 1;
  }
  if (wallX < 0 || wallX >= ACTIVE_GRID_W) return false;

  // Head row (top of blockhead AABB)
  const headY = Math.floor(y);
  // Foot row (bottom of blockhead AABB)
  const footY = Math.floor(y + BH_H - 0.001);

  if (headY < 0 || headY >= ACTIVE_GRID_H) return false;
  if (footY < 0 || footY >= ACTIVE_GRID_H) return false;

  // The cell at head level on the wall side must be air (we've climbed above the wall top)
  if (isSolidBlock(fg[headY * ACTIVE_GRID_W + wallX])) return false;

  // The cell below head level on the wall side must be solid (the ledge to stand on)
  const ledgeY = headY;
  if (ledgeY + 1 >= ACTIVE_GRID_H) return false;
  if (!isSolidBlock(fg[(ledgeY + 1) * ACTIVE_GRID_W + wallX])) return false;

  // There must be room to stand (2 cells of air above the ledge)
  // headY is already air (checked above). Check headY-1 too.
  if (headY - 1 >= 0 && isSolidBlock(fg[(headY - 1) * ACTIVE_GRID_W + wallX])) return false;

  // The blockhead must have been climbing a wall below (there's a solid block
  // at or below the foot level on the wall side)
  let hasWallBelow = false;
  for (let cy = footY; cy <= Math.min(footY + 1, ACTIVE_GRID_H - 1); cy++) {
    if (isSolidBlock(fg[cy * ACTIVE_GRID_W + wallX])) {
      hasWallBelow = true;
      break;
    }
  }
  return hasWallBelow;
}

// --- Main physics update ---
// Coordinates: bh.x/bh.y are in active-grid space (0..ACTIVE_GRID_W).
// The fg array is the active grid foreground; bg is the background layer.
export function updateBlockhead(
  bh: BlockheadState,
  input: BlockheadInput,
  fg: Uint16Array,
  bg: Uint16Array,
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

  // --- Mantle animation (smooth vault onto ledge) ---
  // When mantleActive, the blockhead is smoothly interpolating from
  // (mantleFromX, mantleFromY) to (mantleToX, mantleToY). Physics is
  // suspended during the mantle. The animation takes ~150ms.
  if (bh.mantleActive) {
    const MANTLE_DURATION = 0.6; // seconds
    bh.mantleTime += dt / MANTLE_DURATION;
    if (bh.mantleTime >= 1) {
      // Mantle complete — snap to target
      bh.x = bh.mantleToX;
      bh.y = bh.mantleToY;
      bh.vx = 0;
      bh.vy = 0;
      bh.onGround = true;
      bh.mantleActive = false;
      bh.animState = "idle";
    } else {
      // Ease the interpolation (ease-out for a natural landing)
      const t = bh.mantleTime;
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      bh.x = bh.mantleFromX + (bh.mantleToX - bh.mantleFromX) * eased;
      bh.y = bh.mantleFromY + (bh.mantleToY - bh.mantleFromY) * eased;
      bh.vx = 0;
      bh.vy = 0;
      bh.onGround = false;
      bh.animState = "climb";
    }
    bh.animTime += dt;
    return;
  }

  // --- Environment detection ---
  const liquidCount = countLiquid(ax, ay, fg);
  const climbCount = countClimbable(ax, ay, fg);
  const inLiquid = liquidCount > 0;
  const onLadder = climbCount > 0;
  const headSubmerged = isHeadInLiquid(ax, ay, fg);

  // "Monkey" movement detection:
  // - wallLeft/wallRight: solid foreground wall adjacent to the blockhead
  // - onBackWall: background block present at the blockhead's position
  // - crawling: in a 1-block-high gap (ceiling above, ground below)
  const wallLeft = hasWallAt(ax, ay, fg, -1);
  const wallRight = hasWallAt(ax, ay, fg, +1);
  const onBackWall = hasBackWall(ax, ay, bg);
  const crawling = isCrawling(ax, ay, fg);

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
  } else if (crawling) {
    // Crawling through a 1-high gap: reduced speed
    accel = CRAWL_ACCEL;
    maxSpd = CRAWL_SPEED;
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
  // Priority: ladder > swimming > wall climbing > gravity
  //
  // Wall climbing activates when the blockhead is airborne (has jumped) and:
  //  - Pressing up while adjacent to any wall or back wall, OR
  //  - Pressing into a FOREGROUND wall (same layer as the player).
  // Back walls (background layer) only trigger on input.up — this prevents
  // the blockhead from sticking to the ubiquitous back walls when walking
  // off edges, while still allowing intentional climbing by pressing up.
  // Foreground walls are only present when you jump into them, so pressing
  // toward them to climb feels natural.
  //
  // To descend: stop pressing up / into the wall and you fall normally.
  //
  // Exception: when mining (AI), hold position on the wall to work on the
  // target block without climbing past it or falling.
  //
  // Stamina: wall climbing drains energy. When energy reaches 0, the
  // blockhead slides down the wall at reduced speed (grip). Ladders/ropes
  // don't drain stamina (they're easy to climb).
  const isMining = input.mineX >= 0;
  const pressingLeftWall = input.left && wallLeft;
  const pressingRightWall = input.right && wallRight;
  const pressingIntoFgWall = pressingLeftWall || pressingRightWall;
  let climbingStaminaDrain = 0; // energy/sec to drain this tick

  if (onLadder) {
    // Climbing (ladder/rope): suspend gravity, allow up/down. No stamina drain.
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
  } else if (!bh.onGround && (wallLeft || wallRight || onBackWall)) {
    // Airborne and adjacent to a wall or back wall.
    if (isMining && bh.energy > 0) {
      // AI mining: hold position on wall to work on the target block.
      bh.vy = 0;
      climbingStaminaDrain = WALL_HOLD_STAMINA;
    } else if (bh.energy > 0 && (input.up || pressingIntoFgWall)) {
      // Wall climbing up.
      // Foreground wall: triggered by pressing up OR pressing into the wall.
      // Back wall: triggered only by pressing up (prevents accidental sticking).
      if (wallLeft || wallRight) {
        bh.vy = -WALL_CLIMB_SPEED;
        climbingStaminaDrain = WALL_CLIMB_STAMINA;
      } else if (onBackWall) {
        bh.vy = -BG_WALL_CLIMB_SPEED;
        climbingStaminaDrain = WALL_CLIMB_STAMINA;
      }
    } else if (bh.energy <= 0) {
      // No stamina — slide down with grip (reduced fall speed)
      bh.vy += GRAVITY * 0.4;
      if (bh.vy > MAX_FALL * 0.3) bh.vy = MAX_FALL * 0.3;
    } else {
      // Not pressing up or into a foreground wall — fall normally.
      bh.vy += GRAVITY;
      if (bh.vy > MAX_FALL) bh.vy = MAX_FALL;
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
      // Snap flush against the wall instead of leaving a gap.
      // Move in small increments until we're touching the wall.
      if (stepX > 0) {
        // Moving right: snap so right edge (x+BH_W) is at the wall column boundary
        const wallCol = Math.floor(bh.x + BH_W - 0.001) + 1;
        const flushX = wallCol - BH_W;
        if (!boxHitsSolid(flushX, bh.y, fg)) bh.x = flushX;
      } else if (stepX < 0) {
        // Moving left: snap so left edge (x) is at the wall column boundary
        const wallCol = Math.floor(bh.x) - 1;
        const flushX = wallCol + 1;
        if (!boxHitsSolid(flushX, bh.y, fg)) bh.x = flushX;
      }
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

  // --- Mantle (vault over wall top) ---
  // When the blockhead was wall-climbing and has reached the top of the wall
  // (no longer adjacent to a wall, but there's a ledge to stand on), initiate
  // a smooth mantle animation that vaults the blockhead onto the ledge.
  // Activates when pressing up or pressing into a foreground wall.
  // Prioritize the direction the player is pressing.
  // Skip mantling while mining or placing — the blockhead should hold its
  // climbing position to work on the target block, not vault onto it.
  const isPlacing = input.placeX >= 0;
  if (!bh.onGround && (input.up || pressingIntoFgWall) && !onLadder && !inLiquid
      && !isMining && !isPlacing) {
    const mantleLeft = canMantle(bh.x, bh.y, fg, -1);
    const mantleRight = canMantle(bh.x, bh.y, fg, +1);
    // Choose direction: prefer the side the player is pressing toward
    const tryRightFirst = input.right || (!input.left && mantleRight && !mantleLeft);
    const tryLeftFirst = input.left || (!input.right && mantleLeft && !mantleRight);
    let chosenSide: number = 0;
    if (tryRightFirst && mantleRight) chosenSide = +1;
    else if (tryLeftFirst && mantleLeft) chosenSide = -1;
    else if (mantleRight) chosenSide = +1;
    else if (mantleLeft) chosenSide = -1;

    if (chosenSide !== 0) {
      const ledgeY = Math.floor(bh.y);
      const wallX = chosenSide < 0
        ? Math.floor(bh.x) - 1
        : Math.floor(bh.x + BH_W - 0.001) + 1;
      const targetY = ledgeY - BH_H + 0.001;
      if (!boxHitsSolid(wallX, targetY, fg)) {
        bh.mantleActive = true;
        bh.mantleTime = 0;
        bh.mantleFromX = bh.x;
        bh.mantleFromY = bh.y;
        bh.mantleToX = wallX;
        bh.mantleToY = targetY;
        bh.vy = 0;
        bh.vx = 0;
      }
    }
  }

  // --- Animation state ---
  const moving = Math.abs(bh.vx) > 0.05;
  // Show climb animation only when actively climbing (pressing up or into a
  // foreground wall) or holding position to mine — not just when adjacent
  // to a wall.
  const wallClimbing = !bh.onGround && (wallLeft || wallRight || onBackWall)
    && bh.energy > 0 && (input.up || pressingIntoFgWall || isMining);
  if (onLadder && (input.up || input.down)) {
    bh.animState = "climb";
  } else if (wallClimbing) {
    bh.animState = "climb";
  } else if (inLiquid) {
    bh.animState = "swim";
  } else if (!bh.onGround) {
    bh.animState = "fall";
  } else if (crawling && moving) {
    bh.animState = "walk";
  } else if (moving) {
    bh.animState = "walk";
  } else {
    bh.animState = "idle";
  }
  bh.animTime += dt;

  // --- Attribute decay (slow) ---
  bh.hunger -= 0.002;
  bh.energy -= 0.001;
  // Stamina drain from climbing (computed in the vertical movement section)
  bh.energy -= climbingStaminaDrain * dt;
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
