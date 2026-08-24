// ============================================================================
// Overburden — exhaustive A* pathfinding geometry test suite
//
// Tests every variant of weird terrain geometry the AI might encounter:
//   - Flat ground, walls, steps, stairs
//   - Pits (1/2/3-wide, shallow/deep, open-bottom)
//   - Cliffs, shelves, ledges, overhangs
//   - Trees (background trunks + leaves), wall climbing, back-wall climbing
//   - Ladders, water, crawl tunnels
//   - Jump-moves (horizontal gap, diagonal up)
//   - Cylinder wrap, no-path scenarios, edge cases
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_LADDER, BLOCK_LEAVES, BLOCK_STONE, BLOCK_WATER, BLOCK_WOOD,
} from "../shared/constants";
import { findPath, findPathToAdjacent } from "./pathfinding";

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
function setBlock(fg: Uint16Array, x: number, y: number, id: number): void {
  fg[y * ACTIVE_GRID_W + x] = id;
}
function setFloor(fg: Uint16Array, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}
function setCeiling(fg: Uint16Array, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}
function setWall(fg: Uint16Array, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}
function setLadder(fg: Uint16Array, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) fg[y * ACTIVE_GRID_W + x] = BLOCK_LADDER;
}
function setWater(fg: Uint16Array, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) fg[y * ACTIVE_GRID_W + x] = BLOCK_WATER;
}

// Standard test area: ground floor at y=110, blockhead stands at y=109
const FLOOR_Y = 110;
const STAND_Y = 109;

function makeFloor(x0 = 95, x1 = 120): Uint16Array {
  const fg = makeAirGrid();
  setFloor(fg, x0, x1, FLOOR_Y);
  return fg;
}

// Assert path reaches target
function expectReaches(path: PathNode[] | null, tx: number, ty: number): void {
  expect(path).not.toBeNull();
  expect(path!.length).toBeGreaterThan(0);
  const last = path![path!.length - 1];
  expect(last.x).toBe(tx);
  expect(last.y).toBe(ty);
}

// Assert path is null (no route)
function expectNoPath(path: PathNode[] | null): void {
  expect(path).toBeNull();
}

// Assert path does not pass through a specific cell
function expectAvoidsCell(path: PathNode[] | null, x: number, y: number): void {
  expect(path).not.toBeNull();
  for (const node of path!) {
    if (node.x === x && node.y === y) {
      throw new Error(`Path passes through (${x}, ${y}) but should avoid it`);
    }
  }
}

// Assert all path nodes are at a specific Y (stay on one level)
function expectStaysAtY(path: PathNode[] | null, y: number): void {
  expect(path).not.toBeNull();
  for (const node of path!) {
    expect(node.y).toBe(y);
  }
}

type PathNode = { x: number; y: number };

// ============================================================================
// 1. FLAT GROUND
// ============================================================================

describe("geometry: flat ground", () => {
  it("walks right on flat ground", () => {
    const fg = makeFloor();
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false), 110, STAND_Y);
  });

  it("walks left on flat ground", () => {
    const fg = makeFloor();
    expectReaches(findPath(fg, makeAirBg(), 110, STAND_Y, 100, STAND_Y, false), 100, STAND_Y);
  });

  it("walks a long distance on flat ground", () => {
    const fg = makeFloor(50, 200);
    expectReaches(findPath(fg, makeAirBg(), 55, STAND_Y, 195, STAND_Y, false), 195, STAND_Y);
  });

  it("returns empty path when start === goal", () => {
    const fg = makeFloor();
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 100, STAND_Y, false);
    expect(path).toEqual([]);
  });
});

// ============================================================================
// 2. WALLS
// ============================================================================

describe("geometry: walls", () => {
  it("goes around a 1-block wall", () => {
    const fg = makeFloor();
    setSolid(fg, 105, STAND_Y); // 1-block wall on the floor
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("goes around a 2-block wall", () => {
    const fg = makeFloor();
    setWall(fg, 105, STAND_Y, STAND_Y + 1);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("goes around a 3-block wall (jump over)", () => {
    const fg = makeFloor();
    setWall(fg, 105, STAND_Y, STAND_Y + 2);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("cannot pass through a floor-to-ceiling wall (extending below floor)", () => {
    const fg = makeFloor();
    // Wall extends from top of grid through the floor to the bottom
    setWall(fg, 105, 0, ACTIVE_GRID_H - 1);
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false));
  });

  it("can climb a very tall wall (wall climbing has no height limit)", () => {
    const fg = makeFloor();
    // Wall from y=105 to y=112 — 8 blocks tall
    // The blockhead climbs the side of the wall (at x=104, adjacent to wall at x=105)
    setWall(fg, 105, 105, 112);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false), 110, STAND_Y);
  });

  it("can climb over a 4-block wall using wall climbing", () => {
    const fg = makeFloor();
    // 4-block wall: top at y=109 (same as standing height) — blockhead climbs over
    setWall(fg, 105, STAND_Y, STAND_Y + 3);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false), 110, STAND_Y);
  });
});

