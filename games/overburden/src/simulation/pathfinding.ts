// ============================================================================
// Overburden — A* pathfinding through the block grid
//
// Walkable cells: air, liquid (swim), climbable (ladder/rope), non-solid
// special blocks (torch, scaffolding). Solid blocks are obstacles.
//
// Movement model: 4-directional (no diagonal). Capabilities:
// - Walk horizontally (normal)
// - Step up 1 block (auto-jump) if cell above is clear
// - Step down 1 block freely
// - Fall: walking off a ledge or stepping into an unsupported cell causes the
//   blockhead to fall to the landing cell (gravity modeling). Fall edges are
//   directed (down-only) and the landing is the first supported cell below.
// - Climb climbable cells (ladder/rope) vertically
// - Wall climb: move up when adjacent to a solid foreground wall
// - Back wall climb: move up when there's a background block at the cell
// - Crawl: move horizontally through 1-block-high gaps
//
// Cylinder wrap: the world wraps horizontally on X. When wrap=true, the
// heuristic and neighbor expansion account for the shorter path around the
// cylinder.
//
// Max nodes: 4096 (cap to prevent long searches). If exceeded, returns null.
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, BLOCK_AIR } from "../shared/constants";
import { getBlockFromPacked } from "./fluid-sim";

export interface PathNode {
  x: number;
  y: number;
}

const MAX_NODES = 4096;

// --- Binary heap (min-heap by fScore) ---
// Stores cell indices (y * ACTIVE_GRID_W + x). fScore stored separately.
const heapData = new Int32Array(MAX_NODES + 1);
const heapFScore = new Float32Array(MAX_NODES + 1);
let heapSize = 0;

function heapPush(cellIdx: number, fScore: number): boolean {
  if (heapSize >= MAX_NODES) return false;
  heapSize++;
  let i = heapSize;
  heapData[i] = cellIdx;
  heapFScore[i] = fScore;
  // Sift up
  while (i > 1) {
    const parent = i >> 1;
    if (heapFScore[parent] <= heapFScore[i]) break;
    // Swap
    const td = heapData[parent]; heapData[parent] = heapData[i]; heapData[i] = td;
    const tf = heapFScore[parent]; heapFScore[parent] = heapFScore[i]; heapFScore[i] = tf;
    i = parent;
  }
  return true;
}

function heapPop(): number {
  if (heapSize === 0) return -1;
  const result = heapData[1];
  heapData[1] = heapData[heapSize];
  heapFScore[1] = heapFScore[heapSize];
  heapSize--;
  // Sift down
  let i = 1;
  while (true) {
    let min = i;
    const left = i << 1;
    const right = left + 1;
    if (left <= heapSize && heapFScore[left] < heapFScore[min]) min = left;
    if (right <= heapSize && heapFScore[right] < heapFScore[min]) min = right;
    if (min === i) break;
    const td = heapData[min]; heapData[min] = heapData[i]; heapData[i] = td;
    const tf = heapFScore[min]; heapFScore[min] = heapFScore[i]; heapFScore[i] = tf;
    i = min;
  }
  return result;
}

function heapClear(): void {
  heapSize = 0;
}

// --- Visited tracking ---
// cameFrom[cellIdx] = parent cellIdx, or -1 if unvisited
const cameFrom = new Int32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
const gScore = new Float32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
const closed = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);

/** Check if a block is solid (obstacle for pathing). */
function isSolid(packed: number): boolean {
  const id = getBlockFromPacked(packed);
  if (id === BLOCK_AIR) return false;
  const def = getBlockDef(id);
  return def?.category === "solid";
}

/** Check if a cell is walkable (the blockhead can stand in it). */
function isWalkable(packed: number): boolean {
  const id = getBlockFromPacked(packed);
  if (id === BLOCK_AIR) return true;
  const def = getBlockDef(id);
  if (!def) return false;
  // Liquids, climbable, and non-solid special blocks are walkable
  if (def.category === "liquid") return true;
  if (def.climbable) return true;
  // Special non-solid blocks (torch, scaffolding, stations that are non-solid)
  if (def.category === "special" && !isSolid(packed)) return true;
  return false;
}

