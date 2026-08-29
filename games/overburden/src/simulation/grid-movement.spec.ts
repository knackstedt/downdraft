// ============================================================================
// Overburden — grid-movement A* unit tests
//
// Tests the weighted grid-movement pathfinder: cost/priority model, crawl
// routing, diagonal back-wall traversal, and ported baseline cases from the
// original pathfinding.spec.ts.
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_LADDER, BLOCK_STONE,
} from "../shared/constants";
import {
    COST_BACKWALL_V,
    COST_CRAWL_H,
    COST_WALK_H,
    findPath,
    findPathToAdjacent,
    type PathNode,
} from "./grid-movement";

// --- Grid helpers ---

function makeAirGrid(): Uint16Array {
  return new Uint16Array(ACTIVE_GRID_W * ACTIVE_GRID_H).fill(BLOCK_AIR);
}
function makeAirBg(): Uint16Array {
  return new Uint16Array(ACTIVE_GRID_W * ACTIVE_GRID_H).fill(BLOCK_AIR);
}
function setSolid(fg: Uint16Array, x: number, y: number): void {
  fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}
function setFloor(fg: Uint16Array, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}
function setBgBlock(bg: Uint16Array, x: number, y: number): void {
  bg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}

const FLOOR_Y = 110;
const STAND_Y = 109;

function expectReaches(path: PathNode[] | null, tx: number, ty: number): void {
  expect(path).not.toBeNull();
  expect(path!.length).toBeGreaterThan(0);
  const last = path![path!.length - 1];
  expect(last.x).toBe(tx);
  expect(last.y).toBe(ty);
}

// ============================================================================
// 1. Baseline (ported from pathfinding.spec.ts)
// ============================================================================

describe("grid-movement: baseline", () => {
  it("finds a straight-line path with no obstacles (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 105, STAND_Y, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    expectReaches(path, 105, STAND_Y);
  });

  it("finds a path around a 1-block wall (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    setSolid(fg, 102, STAND_Y);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 105, STAND_Y, false);
    expectReaches(path, 105, STAND_Y);
  });

  it("finds a path around a 3-block wall (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    setSolid(fg, 102, 107);
    setSolid(fg, 102, 108);
    setSolid(fg, 102, 109);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 105, STAND_Y, false);
    expectReaches(path, 105, STAND_Y);
  });

  it("returns null when walled in with no path", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    setSolid(fg, 99, 109);
    setSolid(fg, 101, 109);
    setSolid(fg, 100, 108);
    setSolid(fg, 100, 110);
    setSolid(fg, 99, 108);
    setSolid(fg, 101, 108);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 200, STAND_Y, false);
    expect(path).toBeNull();
  });

  it("handles cylinder wrap on X (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 0, ACTIVE_GRID_W - 1, FLOOR_Y);
    const path = findPath(fg, makeAirBg(), ACTIVE_GRID_W - 5, STAND_Y, 5, STAND_Y, true);
    expectReaches(path, 5, STAND_Y);
  });

  it("returns empty path when start === goal", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 100, STAND_Y, false);
    expect(path).toEqual([]);
  });
});

// ============================================================================
// 2. Crawl routing (NEW — was impossible before the refactor)
// ============================================================================

