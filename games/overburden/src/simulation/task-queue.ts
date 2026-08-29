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
import { BH_H, BH_W } from "./blockhead";
import { getBlockFromPacked } from "./fluid-sim";
import { findPath, findPathToAdjacent, type PathNode } from "./grid-movement";
import type { PathfindingBroker } from "./pathfinding-broker";

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
  failReason?: string;
  // Which layer to mine: "fg" or "bg". Set on first execution.
  mineLayer?: "fg" | "bg";
  // Path cache (active grid coords)
  path?: PathNode[] | null;
  pathIndex?: number;
  // In-flight async path request id (set by PathfindingBroker while a path
  // is being computed on the dedicated pather worker). Transient — not
  // persisted. When set, `path` is still `undefined` and the caller uses a
  // greedy walkToward() fallback until the result arrives.
  pathRequestId?: number;
  // Stuck detection: track time spent moving without progress
  stuckTimer?: number;
  lastDist?: number;
}

let nextTaskId = 1;

// --- Async pathfinding broker (set by the sim worker on init) ---
// When set, pathToAndWalk() offloads A* to the dedicated pather worker via
// the broker and uses a greedy walkToward() fallback while the path is
// in-flight. When null (unit tests, or before the worker is wired), it
// falls back to synchronous grid-movement.findPath (pre-refactor behavior).
let pathBroker: PathfindingBroker | null = null;

export function setPathBroker(broker: PathfindingBroker | null): void {
  pathBroker = broker;
}

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
 * Generate movement input to maintain a climb (hold position on a wall or
 * back wall) while the blockhead is airborne. Used when the blockhead needs
 * to stay in place to mine or place a block while climbing.
 *
 * Returns partial input with `up` set (so the physics code recognizes a
 * climbing context), and `left`/`right` set toward the nearest foreground
 * wall to stay close. The actual holding is done by the physics code's
 * mining exception (when mineX >= 0, vy is zeroed). If no wall or back wall
 * is nearby, returns empty input (the blockhead will fall).
 */