/** Check if there's a solid wall to the left or right of cell (x, y). */
function hasWallAdjacent(fg: Uint16Array, x: number, y: number): boolean {
  for (const dx of [-1, 1]) {
    const wx = x + dx;
    if (wx < 0 || wx >= ACTIVE_GRID_W) continue;
    if (y >= 0 && y < ACTIVE_GRID_H && isSolid(fg[y * ACTIVE_GRID_W + wx])) return true;
    // Also check the cell above (blockhead is 2 tall)
    if (y - 1 >= 0 && isSolid(fg[(y - 1) * ACTIVE_GRID_W + wx])) return true;
  }
  return false;
}

/** Check if there's a background block at cell (x, y). */
function hasBgBlock(bg: Uint16Array, x: number, y: number): boolean {
  if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return false;
  return (bg[y * ACTIVE_GRID_W + x] & 0xFF) !== BLOCK_AIR;
}

/**
 * Check if the blockhead can climb vertically at cell (x, y).
 * True if: climbable block, adjacent wall, or background wall.
 */
function canClimbAt(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  // Climbable block (ladder/rope)
  const cell = fg[y * ACTIVE_GRID_W + x];
  const def = getBlockDef(getBlockFromPacked(cell));
  if (def?.climbable) return true;
  // Adjacent solid wall
  if (hasWallAdjacent(fg, x, y)) return true;
  // Background wall
  if (hasBgBlock(bg, x, y)) return true;
  return false;
}

/** Check if a cell contains a liquid block (water/lava). */
function isLiquid(packed: number): boolean {
  const def = getBlockDef(getBlockFromPacked(packed));
  return def?.category === "liquid";
}

/**
 * Check if the blockhead can stay at cell (x, y) without falling.
 * True if: solid ground below, climbing (wall/ladder/backwall), swimming
 * (liquid), or at the bottom of the grid.
 */
function isSupported(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  // Ground below (solid block at y+1)
  if (y + 1 < ACTIVE_GRID_H && isSolid(fg[(y + 1) * ACTIVE_GRID_W + x])) return true;
  // Climbing (ladder, adjacent wall, back wall)
  if (canClimbAt(fg, bg, x, y)) return true;
  // Swimming (liquid cell — buoyancy counteracts gravity)
  if (isLiquid(fg[y * ACTIVE_GRID_W + x])) return true;
  // Bottom of grid (can't fall further)
  if (y + 1 >= ACTIVE_GRID_H) return true;
  return false;
}

/**
 * Check if a cell is supported ONLY by a back wall (background block) — no
 * foreground ground below, no ladder, no adjacent foreground wall, no liquid.
 * These cells are climbable but slow and stamina-draining. The pathfinder
 * should charge a high cost for routing through them to prefer ground routes
 * and avoid climbing trees/walls unnecessarily.
 */
function isBackWallOnlySupported(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  // If there's foreground ground below, it's not back-wall-only
  if (y + 1 < ACTIVE_GRID_H && isSolid(fg[(y + 1) * ACTIVE_GRID_W + x])) return false;
  // If there's a liquid, it's not back-wall-only
  if (isLiquid(fg[y * ACTIVE_GRID_W + x])) return false;
  // If at the bottom of the grid, it's not back-wall-only
  if (y + 1 >= ACTIVE_GRID_H) return false;
  // Check what kind of climbing support is available
  const cell = fg[y * ACTIVE_GRID_W + x];
  const def = getBlockDef(getBlockFromPacked(cell));
  if (def?.climbable) return false; // ladder/rope — not back-wall-only
  if (hasWallAdjacent(fg, x, y)) return false; // foreground wall — not back-wall-only
  // Only back wall support remains
  return hasBgBlock(bg, x, y);
}

/**
 * Compute where the blockhead lands if it falls from cell (x, y).
 * Falls downward through walkable cells until reaching a supported cell.
 * Checks 2-tall clearance (feet at cy, head at cy-1) during the fall.
 * @returns Landing Y, or -1 if the fall is blocked (hit a solid block or
 *          fell out of the grid).
 */