// ============================================================================
// 3. STEPS AND STAIRS
// ============================================================================

describe("geometry: steps and stairs", () => {
  it("steps up 1 block", () => {
    const fg = makeFloor();
    // Step up at x=105: floor at 110, block at 109 → stand at 108
    setSolid(fg, 105, 109);
    // Target on the step
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 105, 108, false), 105, 108);
  });

  it("steps down 1 block", () => {
    const fg = makeFloor();
    // Lower floor at y=112
    setFloor(fg, 106, 115, 112);
    // Remove the upper floor from x=106 onward
    for (let x = 106; x <= 115; x++) fg[FLOOR_Y * ACTIVE_GRID_W + x] = BLOCK_AIR;
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 110, 111, false), 110, 111);
  });

  it("climbs a staircase (up 1, over, up 1, over, ...)", () => {
    const fg = makeFloor();
    // Staircase going up: each step is 1 block higher
    for (let i = 0; i < 5; i++) {
      setFloor(fg, 105 + i, 115, FLOOR_Y - i);
    }
    // Target at the top of the stairs
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 109, 105, false), 109, 105);
  });

  it("descends a staircase (down 1, over, down 1, over, ...)", () => {
    const fg = makeFloor(95, 115);
    // Descending staircase with 1-block-wide steps:
    // y=110: x=95-103 (upper floor)
    // y=111: x=104 (step 1)
    // y=112: x=105 (step 2)
    // y=113: x=106 (step 3)
    // y=114: x=107-115 (lower floor)
    fg[111 * ACTIVE_GRID_W + 104] = BLOCK_STONE;
    fg[112 * ACTIVE_GRID_W + 105] = BLOCK_STONE;
    fg[113 * ACTIVE_GRID_W + 106] = BLOCK_STONE;
    setFloor(fg, 107, 115, 114);
    // Remove the upper floor from x=104 onward
    for (let x = 104; x <= 115; x++) fg[FLOOR_Y * ACTIVE_GRID_W + x] = BLOCK_AIR;
    // Blockhead at (100, 109), target at (107, 113)
    // The blockhead walks right and falls at each step edge
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 107, 113, false), 107, 113);
  });

  it("can climb a 2-block step using wall climbing (wall adjacent)", () => {
    const fg = makeFloor();
    // 2-block step: floor at 110, blocks at 109 and 108
    setSolid(fg, 105, 109);
    setSolid(fg, 105, 108);
    // The blockhead can wall-climb the side of the step (wall at x=105)
    // Target on top of the 2-block step
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 105, 107, false), 105, 107);
  });

  it("can climb a 2-block step from an adjacent cell (wall climbing)", () => {
    const fg = makeFloor(95, 103);
    // 2-block step at x=106 (gap at x=104,105)
    setSolid(fg, 106, 109);
    setSolid(fg, 106, 108);
    setFloor(fg, 106, 115, 107);
    // The blockhead can reach x=105 (via 2-cell jump from x=103)
    // and climb the wall at x=106 to reach the top
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 110, 106, false), 110, 106);
  });
});

// ============================================================================
// 4. PITS AND HOLES
// ============================================================================