function climbHoldInput(bh: BlockheadState, fg: Uint16Array, bg: Uint16Array): {
  left: boolean; right: boolean; up: boolean;
} {
  if (bh.onGround) return { left: false, right: false, up: false };

  const footY = Math.floor(bh.y + 0.5);
  const headY = Math.floor(bh.y - 0.5);
  const wallLeftX = Math.floor(bh.x - 0.5);
  const wallRightX = Math.floor(bh.x + BH_W + 0.5);

  let hasWallLeft = false;
  let hasWallRight = false;
  if (wallLeftX >= 0 && footY >= 0 && footY < ACTIVE_GRID_H) {
    hasWallLeft = isSolid(fg[footY * ACTIVE_GRID_W + wallLeftX])
      || (headY >= 0 && isSolid(fg[headY * ACTIVE_GRID_W + wallLeftX]));
  }
  if (wallRightX >= 0 && wallRightX < ACTIVE_GRID_W && footY >= 0 && footY < ACTIVE_GRID_H) {
    hasWallRight = isSolid(fg[footY * ACTIVE_GRID_W + wallRightX])
      || (headY >= 0 && isSolid(fg[headY * ACTIVE_GRID_W + wallRightX]));
  }

  // Check for back wall at the blockhead's position — scan all cells
  // overlapping the AABB (blockhead is BH_W wide, ~2 tall). The physics
  // code's hasBackWall does the same; checking only the center cell misses
  // the trunk when the blockhead is slightly off-center.
  let hasBackWall = false;
  {
    const x0 = Math.floor(bh.x);
    const x1 = Math.floor(bh.x + BH_W - 0.001);
    const y0 = Math.floor(bh.y);
    const y1 = Math.floor(bh.y + BH_H - 0.001);
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
        if ((bg[cy * ACTIVE_GRID_W + cx] & 0xFF) !== BLOCK_AIR) {
          hasBackWall = true;
          break;
        }
      }
      if (hasBackWall) break;
    }
  }

  if (!hasWallLeft && !hasWallRight && !hasBackWall) {
    return { left: false, right: false, up: false };
  }

  // Press up so the physics code recognizes a climbing context. Press toward
  // a foreground wall to stay close (keeps the blockhead adjacent for the
  // mining hold). The mining exception in physics zeroes vy when mineX >= 0.
  return {
    up: true,
    left: hasWallLeft && !hasWallRight,
    right: hasWallRight && !hasWallLeft,
  };
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
    const bhCx = bh.x + BH_W / 2;
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
    return pathToAndWalk(bh, task, sx, sy, fg, bg);
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
    const bhCx = bh.x + BH_W / 2;
    const bhCy = bh.y + 1.0;
    const dx = sx - bhCx;
    const dy = sy - bhCy;
    if (Math.abs(dx) < 2.5 && Math.abs(dy) < 3.0) {
      // Adjacent — sleeping is handled by the worker (sets animState, restores energy)
      task.status = "executing";
      return null; // no movement needed while sleeping
    }
    task.status = "moving";
    return pathToAndWalk(bh, task, sx, sy, fg, bg);
  }

  // --- COLLECT_ITEM: path to location, then done (stub for now) ---
  if (task.type === "COLLECT_ITEM") {
    if (targetAx < 0 || targetAx >= ACTIVE_GRID_W || targetAy < 0 || targetAy >= ACTIVE_GRID_H) {
      task.status = "failed";
      return null;
    }
    const bhCx = bh.x + BH_W / 2;
    const bhCy = bh.y + 1.0;
    const dx = targetAx - bhCx;
    const dy = targetAy - bhCy;
    if (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.5) {
      task.status = "done";
      return null;
    }
    task.status = "moving";
    return pathToAndWalk(bh, task, targetAx, targetAy, fg, bg);
  }

  // --- Bounds check for movement-based tasks ---
  if (targetAx < 0 || targetAx >= ACTIVE_GRID_W || targetAy < 0 || targetAy >= ACTIVE_GRID_H) {
    task.status = "failed";
    return null;
  }

  const bhCx = bh.x + BH_W / 2;
  const bhCy = bh.y + 1.0;
  const dx = targetAx - bhCx;
  const dy = targetAy - bhCy;
  const distX = Math.abs(dx);
  const distY = Math.abs(dy);
  const dist = Math.sqrt(dx * dx + dy * dy);

  const isAdjacent = distX < 2.0 && distY < 2.5;
  const isAtTarget = distX < 1.0 && distY < 1.5;

  // --- Stuck detection ---
  // If the blockhead is moving but not getting closer to the target for
  // STUCK_TIMEOUT seconds, mark the task as failed with a "stuck" reason.
  const STUCK_TIMEOUT = 5.0;
  if (task.status === "moving") {
    const lastDist = task.lastDist ?? dist;
    if (dist < lastDist + 0.1) {
      // Not making progress (within 0.1 block tolerance)
      task.stuckTimer = (task.stuckTimer ?? 0) + dt;
    } else {
      // Making progress — reset timer
      task.stuckTimer = 0;
    }
    task.lastDist = dist;
    if ((task.stuckTimer ?? 0) >= STUCK_TIMEOUT) {
      task.status = "failed";
      task.failReason = "stuck";
      return null;
    }
  } else {
    task.stuckTimer = 0;
    task.lastDist = dist;
  }

  if (task.type === "MOVE_TO") {
    if (isAtTarget) {
      task.status = "done";
      return null;
    }
    task.status = "moving";
    return pathToAndWalk(bh, task, targetAx, targetAy, fg, bg);
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

    // Determine target layer on first execution: if fg has a block, mine fg.
    // If only bg has a block, mine bg. Stick with that layer for the task's
    // lifetime so mining fg doesn't cascade into mining bg.
    if (task.mineLayer === undefined) {
      if (fgBlock !== BLOCK_AIR) {
        task.mineLayer = "fg";
      } else if (bgBlock !== BLOCK_AIR) {
        task.mineLayer = "bg";
      } else {
        // Both air — nothing to mine
        task.status = "done";
        return null;
      }
    }

    // Check if the target layer's block is gone
    if (task.mineLayer === "fg" && fgBlock === BLOCK_AIR) {
      task.status = "done";
      return null;
    }
    if (task.mineLayer === "bg" && bgBlock === BLOCK_AIR) {
      task.status = "done";
      return null;
    }

    if (!isAdjacent) {
      task.status = "moving";
      return pathToAndWalk(bh, task, targetAx, targetAy, fg, bg, true);
    }

    task.status = "executing";
    // While mining, maintain climbing position if airborne (press up/toward
    // wall so the blockhead doesn't fall off while working on the block).
    const climb = climbHoldInput(bh, fg, bg);
    const input: BlockheadInput = {
      left: climb.left, right: climb.right, up: climb.up, down: false,
      jump: false, noclip: false,
      mineX: task.targetX, mineY: task.targetY,
      placeX: -1, placeY: -1, placeBlockId: 0,
    };
    return input;
  }

  if (task.type === "PLACE_BLOCK") {
    if (!isAdjacent) {
      task.status = "moving";
      return pathToAndWalk(bh, task, targetAx, targetAy, fg, bg, true);
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
      const climb = climbHoldInput(bh, fg, bg);
      const input: BlockheadInput = {
        left: climb.left, right: climb.right, up: climb.up, down: false,
        jump: false, noclip: false,
        mineX: task.targetX, mineY: task.targetY,
        placeX: -1, placeY: -1, placeBlockId: 0,
      };
      return input;
    }

    if (!isAdjacent) {
      task.status = "moving";
      return pathToAndWalk(bh, task, targetAx, targetAy, fg, bg, true);
    }

    task.status = "executing";
    {
      const climb = climbHoldInput(bh, fg, bg);
      const input: BlockheadInput = {
        left: climb.left, right: climb.right, up: climb.up, down: false,
        jump: false, noclip: false,
        mineX: task.targetX, mineY: task.targetY,
        placeX: -1, placeY: -1, placeBlockId: 0,
      };
      return input;
    }
  }

  task.status = "failed";
  return null;
}