function computeFallLanding(fg: Uint16Array, bg: Uint16Array, x: number, y: number): number {
  let cy = y;
  while (cy < ACTIVE_GRID_H) {
    // Feet cell must be walkable
    if (!isWalkable(fg[cy * ACTIVE_GRID_W + x])) return -1;
    // Head cell (cy-1) must be walkable, unless climbing
    if (cy >= 1 && !isWalkable(fg[(cy - 1) * ACTIVE_GRID_W + x])) {
      if (!canClimbAt(fg, bg, x, cy)) return -1;
    }
    // Can the blockhead stay here?
    if (isSupported(fg, bg, x, cy)) return cy;
    cy++;
  }
  return -1;
}

/**
 * Check if the blockhead can jump from (x0, y0) to (x1, y0) — a horizontal
 * jump across a 1-block gap (2 cells horizontally) at the same height.
 * This is used to cross 1-block-wide pits without falling in.
 *
 * Conditions:
 * - The blockhead is supported at (x0, y0) (on ground)
 * - The cell above the blockhead (x0, y0-1) is walkable (room to jump)
 * - The intermediate cell (x0±1, y0) is walkable (air — the gap)
 * - The target cell (x1, y0) is walkable
 * - The cell above the target (x1, y0-1) is walkable (room to land)
 * - The target is supported (ground at x1, y0+1)
 */
function canJumpAcross(
  fg: Uint16Array, bg: Uint16Array,
  x0: number, y0: number, x1: number,
): boolean {
  if (x1 < 0 || x1 >= ACTIVE_GRID_W) return false;
  if (Math.abs(x1 - x0) !== 2) return false; // only 2-cell horizontal jumps
  const midX = x0 + (x1 > x0 ? 1 : -1);
  // Room to jump from current
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + x0])) return false;
  // Gap cell must be walkable (air)
  if (!isWalkable(fg[y0 * ACTIVE_GRID_W + midX])) return false;
  // Gap cell above must be walkable (room to pass through)
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + midX])) return false;
  // Target cell must be walkable
  if (!isWalkable(fg[y0 * ACTIVE_GRID_W + x1])) return false;
  // Room to land at target (head cell walkable, or climbing)
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + x1])) {
    if (!canClimbAt(fg, bg, x1, y0)) return false;
  }
  // Target must be supported (ground below)
  if (!isSupported(fg, bg, x1, y0)) return false;
  return true;
}

/**
 * Check if the blockhead can jump from (x0, y0) to (x1, y0-1) — a diagonal
 * up move representing jump + horizontal movement. This is used to cross
 * 2-block-wide holes and step up 1-block ledges without routing through
 * unsupported intermediate cells.
 *
 * Conditions:
 * - The blockhead is supported at (x0, y0) (on ground)
 * - The cell above the blockhead (x0, y0-1) is walkable (room to jump)
 * - The target cell (x1, y0-1) is walkable
 * - The cell above the target (x1, y0-2) is walkable (room to stand)
 * - The target is supported (ground at x1, y0)
 */
function canJumpUp(
  fg: Uint16Array, bg: Uint16Array,
  x0: number, y0: number, x1: number,
): boolean {
  if (x1 < 0 || x1 >= ACTIVE_GRID_W) return false;
  const ty = y0 - 1; // target Y (1 block up)
  if (ty < 0) return false;
  // Target cell must be walkable
  if (!isWalkable(fg[ty * ACTIVE_GRID_W + x1])) return false;
  // Room to stand at target (head cell walkable, or climbing)
  if (ty - 1 >= 0 && !isWalkable(fg[(ty - 1) * ACTIVE_GRID_W + x1])) {
    if (!canClimbAt(fg, bg, x1, ty)) return false;
  }
  // Target must be supported (ground below, or climbing)
  if (!isSupported(fg, bg, x1, ty)) return false;
  // Room to jump from current (head cell above current must be walkable)
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + x0])) return false;
  return true;
}

/**
 * Check if the blockhead can step from (x0,y0) to (x1,y1).
 * Handles: normal walk, auto-jump, crawl (1-high gaps), wall climb.
 */
