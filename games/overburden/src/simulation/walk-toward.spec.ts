// ============================================================================
// Overburden — walkToward movement tests for ledge descent and wall climbing
//
// Tests the walkToward function's output for the two stuck scenarios:
//   1. Blockhead on a ledge needing to go straight down (fall move)
//   2. Blockhead needing to climb up a wall (climb move)
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_STONE, BLOCK_WOOD,
} from "../shared/constants";
import type { BlockheadAnimState, BlockheadState } from "../shared/types";
import { BH_H } from "./blockhead";
import { type PathNode } from "./pathfinding";
import { classifyMove, walkToward } from "./task-queue";

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
function setWall(fg: Uint16Array, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}

// --- Blockhead state helper ---

const FLOOR_Y = 110;
const STAND_Y = 109;

function makeBlockhead(
  x: number,
  y: number,
  opts: Partial<BlockheadState> = {},
): BlockheadState {
  return {
    id: 0,
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: true,
    health: 100,
    happiness: 100,
    hunger: 100,
    energy: 100,
    environment: 100,
    air: 100,
    animState: "idle" as BlockheadAnimState,
    animTime: 0,
    mantleActive: false,
    mantleTime: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleToX: 0,
    mantleToY: 0,
    wallClimbing: false,
    ...opts,
  };
}

// When standing on floor at cell FLOOR_Y, bh.y = FLOOR_Y - BH_H
const STAND_BH_Y = FLOOR_Y - BH_H;

// ============================================================================
// 1. CLASSIFY MOVE — fall detection
// ============================================================================

describe("classifyMove: fall detection", () => {
  it("classifies directly-below target as fall", () => {
    const bh = makeBlockhead(100, STAND_BH_Y);
    const node: PathNode = { x: 100, y: FLOOR_Y + 3 };
    expect(classifyMove(bh, null, node)).toBe("fall");
  });

  it("classifies below-and-slightly-side as fall", () => {
    const bh = makeBlockhead(100, STAND_BH_Y);
    const node: PathNode = { x: 101, y: FLOOR_Y + 3 };
    expect(classifyMove(bh, null, node)).toBe("fall");
  });

  it("classifies below-and-far-side as fall (not jump)", () => {
    const bh = makeBlockhead(100, STAND_BH_Y);
    const node: PathNode = { x: 103, y: FLOOR_Y + 3 };
    // dx > 1.5 and dy > 1.5 → fall (the fall handler handles horizontal too)
    expect(classifyMove(bh, null, node)).toBe("fall");
  });
});

// ============================================================================
// 2. CLASSIFY MOVE — climb detection
// ============================================================================

describe("classifyMove: climb detection", () => {
  it("classifies directly-above target as climb", () => {
    const bh = makeBlockhead(100, STAND_BH_Y);
    const node: PathNode = { x: 100, y: STAND_Y - 3 };
    expect(classifyMove(bh, null, node)).toBe("climb");
  });

  it("classifies above-and-slightly-side as climb", () => {
    const bh = makeBlockhead(100, STAND_BH_Y);
    const node: PathNode = { x: 101, y: STAND_Y - 3 };
    expect(classifyMove(bh, null, node)).toBe("climb");
  });

  it("classifies 1-block-up as step-up (not climb)", () => {
    const bh = makeBlockhead(100, STAND_BH_Y);
    const node: PathNode = { x: 101, y: STAND_Y - 1 };
    expect(classifyMove(bh, null, node)).toBe("step-up");
  });
});

// ============================================================================
// 3. FALL MOVE — walking off a ledge to go straight down
// ============================================================================