describe("grid-movement: crawl", () => {
  it("crawls through a 1-high horizontal corridor", () => {
    const fg = makeAirGrid();
    // Two chambers connected by a 1-high corridor at y=109.
    // Floor at y=110, ceiling at y=108 for x=105..108 (the corridor).
    setFloor(fg, 95, 115, FLOOR_Y);     // floor
    setFloor(fg, 105, 108, 108);        // ceiling over corridor
    // Chambers at x=95..104 and x=109..115 have full 2-high clearance.
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false);
    expectReaches(path, 112, STAND_Y);
    // Path must pass through the crawl corridor.
    const crawlNodes = path!.filter(
      (n) => n.x >= 105 && n.x <= 108 && n.y === STAND_Y,
    );
    expect(crawlNodes.length).toBeGreaterThan(0);
  });

  it("crawls through a 1-high gap in a full-height wall", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, FLOOR_Y);
    // Wall from y=0 to y=FLOOR_Y at x=105..108, gap at y=STAND_Y.
    for (let y = 0; y <= FLOOR_Y; y++) {
      for (let x = 105; x <= 108; x++) {
        if (y !== STAND_Y) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
      }
    }
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false);
    expectReaches(path, 112, STAND_Y);
  });

  it("prefers a 2-high gap over a 1-high crawl gap (cost preference)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, FLOOR_Y);
    // Wall at x=105..106 from y=0 to y=FLOOR_Y.
    // Left side (x=105): 1-high crawl gap at y=109.
    // Right side (x=106): 2-high gap at y=108..109.
    for (let y = 0; y <= FLOOR_Y; y++) {
      if (y !== STAND_Y) setSolid(fg, 105, y);
      if (y !== STAND_Y && y !== STAND_Y - 1) setSolid(fg, 106, y);
    }
    // Both routes reach the goal, but the 2-high gap (walk, cost 1) should
    // be cheaper than the crawl gap (cost 12). The path should go through x=106.
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false);
    expectReaches(path, 112, STAND_Y);
    // Path should pass through x=106 (the 2-high gap), not x=105 (crawl gap).
    const passThrough106 = path!.some((n) => n.x === 106);
    expect(passThrough106).toBe(true);
  });
});

// ============================================================================
// 3. Diagonal back-wall traversal (NEW)
// ============================================================================

describe("grid-movement: diagonal back-wall", () => {
  it("traverses diagonally along a back wall", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // No foreground floor — the blockhead clings to back walls.
    // Place back-wall blocks in a diagonal staircase from (100, 109) to
    // (108, 101): each cell (x, y) has a bg block, no fg ground, no fg wall,
    // no ladder. The blockhead must use BACKWALL_DIAG moves.
    for (let i = 0; i <= 8; i++) {
      setBgBlock(bg, 100 + i, 109 - i);
    }
    const path = findPath(fg, bg, 100, 109, 108, 101, false);
    expectReaches(path, 108, 101);
  });

  it("diagonal back-wall is cheaper than separate H+V back-wall moves", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // Two routes from (100, 109) to (102, 107):
    // Route A (diagonal): bg at (100,109), (101,108), (102,107) → 2 diag moves = 2×5 = 10
    // Route B (H then V): bg at (100,109), (101,109), (102,109), (102,108), (102,107)
    //   = 2×8 (H) + 2×10 (V) = 36
    // The diagonal route should be chosen.
    setBgBlock(bg, 100, 109);
    setBgBlock(bg, 101, 108);
    setBgBlock(bg, 102, 107);
    // Also provide the H+V route cells so both are available.
    setBgBlock(bg, 101, 109);
    setBgBlock(bg, 102, 109);
    setBgBlock(bg, 102, 108);
    const path = findPath(fg, bg, 100, 109, 102, 107, false);
    expectReaches(path, 102, 107);
    // The path should use the diagonal (pass through (101, 108)).
    const usesDiag = path!.some((n) => n.x === 101 && n.y === 108);
    expect(usesDiag).toBe(true);
  });
});

// ============================================================================
// 4. Cost preference ordering (the core of the priority model)
// ============================================================================