function canStep(
  fg: Uint16Array, bg: Uint16Array,
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  if (x1 < 0 || x1 >= ACTIVE_GRID_W || y1 < 0 || y1 >= ACTIVE_GRID_H) return false;
  const target = fg[y1 * ACTIVE_GRID_W + x1];
  if (!isWalkable(target)) return false;

  const isVertical = x1 === x0;
  const isHorizontal = y1 === y0;

  if (isVertical) {
    // Vertical movement (up or down): need the 2nd cell above to be walkable
    // (blockhead is 2 tall), OR we're climbing a wall (only need 1 cell)
    if (y1 - 1 >= 0) {
      const above = fg[(y1 - 1) * ACTIVE_GRID_W + x1];
      if (!isWalkable(above)) {
        // Can still move if we're wall/back-wall climbing
        if (!canClimbAt(fg, bg, x1, y1)) return false;
      }
    }
    // If stepping up (y1 < y0), check we can jump or climb from current
    if (y1 < y0) {
      if (y0 - 1 >= 0) {
        const aboveCurrent = fg[(y0 - 1) * ACTIVE_GRID_W + x0];
        if (!isWalkable(aboveCurrent)) {
          // Can we climb from current position?
          if (!canClimbAt(fg, bg, x0, y0)) return false;
        }
      }
    }
    return true;
  }

  if (isHorizontal) {
    // Horizontal movement: normally need 2 cells walkable (blockhead is 2 tall)
    const aboveOk = y1 - 1 < 0 || isWalkable(fg[(y1 - 1) * ACTIVE_GRID_W + x1]);
    if (aboveOk) return true;
    // Crawling: if only 1 cell is walkable (ceiling above), allow crawling
    // if the current cell also has a ceiling (we're already crawling)
    // or if we can transition into a crawl
    return true; // allow crawl — physics will slow the blockhead down
  }

  return true;
}

/** Manhattan distance with optional cylinder wrap on X. */
function heuristic(ax: number, ay: number, bx: number, by: number, wrap: boolean): number {
  const dy = Math.abs(ay - by);
  let dx = Math.abs(ax - bx);
  if (wrap) {
    dx = Math.min(dx, ACTIVE_GRID_W - dx);
  }
  return dx + dy;
}

/**
 * A* pathfinding through the active grid foreground.
 *
 * @param fg       Active grid foreground (packed block IDs)
 * @param bg       Active grid background (for back wall climbing)
 * @param startX   Start X (active grid coords)
 * @param startY   Start Y (active grid coords)
 * @param goalX    Goal X (active grid coords)
 * @param goalY    Goal Y (active grid coords)
 * @param wrap     Whether to wrap horizontally (cylinder world). Default true.
 * @returns Array of PathNode from start (exclusive) to goal (inclusive),
 *          or null if no path found within MAX_NODES.
 */
export function findPath(
  fg: Uint16Array,
  bg: Uint16Array,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  wrap: boolean = true,
): PathNode[] | null {
  // Clamp start/goal to grid bounds
  const sx = Math.max(0, Math.min(ACTIVE_GRID_W - 1, startX));
  const sy = Math.max(0, Math.min(ACTIVE_GRID_H - 1, startY));
  const gx = Math.max(0, Math.min(ACTIVE_GRID_W - 1, goalX));
  const gy = Math.max(0, Math.min(ACTIVE_GRID_H - 1, goalY));

  const startIdx = sy * ACTIVE_GRID_W + sx;
  const goalIdx = gy * ACTIVE_GRID_W + gx;

  if (startIdx === goalIdx) return [];

  const goalSet = new Set<number>([goalIdx]);
  const goalCoords: PathNode[] = [{ x: gx, y: gy }];

  return findPathMultiGoal(fg, bg, sx, sy, goalSet, goalCoords, wrap);
}

/**
 * Find a path to any standable cell adjacent to a target block at
 * (targetX, targetY). Used for mining/placing tasks where the target cell
 * itself is solid (not walkable) — the blockhead must stand next to it.
 *
 * @returns Array of PathNode from start (exclusive) to the best adjacent
 *          goal cell (inclusive), or null if no path found.
 */
