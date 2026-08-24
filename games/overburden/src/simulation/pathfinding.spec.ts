// ============================================================================
// Overburden — A* pathfinding unit tests
// ============================================================================

import { describe, expect, it } from "bun:test";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, BLOCK_AIR, BLOCK_LEAVES, BLOCK_STONE, BLOCK_WOOD } from "../shared/constants";
import { findPath, findPathToAdjacent } from "./pathfinding";

// Helper: create a foreground grid filled with air
function makeAirGrid(): Uint16Array {
  return new Uint16Array(ACTIVE_GRID_W * ACTIVE_GRID_H).fill(BLOCK_AIR);
}

// Helper: create a background grid filled with air
function makeAirBg(): Uint16Array {
  return new Uint16Array(ACTIVE_GRID_W * ACTIVE_GRID_H).fill(BLOCK_AIR);
}

// Helper: set a solid block at (x, y)
function setSolid(fg: Uint16Array, x: number, y: number): void {
  fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}

// Helper: fill a horizontal floor at row y, from x0 to x1 (inclusive)
function setFloor(fg: Uint16Array, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) {
    fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
  }
}

describe("pathfinding", () => {
  it("finds a straight-line path with no obstacles (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 102); // floor at y=102 so y=101 is standable
    const path = findPath(fg, makeAirBg(), 100, 101, 105, 101, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(101);
  });

  it("finds a path around a 1-block wall (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 102);
    setSolid(fg, 102, 101); // 1-block wall on the floor
    const path = findPath(fg, makeAirBg(), 100, 101, 105, 101, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(101);
  });

  it("finds a path around a 3-block wall (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 102);
    // 3-block vertical wall at x=102, y=99..101 (on top of floor)
    setSolid(fg, 102, 99);
    setSolid(fg, 102, 100);
    setSolid(fg, 102, 101);
    const path = findPath(fg, makeAirBg(), 100, 101, 105, 101, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(101);
  });

  it("returns null when walled in with no path", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 102);
    // Surround (100, 101) with solid blocks on all 4 sides
    setSolid(fg, 99, 101);
    setSolid(fg, 101, 101);
    setSolid(fg, 100, 100);
    setSolid(fg, 100, 102); // this is the floor too
    // Also block the diagonal escape (blockhead is 2 tall)
    setSolid(fg, 99, 100);
    setSolid(fg, 101, 100);
    const path = findPath(fg, makeAirBg(), 100, 101, 200, 101, false);
    expect(path).toBeNull();
  });

  it("handles cylinder wrap on X (with floor)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 0, ACTIVE_GRID_W - 1, 102); // full-width floor
    const path = findPath(fg, makeAirBg(), ACTIVE_GRID_W - 5, 101, 5, 101, true);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(5);
    expect(last.y).toBe(101);
  });

  it("returns empty array when start === goal", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 102);
    const path = findPath(fg, makeAirBg(), 100, 101, 100, 101, false);
    expect(path).toEqual([]);
  });

  it("is deterministic — same input gives same path", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 102);
    setSolid(fg, 102, 101);
    const path1 = findPath(fg, makeAirBg(), 100, 101, 105, 101, false);
    const path2 = findPath(fg, makeAirBg(), 100, 101, 105, 101, false);
    expect(path1).toEqual(path2);
  });

  it("can step up a 1-block step", () => {
    const fg = makeAirGrid();
    // Floor at y=102, step at y=101 (x=102..104)
    for (let x = 98; x < 108; x++) {
      setSolid(fg, x, 102);
    }
    // 1-block-high step extending from x=102 to x=104
    for (let x = 102; x <= 104; x++) {
      setSolid(fg, x, 101);
    }
    const path = findPath(fg, makeAirBg(), 100, 101, 104, 100, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(104);
    expect(last.y).toBe(100);
  });

  // --- Gravity / fall modeling tests ---

  it("falls off a shelf to reach a target below (Bug 1: shelf stuck)", () => {
    const fg = makeAirGrid();
    // Shelf: a 1-block-wide pillar at x=100, top at y=101 (solid at y=102)
    setSolid(fg, 100, 102); // pillar body
    // Ground far below at y=110
    setFloor(fg, 95, 110, 110);
    // Blockhead stands on top of pillar at (100, 101)
    // Target is one column to the right and down at (101, 109)
    const path = findPath(fg, makeAirBg(), 100, 101, 101, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(101);
    expect(last.y).toBe(109);
  });

  it("falls off a shelf to the left to reach a target below", () => {
    const fg = makeAirGrid();
    setSolid(fg, 100, 102); // pillar
    setFloor(fg, 90, 110, 110); // ground below
    // Blockhead on pillar at (100, 101), target at (99, 109)
    const path = findPath(fg, makeAirBg(), 100, 101, 99, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(99);
    expect(last.y).toBe(109);
  });

  it("does not route through mid-air cells (gravity is modeled)", () => {
    const fg = makeAirGrid();
    // No floor anywhere — the blockhead can't walk through mid-air
    // Start at (100, 100), goal at (105, 100) — both in mid-air
    const path = findPath(fg, makeAirBg(), 100, 100, 105, 100, false);
    // With gravity modeling, the blockhead falls to the bottom of the grid.
    // It can't stay at y=100, so no path to (105, 100).
    expect(path).toBeNull();
  });

  it("can walk off a ledge and fall to a lower floor", () => {
    const fg = makeAirGrid();
    // Upper shelf at y=101 (floor at y=102), x=95..100
    setFloor(fg, 95, 100, 102);
    // Lower floor at y=110, x=95..110
    setFloor(fg, 95, 110, 110);
    // Blockhead on upper shelf at (100, 101), target on lower floor at (105, 109)
    const path = findPath(fg, makeAirBg(), 100, 101, 105, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(109);
  });

  // --- findPathToAdjacent tests (Bug 2: mining solid blocks) ---

  it("finds a path to a cell adjacent to a solid block (Bug 2: tree leaf)", () => {
    const fg = makeAirGrid();
    // Ground floor
    setFloor(fg, 95, 110, 110);
    // A "tree trunk" — vertical column of wood at x=105, y=104..109
    for (let y = 104; y <= 109; y++) {
      fg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    }
    // A "leaf" block at (105, 103) — on top of the trunk
    fg[103 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    // Blockhead on the ground at (100, 109)
    // Target: the leaf at (105, 103) — the blockhead must climb the trunk
    const path = findPathToAdjacent(fg, makeAirBg(), 100, 109, 105, 103, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    // The last node should be adjacent to (105, 103)
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 103);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("finds a path to climb a background tree trunk to mine a leaf (real tree structure)", () => {
    // Real trees: trunk + leaves are in the BACKGROUND layer. The foreground
    // at tree positions is air (walkable). The blockhead climbs via back-wall
    // climbing (background block at the blockhead's position).
    const fg = makeAirGrid();
    const bg = makeAirBg();
    // Ground floor in foreground
    setFloor(fg, 95, 110, 110);
    // Tree trunk in BACKGROUND at x=105, y=104..109 (6 blocks tall)
    for (let y = 104; y <= 109; y++) {
      bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    }
    // Leaves in BACKGROUND at (105, 103) and surrounding cells
    bg[103 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[103 * ACTIVE_GRID_W + 104] = BLOCK_LEAVES;
    bg[103 * ACTIVE_GRID_W + 106] = BLOCK_LEAVES;
    // Blockhead on the ground at (100, 109)
    // Target: the leaf at (105, 103) in the background
    // The blockhead must walk to x=105, then back-wall climb up the trunk
    const path = findPathToAdjacent(fg, bg, 100, 109, 105, 103, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    // The last node should be at or adjacent to (105, 103)
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 103);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("finds a path to the target cell itself when fg is air (background mining)", () => {
    // For background blocks, the foreground at the target is air, so the
    // blockhead can stand AT the target position. findPathToAdjacent should
    // include the target cell in the goal set.
    const fg = makeAirGrid();
    const bg = makeAirBg();
    setFloor(fg, 95, 110, 110);
    // Tree trunk in background at x=105, y=105..109
    for (let y = 105; y <= 109; y++) {
      bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    }
    // Leaf in background at (105, 104) — fg is air here, so blockhead can
    // stand at (105, 104) and mine the leaf
    bg[104 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    // Blockhead at (100, 109), target the leaf at (105, 104)
    const path = findPathToAdjacent(fg, bg, 100, 109, 105, 104, false);
    expect(path).not.toBeNull();
    // The path should end at or adjacent to (105, 104) — either the target
    // cell itself (if it's the closest goal) or a cell adjacent to it.
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 104);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("finds a path to mine a ground-level stone block", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 110);
    // A stone block at (105, 109) sitting on the floor
    setSolid(fg, 105, 109);
    // Blockhead at (100, 109), target the stone at (105, 109)
    const path = findPathToAdjacent(fg, makeAirBg(), 100, 109, 105, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    // Should be adjacent to (105, 109)
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 109);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  it("returns null for findPathToAdjacent when target is surrounded by solid", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 110);
    // Target block at (105, 109) surrounded on all sides by solid
    setSolid(fg, 105, 109);
    setSolid(fg, 104, 109);
    setSolid(fg, 106, 109);
    setSolid(fg, 105, 108);
    setSolid(fg, 105, 110);
    // Also block diagonals and above
    setSolid(fg, 104, 108);
    setSolid(fg, 106, 108);
    setSolid(fg, 104, 110);
    setSolid(fg, 106, 110);
    const path = findPathToAdjacent(fg, makeAirBg(), 100, 109, 105, 109, false);
    expect(path).toBeNull();
  });

  it("findPathToAdjacent returns empty when already at an adjacent cell", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, 110);
    setSolid(fg, 105, 109); // target block
    // Blockhead already at (104, 109) — adjacent to target
    const path = findPathToAdjacent(fg, makeAirBg(), 104, 109, 105, 109, false);
    expect(path).toEqual([]);
  });

  // --- Tree avoidance: pathfinder should prefer ground routes over tree routes ---

  it("prefers ground route around a tree instead of climbing through it", () => {
    // A tree trunk in the background at x=105, y=100..109. The foreground
    // is air at the trunk position. The ground floor is at y=110.
    // The blockhead needs to go from (100, 109) to (110, 109) — straight
    // line on the ground. The pathfinder should route AROUND the tree
    // (along the ground) not THROUGH it (climbing up and over).
    const fg = makeAirGrid();
    const bg = makeAirBg();
    setFloor(fg, 95, 115, 110); // continuous ground floor
    // Tree trunk in background at x=105, y=100..109
    for (let y = 100; y <= 109; y++) {
      bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    }
    // Tree leaves in background at y=99
    bg[99 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 104] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 106] = BLOCK_LEAVES;

    // Blockhead at (100, 109), target at (110, 109) — both on the ground
    const path = findPath(fg, bg, 100, 109, 110, 109, false);
    expect(path).not.toBeNull();
    // The path should stay at y=109 (ground level) — not go up to y=99
    // (tree top). If the path goes through the tree, it would have nodes
    // at y < 109.
    for (const node of path!) {
      expect(node.y).toBe(109); // stays on the ground
    }
  });

  it("still routes through a tree when the target is in the tree", () => {
    // Same tree as above, but the target is a leaf at (105, 99).
    // The pathfinder should route up the tree to reach the leaf.
    const fg = makeAirGrid();
    const bg = makeAirBg();
    setFloor(fg, 95, 115, 110);
    for (let y = 100; y <= 109; y++) {
      bg[y * ACTIVE_GRID_W + 105] = BLOCK_WOOD;
    }
    bg[99 * ACTIVE_GRID_W + 105] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 104] = BLOCK_LEAVES;
    bg[99 * ACTIVE_GRID_W + 106] = BLOCK_LEAVES;

    // Target: the leaf at (105, 99) in the background
    const path = findPathToAdjacent(fg, bg, 100, 109, 105, 99, false);
    expect(path).not.toBeNull();
    // The path should go up (y < 109) to reach the leaf
    const last = path![path!.length - 1];
    const distX = Math.abs(last.x - 105);
    const distY = Math.abs(last.y - 99);
    expect(distX <= 1 && distY <= 1).toBe(true);
  });

  // --- Cliff descent: pathfinder should route off cliffs ---

  it("finds a path down a cliff (fall off edge to lower floor)", () => {
    // Upper cliff: floor at y=102, x=95..100. Lower floor at y=110, x=95..110.
    // Blockhead on upper cliff at (100, 101). Target on lower floor at (100, 109).
    // The blockhead must walk off the right edge of the cliff and fall.
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102); // upper cliff (ends at x=100)
    setFloor(fg, 95, 110, 110); // lower floor
    // Blockhead at (100, 101) on the cliff edge, target at (100, 109) below
    const path = findPath(fg, makeAirBg(), 100, 101, 100, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(100);
    expect(last.y).toBe(109);
  });

  it("finds a path down a cliff when target is directly below the edge", () => {
    // Cliff edge at x=100. Blockhead at (98, 101) on the cliff.
    // Target at (100, 109) — directly below the cliff edge.
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, 102); // upper cliff
    setFloor(fg, 95, 110, 110); // lower floor
    const path = findPath(fg, makeAirBg(), 98, 101, 100, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(100);
    expect(last.y).toBe(109);
  });

  // --- 2-block hole crossing (jump-move) ---

  it("crosses a 2-block-wide hole in the floor", () => {
    // Ground floor at y=110 with a 2-block-wide hole at x=105,106.
    // Bottom of hole at y=111 (solid). Blockhead at (100, 109), target at (110, 109).
    // The blockhead must either fall in and climb out, or jump across.
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, 110); // full floor
    // Cut a 2-block hole at x=105,106
    fg[110 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[110 * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    // Bottom of hole (floor at y=111)
    setFloor(fg, 105, 106, 111);
    const path = findPath(fg, makeAirBg(), 100, 109, 110, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(110);
    expect(last.y).toBe(109);
  });

  it("crosses a 2-block-wide, 2-block-deep hole in the floor", () => {
    // Ground floor at y=110 with a 2-block hole at x=105,106.
    // Bottom of hole at y=112 (2 blocks deep). Blockhead at (100, 109), target at (110, 109).
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, 110);
    fg[110 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[110 * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    fg[111 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[111 * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    setFloor(fg, 105, 106, 112); // bottom of 2-deep hole
    const path = findPath(fg, makeAirBg(), 100, 109, 110, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(110);
    expect(last.y).toBe(109);
  });

  it("does not route through unsupported cells when crossing a hole", () => {
    // 2-block hole. The path should NOT include nodes at y=109 above the hole
    // (unsupported — no ground below). It should either jump across or go
    // through the bottom of the hole.
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, 110);
    fg[110 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    fg[110 * ACTIVE_GRID_W + 106] = BLOCK_AIR;
    setFloor(fg, 105, 106, 111);
    const path = findPath(fg, makeAirBg(), 100, 109, 110, 109, false);
    expect(path).not.toBeNull();
    // No path node should be at y=109 for x=105 or x=106 (above the hole,
    // unsupported). Either the path jumps over or goes through the bottom.
    for (const node of path!) {
      if (node.x === 105 || node.x === 106) {
        // Must be at the bottom of the hole (y=110), not at y=109 (unsupported)
        expect(node.y).not.toBe(109);
      }
    }
  });

  it("finds a path to the bottom of a hole from the top", () => {
    // Blockhead at the top of a hole, target at the bottom.
    // Ground at y=110, hole at x=105 (1-block wide, 3-block deep).
    // Bottom at y=113.
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, 110);
    for (let y = 110; y <= 112; y++) {
      fg[y * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    }
    setFloor(fg, 105, 105, 113); // bottom of hole
    // Blockhead at (104, 109) next to the hole, target at (105, 112) at the bottom
    const path = findPath(fg, makeAirBg(), 104, 109, 105, 112, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(112);
  });

  it("jumps across a 1-block-wide pit without falling in", () => {
    // Ground floor at y=110 with a 1-block-wide pit at x=105.
    // No bottom (open pit). Blockhead at (100, 109), target at (110, 109).
    // The blockhead must jump across the 1-block gap.
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, 110);
    fg[110 * ACTIVE_GRID_W + 105] = BLOCK_AIR; // 1-block pit (no bottom)
    const path = findPath(fg, makeAirBg(), 100, 109, 110, 109, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(110);
    expect(last.y).toBe(109);
    // The path should NOT include a node at x=105 (the pit — unsupported)
    for (const node of path!) {
      expect(node.x).not.toBe(105);
    }
  });

  it("jumps across a 1-block pit and does not route through the pit cell", () => {
    // 1-block pit at x=105. The path should jump from (104,109) to (106,109)
    // without going through (105,109) or (105,110).
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, 110);
    fg[110 * ACTIVE_GRID_W + 105] = BLOCK_AIR;
    const path = findPath(fg, makeAirBg(), 103, 109, 107, 109, false);
    expect(path).not.toBeNull();
    // No node at x=105 (the pit)
    for (const node of path!) {
      expect(node.x).not.toBe(105);
    }
  });
});