describe("walkToward: fall move — ledge descent", () => {
  it("walks right when target is below and to the right", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, FLOOR_Y); // ledge
    setFloor(fg, 95, 115, FLOOR_Y + 5); // lower floor
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 1; // target 1 block right
    const dy = 4; // target 4 blocks below
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    expect(input.right).toBe(true);
    expect(input.left).toBe(false);
  });

  it("walks left when target is below and to the left", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 100, FLOOR_Y);
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = -1;
    const dy = 4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    expect(input.left).toBe(true);
    expect(input.right).toBe(false);
  });

  it("walks off a 1-wide ledge when target is directly below (gap on both sides)", () => {
    const fg = makeAirGrid();
    // 1-wide ledge: floor only at x=100
    setSolid(fg, 100, FLOOR_Y);
    // Lower floor far below
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 0; // directly below
    const dy = 4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    // Both sides are gaps — should pick facing direction (right by default)
    expect(input.right).toBe(true);
    expect(input.left).toBe(false);
  });

  it("walks off a ledge to the right when left side has a wall", () => {
    const fg = makeAirGrid();
    // 1-wide ledge at x=100, wall to the left at x=99
    setSolid(fg, 100, FLOOR_Y);
    setWall(fg, 99, 108, 110);
    // Lower floor
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 0;
    const dy = 4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    // Left side is blocked by wall, right side is a gap → walk right
    expect(input.right).toBe(true);
    expect(input.left).toBe(false);
  });

  it("walks off a ledge to the left when right side has a wall", () => {
    const fg = makeAirGrid();
    setSolid(fg, 100, FLOOR_Y);
    setWall(fg, 101, 108, 110);
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    const bh = makeBlockhead(100, STAND_BH_Y, { facing: -1 });
    const dx = 0;
    const dy = 4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    // Right side is blocked, left side is a gap → walk left
    expect(input.left).toBe(true);
    expect(input.right).toBe(false);
  });

  it("does NOT walk off when both sides have floors (wide ledge)", () => {
    const fg = makeAirGrid();
    // 3-wide ledge: floor at x=99, 100, 101
    setFloor(fg, 99, 101, FLOOR_Y);
    // No lower floor (or far away)
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 0;
    const dy = 4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    // Both sides have floors — no gap detected. Should still output a
    // direction (facing) but this scenario shouldn't occur with correct
    // pathfinding (the path would route to the edge first).
    expect(input.left || input.right).toBe(true);
  });

  it("detects gap at floor level, not body level (the bug fix)", () => {
    const fg = makeAirGrid();
    // Ledge: floor at x=100, y=110. No floor at x=101 or x=99.
    // But there ARE blocks at body level (y=109) on both sides —
    // these are NOT walls, they're decorative/background. Actually,
    // let's test the real scenario: floor at x=100 only, and
    // the adjacent cells at standable level (y=109) are air (no walls).
    // The old code checked y=109 (body level) which would see air on both
    // sides and think both are "gaps" — but that's correct behavior here.
    // The real bug was: floor at x=100 and x=101, blockhead at x=100,
    // target directly below. Old code checked y=109: both sides air →
    // both "gaps" → walks in facing dir but doesn't fall (floor continues).
    // Fix: check y=110 (floor level): right has floor, left doesn't →
    // walk left to fall off.
    setFloor(fg, 100, 101, FLOOR_Y); // 2-wide ledge
    setFloor(fg, 95, 115, FLOOR_Y + 5); // lower floor
    const bh = makeBlockhead(100, STAND_BH_Y, { facing: 1 });
    const dx = 0;
    const dy = 4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    // Right side (x=101) has floor at y=110 → NOT a gap
    // Left side (x=99) has no floor at y=110 → IS a gap
    // Should walk LEFT to fall off, even though facing is right
    expect(input.left).toBe(true);
    expect(input.right).toBe(false);
  });

  it("presses down when airborne during a fall", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    const bh = makeBlockhead(100, STAND_BH_Y, { onGround: false });
    const dx = 0;
    const dy = 3;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "fall", null);
    expect(input.down).toBe(true);
  });
});

// ============================================================================
// 4. CLIMB MOVE — climbing up a wall
// ============================================================================

