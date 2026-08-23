// ============================================================================
// Overburden — task queue + autonomous blockhead execution
//
// The Blockheads' signature mechanic: queue tasks (move/mine/place/craft/eat/
// sleep) and the blockhead executes them autonomously. When the queue is
// non-empty, the task executor generates synthetic movement input that
// overrides direct control. When the queue is empty, direct control (WASD via
// SAB) works as normal.
//
// Pathfinding uses A* (see pathfinding.ts) with cylinder wrap. Paths are
// cached per-blockhead and invalidated on block changes near the path.
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR,
} from "../shared/constants";
import type { BlockheadState } from "../shared/types";
import type { BlockheadInput } from "./blockhead";
import { getBlockFromPacked } from "./fluid-sim";
import { findPath, type PathNode } from "./pathfinding";

export type TaskType =
  | "MOVE_TO" | "MINE_BLOCK" | "PLACE_BLOCK"
  | "CHOP_TREE" | "CRAFT_AT" | "COLLECT_ITEM"
  | "EAT" | "SLEEP";

export type TaskStatus = "pending" | "moving" | "executing" | "done" | "failed";

export interface Task {
  id: number;
  type: TaskType;
  targetX: number; // world coords (for movement-based tasks)
  targetY: number;
  blockId?: number; // for PLACE_BLOCK
  recipeId?: string; // for CRAFT_AT
  stationAx?: number; // for CRAFT_AT (active grid coords of station)
  stationAy?: number;
  itemId?: string; // for EAT, COLLECT_ITEM
  status: TaskStatus;
  // Path cache (active grid coords)
  path?: PathNode[] | null;
  pathIndex?: number;
}

let nextTaskId = 1;