/** Type of movement needed to reach the next path node. */
export type MoveType = "walk" | "jump" | "fall" | "climb" | "step-up";

/**
 * Classify the movement needed to go from the blockhead's current position
 * to the next path node, based on the relative position and the previous
 * path node (to detect jump-moves across gaps).
 */
export function classifyMove(
  bh: BlockheadState,
  prevNode: PathNode | null,
  node: PathNode,
): MoveType {
  // Use the ACTUAL blockhead center (BH_W/2 = 0.35), not 0.5.
  // The blockhead's AABB spans [bh.x, bh.x + BH_W]; center is bh.x + BH_W/2.
  const bhCx = bh.x + BH_W / 2;
  const bhCy = bh.y + 1.0;
  // Path nodes are in cell coordinates (integers). The center of cell (x, y)
  // is at (x + 0.5, y + 0.5) in world space. The blockhead's center is at
  // (bh.x + BH_W/2, bh.y + 1.0). Use node.x + 0.5 so the blockhead walks to
  // the CENTER of the target cell, not the left edge.
  const dx = (node.x + 0.5) - bhCx;
  const dy = node.y - bhCy;

  // Target is above
  if (dy < -0.5) {
    // If the horizontal distance is > 1.5, it's a jump-move (diagonal up)
    if (Math.abs(dx) > 1.5) return "jump";
    // If 1 block up and close horizontally, it's a step-up
    if (dy > -1.5) return "step-up";
    // Higher than 1 block — wall/back-wall climbing
    return "climb";
  }

  // Target is below
  if (dy > 1.5) {
    // If the horizontal distance is > 1.5, it's a fall + horizontal move
    if (Math.abs(dx) > 1.5) return "fall";
    // Directly below — fall off edge
    return "fall";
  }

  // Target is roughly same height
  // If horizontal distance is > 1.5, it's a jump-move across a gap
  if (Math.abs(dx) > 1.5) return "jump";

  return "walk";
}

/**
 * Path to a target using A*, then walk along the path.
 * Caches the path on the task; re-paths only if no path exists.
 * @param adjacent  If true, path to a standable cell adjacent to the target
 *                  (for mining/placing where the target cell is solid).
 */
