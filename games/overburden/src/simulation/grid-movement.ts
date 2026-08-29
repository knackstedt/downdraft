// ============================================================================
// Overburden — weighted grid-movement A* pathfinder
//
// This is the refactored pathfinding system. It grades every candidate move
// by movement mode and assigns a cost, so A* minimizes total cost = a balance
// of distance AND difficulty. Lower cost = higher priority.
//
// Movement modes (lowest cost = highest priority):
//   WALK_H        1.0   horizontal walking on a stable fg surface
//   FALL          1.0   vertical fall through air to a landing cell
//   LADDER_V      1.2   vertical movement on a climbable (ladder/rope/trellis/vine)
//   JUMP_UP       2.0   fg diagonal-up (jump + horizontal, x±1, y-1)
//   JUMP_ACROSS   2.0   fg 2-cell horizontal jump across a 1-wide gap
//   WALL_CLIMB_V  3.0   vertical up clinging to an adjacent fg wall (layer 1/2)
//   BACKWALL_DIAG 5.0   diagonal move supported only by a bg block (layer 3/4)
//   BACKWALL_H    8.0   horizontal move supported only by a bg block (layer 3/4)
//   BACKWALL_V   10.0   vertical up supported only by a bg block (layer 3/4)
//   CRAWL_H      12.0   horizontal through a 1-block-high gap (player goes 1x2 → 1x1)
//
// Cylinder wrap: the world wraps horizontally on X. When wrap=true, the
// heuristic and neighbor expansion account for the shorter path around the
// cylinder.
//
// Max nodes: 4096 (cap to prevent long searches). If exceeded, returns null.
//
// Pure + synchronous + worker-agnostic: unit-testable and safe to call from
// the dedicated pather worker (pathfinding-worker.ts) which reads the active
// grid directly from the SharedArrayBuffer.
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, BLOCK_AIR } from "../shared/constants";
import { getBlockFromPacked } from "./fluid-sim";

// ---------------------------------------------------------------------------
// Public types + cost constants
// ---------------------------------------------------------------------------

export type MoveMode =
  | "WALK_H"
  | "FALL"
  | "LADDER_V"
  | "JUMP_UP"
  | "JUMP_ACROSS"
  | "WALL_CLIMB_V"
  | "BACKWALL_DIAG"
  | "BACKWALL_H"
  | "BACKWALL_V"
  | "CRAWL_H";

export interface PathNode {
  x: number;
  y: number;
  /** Movement mode used to enter this cell (undefined on the start node). */
  mode?: MoveMode;
}

// Tunable cost constants — exported so playtesting can adjust in one place.
export const COST_WALK_H = 1.0;
export const COST_FALL = 1.0;
export const COST_LADDER_V = 1.2;
export const COST_JUMP = 2.0; // JUMP_UP + JUMP_ACROSS share a cost
export const COST_WALL_CLIMB_V = 3.0;
export const COST_BACKWALL_DIAG = 5.0;
export const COST_BACKWALL_H = 8.0;
export const COST_BACKWALL_V = 10.0;
export const COST_CRAWL_H = 12.0;

const MAX_NODES = 4096;

// ---------------------------------------------------------------------------
// Binary heap (min-heap by fScore)
// Stores cell indices (y * ACTIVE_GRID_W + x). fScore stored separately.
// ---------------------------------------------------------------------------
const heapData = new Int32Array(MAX_NODES + 1);
const heapFScore = new Float32Array(MAX_NODES + 1);
let heapSize = 0;