export function createTask(
  type: TaskType,
  opts: {
    targetX?: number;
    targetY?: number;
    blockId?: number;
    recipeId?: string;
    stationAx?: number;
    stationAy?: number;
    itemId?: string;
  },
): Task {
  return {
    id: nextTaskId++,
    type,
    targetX: opts.targetX ?? 0,
    targetY: opts.targetY ?? 0,
    blockId: opts.blockId,
    recipeId: opts.recipeId,
    stationAx: opts.stationAx,
    stationAy: opts.stationAy,
    itemId: opts.itemId,
    status: "pending",
  };
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
 * @param bg        Active grid background
 * @param originCx  Active grid origin chunk X (for world↔active coord conversion)
 * @param originCy  Active grid origin chunk Y
 * @param dt        Delta time (seconds)
 * @returns Synthetic input, or null to use direct control.
 */
export function executeTask(
  bh: BlockheadState,
  task: Task,
  fg: Uint16Array,
  bg: Uint16Array,
  originCx: number,
  originCy: number,
  dt: number,
): BlockheadInput | null {
  // Convert task world coords to active grid coords
  const targetAx = task.targetX - originCx * 64;
  const targetAy = task.targetY - originCy * 64;

  // --- EAT: instant, no movement needed ---
  if (task.type === "EAT") {
    // The worker handles the actual consumption; task is done immediately
    task.status = "done";
    return null;
  }

  // --- CRAFT_AT: path to station, then signal completion ---
  if (task.type === "CRAFT_AT") {
    if (task.stationAx === undefined || task.stationAy === undefined) {
      task.status = "failed";
      return null;
    }
    const sx = task.stationAx;
    const sy = task.stationAy;
    if (sx < 0 || sx >= ACTIVE_GRID_W || sy < 0 || sy >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    // Check station still exists
    const blockId = getBlockFromPacked(fg[sy * ACTIVE_GRID_W + sx]);
    const def = getBlockDef(blockId);
    if (!def || !def.isStation) {
      task.status = "failed";
      return null;
    }
    // Check adjacency (within 2 blocks)
    const bhCx = bh.x + 0.5;
    const bhCy = bh.y + 1.0;
    const dx = sx - bhCx;
    const dy = sy - bhCy;
    if (Math.abs(dx) < 2.5 && Math.abs(dy) < 3.0) {
      // Adjacent — the worker handles queuing the craft; task is done
      task.status = "done";
      return null;
    }
    // Need to path to the station
    task.status = "moving";
    return pathToAndWalk(bh, task, sx, sy, fg);
  }

  // --- SLEEP: path to bed, then sleep (energy restore handled by worker) ---
  if (task.type === "SLEEP") {
    const sx = targetAx;
    const sy = targetAy;
    if (sx < 0 || sx >= ACTIVE_GRID_W || sy < 0 || sy >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    // Check bed still exists
    const blockId = getBlockFromPacked(fg[sy * ACTIVE_GRID_W + sx]);
    const def = getBlockDef(blockId);
    if (!def) {
      task.status = "failed";
      return null;
    }
    const bhCx = bh.x + 0.5;
    const bhCy = bh.y + 1.0;
    const dx = sx - bhCx;
    const dy = sy - bhCy;
    if (Math.abs(dx) < 2.5 && Math.abs(dy) < 3.0) {
      // Adjacent — sleeping is handled by the worker (sets animState, restores energy)
      task.status = "executing";
      return null; // no movement needed while sleeping
    }
    task.status = "moving";
    return pathToAndWalk(bh, task, sx, sy, fg);
  }

  // --- COLLECT_ITEM: path to location, then done (stub for now) ---
  if (task.type === "COLLECT_ITEM") {
    if (targetAx < 0 || targetAx >= ACTIVE_GRID_W || targetAy < 0 || targetAy >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    const bhCx = bh.x + 0.5;
    const bhCy = bh.y + 1.0;
    const dx = targetAx - bhCx;
    const dy = targetAy - bhCy;
    if (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.5) {
      task.status = "done";
      return null;
    }
    task.status = "moving";
    return pathToAndWalk(bh, task, targetAx, targetAy, fg);
  }

  // --- Bounds check for movement-based tasks ---
  if (targetAx < 0 || targetAx >= ACTIVE_GRID_W || targetAy < 0 || targetAy >= ACTIVE_GRID_H) {
    task.status = "failed";
    return null;
  }

  const bhCx = bh.x + 0.5;
  const bhCy = bh.y + 1.0;
  const dx = targetAx - bhCx;
  const dy = targetAy - bhCy;
  const distX = Math.abs(dx);
  const distY = Math.abs(dy);

  const isAdjacent = distX < 2.0 && distY < 2.5;
  const isAtTarget = distX < 1.0 && distY < 1.5;

  if (task.type === "MOVE_TO") {
    if (isAtTarget) {
      task.status = "done";
      return null;
    }
    task.status = "moving";
    return pathToAndWalk(bh, task, targetAx, targetAy, fg);
  }

  if (task.type === "MINE_BLOCK") {
    const tx = Math.floor(targetAx);
    const ty = Math.floor(targetAy);
    if (tx < 0 || tx >= ACTIVE_GRID_W || ty < 0 || ty >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    const fgBlock = getBlockFromPacked(fg[ty * ACTIVE_GRID_W + tx]);
    const bgBlock = getBlockFromPacked(bg[ty * ACTIVE_GRID_W + tx]);
    if (fgBlock === BLOCK_AIR && bgBlock === BLOCK_AIR) {
      task.status = "done";
      return null;
    }

    if (!isAdjacent) {
      task.status = "moving";
      return pathToAndWalk(bh, task, targetAx, targetAy, fg);
    }

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
      return pathToAndWalk(bh, task, targetAx, targetAy, fg);
    }

    task.status = "executing";
    const input: BlockheadInput = {
      left: false, right: false, up: false, down: false,
      jump: false, noclip: false,
      mineX: -1, mineY: -1,
      placeX: task.targetX, placeY: task.targetY,
      placeBlockId: task.blockId ?? 0,
    };
    task.status = "done";
    return input;
  }

  if (task.type === "CHOP_TREE") {
    // CHOP_TREE targets a wood block in the background layer.
    // For now, treat it like MINE_BLOCK but the worker handles background mining.
    const tx = Math.floor(targetAx);
    const ty = Math.floor(targetAy);
    if (tx < 0 || tx >= ACTIVE_GRID_W || ty < 0 || ty >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    // Check if there's still wood at the target (background or foreground)
    const fgBlock = getBlockFromPacked(fg[ty * ACTIVE_GRID_W + tx]);
    if (fgBlock === BLOCK_AIR) {
      // Could be in background — the worker handles that
      task.status = "executing";
      const input: BlockheadInput = {
        left: false, right: false, up: false, down: false,
        jump: false, noclip: false,
        mineX: task.targetX, mineY: task.targetY,
        placeX: -1, placeY: -1, placeBlockId: 0,
      };
      return input;
    }

    if (!isAdjacent) {
      task.status = "moving";
      return pathToAndWalk(bh, task, targetAx, targetAy, fg);
    }

    task.status = "executing";
    const input: BlockheadInput = {
      left: false, right: false, up: false, down: false,
      jump: false, noclip: false,
      mineX: task.targetX, mineY: task.targetY,
      placeX: -1, placeY: -1, placeBlockId: 0,
    };
    return input;
  }

  task.status = "failed";
  return null;
}

/**
 * Path to a target using A*, then walk along the path.
 * Caches the path on the task; re-paths only if no path exists.
 */
function pathToAndWalk(
  bh: BlockheadState,
  task: Task,
  targetAx: number,
  targetAy: number,
  fg: Uint16Array,
): BlockheadInput {
  // Find or reuse path
  if (task.path === undefined || task.path === null) {
    const sx = Math.floor(bh.x + 0.5);
    const sy = Math.floor(bh.y + 1.0);
    task.path = findPath(fg, sx, sy, Math.floor(targetAx), Math.floor(targetAy), true);
    task.pathIndex = 0;
    if (task.path === null) {
      // No path found — fall back to greedy walk
      const dx = targetAx - (bh.x + 0.5);
      const dy = targetAy - (bh.y + 1.0);
      return walkToward(bh, dx, dy, fg);
    }
  }

  // Walk along the path
  const path = task.path;
  let idx = task.pathIndex ?? 0;

  // Skip nodes we've already reached
  while (idx < path.length) {
    const node = path[idx];
    const dx = node.x - (bh.x + 0.5);
    const dy = node.y - (bh.y + 1.0);
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      idx++;
      continue;
    }
    break;
  }
  task.pathIndex = idx;

  if (idx >= path.length) {
    // Reached end of path — walk directly to target
    const dx = targetAx - (bh.x + 0.5);
    const dy = targetAy - (bh.y + 1.0);
    return walkToward(bh, dx, dy, fg);
  }

  // Walk toward the current path node
  const node = path[idx];
  const dx = node.x - (bh.x + 0.5);
  const dy = node.y - (bh.y + 1.0);
  return walkToward(bh, dx, dy, fg);
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
    input.up = true;
  }
  if (dy > 1.5) {
    input.down = true;
  }

  return input;
}

/** Invalidate a task's cached path (call when blocks near the path change). */
export function invalidatePath(task: Task): void {
  task.path = undefined;
  task.pathIndex = undefined;
}