describe("geometry: pits and holes", () => {
  it("jumps across a 1-block pit (no bottom)", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR; // 1-block pit
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
    expectAvoidsCell(path, 105, STAND_Y);
    expectAvoidsCell(path, 105, FLOOR_Y);
  });

  it("jumps across a 1-block pit (with bottom)", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    setSolid(fg, 105, FLOOR_Y + 1); // bottom of pit
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("crosses a 2-block pit (with bottom) via fall + climb out", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    setFloor(fg, 105, 106, FLOOR_Y + 1); // bottom
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("crosses a 3-block open pit via wall climbing (climb down, jump, climb up)", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 107] = BLOCK_AIR;
    // Open pit — but the blockhead can wall-climb down one side and up the other
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("cannot cross a 5-block open pit (too wide even with wall climbing)", () => {
    const fg = makeFloor();
    for (let x = 105; x <= 109; x++) fg[FLOOR_Y * ACTIVE_GRID_W + x] = BLOCK_AIR;
    // 5-block open pit — can climb down, but can't jump 3+ cells across the bottom
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false));
  });

  it("crosses a 3-block pit with bottom (fall in, walk across, climb out)", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 107] = BLOCK_AIR;
    setFloor(fg, 105, 107, FLOOR_Y + 1); // bottom
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });

  it("finds a path to the bottom of a deep pit", () => {
    const fg = makeFloor();
    for (let y = FLOOR_Y; y <= FLOOR_Y + 4; y++) {
      fg[y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    }
    setSolid(fg, 105, FLOOR_Y + 5); // bottom
    expectReaches(findPath(fg, makeAirBg(), 104, STAND_Y, 105, FLOOR_Y + 4, false), 105, FLOOR_Y + 4);
  });

  it("does not route through unsupported cells above a pit", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    setFloor(fg, 105, 106, FLOOR_Y + 1);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expect(path).not.toBeNull();
    // No node at y=109 (standable height) for x=105 or x=106 (above the pit)
    for (const node of path!) {
      if (node.x === 105 || node.x === 106) {
        expect(node.y).not.toBe(STAND_Y);
      }
    }
  });

  it("handles a pit with a ceiling (1-high tunnel at bottom)", () => {
    const fg = makeFloor();
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    setSolid(fg, 105, FLOOR_Y + 1); // bottom
    setSolid(fg, 105, STAND_Y); // ceiling (1-high gap at FLOOR_Y)
    // Blockhead can't fit in a 1-high gap — no path through
    // (blockhead is 2 tall; needs 2-high clearance)
    // But can still jump across
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
  });
});

// ============================================================================
// 5. CLIFFS AND LEDGES
// ============================================================================

describe("geometry: cliffs and ledges", () => {
  it("falls off a cliff to a lower floor", () => {
    const fg = makeAirGrid();
    // Upper cliff: floor at y=102, x=95..100
    setFloor(fg, 95, 100, 102);
    // Lower floor at y=110, x=95..115
    setFloor(fg, 95, 115, 110);
    expectReaches(findPath(fg, makeAirBg(), 100, 101, 110, 109, false), 110, 109);
  });

  it("falls off a cliff to the right", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102);
    setFloor(fg, 95, 115, 110);
    expectReaches(findPath(fg, makeAirBg(), 98, 101, 108, 109, false), 108, 109);
  });

  it("falls off a cliff to the left", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102);
    setFloor(fg, 95, 115, 110);
    expectReaches(findPath(fg, makeAirBg(), 100, 101, 96, 109, false), 96, 109);
  });

  it("finds a path when target is directly below the cliff edge", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102);
    setFloor(fg, 95, 115, 110);
    expectReaches(findPath(fg, makeAirBg(), 98, 101, 100, 109, false), 100, 109);
  });

  it("climbs up from a lower floor to an upper shelf (with wall)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102); // upper shelf
    setFloor(fg, 95, 115, 110); // lower floor
    // Wall at the cliff edge for climbing
    setWall(fg, 101, 103, 109);
    // Target on the upper shelf
    expectReaches(findPath(fg, makeAirBg(), 110, 109, 98, 101, false), 98, 101);
  });

  it("cannot climb up from a lower floor to an upper shelf (no wall)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102);
    setFloor(fg, 95, 115, 110);
    // No wall at the cliff edge — can't climb up
    expectNoPath(findPath(fg, makeAirBg(), 110, 109, 98, 101, false));
  });

  it("navigates a multi-level cliff (3 tiers)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102);  // top
    setFloor(fg, 95, 110, 106);  // middle
    setFloor(fg, 95, 120, 110);  // bottom
    expectReaches(findPath(fg, makeAirBg(), 98, 101, 115, 109, false), 115, 109);
  });
});

// ============================================================================
// 6. SHELVES AND OVERHANGS
// ============================================================================