function heapPush(cellIdx: number, fScore: number): boolean {
  if (heapSize >= MAX_NODES) return false;
  heapSize++;
  let i = heapSize;
  heapData[i] = cellIdx;
  heapFScore[i] = fScore;
  while (i > 1) {
    const parent = i >> 1;
    if (heapFScore[parent] <= heapFScore[i]) break;
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

// ---------------------------------------------------------------------------
// Visited tracking
// ---------------------------------------------------------------------------
const cameFrom = new Int32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
const gScore = new Float32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
const closed = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);

// ---------------------------------------------------------------------------
// Cell predicates
// ---------------------------------------------------------------------------

function isSolid(packed: number): boolean {
  const id = getBlockFromPacked(packed);
  if (id === BLOCK_AIR) return false;
  const def = getBlockDef(id);
  return def?.category === "solid";
}

function isWalkable(packed: number): boolean {
  const id = getBlockFromPacked(packed);
  if (id === BLOCK_AIR) return true;
  const def = getBlockDef(id);
  if (!def) return false;
  if (def.category === "liquid") return true;
  if (def.climbable) return true;
  if (def.category === "special" && !isSolid(packed)) return true;
  return false;
}

function hasWallAdjacent(fg: Uint16Array, x: number, y: number): boolean {
  for (const dx of [-1, 1]) {
    const wx = x + dx;
    if (wx < 0 || wx >= ACTIVE_GRID_W) continue;
    if (y >= 0 && y < ACTIVE_GRID_H && isSolid(fg[y * ACTIVE_GRID_W + wx])) return true;
    if (y - 1 >= 0 && isSolid(fg[(y - 1) * ACTIVE_GRID_W + wx])) return true;
  }
  return false;
}

function hasBgBlock(bg: Uint16Array, x: number, y: number): boolean {
  if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return false;
  return (bg[y * ACTIVE_GRID_W + x] & 0xFF) !== BLOCK_AIR;
}

function canClimbAt(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  const cell = fg[y * ACTIVE_GRID_W + x];
  const def = getBlockDef(getBlockFromPacked(cell));
  if (def?.climbable) return true;
  if (hasWallAdjacent(fg, x, y)) return true;
  if (hasBgBlock(bg, x, y)) return true;
  return false;
}

function isLiquid(packed: number): boolean {
  const def = getBlockDef(getBlockFromPacked(packed));
  return def?.category === "liquid";
}

function isClimbableCell(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return false;
  const cell = fg[y * ACTIVE_GRID_W + x];
  const def = getBlockDef(getBlockFromPacked(cell));
  if (def?.climbable) return true;
  // background climbable (ladder/rope placed in bg plane)
  const bgPacked = bg[y * ACTIVE_GRID_W + x];
  if (bgPacked !== 0) {
    const bgDef = getBlockDef(getBlockFromPacked(bgPacked));
    if (bgDef?.climbable) return true;
  }
  return false;
}

function isSupported(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  if (y + 1 < ACTIVE_GRID_H && isSolid(fg[(y + 1) * ACTIVE_GRID_W + x])) return true;
  if (canClimbAt(fg, bg, x, y)) return true;
  if (isLiquid(fg[y * ACTIVE_GRID_W + x])) return true;
  if (y + 1 >= ACTIVE_GRID_H) return true;
  return false;
}

function isBackWallOnlySupported(fg: Uint16Array, bg: Uint16Array, x: number, y: number): boolean {
  if (y + 1 < ACTIVE_GRID_H && isSolid(fg[(y + 1) * ACTIVE_GRID_W + x])) return false;
  if (isLiquid(fg[y * ACTIVE_GRID_W + x])) return false;
  if (y + 1 >= ACTIVE_GRID_H) return false;
  const cell = fg[y * ACTIVE_GRID_W + x];
  const def = getBlockDef(getBlockFromPacked(cell));
  if (def?.climbable) return false;
  if (hasWallAdjacent(fg, x, y)) return false;
  return hasBgBlock(bg, x, y);
}

function computeFallLanding(fg: Uint16Array, bg: Uint16Array, x: number, y: number): number {
  let cy = y;
  while (cy < ACTIVE_GRID_H) {
    if (!isWalkable(fg[cy * ACTIVE_GRID_W + x])) return -1;
    if (cy >= 1 && !isWalkable(fg[(cy - 1) * ACTIVE_GRID_W + x])) {
      if (!canClimbAt(fg, bg, x, cy)) return -1;
    }
    if (isSupported(fg, bg, x, cy)) return cy;
    cy++;
  }
  return -1;
}

function canJumpAcross(
  fg: Uint16Array, bg: Uint16Array,
  x0: number, y0: number, x1: number,
): boolean {
  if (x1 < 0 || x1 >= ACTIVE_GRID_W) return false;
  if (Math.abs(x1 - x0) !== 2) return false;
  const midX = x0 + (x1 > x0 ? 1 : -1);
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + x0])) return false;
  if (!isWalkable(fg[y0 * ACTIVE_GRID_W + midX])) return false;
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + midX])) return false;
  if (!isWalkable(fg[y0 * ACTIVE_GRID_W + x1])) return false;
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + x1])) {
    if (!canClimbAt(fg, bg, x1, y0)) return false;
  }
  if (!isSupported(fg, bg, x1, y0)) return false;
  return true;
}

