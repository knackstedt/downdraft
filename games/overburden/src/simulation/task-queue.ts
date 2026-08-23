// ============================================================================
// Overburden — task queue + autonomous blockhead execution
//
// The Blockheads' signature mechanic: queue tasks (move/mine/place) and the
// blockhead executes them autonomously. When the queue is non-empty, the task
// executor generates synthetic movement input that overrides direct control.
// When the queue is empty, direct control (WASD via SAB) works as normal.
//
// Pathfinding is intentionally simple (greedy walk + auto-jump over 1-block
// obstacles). Full A* is a future improvement.
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR,
} from "../shared/constants";
import type { BlockheadState } from "../shared/types";
import type { BlockheadInput } from "./blockhead";
import { getBlockFromPacked } from "./fluid-sim";

export type TaskType = "MOVE_TO" | "MINE_BLOCK" | "PLACE_BLOCK";
export type TaskStatus = "pending" | "moving" | "executing" | "done" | "failed";

export interface Task {
  id: number;
  type: TaskType;
  targetX: number; // world coords
  targetY: number;
  blockId?: number; // for PLACE_BLOCK
  status: TaskStatus;
}

let nextTaskId = 1;

export function createTask(type: TaskType, targetX: number, targetY: number, blockId?: number): Task {
  return { id: nextTaskId++, type, targetX, targetY, blockId, status: "pending" };
}

/** Check if a block is solid (for pathing collision). */
function isSolid(packed: number): boolean {
  const id = getBlockFromPacked(packed);
  if (id === BLOCK_AIR) return false;
  const def = getBlockDef(id);
  return def?.category === "solid";
}

/**
 * Execute the current task for a blockhead. Returns the synthetic input to
 * use this tick (overrides direct control), or null if no task is active
 * (caller should use direct input instead).
 *
 * @param bh        Blockhead state (position is in active-grid coords)
 * @param task      Current task
 * @param fg        Active grid foreground
 * @param originCx  Active grid origin chunk X (for world↔active coord conversion)
 * @param originCy  Active grid origin chunk Y
 * @param dt        Delta time (seconds)
 * @returns Synthetic input, or null to use direct control.
 */
export function executeTask(
  bh: BlockheadState,
  task: Task,
  fg: Uint16Array,
  originCx: number,
  originCy: number,
  dt: number,
): BlockheadInput | null {
  // Convert task world coords to active grid coords
  const targetAx = task.targetX - originCx * 64;
  const targetAy = task.targetY - originCy * 64;

  // Bounds check — if target is outside the active grid, fail
  if (targetAx < 0 || targetAx >= ACTIVE_GRID_W || targetAy < 0 || targetAy >= ACTIVE_GRID_H) {
    task.status = "failed";
    return null;
  }

  const bhCx = bh.x + 0.5; // center of 1-wide body
  const bhCy = bh.y + 1.0; // center of 2-tall body
  const dx = targetAx - bhCx;
  const dy = targetAy - bhCy;
  const distX = Math.abs(dx);
  const distY = Math.abs(dy);

  // --- Task-specific adjacency check ---
  // For MINE_BLOCK and PLACE_BLOCK: must be within 1.5 blocks horizontally
  // and within 2 blocks vertically of the target.
  const isAdjacent = distX < 2.0 && distY < 2.5;
  // For MOVE_TO: done when within 1 block
  const isAtTarget = distX < 1.0 && distY < 1.5;

  if (task.type === "MOVE_TO") {
    if (isAtTarget) {
      task.status = "done";
      return null;
    }
    task.status = "moving";
    return walkToward(bh, dx, dy, fg);
  }

  if (task.type === "MINE_BLOCK") {
    // Check the target block still exists
    const tx = Math.floor(targetAx);
    const ty = Math.floor(targetAy);
    if (tx < 0 || tx >= ACTIVE_GRID_W || ty < 0 || ty >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    const blockId = getBlockFromPacked(fg[ty * ACTIVE_GRID_W + tx]);
    if (blockId === BLOCK_AIR) {
      task.status = "done"; // already mined
      return null;
    }

    if (!isAdjacent) {
      task.status = "moving";
      return walkToward(bh, dx, dy, fg);
    }

    // Adjacent — mine the block. Set mineX/mineY in active-grid coords.
    // The worker's processMining expects world coords, so we convert back.
    task.status = "executing";
    const input: BlockheadInput = {
      left: false, right: false, up: false, down: false,
      jump: false, noclip: false,
      mineX: task.targetX, mineY: task.targetY,
      placeX: -1, placeY: -1, placeBlockId: 0,
    };
    return input;
  }

  if (task.type === "PLACE_BLOCK") {
    if (!isAdjacent) {
      task.status = "moving";
      return walkToward(bh, dx, dy, fg);
    }

    // Adjacent — place the block
    task.status = "executing";
    const input: BlockheadInput = {
      left: false, right: false, up: false, down: false,
      jump: false, noclip: false,
      mineX: -1, mineY: -1,
      placeX: task.targetX, placeY: task.targetY,
      placeBlockId: task.blockId ?? 0,
    };
    // Place is instant (one tick), so mark done after placing
    // The worker's processPlacing handles consumption + placement
    task.status = "done";
    return input;
  }

  task.status = "failed";
  return null;
}

/**
 * Generate movement input to walk toward a target delta.
 * Greedy: move horizontally, jump when blocked by a 1-block obstacle.
 */
function walkToward(bh: BlockheadState, dx: number, dy: number, fg: Uint16Array): BlockheadInput {
  const input: BlockheadInput = {
    left: false, right: false, up: false, down: false,
    jump: false, noclip: false,
    mineX: -1, mineY: -1, placeX: -1, placeY: -1, placeBlockId: 0,
  };

  // Horizontal movement
  if (dx > 0.3) {
    input.right = true;
    // Check if there's a wall ahead — jump
    const aheadX = Math.floor(bh.x + 1.5);
    const footY = Math.floor(bh.y + 0.5);
    if (aheadX < ACTIVE_GRID_W && footY >= 0 && footY < ACTIVE_GRID_H) {
      if (isSolid(fg[footY * ACTIVE_GRID_W + aheadX])) {
        input.jump = true;
      }
    }
  } else if (dx < -0.3) {
    input.left = true;
    const aheadX = Math.floor(bh.x - 0.5);
    const footY = Math.floor(bh.y + 0.5);
    if (aheadX >= 0 && footY >= 0 && footY < ACTIVE_GRID_H) {
      if (isSolid(fg[footY * ACTIVE_GRID_W + aheadX])) {
        input.jump = true;
      }
    }
  }

  // Vertical movement: if target is significantly above and we're on ground,
  // jump. If on a climbable block, press up.
  if (dy < -1.5 && bh.onGround) {
    input.jump = true;
  }
  if (dy < -0.5) {
    input.up = true; // also works for climbing ladders
  }
  if (dy > 1.5) {
    input.down = true; // for climbing down ladders
  }

  return input;
}