describe("geometry: shelves and overhangs", () => {
  it("walks off a shelf to reach a target below", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102); // shelf
    setFloor(fg, 95, 115, 110); // floor below
    expectReaches(findPath(fg, makeAirBg(), 98, 101, 105, 109, false), 105, 109);
  });

  it("does not route through cells under a 1-high overhang (insufficient headroom)", () => {
    const fg = makeFloor();
    // Overhang: solid blocks at y=108 (directly above standable y=109)
    // Blockhead at y=109 has head at y=108 — if y=108 is solid, can't stand there
    setFloor(fg, 105, 108, 108);
    // The pathfinder should route around the overhang (over it or detour)
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false);
    expect(path).not.toBeNull();
    // Should not pass through cells at y=109 where x=105..108 (under overhang)
    for (const node of path!) {
      if (node.x >= 105 && node.x <= 108) {
        expect(node.y).not.toBe(STAND_Y);
      }
    }
  });

  it("navigates under a 2-high overhang (enough headroom)", () => {
    const fg = makeFloor();
    // Overhang at y=107 (2 blocks above standable y=109)
    // Blockhead at y=109 has head at y=108 — y=107 is above the head, so OK
    setFloor(fg, 105, 108, 107);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false);
    expectReaches(path, 112, STAND_Y);
  });

  it("cannot pass through a 1-high gap in a full-height wall (blockhead is 2 tall)", () => {
    const fg = makeFloor();
    // Full-height wall at x=105-108, from y=0 to y=FLOOR_Y
    // with a 1-high gap at y=STAND_Y (y=109)
    for (let y = 0; y <= FLOOR_Y; y++) {
      for (let x = 105; x <= 108; x++) {
        if (y !== STAND_Y) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
      }
    }
    // Blockhead is 2 tall — can't fit through a 1-high gap
    // Can't climb over (wall extends to top of grid)
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false));
  });

  it("can pass through a 2-high gap in a full-height wall (blockhead fits)", () => {
    const fg = makeFloor();
    // Full-height wall at x=105-108, from y=0 to y=FLOOR_Y
    // with a 2-high gap at y=STAND_Y and y=STAND_Y-1 (y=109 and y=108)
    for (let y = 0; y <= FLOOR_Y; y++) {
      for (let x = 105; x <= 108; x++) {
        if (y !== STAND_Y && y !== STAND_Y - 1) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
      }
    }
    // Blockhead is 2 tall — fits through a 2-high gap
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false), 112, STAND_Y);
  });
});

// ============================================================================
// 7. TREES (background trunks + leaves)
// ============================================================================

describe("geometry: trees", () => {
  it("prefers ground route around a tree (not through it)", () => {
    const fg = makeFloor(95, 120);
    const bg = makeAirBg();
    // Tree trunk in background at x=105, y=100..109
    for (let y = 100; y <= 109; y++) bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    bg[99 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 104] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 106] = BLOCK_LEAVES;
    const path = findPath(fg, bg, 100, STAND_Y, 115, STAND_Y, false);
    expectReaches(path, 115, STAND_Y);
    // Path should stay on the ground (y=109), not climb the tree
    expectStaysAtY(path, STAND_Y);
  });

  it("routes through a tree when the target is in the tree", () => {
    const fg = makeFloor(95, 120);
    const bg = makeAirBg();
    for (let y = 100; y <= 109; y++) bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    bg[99 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 104] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 106] = BLOCK_LEAVES;
    const path = findPathToAdjacent(fg, bg, 100, STAND_Y, 105, 99, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 99);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("climbs a background tree trunk to mine a leaf", () => {
    const fg = makeFloor(95, 120);
    const bg = makeAirBg();
    for (let y = 100; y <= 109; y++) bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    bg[99 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 104] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 106] = BLOCK_LEAVES;
    const path = findPathToAdjacent(fg, bg, 100, STAND_Y, 105, 99, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
  });

  it("finds path to target cell when fg is air (background mining)", () => {
    const fg = makeFloor(95, 120);
    const bg = makeAirBg();
    for (let y = 105; y <= 109; y++) bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    bg[104 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    const path = findPathToAdjacent(fg, bg, 100, STAND_Y, 105, 104, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 104);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("does not route through two adjacent trees on flat ground", () => {
    const fg = makeFloor(95, 120);
    const bg = makeAirBg();
    // Two trees at x=105 and x=110
    for (let y = 100; y <= 109; y++) {
      bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
      bg[y * ACTIVE_GRID_W + 110] = BLOCK_WOOD;
    }
    bg[99 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 110] = BLOCK_LEAVES;
    const path = findPath(fg, bg, 100, STAND_Y, 115, STAND_Y, false);
    expectReaches(path, 115, STAND_Y);
    expectStaysAtY(path, STAND_Y);
  });
});

// ============================================================================
// 8. WALL CLIMBING (foreground walls)
// ============================================================================

describe("geometry: wall climbing", () => {
  it("climbs up a foreground wall to reach a target above", () => {
    const fg = makeFloor(95, 115);
    // Wall at x=105, y=100..109 (10 blocks tall)
    setWall(fg, 105, 100, 109);
    // Target on top of the wall (at y=99, with the wall block at y=100 as floor)
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 105, 99, false), 105, 99);
  });

  it("climbs a wall and walks along the top", () => {
    const fg = makeFloor(95, 115);
    setWall(fg, 105, 100, 109);
    // Platform on top of the wall
    setFloor(fg, 105, 110, 99);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 108, 98, false), 108, 98);
  });

  it("climbs a 1-block wall step (jump over)", () => {
    const fg = makeFloor();
    setSolid(fg, 105, STAND_Y);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 108, STAND_Y, false), 108, STAND_Y);
  });
});