export function findPathToAdjacent(
  fg: Uint16Array,
  bg: Uint16Array,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  wrap: boolean = true,
): PathNode[] | null {
  const sx = Math.max(0, Math.min(ACTIVE_GRID_W - 1, startX));
  const sy = Math.max(0, Math.min(ACTIVE_GRID_H - 1, startY));
  const tx = Math.max(0, Math.min(ACTIVE_GRID_W - 1, targetX));
  const ty = Math.max(0, Math.min(ACTIVE_GRID_H - 1, targetY));

  // Collect all standable cells adjacent to the target block, plus the
  // target cell itself if the foreground is walkable (for background mining
  // — e.g. tree leaves/wood in the background layer where the foreground
  // is air and the blockhead can stand at the target position).
  const goalSet = new Set<number>();
  const goalCoords: PathNode[] = [];
  const startIdx = sy * ACTIVE_GRID_W + sx;

  // Helper: validate and add a candidate goal cell
  function addGoalCandidate(cx: number, cy: number): void {
    if (cx < 0 || cx >= ACTIVE_GRID_W || cy < 0 || cy >= ACTIVE_GRID_H) return;
    const idx = cy * ACTIVE_GRID_W + cx;
    // Must be walkable (foreground is air/liquid/climbable)
    if (!isWalkable(fg[cy * ACTIVE_GRID_W + cx])) return;
    // Headroom (cell above must be walkable, unless climbing)
    if (cy >= 1 && !isWalkable(fg[(cy - 1) * ACTIVE_GRID_W + cx])) {
      if (!canClimbAt(fg, bg, cx, cy)) return;
    }
    // Must be supported (can stand here without falling)
    if (!isSupported(fg, bg, cx, cy)) return;
    goalSet.add(idx);
    goalCoords.push({ x: cx, y: cy });
  }

  // The target cell itself — valid when the foreground is walkable (e.g.
  // the target block is in the background layer, like tree leaves/wood).
  addGoalCandidate(tx, ty);

  // 4 direct neighbors + 4 diagonals (blockhead is 2 tall, can reach
  // diagonally-adjacent targets within the isAdjacent tolerance)
  addGoalCandidate(tx - 1, ty); addGoalCandidate(tx + 1, ty);
  addGoalCandidate(tx, ty - 1); addGoalCandidate(tx, ty + 1);
  addGoalCandidate(tx - 1, ty - 1); addGoalCandidate(tx + 1, ty - 1);
  addGoalCandidate(tx - 1, ty + 1); addGoalCandidate(tx + 1, ty + 1);

  if (goalSet.size === 0) return null;

  return findPathMultiGoal(fg, bg, sx, sy, goalSet, goalCoords, wrap);
}

/**
 * Multi-goal A* core. Finds a path from (sx, sy) to any of the goal cells in
 * goalSet. Uses the minimum heuristic to any goal for the A* estimate.
 */