function canJumpUp(
  fg: Uint16Array, bg: Uint16Array,
  x0: number, y0: number, x1: number,
): boolean {
  if (x1 < 0 || x1 >= ACTIVE_GRID_W) return false;
  const ty = y0 - 1;
  if (ty < 0) return false;
  if (!isWalkable(fg[ty * ACTIVE_GRID_W + x1])) return false;
  if (ty - 1 >= 0 && !isWalkable(fg[(ty - 1) * ACTIVE_GRID_W + x1])) {
    if (!canClimbAt(fg, bg, x1, ty)) return false;
  }
  if (!isSupported(fg, bg, x1, ty)) return false;
  if (y0 - 1 >= 0 && !isWalkable(fg[(y0 - 1) * ACTIVE_GRID_W + x0])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Move grading — the heart of the cost model
// ---------------------------------------------------------------------------

/**
 * Classify a candidate step from (cx, cy) → (nx, ny) and return its cost +
 * mode, or null if the move is illegal. The caller has already verified the
 * target cell is in-bounds; this does the rest (walkability, headroom,
 * support, gravity modeling, mode classification).
 *
 * Gravity modeling: for non-upward moves into an unsupported cell, the
 * blockhead falls to the landing cell. The returned node coordinates are
 * adjusted to the landing cell. Upward moves require the target to be
 * supported (or climbable) — otherwise the blockhead would fall right back.
 *
 * @returns `{ nx, ny, cost, mode }` or `null`. `nx/ny` may differ from the
 *          inputs after gravity modeling (fall landing).
 */
function gradeMove(
  fg: Uint16Array, bg: Uint16Array,
  cx: number, cy: number,
  nx: number, ny: number,
): { nx: number; ny: number; cost: number; mode: MoveMode } | null {
  if (nx < 0 || nx >= ACTIVE_GRID_W || ny < 0 || ny >= ACTIVE_GRID_H) return null;
  if (!isWalkable(fg[ny * ACTIVE_GRID_W + nx])) {
    // Target cell is not walkable (solid) — cannot move into it at all.
    // Crawl does NOT apply here: crawl requires the feet (target) cell to be
    // walkable (air) with a solid head cell above. The crawl exception is
    // handled in the headroom check below.
    return null;
  }

  const isVertical = nx === cx;
  const isHorizontal = ny === cy;
  const isUp = isVertical && ny < cy;

  // Headroom: the cell above the target must be walkable, unless climbing
  // or crawling. Crawl: a horizontal move where the head cell (ny-1) is solid
  // but the feet cell is walkable and there's solid fg ground below — a
  // 1-block-high corridor. The blockhead collapses to 1x1 and crawls.
  if (ny - 1 >= 0 && !isWalkable(fg[(ny - 1) * ACTIVE_GRID_W + nx])) {
    if (canClimbAt(fg, bg, nx, ny)) {
      // Climbing (ladder/wall/back-wall) — headroom not required.
    } else if (
      isHorizontal &&
      ny + 1 < ACTIVE_GRID_H && isSolid(fg[(ny + 1) * ACTIVE_GRID_W + nx])
    ) {
      // Crawl: 1-high corridor (solid ceiling, solid floor, walkable gap).
      return { nx, ny, cost: COST_CRAWL_H, mode: "CRAWL_H" };
    } else {
      return null;
    }
  }

  // Upward moves require support at the target (no jumping into the void).
  if (isUp) {
    if (!isSupported(fg, bg, nx, ny)) return null;
    // Also need to be able to leave the current cell (headroom above current,
    // or climbing from current).
    if (cy - 1 >= 0 && !isWalkable(fg[(cy - 1) * ACTIVE_GRID_W + cx])) {
      if (!canClimbAt(fg, bg, cx, cy)) return null;
    }
  }

  // Gravity modeling for non-upward moves.
  if (!isUp) {
    if (!isSupported(fg, bg, nx, ny)) {
      const landingY = computeFallLanding(fg, bg, nx, ny);
      if (landingY < 0) return null;
      ny = landingY;
    }
  }

  // --- Mode classification + cost ---
  if (isVertical) {
    if (isUp) {
      // Vertical up. Ladder? fg wall? back wall only?
      if (isClimbableCell(fg, bg, nx, ny)) {
        return { nx, ny, cost: COST_LADDER_V, mode: "LADDER_V" };
      }
      if (isBackWallOnlySupported(fg, bg, nx, ny)) {
        return { nx, ny, cost: COST_BACKWALL_V, mode: "BACKWALL_V" };
      }
      // Adjacent fg wall (layer 1/2) — the remaining climbable case.
      return { nx, ny, cost: COST_WALL_CLIMB_V, mode: "WALL_CLIMB_V" };
    }
    // Vertical down — fall (gravity handles it).
    return { nx, ny, cost: COST_FALL, mode: "FALL" };
  }

  if (isHorizontal) {
    // Back-wall-only horizontal traverse (e.g. along a tree trunk).
    if (isBackWallOnlySupported(fg, bg, nx, ny)) {
      return { nx, ny, cost: COST_BACKWALL_H, mode: "BACKWALL_H" };
    }
    return { nx, ny, cost: COST_WALK_H, mode: "WALK_H" };
  }

  // Diagonal move (only reached via the explicit diagonal expansion for
  // back-wall-supported diagonal traversal — see findPathMultiGoal).
  if (isBackWallOnlySupported(fg, bg, nx, ny)) {
    return { nx, ny, cost: COST_BACKWALL_DIAG, mode: "BACKWALL_DIAG" };
  }
  // Non-back-wall diagonal — treat as a walk (rare; only via jump expansion).
  return { nx, ny, cost: COST_WALK_H, mode: "WALK_H" };
}

// ---------------------------------------------------------------------------
// Heuristic
// ---------------------------------------------------------------------------

function heuristic(ax: number, ay: number, bx: number, by: number, wrap: boolean): number {
  const dy = Math.abs(ay - by);
  let dx = Math.abs(ax - bx);
  if (wrap) dx = Math.min(dx, ACTIVE_GRID_W - dx);
  return dx + dy;
}

function minHeuristic(x: number, y: number, goals: PathNode[], wrap: boolean): number {
  let min = Infinity;
  for (const g of goals) {
    const h = heuristic(x, y, g.x, g.y, wrap);
    if (h < min) min = h;
  }
  return min;
}

// ---------------------------------------------------------------------------
// Path reconstruction
// ---------------------------------------------------------------------------

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
  if (path.length > 0 && path[0].x === sx && path[0].y === sy) {
    path.shift();
  }
  return path;
}

// ---------------------------------------------------------------------------
// Neighbor expansion
// ---------------------------------------------------------------------------

function expandNeighbor(
  fg: Uint16Array, bg: Uint16Array,
  cx: number, cy: number,
  nx: number, ny: number,
  currentIdx: number,
  currentG: number,
  goalCoords: PathNode[],
  wrap: boolean,
): void {
  const graded = gradeMove(fg, bg, cx, cy, nx, ny);
  if (!graded) return;
  const nIdx = graded.ny * ACTIVE_GRID_W + graded.nx;
  if (closed[nIdx]) return;
  const tentativeG = currentG + graded.cost;
  if (tentativeG < gScore[nIdx]) {
    gScore[nIdx] = tentativeG;
    cameFrom[nIdx] = currentIdx;
    const f = tentativeG + minHeuristic(graded.nx, graded.ny, goalCoords, wrap);
    heapPush(nIdx, f);
  }
}

function expandJumpNeighbor(
  fg: Uint16Array, bg: Uint16Array,
  cx: number, cy: number,
  nx: number, ny: number,
  currentIdx: number,
  currentG: number,
  goalCoords: PathNode[],
  wrap: boolean,
  _mode: MoveMode,
): void {
  const nIdx = ny * ACTIVE_GRID_W + nx;
  if (closed[nIdx]) return;
  let cost = COST_JUMP;
  if (isBackWallOnlySupported(fg, bg, nx, ny)) {
    // Discourage jumping onto tree trunks / back-wall-only cells.
    cost = COST_BACKWALL_V;
  }
  const tentativeG = currentG + cost;
  if (tentativeG < gScore[nIdx]) {
    gScore[nIdx] = tentativeG;
    cameFrom[nIdx] = currentIdx;
    const f = tentativeG + minHeuristic(nx, ny, goalCoords, wrap);
    heapPush(nIdx, f);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function findPath(
  fg: Uint16Array,
  bg: Uint16Array,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  wrap: boolean = true,
): PathNode[] | null {
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

  const goalSet = new Set<number>();
  const goalCoords: PathNode[] = [];

  function addGoalCandidate(cx: number, cy: number): void {
    if (cx < 0 || cx >= ACTIVE_GRID_W || cy < 0 || cy >= ACTIVE_GRID_H) return;
    const idx = cy * ACTIVE_GRID_W + cx;
    if (!isWalkable(fg[cy * ACTIVE_GRID_W + cx])) return;
    if (cy >= 1 && !isWalkable(fg[(cy - 1) * ACTIVE_GRID_W + cx])) {
      if (!canClimbAt(fg, bg, cx, cy)) return;
    }
    if (!isSupported(fg, bg, cx, cy)) return;
    goalSet.add(idx);
    goalCoords.push({ x: cx, y: cy });
  }

  addGoalCandidate(tx, ty);
  addGoalCandidate(tx - 1, ty); addGoalCandidate(tx + 1, ty);
  addGoalCandidate(tx, ty - 1); addGoalCandidate(tx, ty + 1);
  addGoalCandidate(tx - 1, ty - 1); addGoalCandidate(tx + 1, ty - 1);
  addGoalCandidate(tx - 1, ty + 1); addGoalCandidate(tx + 1, ty + 1);

  if (goalSet.size === 0) return null;

  return findPathMultiGoal(fg, bg, sx, sy, goalSet, goalCoords, wrap);
}

// ---------------------------------------------------------------------------
// Multi-goal A* core
// ---------------------------------------------------------------------------

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

  if (goalSet.has(startIdx)) return [];

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
      return reconstructPath(cameFrom, current, sx, sy);
    }

    if (closed[current]) continue;
    closed[current] = 1;
    nodesExpanded++;
    if (nodesExpanded > MAX_NODES) return null;

    const cx = current % ACTIVE_GRID_W;
    const cy = Math.floor(current / ACTIVE_GRID_W);
    const currentG = gScore[current];

    // 4-directional expansion (left, right, up, down).
    let nx = cx - 1;
    if (nx < 0) nx = wrap ? ACTIVE_GRID_W - 1 : -1;
    if (nx >= 0) expandNeighbor(fg, bg, cx, cy, nx, cy, current, currentG, goalCoords, wrap);
    nx = cx + 1;
    if (nx >= ACTIVE_GRID_W) nx = wrap ? 0 : -1;
    if (nx >= 0) expandNeighbor(fg, bg, cx, cy, nx, cy, current, currentG, goalCoords, wrap);
    if (cy - 1 >= 0) expandNeighbor(fg, bg, cx, cy, cx, cy - 1, current, currentG, goalCoords, wrap);
    if (cy + 1 < ACTIVE_GRID_H) expandNeighbor(fg, bg, cx, cy, cx, cy + 1, current, currentG, goalCoords, wrap);

    // Diagonal back-wall expansion: when clinging to a back wall (layer 3/4),
    // the blockhead can move diagonally to an adjacent back-wall-supported
    // cell. This is cheaper than separate horizontal + vertical back-wall
    // moves (5 vs 8+10) and matches the user's priority ordering.
    if (isBackWallOnlySupported(fg, bg, cx, cy)) {
      for (const ddx of [-1, 1]) {
        for (const ddy of [-1, 1]) {
          let dxn = cx + ddx;
          if (dxn < 0) dxn = wrap ? ACTIVE_GRID_W - 1 : -1;
          if (dxn >= ACTIVE_GRID_W) dxn = wrap ? 0 : -1;
          if (dxn < 0) continue;
          const dyn = cy + ddy;
          if (dyn < 0 || dyn >= ACTIVE_GRID_H) continue;
          // Target must be back-wall-only supported too, and walkable with
          // headroom (or climbing). gradeMove's diagonal branch enforces this.
          if (!isBackWallOnlySupported(fg, bg, dxn, dyn)) continue;
          if (!isWalkable(fg[dyn * ACTIVE_GRID_W + dxn])) continue;
          if (dyn - 1 >= 0 && !isWalkable(fg[(dyn - 1) * ACTIVE_GRID_W + dxn])) {
            if (!canClimbAt(fg, bg, dxn, dyn)) continue;
          }
          expandDiagBackwall(fg, bg, cx, cy, dxn, dyn, current, currentG, goalCoords, wrap);
        }
      }
    }

    // Jump moves (only from supported cells — need ground to jump from).
    if (isSupported(fg, bg, cx, cy)) {
      // Jump up-left / up-right (diagonal up: x±1, y-1).
      let jx = cx - 1;
      if (jx < 0) jx = wrap ? ACTIVE_GRID_W - 1 : -1;
      if (jx >= 0 && canJumpUp(fg, bg, cx, cy, jx)) {
        expandJumpNeighbor(fg, bg, cx, cy, jx, cy - 1, current, currentG, goalCoords, wrap, "JUMP_UP");
      }
      jx = cx + 1;
      if (jx >= ACTIVE_GRID_W) jx = wrap ? 0 : -1;
      if (jx >= 0 && canJumpUp(fg, bg, cx, cy, jx)) {
        expandJumpNeighbor(fg, bg, cx, cy, jx, cy - 1, current, currentG, goalCoords, wrap, "JUMP_UP");
      }
      // Jump across a 1-wide gap (2 cells horizontally, same height).
      let hx = cx - 2;
      if (hx < 0) hx = wrap ? ACTIVE_GRID_W + hx : -1;
      if (hx >= 0 && canJumpAcross(fg, bg, cx, cy, hx)) {
        expandJumpNeighbor(fg, bg, cx, cy, hx, cy, current, currentG, goalCoords, wrap, "JUMP_ACROSS");
      }
      hx = cx + 2;
      if (hx >= ACTIVE_GRID_W) hx = wrap ? hx - ACTIVE_GRID_W : -1;
      if (hx >= 0 && canJumpAcross(fg, bg, cx, cy, hx)) {
        expandJumpNeighbor(fg, bg, cx, cy, hx, cy, current, currentG, goalCoords, wrap, "JUMP_ACROSS");
      }
    }
  }

  return null;
}

function expandDiagBackwall(
  _fg: Uint16Array, _bg: Uint16Array,
  _cx: number, _cy: number,
  nx: number, ny: number,
  currentIdx: number,
  currentG: number,
  goalCoords: PathNode[],
  wrap: boolean,
): void {
  // Caller (findPathMultiGoal) has already validated walkability, headroom,
  // and back-wall-only support for the diagonal target; we just push the node.
  const nIdx = ny * ACTIVE_GRID_W + nx;
  if (closed[nIdx]) return;
  const tentativeG = currentG + COST_BACKWALL_DIAG;
  if (tentativeG < gScore[nIdx]) {
    gScore[nIdx] = tentativeG;
    cameFrom[nIdx] = currentIdx;
    const f = tentativeG + minHeuristic(nx, ny, goalCoords, wrap);
    heapPush(nIdx, f);
  }
}