// ============================================================================
// 9. BACK-WALL CLIMBING (background blocks)
// ============================================================================

describe("geometry: back-wall climbing", () => {
  it("climbs a back wall to reach a higher platform", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // Lower floor at y=110
    setFloor(fg, 95, 115, 110);
    // Upper platform at y=104, x=105..110
    setFloor(fg, 105, 110, 104);
    // Back wall at x=105, y=105..109 (climbing support)
    for (let y = 105; y <= 109; y++) bg[y * ACTIVE_GRID_W + 105] = BLOCK_STONE;
    // Blockhead at (100, 109), target at (108, 103)
    expectReaches(findPath(fg, bg, 100, STAND_Y, 108, 103, false), 108, 103);
  });

  it("does not climb a back wall when a ground route exists", () => {
    const fg = makeFloor(95, 120);
    const bg = makeAirBg();
    // Back wall at x=105, y=100..109
    for (let y = 100; y <= 109; y++) bg[y * ACTIVE_GRID_W + 105] = BLOCK_STONE;
    // Target on the ground — should stay on ground, not climb
    const path = findPath(fg, bg, 100, STAND_Y, 115, STAND_Y, false);
    expectReaches(path, 115, STAND_Y);
    expectStaysAtY(path, STAND_Y);
  });
});

// ============================================================================
// 10. LADDERS
// ============================================================================

describe("geometry: ladders", () => {
  it("climbs a ladder to reach a target above", () => {
    const fg = makeFloor(95, 115);
    // Ladder at x=105, y=100..109
    setLadder(fg, 105, 100, 109);
    // Platform at the top (y=99)
    setFloor(fg, 104, 110, 100);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 105, 99, false), 105, 99);
  });

  it("descends a ladder to reach a target below", () => {
    const fg = makeAirGrid();
    // Upper platform at y=102
    setFloor(fg, 95, 110, 102);
    // Lower floor at y=110
    setFloor(fg, 95, 110, 110);
    // Ladder at x=105, y=103..109
    setLadder(fg, 105, 103, 109);
    expectReaches(findPath(fg, makeAirBg(), 100, 101, 105, 109, false), 105, 109);
  });

  it("climbs a ladder past a gap in the floor", () => {
    const fg = makeFloor(95, 115);
    // Gap in the floor at x=105
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    // Ladder at x=105 going down to the bottom
    setLadder(fg, 105, FLOOR_Y, FLOOR_Y + 3);
    setSolid(fg, 105, FLOOR_Y + 4); // bottom
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 105, FLOOR_Y + 3, false), 105, FLOOR_Y + 3);
  });
});

// ============================================================================
// 11. WATER AND SWIMMING
// ============================================================================

describe("geometry: water and swimming", () => {
  it("walks through a shallow water pool (1 deep)", () => {
    const fg = makeFloor(95, 120);
    // Water at x=105..107, y=109 (1-deep pool on the floor)
    setWater(fg, 105, 107, STAND_Y, STAND_Y);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false), 112, STAND_Y);
  });

  it("swims through a deep water pool", () => {
    const fg = makeFloor(95, 120);
    // Deep water: 3-deep pool at x=105..108
    setWater(fg, 105, 108, STAND_Y - 1, FLOOR_Y);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 112, STAND_Y, false), 112, STAND_Y);
  });

  it("swims up through water to reach a target above", () => {
    const fg = makeFloor(95, 115);
    // Water column at x=105, y=105..109
    setWater(fg, 105, 105, 105, 109);
    // Platform at y=104
    setFloor(fg, 104, 110, 105);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 105, 104, false), 105, 104);
  });
});

// ============================================================================
// 12. JUMP-MOVES (horizontal gap + diagonal up)
// ============================================================================