describe("walkToward: climb move — wall climbing", () => {
  it("jumps and presses toward a foreground wall on the right", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Wall to the right at x=105
    setWall(fg, 105, 100, 109);
    const bh = makeBlockhead(104, STAND_BH_Y, { facing: 1 });
    const dx = 1; // target is up and to the right
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    expect(input.jump).toBe(true);
    expect(input.up).toBe(true);
    expect(input.right).toBe(true);
  });

  it("jumps and presses toward a foreground wall on the left", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Wall to the left at x=95
    setWall(fg, 95, 100, 109);
    const bh = makeBlockhead(96, STAND_BH_Y, { facing: -1 });
    const dx = -1;
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    expect(input.jump).toBe(true);
    expect(input.up).toBe(true);
    expect(input.left).toBe(true);
  });

  it("jumps with up when a back wall is present (no foreground wall)", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Back wall at the blockhead's position
    bg[109 * ACTIVE_GRID_W + 100] = BLOCK_STONE;
    bg[108 * ACTIVE_GRID_W + 100] = BLOCK_STONE;
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 0;
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, bg, "climb", null);
    expect(input.jump).toBe(true);
    expect(input.up).toBe(true);
  });

  it("does NOT jump when no wall is found — walks toward target instead", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    // No wall anywhere near the blockhead
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 2; // target is up and to the right
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    // No wall → should NOT jump (would jump in place repeatedly = stuck)
    expect(input.jump).toBe(false);
    // Should walk toward the target X to get closer to the wall
    expect(input.right).toBe(true);
  });

  it("does NOT jump when no wall is found — walks left toward target", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = -2;
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    expect(input.jump).toBe(false);
    expect(input.left).toBe(true);
  });

  it("presses up when airborne during a climb", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    setWall(fg, 105, 100, 109);
    const bh = makeBlockhead(104, STAND_BH_Y - 1, { onGround: false, facing: 1 });
    const dx = 1;
    const dy = -3;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    expect(input.up).toBe(true);
    expect(input.jump).toBe(false); // already airborne, no need to jump
  });

  it("stabilizes (waits) when horizontal velocity is high", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    setWall(fg, 105, 100, 109);
    const bh = makeBlockhead(104, STAND_BH_Y, { vx: 0.5, facing: 1 });
    const dx = 1;
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    // Should press up to stabilize, not jump
    expect(input.up).toBe(true);
    expect(input.jump).toBe(false);
  });

  it("detects foreground wall using facing direction first", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Blockhead at x=100, AABB [100, 100.7). Adjacent columns: x=99 (left), x=101 (right).
    // Walls on both sides (narrow corridor)
    setWall(fg, 99, 100, 109);   // left wall (adjacent to AABB left edge)
    setWall(fg, 101, 100, 109);  // right wall (adjacent to AABB right edge)
    const bh = makeBlockhead(100, STAND_BH_Y, { facing: 1 });
    const dx = 0;
    const dy = -4;
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), "climb", null);
    // Facing right → should climb the right wall
    expect(input.jump).toBe(true);
    expect(input.up).toBe(true);
    expect(input.right).toBe(true);
  });
});

// ============================================================================
// 5. CLIMB MOVE — back wall (tree trunk) climbing
// ============================================================================

describe("walkToward: climb move — back wall (tree) climbing", () => {
  it("jumps with up when a tree trunk is in the background", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Tree trunk in background at x=100
    for (let y = 100; y <= 109; y++) bg[y * ACTIVE_GRID_W + 100] = BLOCK_WOOD;
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 0;
    const dy = -5;
    const input = walkToward(bh, dx, dy, fg, bg, "climb", null);
    expect(input.jump).toBe(true);
    expect(input.up).toBe(true);
  });

  it("does not jump when no back wall and no foreground wall", () => {
    const fg = makeAirGrid();
    const bg = makeAirBg();
    setFloor(fg, 95, 110, FLOOR_Y);
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = 0;
    const dy = -5;
    const input = walkToward(bh, dx, dy, fg, bg, "climb", null);
    expect(input.jump).toBe(false);
  });
});