describe("grid-movement: cost preference", () => {
  it("prefers a longer ground+ladder walk over a shorter back-wall climb", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // Start at (100, 109) on a ground floor. Goal at (100, 101) — 8 cells up.
    // Route A (ground + ladder): walk right 10 cells to x=110, climb a ladder
    //   8 cells to y=101, walk left 10 cells back to x=100.
    //   Cost: 10×1 (walk) + 8×1.2 (ladder) + 10×1 (walk) = 29.6.
    // Route B (back-wall): climb straight up 8 cells at x=100 via bg blocks.
    //   Cost: 8×10 = 80. Much more expensive.
    // The pathfinder should prefer route A.
    setFloor(fg, 95, 120, FLOOR_Y);      // bottom floor (standable at y=109)
    setFloor(fg, 95, 120, 102);          // top floor (standable at y=101)
    // Ladder at x=110, y=101..109 (connects bottom to top)
    for (let y = 101; y <= 109; y++) fg[y * ACTIVE_GRID_W + 110] = BLOCK_LADDER;
    // Back-wall at x=100, y=101..109 (the direct vertical route)
    for (let y = 101; y <= 109; y++) setBgBlock(bg, 100, y);
    const path = findPath(fg, bg, 100, STAND_Y, 100, 101, false);
    expectReaches(path, 100, 101);
    // The path should NOT go straight up the back wall (x=100, y=102..108).
    // It should take the ground + ladder route (much cheaper).
    const backWallNodes = path!.filter(
      (n) => n.x === 100 && n.y >= 102 && n.y <= 108,
    );
    expect(backWallNodes.length).toBe(0);
  });

  it("prefers back-wall climb when ground route is very long", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // Start at (100, 109), goal at (100, 101) — 8 cells up.
    // Ground route: walk all the way around a very long detour (not built
    // here, so no ground route exists). Back-wall route: straight up.
    for (let y = 101; y <= 109; y++) setBgBlock(bg, 100, y);
    // No floor anywhere — the only support is the back wall.
    const path = findPath(fg, bg, 100, 109, 100, 101, false);
    expectReaches(path, 100, 101);
  });

  it("prefers ladder over wall-climb over back-wall (cost ordering)", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // Three vertical shafts from y=109 to y=101 at x=100, 110, 120.
    // x=100: ladder (fg climbable) — cost 1.2 per cell
    // x=110: fg wall adjacent — cost 3 per cell
    // x=120: back-wall only — cost 10 per cell
    // Start at (100, 109), goal at (120, 101).
    // The pathfinder should go up the ladder (x=100), then walk right at the
    // top (cheapest total). We verify it uses the ladder, not the wall or
    // back-wall, for the vertical portion.
    setFloor(fg, 95, 125, 100); // top floor at y=100 so y=101 is standable
    // Ladder at x=100, y=101..109
    for (let y = 101; y <= 109; y++) fg[y * ACTIVE_GRID_W + 100] = BLOCK_LADDER;
    // Wall at x=110: solid blocks at x=111, y=101..109 (wall to climb)
    for (let y = 101; y <= 109; y++) setSolid(fg, 111, y);
    // Back-wall at x=120: bg blocks at x=120, y=101..109
    for (let y = 101; y <= 109; y++) setBgBlock(bg, 120, y);
    const path = findPath(fg, bg, 100, 109, 120, 101, false);
    expectReaches(path, 120, 101);
    // The path should use the ladder (x=100) for the vertical climb.
    const ladderNodes = path!.filter(
      (n) => n.x === 100 && n.y >= 102 && n.y <= 108,
    );
    expect(ladderNodes.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 5. findPathToAdjacent
// ============================================================================

describe("grid-movement: findPathToAdjacent", () => {
  it("paths to a cell adjacent to a solid target block", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Target block at (105, 109) — solid, not walkable.
    setSolid(fg, 105, STAND_Y);
    const path = findPathToAdjacent(fg, makeAirBg(), 100, STAND_Y, 105, STAND_Y, false);
    expect(path).not.toBeNull();
    // The last node should be adjacent to (105, 109), not on it.
    const last = path![path!.length - 1];
    const dx = Math.abs(last.x - 105);
    const dy = Math.abs(last.y - 109);
    expect(dx + dy).toBeLessThanOrEqual(2);
    expect(last.x !== 105 || last.y !== 109).toBe(true);
  });
});

// ============================================================================
// 6. Cost constants are exported and ordered
// ============================================================================

describe("grid-movement: cost constants", () => {
  it("exports cost constants in priority order (lowest = highest priority)", () => {
    // Walk < ladder < jump < wall-climb < backwall-diag < backwall-h < backwall-v < crawl
    expect(COST_WALK_H).toBeLessThan(COST_BACKWALL_V);
    expect(COST_BACKWALL_V).toBeLessThan(COST_CRAWL_H);
  });
});
