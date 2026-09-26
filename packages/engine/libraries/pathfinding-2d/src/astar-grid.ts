// ============================================================================
// A* grid pathfinder — weighted multi-goal search over a 2D cell grid
//
// Extracted from overburden's grid-movement pathfinder: the generic machinery
// (binary min-heap, visited/gScore/cameFrom arrays, multi-goal A* loop, path
// reconstruction, adjacent-goal enumeration, cylinder wrap on X) lives here;
// the game supplies movement grading via `gradeMove` and optional extra
// neighbor expansion via `expandExtra`.
//
// Pure + synchronous + worker-agnostic: zero-alloc hot path (all scratch
// arrays are per-instance typed arrays), safe to call from a dedicated
// worker reading a SharedArrayBuffer-backed grid.
// ============================================================================

/** A step in a computed path. `mode` is whatever tag `gradeMove` returned. */
export interface PathNode<Mode = string> {
  x: number;
  y: number;
  /** Movement mode used to enter this cell (undefined on the start node). */
  mode?: Mode;
}

export interface GradedMove<Mode = string> {
  /** Final target cell — may differ from the requested (nx, ny) when the
   *  grader applies gravity modeling (e.g. fall-to-landing). */
  nx: number;
  ny: number;
  /** Move cost — lower is preferred. */
  cost: number;
  mode?: Mode;
}

export interface AStarGridConfig<Mode = string> {
  width: number;
  height: number;
  /** Wrap the X axis (cylindrical world): left/right edges connect, and the
   *  heuristic uses the shorter wrap distance. Default for all searches;
   *  each findPath* call may override it. */
  wrap?: boolean;
  /** Cap on open-heap size and expanded nodes (default 4096). */
  maxNodes?: number;
  /**
   * Grade a candidate step (cx,cy) → (nx,ny): return the cost/mode and the
   * final target cell, or null when the move is illegal. This is where the
   * game encodes walkability, headroom, support, gravity modeling, and
   * movement-mode costs.
   */
  gradeMove(cx: number, cy: number, nx: number, ny: number): GradedMove<Mode> | null;
  /**
   * Extra neighbor expansion for non-cardinal moves (jumps, diagonal climbs).
   * Called per popped node; push each candidate via `push`. The game is
   * responsible for validating the move — pushed cells are enqueued as-is.
   */
  expandExtra?(
    cx: number, cy: number,
    push: (nx: number, ny: number, cost: number, mode?: Mode) => void,
  ): void;
}

export interface AStarGrid<Mode = string> {
  /** Path from (sx,sy) to (gx,gy). Returns [] when already there, null on failure. */
  findPath(sx: number, sy: number, gx: number, gy: number, wrap?: boolean): PathNode<Mode>[] | null;
  /** Path to the nearest of several goal cells. */
  findPathToGoals(sx: number, sy: number, goals: ReadonlyArray<{ x: number; y: number }>, wrap?: boolean): PathNode<Mode>[] | null;
  /**
   * Path to any valid cell adjacent to (tx,ty) — the 8 surrounding cells plus
   * the target itself. `isValidGoal` filters candidates (e.g. "can the agent
   * stand here"); when omitted, all in-bounds candidates are goals.
   */
  findPathToAdjacent(
    sx: number, sy: number, tx: number, ty: number,
    isValidGoal?: (x: number, y: number) => boolean,
    wrap?: boolean,
  ): PathNode<Mode>[] | null;
}