function findPathMultiGoal(
  fg: Uint16Array,
  bg: Uint16Array,
  sx: number,
  sy: number,
  goalSet: Set<number>,
  goalCoords: PathNode[],
  wrap: boolean,
): PathNode[] | null {
  const startIdx = sy * ACTIVE_GRID_W + sx;

  // If start is already a goal, return empty path
  if (goalSet.has(startIdx)) return [];

  // Reset visited tracking
  cameFrom.fill(-1);
  closed.fill(0);
  gScore.fill(Infinity);

  heapClear();
  let nodesExpanded = 0;

  gScore[startIdx] = 0;
  const h0 = minHeuristic(sx, sy, goalCoords, wrap);
  if (!heapPush(startIdx, h0)) return null;

  while (heapSize > 0) {
    const current = heapPop();
    if (current < 0) break;

    if (goalSet.has(current)) {
      // Reached a goal — reconstruct path
      return reconstructPath(cameFrom, current, sx, sy);
    }

    if (closed[current]) continue;
    closed[current] = 1;
    nodesExpanded++;
    if (nodesExpanded > MAX_NODES) return null;

    const cx = current % ACTIVE_GRID_W;
    const cy = Math.floor(current / ACTIVE_GRID_W);
    const currentG = gScore[current];

    // Expand 4 neighbors: left, right, up, down
    // Left
    let nx = cx - 1;
    if (nx < 0) nx = wrap ? ACTIVE_GRID_W - 1 : -1;
    if (nx >= 0) expandNeighbor(fg, bg, cx, cy, nx, cy, current, currentG, goalCoords, wrap);
    // Right
    nx = cx + 1;
    if (nx >= ACTIVE_GRID_W) nx = wrap ? 0 : -1;
    if (nx >= 0) expandNeighbor(fg, bg, cx, cy, nx, cy, current, currentG, goalCoords, wrap);
    // Up (step up — requires jump or wall climb)
    if (cy - 1 >= 0) expandNeighbor(fg, bg, cx, cy, cx, cy - 1, current, currentG, goalCoords, wrap);
    // Down (step down — always allowed if walkable, may fall)
    if (cy + 1 < ACTIVE_GRID_H) expandNeighbor(fg, bg, cx, cy, cx, cy + 1, current, currentG, goalCoords, wrap);

    // Jump-move (diagonal up): jump + horizontal movement to cross 2-block
    // holes and step up 1-block ledges. Only from supported cells (on ground).
    if (isSupported(fg, bg, cx, cy)) {
      // Jump up-left
      let jx = cx - 1;
      if (jx < 0) jx = wrap ? ACTIVE_GRID_W - 1 : -1;
      if (jx >= 0 && canJumpUp(fg, bg, cx, cy, jx)) {
        expandJumpNeighbor(fg, bg, cx, cy, jx, cy - 1, current, currentG, goalCoords, wrap);
      }
      // Jump up-right
      jx = cx + 1;
      if (jx >= ACTIVE_GRID_W) jx = wrap ? 0 : -1;
      if (jx >= 0 && canJumpUp(fg, bg, cx, cy, jx)) {
        expandJumpNeighbor(fg, bg, cx, cy, jx, cy - 1, current, currentG, goalCoords, wrap);
      }

      // Horizontal jump (jump across a 1-block gap at same height)
      // Jump 2 cells left
      let hx = cx - 2;
      if (hx < 0) hx = wrap ? ACTIVE_GRID_W + hx : -1;
      if (hx >= 0 && canJumpAcross(fg, bg, cx, cy, hx)) {
        expandJumpNeighbor(fg, bg, cx, cy, hx, cy, current, currentG, goalCoords, wrap);
      }
      // Jump 2 cells right
      hx = cx + 2;
      if (hx >= ACTIVE_GRID_W) hx = wrap ? hx - ACTIVE_GRID_W : -1;
      if (hx >= 0 && canJumpAcross(fg, bg, cx, cy, hx)) {
        expandJumpNeighbor(fg, bg, cx, cy, hx, cy, current, currentG, goalCoords, wrap);
      }
    }
  }

  return null; // no path
}

/** Minimum Manhattan distance (with wrap) from (x, y) to any goal. */
function minHeuristic(x: number, y: number, goals: PathNode[], wrap: boolean): number {
  let min = Infinity;
  for (const g of goals) {
    const h = heuristic(x, y, g.x, g.y, wrap);
    if (h < min) min = h;
  }
  return min;
}