function pathToAndWalk(
  bh: BlockheadState,
  task: Task,
  targetAx: number,
  targetAy: number,
  fg: Uint16Array,
  bg: Uint16Array,
  adjacent: boolean = false,
): BlockheadInput {
  // Find or reuse path.
  //
  // `task.path` states:
  //   undefined  — no path yet (or was invalidated). Request one.
  //   null       — pather reported no path; use greedy fallback permanently.
  //   PathNode[] — cached path; walk along it.
  //
  // When a PathfindingBroker is wired in, the request is async: we post it to
  // the dedicated pather worker and `task.path` stays `undefined` until the
  // result arrives (via a microtask). While in-flight, we fall back to a
  // greedy walkToward() so the blockhead keeps moving.
  if (task.path === undefined) {
    const sx = Math.floor(bh.x + BH_W / 2);
    const sy = Math.floor(bh.y + 1.0);
    if (pathBroker && task.pathRequestId === undefined) {
      // Async: offload to the pather worker. Result writes task.path later.
      pathBroker.requestPath(
        task, sx, sy, Math.floor(targetAx), Math.floor(targetAy), adjacent, true,
      );
      // In degraded mode the broker writes task.path synchronously; otherwise
      // it stays undefined and we greedy-walk below.
    } else if (!pathBroker) {
      // Sync fallback (unit tests, or before the broker is wired).
      if (adjacent) {
        task.path = findPathToAdjacent(fg, bg, sx, sy, Math.floor(targetAx), Math.floor(targetAy), true);
      } else {
        task.path = findPath(fg, bg, sx, sy, Math.floor(targetAx), Math.floor(targetAy), true);
      }
      task.pathIndex = 0;
    }
    // While in-flight (pathRequestId set, path still undefined) OR no path
    // found (path === null), fall back to greedy walk toward the target.
    if (task.path === undefined || task.path === null) {
      const dx = (targetAx + 0.5) - (bh.x + BH_W / 2);
      const dy = targetAy - (bh.y + 1.0);
      return walkToward(bh, dx, dy, fg, bg, "walk", null);
    }
  }

  // Walk along the path
  const path = task.path;
  if (!path) {
    // Should not happen (path was set above), but guard for type safety
    const dx = (targetAx + 0.5) - (bh.x + BH_W / 2);
    const dy = targetAy - (bh.y + 1.0);
    return walkToward(bh, dx, dy, fg, bg, "walk", null);
  }
  let idx = task.pathIndex ?? 0;

  // Skip nodes we've already reached.
  // Path nodes are cell coordinates; the blockhead's center is at
  // (bh.x + BH_W/2, bh.y + 1.0). A node is "reached" when the blockhead's
  // center is within REACHED_THRESHOLD of the cell's CENTER (node.x + 0.5).
  const REACHED_THRESHOLD = 0.4;
  while (idx < path.length) {
    const node = path[idx];
    const dx = (node.x + 0.5) - (bh.x + BH_W / 2);
    const dy = node.y - (bh.y + 1.0);
    if (Math.abs(dx) < REACHED_THRESHOLD && Math.abs(dy) < REACHED_THRESHOLD) {
      idx++;
      continue;
    }
    break;
  }
  task.pathIndex = idx;

  if (idx >= path.length) {
    // Reached end of path — walk directly to target
    const dx = (targetAx + 0.5) - (bh.x + BH_W / 2);
    const dy = targetAy - (bh.y + 1.0);
    return walkToward(bh, dx, dy, fg, bg, "walk", null);
  }

  // --- Path drift detection ---
  // If the blockhead has drifted significantly from the current path node
  // (e.g., fell into a hole when it was supposed to jump across), invalidate
  // the path and re-path from the current position. This prevents the
  // blockhead from getting stuck trying to reach an unreachable path node.
  const currentNode = path[idx];
  const driftDx = (currentNode.x + 0.5) - (bh.x + BH_W / 2);
  const driftDy = currentNode.y - (bh.y + 1.0);
  const driftDist = Math.sqrt(driftDx * driftDx + driftDy * driftDy);
  if (driftDist > 4.0 && idx > 0) {
    // Drifted too far from the path — invalidate and re-path
    task.path = undefined;
    task.pathIndex = undefined;
    pathBroker?.cancel(task);
    return pathToAndWalk(bh, task, targetAx, targetAy, fg, bg, adjacent);
  }

  // Walk toward the current path node
  const node = path[idx];
  const prevNode = idx > 0 ? path[idx - 1] : null;
  const moveType = classifyMove(bh, prevNode, node);
  const dx = (node.x + 0.5) - (bh.x + BH_W / 2);
  const dy = node.y - (bh.y + 1.0);
  return walkToward(bh, dx, dy, fg, bg, moveType, node);
}

/**
 * Generate movement input to walk toward a target delta.
 * Uses the moveType to determine the right combination of horizontal,
 * vertical, and jump inputs for the specific movement (walk, jump across
 * gaps, fall off edges, climb walls, step up ledges).
 *
 * @param moveType    Type of movement needed (classified from path context)
 * @param targetNode  The path node being walked toward (null for greedy fallback)
 */
