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

  // Reset visited tracking
  cameFrom.fill(-1);
  closed.fill(0);
  gScore.fill(Infinity);

  heapClear();
  let nodesExpanded = 0;

  gScore[startIdx] = 0;
  if (!heapPush(startIdx, heuristic(sx, sy, gx, gy, wrap))) return null;

  while (heapSize > 0) {
    const current = heapPop();
    if (current < 0) break;

    if (current === goalIdx) {
      // Reconstruct path
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
    if (nx >= 0) expandNeighbor(fg, bg, cx, cy, nx, cy, current, currentG, gx, gy, wrap);
    // Right
    nx = cx + 1;
    if (nx >= ACTIVE_GRID_W) nx = wrap ? 0 : -1;
    if (nx >= 0) expandNeighbor(fg, bg, cx, cy, nx, cy, current, currentG, gx, gy, wrap);
    // Up (step up — requires jump or wall climb)
    if (cy - 1 >= 0) expandNeighbor(fg, bg, cx, cy, cx, cy - 1, current, currentG, gx, gy, wrap);
    // Down (step down — always allowed if walkable)
    if (cy + 1 < ACTIVE_GRID_H) expandNeighbor(fg, bg, cx, cy, cx, cy + 1, current, currentG, gx, gy, wrap);
  }

  return null; // no path
}

function expandNeighbor(
  fg: Uint16Array,
  bg: Uint16Array,
  cx: number, cy: number,
  nx: number, ny: number,
  currentIdx: number,
  currentG: number,
  gx: number, gy: number,
  wrap: boolean,
): void {
  if (!canStep(fg, bg, cx, cy, nx, ny)) return;
  const nIdx = ny * ACTIVE_GRID_W + nx;
  if (closed[nIdx]) return;
  // Cost: 1 for horizontal, 1 for vertical (uniform cost)
  // Wall climbing is slower, so cost more to prefer walking routes
  const isVertical = nx === cx;
  let cost = 1;
  if (isVertical) {
    // Check if this is a wall climb (no ladder, just wall or back wall)
    const cell = fg[ny * ACTIVE_GRID_W + nx];
    const def = getBlockDef(getBlockFromPacked(cell));
    const isLadder = def?.climbable ?? false;
    if (!isLadder) {
      // Wall or back wall climbing — higher cost (slower movement)
      cost = 3;
    }
  }
  const tentativeG = currentG + cost;
  if (tentativeG < gScore[nIdx]) {
    gScore[nIdx] = tentativeG;
    cameFrom[nIdx] = currentIdx;
    const f = tentativeG + heuristic(nx, ny, gx, gy, wrap);
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