function expandNeighbor(
  fg: Uint16Array,
  bg: Uint16Array,
  cx: number, cy: number,
  nx: number, ny: number,
  currentIdx: number,
  currentG: number,
  goalCoords: PathNode[],
  wrap: boolean,
): void {
  if (!canStep(fg, bg, cx, cy, nx, ny)) return;

  // Gravity modeling: if the move is horizontal or downward and the target
  // cell is not supported, the blockhead falls to the landing cell.
  // For upward moves, the target must also be supported (or climbable) —
  // otherwise the blockhead would immediately fall back down after moving up.
  const isUp = nx === cx && ny < cy;
  if (!isUp) {
    if (!isSupported(fg, bg, nx, ny)) {
      const landingY = computeFallLanding(fg, bg, nx, ny);
      if (landingY < 0) return; // can't fall there — invalid move
      ny = landingY;
    }
  } else {
    // Upward move: reject if the target is not supported (no ground, no
    // wall, no back wall, no ladder). Without this, the pathfinder routes
    // through unsupported cells above pits — the blockhead moves up but
    // immediately falls back, getting stuck.
    if (!isSupported(fg, bg, nx, ny)) return;
  }

  const nIdx = ny * ACTIVE_GRID_W + nx;
  if (closed[nIdx]) return;

  // Cost model:
  // - 1 for walking on ground / falling / ladder climbing
  // - 3 for foreground wall climbing (up)
  // - 10 for back-wall-only climbing (up or horizontal) — slow, stamina-draining,
  //   and should only be used when there's no ground route (e.g. reaching a
  //   tree leaf). Without this, the pathfinder routes through tree trunks
  //   instead of around them.
  const isVertical = nx === cx;
  let cost = 1;
  if (isVertical && ny < cy) {
    // Moving up — check if wall/back-wall climbing (not ladder)
    const cell = fg[ny * ACTIVE_GRID_W + nx];
    const def = getBlockDef(getBlockFromPacked(cell));
    const isLadder = def?.climbable ?? false;
    if (!isLadder) {
      // Check if this is back-wall-only (no foreground wall, no ground)
      if (isBackWallOnlySupported(fg, bg, nx, ny)) {
        cost = 10; // back-wall climbing — very expensive
      } else {
        cost = 3; // foreground wall climbing
      }
    }
  } else if (!isVertical && !isUp) {
    // Horizontal movement through a back-wall-only-supported cell (e.g.
    // traversing along a tree trunk) — expensive to discourage tree routes.
    if (isBackWallOnlySupported(fg, bg, nx, ny)) {
      cost = 8;
    }
  }
  const tentativeG = currentG + cost;
  if (tentativeG < gScore[nIdx]) {
    gScore[nIdx] = tentativeG;
    cameFrom[nIdx] = currentIdx;
    const f = tentativeG + minHeuristic(nx, ny, goalCoords, wrap);
    heapPush(nIdx, f);
  }
}

/**
 * Expand a jump-move neighbor (diagonal up: x±1, y-1). The canJumpUp check
 * was already done by the caller. Cost is 2 (slightly more than walking,
 * less than wall climbing) — represents a jump + horizontal move.
 */
function expandJumpNeighbor(
  fg: Uint16Array,
  bg: Uint16Array,
  cx: number, cy: number,
  nx: number, ny: number,
  currentIdx: number,
  currentG: number,
  goalCoords: PathNode[],
  wrap: boolean,
): void {
  const nIdx = ny * ACTIVE_GRID_W + nx;
  if (closed[nIdx]) return;
  // Check if the target is back-wall-only supported (e.g. jumping onto a
  // tree trunk) — charge extra to discourage tree routes.
  let cost = 2;
  if (isBackWallOnlySupported(fg, bg, nx, ny)) {
    cost = 10;
  }
  const tentativeG = currentG + cost;
  if (tentativeG < gScore[nIdx]) {
    gScore[nIdx] = tentativeG;
    cameFrom[nIdx] = currentIdx;
    const f = tentativeG + minHeuristic(nx, ny, goalCoords, wrap);
    heapPush(nIdx, f);
  }
}

function reconstructPath(cameFrom: Int32Array, goalIdx: number, sx: number, sy: number): PathNode[] {
  const path: PathNode[] = [];
  let current = goalIdx;
  while (current >= 0) {
    const cx = current % ACTIVE_GRID_W;
    const cy = Math.floor(current / ACTIVE_GRID_W);
    path.push({ x: cx, y: cy });
    if (current === sy * ACTIVE_GRID_W + sx) break;
    current = cameFrom[current];
  }
  path.reverse();
  // Exclude the start node (caller is already there)
  if (path.length > 0 && path[0].x === sx && path[0].y === sy) {
    path.shift();
  }
  return path;
}