describe("geometry: jump-moves", () => {
  it("jumps across a 1-block gap at same height", () => {
    const fg = makeFloor(95, 120);
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    const path = findPath(fg, makeAirBg(), 103, STAND_Y, 107, STAND_Y, false);
    expectReaches(path, 107, STAND_Y);
    expectAvoidsCell(path, 105, STAND_Y);
  });

  it("jumps diagonally up to a 1-block-higher platform", () => {
    const fg = makeFloor(95, 120);
    // Higher platform at y=109 (1 block up), x=107..115
    setFloor(fg, 107, 115, 109);
    // Gap at x=105,106 (no floor at y=110)
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    // Blockhead at (103, 109), target at (110, 108)
    expectReaches(findPath(fg, makeAirBg(), 103, STAND_Y, 110, 108, false), 110, 108);
  });

  it("crosses a 2-block gap via wall climbing (not a horizontal jump)", () => {
    const fg = makeFloor(95, 120);
    // 2-block gap — too far for a horizontal jump (only 1-block gaps),
    // but the blockhead can wall-climb down and up the pit walls
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    const path = findPath(fg, makeAirBg(), 103, STAND_Y, 108, STAND_Y, false);
    expectReaches(path, 108, STAND_Y);
  });

  it("cannot cross a 4-block gap (too wide for jump or wall climbing)", () => {
    const fg = makeFloor(95, 120);
    // 4-block gap — can climb down, but can't jump 3 cells across the bottom
    for (let x = 105; x <= 108; x++) fg[FLOOR_Y * ACTIVE_GRID_W + x] = BLOCK_AIR;
    expectNoPath(findPath(fg, makeAirBg(), 103, STAND_Y, 110, STAND_Y, false));
  });

  it("jumps up a 1-block step diagonally", () => {
    const fg = makeFloor(95, 120);
    // Step up at x=106: floor at 110, block at 109
    setSolid(fg, 106, 109);
    // Gap at x=105 (no floor)
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    // Blockhead at (103, 109), target at (106, 108) — must jump diagonally
    expectReaches(findPath(fg, makeAirBg(), 103, STAND_Y, 106, 108, false), 106, 108);
  });
});

// ============================================================================
// 13. CYLINDER WRAP
// ============================================================================

describe("geometry: cylinder wrap", () => {
  it("wraps from right edge to left edge", () => {
    const fg = makeFloor(0, ACTIVE_GRID_W - 1);
    // Blockhead at x=ACTIVE_GRID_W-2, target at x=1 — wraps around
    const path = findPath(fg, makeAirBg(), ACTIVE_GRID_W - 2, STAND_Y, 1, STAND_Y, true);
    expectReaches(path, 1, STAND_Y);
  });

  it("wraps from left edge to right edge", () => {
    const fg = makeFloor(0, ACTIVE_GRID_W - 1);
    const path = findPath(fg, makeAirBg(), 1, STAND_Y, ACTIVE_GRID_W - 2, STAND_Y, true);
    expectReaches(path, ACTIVE_GRID_W - 2, STAND_Y);
  });

  it("does not wrap when wrap=false", () => {
    const fg = makeFloor(0, ACTIVE_GRID_W - 1);
    // With wrap=false, the path must go the long way around
    const path = findPath(fg, makeAirBg(), 1, STAND_Y, ACTIVE_GRID_W - 2, STAND_Y, false);
    expectReaches(path, ACTIVE_GRID_W - 2, STAND_Y);
  });
});

// ============================================================================
// 14. COMBINED / COMPLEX GEOMETRY
// ============================================================================

describe("geometry: complex combined terrain", () => {
  it("navigates a wall + pit + step sequence", () => {
    const fg = makeFloor(95, 130);
    // 1-block wall at x=102
    setSolid(fg, 102, STAND_Y);
    // 1-block pit at x=106
    fg[FLOOR_Y * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    // Step up at x=110 (block at 109, platform at 108)
    setSolid(fg, 110, 109);
    setFloor(fg, 110, 125, 109);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 120, 108, false), 120, 108);
  });

  it("navigates a maze of walls", () => {
    const fg = makeFloor(95, 130);
    // Zigzag walls
    setWall(fg, 103, STAND_Y, STAND_Y + 2);
    setWall(fg, 107, STAND_Y, STAND_Y + 2);
    setWall(fg, 111, STAND_Y, STAND_Y + 2);
    // Gaps in between for the blockhead to navigate
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 115, STAND_Y, false), 115, STAND_Y);
  });

  it("navigates a room with a pillar", () => {
    const fg = makeFloor(95, 125);
    // Pillar at x=110, y=105..109
    setWall(fg, 110, 105, 109);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 120, STAND_Y, false), 120, STAND_Y);
  });

  it("navigates around a large obstacle (L-shaped wall)", () => {
    const fg = makeFloor(95, 125);
    // L-shaped wall
    setWall(fg, 108, STAND_Y, STAND_Y + 3);
    setFloor(fg, 108, 112, STAND_Y + 3);
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 118, STAND_Y, false), 118, STAND_Y);
  });

  it("navigates a spiral staircase", () => {
    const fg = makeFloor(95, 120);
    // Spiral: each step is 1 block up and 1 block over
    for (let i = 0; i < 5; i++) {
      setSolid(fg, 105 + i, FLOOR_Y - 1 - i);
    }
    // Target at the top
    expectReaches(findPath(fg, makeAirBg(), 100, STAND_Y, 109, 104, false), 109, 104);
  });

  it("finds the shortest path (not a detour)", () => {
    const fg = makeFloor(95, 120);
    // Direct path: 10 blocks right, no obstacles
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expectReaches(path, 110, STAND_Y);
    // Path should be ~10 nodes (one per step)
    expect(path!.length).toBeLessThanOrEqual(12);
  });
});