export function walkToward(
  bh: BlockheadState,
  dx: number, dy: number,
  fg: Uint16Array, bg: Uint16Array,
  moveType: MoveType,
  targetNode: PathNode | null,
): BlockheadInput {
  const input: BlockheadInput = {
    left: false, right: false, up: false, down: false,
    jump: false, noclip: false,
    mineX: -1, mineY: -1, placeX: -1, placeY: -1, placeBlockId: 0,
  };

  // --- Jump-move: jump across a gap or up a ledge ---
  // The blockhead needs to jump + move horizontally to reach a node that's
  // 2+ blocks away horizontally. Jump while moving toward the node.
  if (moveType === "jump") {
    if (bh.onGround) {
      input.jump = true;
      if (dx > 0) input.right = true;
      else if (dx < 0) input.left = true;
    } else {
      // Airborne — keep moving toward the target
      if (dx > 0.3) input.right = true;
      else if (dx < -0.3) input.left = true;
    }
    return input;
  }

  // --- Fall-move: walk off an edge to fall to a lower level ---
  // The blockhead is on ground and needs to get to a lower level. Walk
  // toward the gap direction (toward the target node's X) to get off
  // the edge so gravity can pull it down.
  if (moveType === "fall") {
    if (bh.onGround) {
      // First check: is the blockhead ALREADY over a gap? If its full body
      // width has no solid floor below, it should fall — just press down.
      // This handles the case where the blockhead is centered over a 1-wide
      // hole: the adjacent columns have solid floor, but the blockhead's
      // body is over the hole and should fall.
      const floorY = Math.floor(bh.y + BH_H + 0.01);
      const bodyLeftX = Math.floor(bh.x);
      const bodyRightX = Math.floor(bh.x + BH_W - 0.001);
      let bodyOverGap = true;
      if (floorY >= 0 && floorY < ACTIVE_GRID_H) {
        for (let bx = bodyLeftX; bx <= bodyRightX; bx++) {
          if (bx < 0 || bx >= ACTIVE_GRID_W) continue;
          if (isSolid(fg[floorY * ACTIVE_GRID_W + bx])) {
            bodyOverGap = false;
            break;
          }
        }
      } else {
        bodyOverGap = false;
      }
      if (bodyOverGap) {
        // Body is fully over a gap — press down to fall.
        input.down = true;
        return input;
      }

      // Not over a gap yet — walk toward the target node's X to get off
      // the edge. Use a small threshold so the blockhead keeps walking
      // until its center is over the target cell center.
      if (dx > 0.1) input.right = true;
      else if (dx < -0.1) input.left = true;
      else {
        // Target is directly below but body isn't fully over the gap yet.
        // Check which side has a gap (no floor) at the FLOOR level and walk
        // toward it. This handles the case where the blockhead needs to
        // nudge sideways to get its body fully over the hole.
        const rightX = Math.floor(bh.x + BH_W + 0.5);
        const leftX = Math.floor(bh.x - 0.5);
        let rightGap = false;
        let leftGap = false;
        if (rightX >= 0 && rightX < ACTIVE_GRID_W && floorY >= 0 && floorY < ACTIVE_GRID_H) {
          rightGap = !isSolid(fg[floorY * ACTIVE_GRID_W + rightX]);
        }
        if (leftX >= 0 && leftX < ACTIVE_GRID_W && floorY >= 0 && floorY < ACTIVE_GRID_H) {
          leftGap = !isSolid(fg[floorY * ACTIVE_GRID_W + leftX]);
        }
        if (rightGap && !leftGap) input.right = true;
        else if (leftGap && !rightGap) input.left = true;
        else if (rightGap && leftGap) {
          if (bh.facing > 0) input.right = true;
          else input.left = true;
        } else {
          // Neither side has a gap — nudge toward target X using facing
          if (bh.facing > 0) input.right = true;
          else input.left = true;
        }
      }
    } else {
      // Airborne — falling, just press down (helps with swim/climb on landing)
      input.down = true;
      if (dx > 0.3) input.right = true;
      else if (dx < -0.3) input.left = true;
    }
    return input;
  }

  // --- Climb: wall or back-wall climbing to reach a higher node ---
  if (moveType === "climb") {
    // Stabilization: wait for horizontal velocity to near-zero before jumping
    if (bh.onGround && Math.abs(bh.vx) > 0.08) {
      input.up = true;
      return input;
    }

    if (bh.onGround) {
      // Look for foreground walls to climb BEFORE jumping.
      // Only jump if there's actually a wall or back wall to climb —
      // otherwise the blockhead jumps in place repeatedly (stuck).
      // footY = the standing cell (blockhead's lower body).
      // headY = the head cell (blockhead's upper body).
      const footY = Math.floor(bh.y + 1.0);
      const headY = Math.floor(bh.y);
      const facingWallX = bh.facing > 0
        ? Math.floor(bh.x + BH_W + 0.5)
        : Math.floor(bh.x - 0.5);
      const oppositeWallX = bh.facing > 0
        ? Math.floor(bh.x - 0.5)
        : Math.floor(bh.x + BH_W + 0.5);

      let foundWall = false;
      let wallDir = 0; // -1 = left, +1 = right
      for (const wallX of [facingWallX, oppositeWallX]) {
        if (wallX < 0 || wallX >= ACTIVE_GRID_W) continue;
        if (footY < 0 || footY >= ACTIVE_GRID_H) continue;
        const wallAtFeet = isSolid(fg[footY * ACTIVE_GRID_W + wallX]);
        const wallAtHead = headY >= 0 && isSolid(fg[headY * ACTIVE_GRID_W + wallX]);
        if (wallAtFeet || wallAtHead) {
          wallDir = wallX > bh.x + BH_W / 2 ? 1 : -1;
          foundWall = true;
          break;
        }
      }

      // Back wall climbing: check all AABB cells for background blocks
      if (!foundWall) {
        const x0 = Math.floor(bh.x);
        const x1 = Math.floor(bh.x + BH_W - 0.001);
        const y0 = Math.floor(bh.y);
        const y1 = Math.floor(bh.y + BH_H - 0.001);
        for (let cy = y0; cy <= y1; cy++) {
          if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
          for (let cx = x0; cx <= x1; cx++) {
            if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
            if ((bg[cy * ACTIVE_GRID_W + cx] & 0xFF) !== BLOCK_AIR) {
              foundWall = true;
              break;
            }
          }
          if (foundWall) break;
        }
      }

      if (foundWall) {
        // Jump to become airborne, then press into wall + up to climb
        input.jump = true;
        input.up = true;
        if (wallDir > 0) input.right = true;
        else if (wallDir < 0) input.left = true;
      } else {
        // No wall found — walk toward the target node's X to get closer
        // to the wall. Don't jump (would just jump in place).
        if (dx > 0.1) input.right = true;
        else if (dx < -0.1) input.left = true;
      }
    } else {
      // Airborne — press up + toward wall to maintain climb
      input.up = true;
      // Use a wider dead zone to avoid overcorrecting
      if (dx > 0.6) input.right = true;
      else if (dx < -0.6) input.left = true;
    }
    return input;
  }

  // --- Step-up: walk into a wall for auto-step (1-block climb) ---
  if (moveType === "step-up") {
    if (bh.onGround) {
      // Walk toward the target — physics auto-step handles the 1-block climb
      if (dx > 0.1) input.right = true;
      else if (dx < -0.1) input.left = true;
    } else {
      // Airborne after auto-step — keep moving toward target
      if (dx > 0.3) input.right = true;
      else if (dx < -0.3) input.left = true;
    }
    return input;
  }

  // --- Walk: normal horizontal movement (default) ---
  // When climbing (airborne, target above), use a wider dead zone.
  const horizThreshold = (!bh.onGround && dy < -0.5) ? 0.6 : 0.3;
  if (dx > horizThreshold) {
    input.right = true;
    // Check for a wall ahead at body level — if solid, jump to clear it.
    // Use BH_W to check past the blockhead's right edge, and bh.y + 1.0
    // (the standing cell) for the foot/body level.
    const aheadX = Math.floor(bh.x + BH_W + 0.5);
    const footY = Math.floor(bh.y + 1.0);
    if (aheadX < ACTIVE_GRID_W && footY >= 0 && footY < ACTIVE_GRID_H) {
      if (isSolid(fg[footY * ACTIVE_GRID_W + aheadX])) {
        input.jump = true;
      }
    }
  } else if (dx < -horizThreshold) {
    input.left = true;
    const aheadX = Math.floor(bh.x - 0.5);
    const footY = Math.floor(bh.y + 1.0);
    if (aheadX >= 0 && footY >= 0 && footY < ACTIVE_GRID_H) {
      if (isSolid(fg[footY * ACTIVE_GRID_W + aheadX])) {
        input.jump = true;
      }
    }
  }

  // Vertical assist for walk moves
  if (dy < -1.5 && bh.onGround) input.jump = true;
  if (dy > 1.5) input.down = true;

  return input;
}

/** Invalidate a task's cached path (call when blocks near the path change). */
export function invalidatePath(task: Task): void {
  task.path = undefined;
  task.pathIndex = undefined;
  // Cancel any in-flight async path request so the stale result doesn't
  // overwrite the newly-cleared cache.
  pathBroker?.cancel(task);
}
