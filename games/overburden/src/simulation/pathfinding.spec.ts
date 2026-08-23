// ============================================================================
// Overburden — A* pathfinding unit tests
// ============================================================================

import { describe, expect, it } from "bun:test";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, BLOCK_AIR, BLOCK_STONE } from "../shared/constants";
import { findPath } from "./pathfinding";

// Helper: create a foreground grid filled with air
function makeAirGrid(): Uint16Array {
  return new Uint16Array(ACTIVE_GRID_W * ACTIVE_GRID_H).fill(BLOCK_AIR);
}

// Helper: set a solid block at (x, y)
function setSolid(fg: Uint16Array, x: number, y: number): void {
  fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}

describe("pathfinding", () => {
  it("finds a straight-line path with no obstacles", () => {
    const fg = makeAirGrid();
    const path = findPath(fg, 100, 100, 105, 100, false);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    // Last node should be at the goal
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(100);
  });

  it("finds a path around a 1-block wall", () => {
    const fg = makeAirGrid();
    // Place a 1-block wall at (102, 100)
    setSolid(fg, 102, 100);
    const path = findPath(fg, 100, 100, 105, 100, false);
    expect(path).not.toBeNull();
    // Path should go around (over) the wall
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(100);
  });

  it("finds a path around a 3-block wall", () => {
    const fg = makeAirGrid();
    // Place a 3-block vertical wall at x=102, y=99..101
    setSolid(fg, 102, 99);
    setSolid(fg, 102, 100);
    setSolid(fg, 102, 101);
    const path = findPath(fg, 100, 100, 105, 100, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(105);
    expect(last.y).toBe(100);
  });

  it("returns null when walled in with no path", () => {
    const fg = makeAirGrid();
    // Surround (100, 100) with solid blocks on all 4 sides
    setSolid(fg, 99, 100);
    setSolid(fg, 101, 100);
    setSolid(fg, 100, 99);
    setSolid(fg, 100, 101);
    // Also block the diagonal escape (since blockhead is 2 tall, need to block above too)
    setSolid(fg, 99, 98);
    setSolid(fg, 101, 98);
    const path = findPath(fg, 100, 100, 200, 100, false);
    expect(path).toBeNull();
  });

  it("handles cylinder wrap on X", () => {
    const fg = makeAirGrid();
    // Start near the right edge, goal near the left edge
    // With wrap, the path should go right (wrapping around) instead of left (long way)
    const path = findPath(fg, ACTIVE_GRID_W - 5, 100, 5, 100, true);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(5);
    expect(last.y).toBe(100);
  });

  it("returns empty array when start === goal", () => {
    const fg = makeAirGrid();
    const path = findPath(fg, 100, 100, 100, 100, false);
    expect(path).toEqual([]);
  });

  it("is deterministic — same input gives same path", () => {
    const fg = makeAirGrid();
    setSolid(fg, 102, 100);
    const path1 = findPath(fg, 100, 100, 105, 100, false);
    const path2 = findPath(fg, 100, 100, 105, 100, false);
    expect(path1).toEqual(path2);
  });

  it("can step up a 1-block step", () => {
    const fg = makeAirGrid();
    // Place a 1-block step at (102, 100) — floor at y=101, step at y=100
    // The blockhead walks from (100, 101) to (103, 100)
    // Need a floor for the blockhead to stand on
    for (let x = 98; x < 108; x++) {
      setSolid(fg, x, 102); // floor
    }
    setSolid(fg, 102, 101); // 1-block step up
    const path = findPath(fg, 100, 101, 104, 100, false);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(last.x).toBe(104);
    expect(last.y).toBe(100);
  });
});