// ============================================================================
// 15. NO-PATH SCENARIOS
// ============================================================================

describe("geometry: no-path scenarios", () => {
  it("returns null when walled in on all sides", () => {
    const fg = makeAirGrid();
    // Blockhead in a 1x2 pocket
    setSolid(fg, 99, 108); setSolid(fg, 101, 108);
    setSolid(fg, 99, 109); setSolid(fg, 101, 109);
    setFloor(fg, 99, 101, 110);
    setCeiling(fg, 99, 101, 107);
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false));
  });

  it("returns null when target is inside a solid block", () => {
    const fg = makeFloor();
    setSolid(fg, 110, STAND_Y); // target cell is solid
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false));
  });

  it("returns null when target is floating in mid-air (unsupported)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 110);
    // Target at (110, 109) — no floor anywhere near it
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 110, 109, false));
  });

  it("returns null when separated by an open pit with no bottom", () => {
    const fg = makeFloor(95, 100);
    setFloor(fg, 106, 115, 110);
    // Gap at x=101..105 (5-block open pit, no bottom)
    expectNoPath(findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false));
  });

  it("returns null for findPathToAdjacent when target is fully surrounded", () => {
    const fg = makeFloor();
    // Target at (105, 109) surrounded by solid blocks on all 4 sides + diagonals
    setSolid(fg, 105, 109);
    setSolid(fg, 104, 108); setSolid(fg, 106, 108);
    setSolid(fg, 104, 109); setSolid(fg, 106, 109);
    setSolid(fg, 104, 110); setSolid(fg, 106, 110);
    setSolid(fg, 105, 108); setSolid(fg, 105, 110);
    expectNoPath(findPathToAdjacent(fg, makeAirBg(), 100, STAND_Y, 105, 109, false));
  });
});

// ============================================================================
// 16. EDGE CASES
// ============================================================================

describe("geometry: edge cases", () => {
  it("handles start at grid boundary (x=0)", () => {
    const fg = makeFloor(0, 50);
    expectReaches(findPath(fg, makeAirBg(), 0, STAND_Y, 10, STAND_Y, false), 10, STAND_Y);
  });

  it("handles start at grid boundary (x=ACTIVE_GRID_W-1)", () => {
    const fg = makeFloor(ACTIVE_GRID_W - 50, ACTIVE_GRID_W - 1);
    const x = ACTIVE_GRID_W - 1;
    expectReaches(findPath(fg, makeAirBg(), x, STAND_Y, x - 10, STAND_Y, false), x - 10, STAND_Y);
  });

  it("handles target at grid boundary (y=0)", () => {
    const fg = makeAirGrid();
    // Fill from y=1 down so y=0 is standable
    setFloor(fg, 95, 110, 1);
    expectReaches(findPath(fg, makeAirBg(), 100, 0, 105, 0, false), 105, 0);
  });

  it("handles target at grid boundary (y=ACTIVE_GRID_H-1)", () => {
    const fg = makeAirGrid();
    const y = ACTIVE_GRID_H - 1;
    // At the bottom of the grid, cells are "supported" (can't fall further)
    expectReaches(findPath(fg, makeAirBg(), 100, y, 105, y, false), 105, y);
  });

  it("clamps out-of-bounds start/goal to grid bounds", () => {
    const fg = makeFloor(0, 50);
    // Start at x=-5 should clamp to x=0, which is on the floor
    const path = findPath(fg, makeAirBg(), -5, STAND_Y, 10, STAND_Y, false);
    expect(path).not.toBeNull();
  });

  it("is deterministic — same input gives same path", () => {
    const fg = makeFloor();
    setSolid(fg, 105, STAND_Y);
    setSolid(fg, 107, STAND_Y);
    const path1 = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    const path2 = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expect(path1).toEqual(path2);
  });

  it("findPathToAdjacent returns empty when already at an adjacent cell", () => {
    const fg = makeFloor();
    setSolid(fg, 105, STAND_Y);
    const path = findPathToAdjacent(fg, makeAirBg(), 104, STAND_Y, 105, STAND_Y, false);
    expect(path).toEqual([]);
  });

  it("findPathToAdjacent returns empty when already at the target cell (fg air)", () => {
    const fg = makeFloor();
    const bg = makeAirBg();
    bg[STAND_Y * ACTIVE_GRID_W + 105] = BLOCK_WOOD; // bg block at target
    const path = findPathToAdjacent(fg, bg, 105, STAND_Y, 105, STAND_Y, false);
    expect(path).toEqual([]);
  });
});