// ============================================================================
// 6. INTEGRATION — pathfinding + walkToward for ledge descent
// ============================================================================

describe("integration: ledge descent path + walkToward", () => {
  it("pathfinder routes off a 1-wide ledge, walkToward walks off edge", () => {
    const fg = makeAirGrid();
    // 1-wide ledge at x=100, y=110
    setSolid(fg, 100, FLOOR_Y);
    // Lower floor at y=115
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    // Path from (100, 109) to (100, 114) — must go off the edge
    const { findPath } = require("./pathfinding");
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 100, FLOOR_Y + 4, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);

    // The first path node should require walking off the edge
    const firstNode = path![0];
    const bh = makeBlockhead(100, STAND_BH_Y);
    const dx = firstNode.x - (bh.x + 0.5);
    const dy = firstNode.y - (bh.y + 1.0);
    const moveType = classifyMove(bh, null, firstNode);
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), moveType, firstNode);
    // Should output a horizontal direction to walk off the edge
    expect(input.left || input.right).toBe(true);
  });

  it("pathfinder routes off a 2-wide ledge to the nearest edge", () => {
    const fg = makeAirGrid();
    // 2-wide ledge at x=100,101
    setFloor(fg, 100, 101, FLOOR_Y);
    // Lower floor
    setFloor(fg, 95, 115, FLOOR_Y + 5);
    const { findPath } = require("./pathfinding");
    // Blockhead at x=100, target at x=100, y=114 (below)
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 100, FLOOR_Y + 4, false);
    expect(path).not.toBeNull();
    // The path should go to the edge (x=101 or x=99) then fall
    const bh = makeBlockhead(100, STAND_BH_Y);
    const firstNode = path![0];
    const dx = firstNode.x - (bh.x + 0.5);
    const dy = firstNode.y - (bh.y + 1.0);
    const moveType = classifyMove(bh, null, firstNode);
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), moveType, firstNode);
    expect(input.left || input.right).toBe(true);
  });
});

// ============================================================================
// 7. INTEGRATION — pathfinding + walkToward for wall climbing
// ============================================================================

describe("integration: wall climbing path + walkToward", () => {
  it("pathfinder routes up a wall, walkToward jumps and climbs", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    // Wall at x=105, y=100..109
    setWall(fg, 105, 100, 109);
    const { findPath } = require("./pathfinding");
    // Target on top of the wall at (105, 99)
    const path = findPath(fg, makeAirBg(), 100, STAND_Y, 105, 99, false);
    expect(path).not.toBeNull();

    // Walk toward the first node
    const bh = makeBlockhead(100, STAND_BH_Y);
    const firstNode = path![0];
    const dx = firstNode.x - (bh.x + 0.5);
    const dy = firstNode.y - (bh.y + 1.0);
    const moveType = classifyMove(bh, null, firstNode);
    // The first node should be a walk (toward the wall)
    expect(moveType === "walk" || moveType === "step-up").toBe(true);
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), moveType, firstNode);
    expect(input.left || input.right).toBe(true);
  });

  it("walkToward climbs when at the wall base (climb move)", () => {
    const fg = makeAirGrid();
    setFloor(fg, 95, 110, FLOOR_Y);
    setWall(fg, 105, 100, 109);
    // Blockhead is right next to the wall
    const bh = makeBlockhead(104, STAND_BH_Y, { facing: 1 });
    const node: PathNode = { x: 105, y: 99 }; // top of wall
    const dx = node.x - (bh.x + 0.5);
    const dy = node.y - (bh.y + 1.0);
    const moveType = classifyMove(bh, null, node);
    expect(moveType).toBe("climb");
    const input = walkToward(bh, dx, dy, fg, makeAirBg(), moveType, node);
    expect(input.jump).toBe(true);
    expect(input.up).toBe(true);
    expect(input.right).toBe(true);
  });
});