export function createAStarGrid<Mode = string>(config: AStarGridConfig<Mode>): AStarGrid<Mode> {
  const W = config.width;
  const H = config.height;
  const defaultWrap = config.wrap ?? false;
  const MAX_NODES = config.maxNodes ?? 4096;
  // Per-search wrap flag — set at the top of each findPath* call.
  let wrap = defaultWrap;
  const gradeMove = config.gradeMove;
  const expandExtra = config.expandExtra;

  // ---------------------------------------------------------------------------
  // Binary heap (min-heap by fScore), 1-indexed.
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

  // ---------------------------------------------------------------------------
  // Visited tracking
  // ---------------------------------------------------------------------------
  const cameFrom = new Int32Array(W * H);
  const gScore = new Float32Array(W * H);
  const closed = new Uint8Array(W * H);

  function heuristic(ax: number, ay: number, bx: number, by: number): number {
    const dy = Math.abs(ay - by);
    let dx = Math.abs(ax - bx);
    if (wrap) dx = Math.min(dx, W - dx);
    return dx + dy;
  }

  function minHeuristic(x: number, y: number, goals: ReadonlyArray<{ x: number; y: number }>): number {
    let min = Infinity;
    goals.forEach((g) => {
      const h = heuristic(x, y, g.x, g.y);
      if (h < min) min = h;
    });
    return min;
  }

  function reconstructPath(goalIdx: number, sx: number, sy: number): PathNode<Mode>[] {
    const path: PathNode<Mode>[] = [];
    let current = goalIdx;
    while (current >= 0) {
      const cx = current % W;
      const cy = Math.floor(current / W);
      path.push({ x: cx, y: cy });
      if (current === sy * W + sx) break;
      current = cameFrom[current];
    }
    path.reverse();
    if (path.length > 0 && path[0].x === sx && path[0].y === sy) {
      path.shift();
    }
    return path;
  }

  function expandNeighbor(
    cx: number, cy: number,
    nx: number, ny: number,
    currentIdx: number, currentG: number,
    goalCoords: ReadonlyArray<{ x: number; y: number }>,
  ): void {
    const graded = gradeMove(cx, cy, nx, ny);
    if (!graded) return;
    const nIdx = graded.ny * W + graded.nx;
    if (closed[nIdx]) return;
    const tentativeG = currentG + graded.cost;
    if (tentativeG < gScore[nIdx]) {
      gScore[nIdx] = tentativeG;
      cameFrom[nIdx] = currentIdx;
      const f = tentativeG + minHeuristic(graded.nx, graded.ny, goalCoords);
      heapPush(nIdx, f);
    }
  }

  function findPathMultiGoal(
    sx: number, sy: number,
    goalSet: Set<number>,
    goalCoords: ReadonlyArray<{ x: number; y: number }>,
  ): PathNode<Mode>[] | null {
    const startIdx = sy * W + sx;
    if (goalSet.has(startIdx)) return [];

    cameFrom.fill(-1);
    closed.fill(0);
    gScore.fill(Infinity);
    heapSize = 0;
    let nodesExpanded = 0;

    gScore[startIdx] = 0;
    if (!heapPush(startIdx, minHeuristic(sx, sy, goalCoords))) return null;

    while (heapSize > 0) {
      const current = heapPop();
      if (current < 0) break;

      if (goalSet.has(current)) {
        return reconstructPath(current, sx, sy);
      }

      if (closed[current]) continue;
      closed[current] = 1;
      nodesExpanded++;
      if (nodesExpanded > MAX_NODES) return null;

      const cx = current % W;
      const cy = Math.floor(current / W);
      const currentG = gScore[current];

      // 4-directional expansion (left, right, up, down).
      let nx = cx - 1;
      if (nx < 0) nx = wrap ? W - 1 : -1;
      if (nx >= 0) expandNeighbor(cx, cy, nx, cy, current, currentG, goalCoords);
      nx = cx + 1;
      if (nx >= W) nx = wrap ? 0 : -1;
      if (nx >= 0) expandNeighbor(cx, cy, nx, cy, current, currentG, goalCoords);
      if (cy - 1 >= 0) expandNeighbor(cx, cy, cx, cy - 1, current, currentG, goalCoords);
      if (cy + 1 < H) expandNeighbor(cx, cy, cx, cy + 1, current, currentG, goalCoords);

      // Game-specific extra moves (jumps, diagonal climbs, teleports...).
      expandExtra?.(cx, cy, (nx2, ny2, cost, mode) => {
        if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) return;
        const nIdx = ny2 * W + nx2;
        if (closed[nIdx]) return;
        const tentativeG = currentG + cost;
        if (tentativeG < gScore[nIdx]) {
          gScore[nIdx] = tentativeG;
          cameFrom[nIdx] = current;
          const f = tentativeG + minHeuristic(nx2, ny2, goalCoords);
          heapPush(nIdx, f);
        }
      });
    }

    return null;
  }

  function clampX(x: number): number {
    return Math.max(0, Math.min(W - 1, x));
  }

  function clampY(y: number): number {
    return Math.max(0, Math.min(H - 1, y));
  }

  return {
    findPath(sx, sy, gx, gy, wrapOverride) {
      wrap = wrapOverride ?? defaultWrap;
      const cSx = clampX(sx), cSy = clampY(sy), cGx = clampX(gx), cGy = clampY(gy);
      if (cSx === cGx && cSy === cGy) return [];
      return findPathMultiGoal(cSx, cSy, new Set([cGy * W + cGx]), [{ x: cGx, y: cGy }]);
    },

    findPathToGoals(sx, sy, goals, wrapOverride) {
      wrap = wrapOverride ?? defaultWrap;
      const cSx = clampX(sx), cSy = clampY(sy);
      const goalSet = new Set<number>();
      const goalCoords: { x: number; y: number }[] = [];
      goals.forEach((g) => {
        const gx = clampX(g.x), gy = clampY(g.y);
        const idx = gy * W + gx;
        if (!goalSet.has(idx)) {
          goalSet.add(idx);
          goalCoords.push({ x: gx, y: gy });
        }
      });
      if (goalSet.size === 0) return null;
      return findPathMultiGoal(cSx, cSy, goalSet, goalCoords);
    },

    findPathToAdjacent(sx, sy, tx, ty, isValidGoal, wrapOverride) {
      wrap = wrapOverride ?? defaultWrap;
      const cSx = clampX(sx), cSy = clampY(sy);
      const cTx = clampX(tx), cTy = clampY(ty);
      const goalSet = new Set<number>();
      const goalCoords: { x: number; y: number }[] = [];

      const add = (cx: number, cy: number): void => {
        if (cx < 0 || cx >= W || cy < 0 || cy >= H) return;
        if (isValidGoal && !isValidGoal(cx, cy)) return;
        const idx = cy * W + cx;
        if (!goalSet.has(idx)) {
          goalSet.add(idx);
          goalCoords.push({ x: cx, y: cy });
        }
      };

      add(cTx, cTy);
      add(cTx - 1, cTy); add(cTx + 1, cTy);
      add(cTx, cTy - 1); add(cTx, cTy + 1);
      add(cTx - 1, cTy - 1); add(cTx + 1, cTy - 1);
      add(cTx - 1, cTy + 1); add(cTx + 1, cTy + 1);

      if (goalSet.size === 0) return null;
      return findPathMultiGoal(cSx, cSy, goalSet, goalCoords);
    },
  };
}