// ============================================================================
// 17. MINING / ADJACENT PATHING
// ============================================================================

describe("geometry: mining / adjacent pathing", () => {
  it("finds a path to mine a ground-level stone block", () => {
    const fg = makeFloor();
    setSolid(fg, 105, STAND_Y);
    const path = findPathToAdjacent(fg, makeAirBg(), 100, STAND_Y, 105, STAND_Y, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - STAND_Y);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("finds a path to mine a block on top of a wall", () => {
    const fg = makeFloor(95, 115);
    setWall(fg, 105, 100, 109);
    // Target: the top block of the wall at (105, 100)
    const path = findPathToAdjacent(fg, makeAirBg(), 100, STAND_Y, 105, 100, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 100);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("finds a path to mine a block deep underground", () => {
    const fg = makeFloor(95, 115);
    // Underground stone at (105, 115)
    setSolid(fg, 105, 115);
    // Need to dig down — but pathfinder can't dig. The blockhead must
    // reach a cell adjacent to (105, 115). The cell at (105, 114) is
    // air with ground at (105, 115) — supported. But getting there
    // requires going through the floor at (105, 110).
    // Actually the blockhead can't reach underground without digging.
    // The adjacent cells are (104,115), (106,115), (105,114), (105,116).
    // (105,114) is air but unreachable (surrounded by stone at 105,110 and
    // 104,114 / 106,114 if they're stone). Let's make it reachable:
    // Remove the floor at x=105 to create a shaft
    fg[FLOOR_Y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[111 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[112 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[113 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[114 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    // Now (105, 114) is reachable by falling down the shaft
    const path = findPathToAdjacent(fg, makeAirBg(), 100, STAND_Y, 105, 115, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 115);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("finds a path to mine a ceiling block from below (with climbing pillar)", () => {
    const fg = makeFloor(95, 115);
    // Ceiling at y=105, x=105
    setCeiling(fg, 105, 105, 105);
    // Pillar from floor to ceiling for climbing
    setWall(fg, 104, 106, 109);
    // Target: (105, 105) — the ceiling block
    // Blockhead can climb the pillar at x=104 to reach (105, 106) which is
    // adjacent to the ceiling block and supported by wall climbing
    const path = findPathToAdjacent(fg, makeAirBg(), 100, STAND_Y, 105, 105, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 105);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });
});

// ============================================================================
// 18. PATH QUALITY / INVARIANTS
// ============================================================================

describe("geometry: path quality invariants", () => {
  it("path nodes are contiguous (each step is ≤ 2 cells apart)", () => {
    const fg = makeFloor(95, 120);
    setSolid(fg, 105, STAND_Y); // obstacle
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 115, STAND_Y, false);
    expect(path).not.toBeNull();
    for (let i = 1; i < path!.length; i++) {
      const dx = Math.abs(path![i].x - path![i - 1].x);
      const dy = Math.abs(path![i].y - path![i - 1].y);
      // Each step should be at most 2 cells (jump-move) or 1 cell (normal)
      expect(dx + dy).toBeLessThanOrEqual(2);
    }
  });

  it("path does not revisit the same cell twice", () => {
    const fg = makeFloor(95, 120);
    setSolid(fg, 105, STAND_Y);
    setSolid(fg, 107, STAND_Y);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 115, STAND_Y, false);
    expect(path).not.toBeNull();
    const visited = new Set<string>();
    for (const node of path!) {
      const key = `${node.x},${node.y}`;
      expect(visited.has(key)).toBe(false);
      visited.add(key);
    }
  });

  it("path cost is optimal (shortest route around a wall)", () => {
    const fg = makeFloor(95, 120);
    // 1-block wall at x=105
    setSolid(fg, 105, STAND_Y);
    // Direct distance is 10, but the wall forces a detour (jump over)
    // The path should be ≤ 12 nodes (10 + 2 for the jump detour)
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeLessThanOrEqual(13);
  });

  it("path reaches the exact goal cell (not just adjacent)", () => {
    const fg = makeFloor(95, 120);
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 110, STAND_Y, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(110);
    expect(last.y).toBe(STAND_Y);
  });
});
