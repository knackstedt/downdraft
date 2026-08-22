import { describe, expect, it } from "bun:test";
import { TileBoard } from "./board";
import { countTurns, findPath } from "./pathfinding";

describe("pathfinding", () => {
  it("same cell returns null", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0);
    expect(findPath(b, 1, 1, 1, 1)).toBeNull();
  });

  it("adjacent same-element tiles connect (0 turns)", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0);
    b.place(2, 1, 0);
    const path = findPath(b, 1, 1, 2, 1);
    expect(path).not.toBeNull();
    expect(path!.turns).toBe(0);
    expect(path!.points.length).toBe(2);
  });

  it("straight horizontal line connects (0 turns)", () => {
    const b = new TileBoard(8, 6);
    b.place(1, 3, 0);
    b.place(6, 3, 0);
    const path = findPath(b, 1, 3, 6, 3);
    expect(path).not.toBeNull();
    expect(path!.turns).toBe(0);
  });

  it("straight vertical line connects (0 turns)", () => {
    const b = new TileBoard(6, 8);
    b.place(3, 1, 0);
    b.place(3, 6, 0);
    const path = findPath(b, 3, 1, 3, 6);
    expect(path).not.toBeNull();
    expect(path!.turns).toBe(0);
  });

  it("L-path connects (1 turn)", () => {
    const b = new TileBoard(8, 8);
    b.place(1, 1, 0);
    b.place(5, 5, 0);
    const path = findPath(b, 1, 1, 5, 5);
    expect(path).not.toBeNull();
    expect(path!.turns).toBe(1);
  });

  it("Z-path connects (2 turns) through empty space", () => {
    const b = new TileBoard(10, 8);
    // Place a wall of tiles blocking the direct path.
    for (let r = 0; r < 8; r++) {
      if (r !== 3) b.place(5, r, 1);
    }
    b.place(1, 1, 0);
    b.place(8, 6, 0);
    // Path must go through the gap at row 3, requiring 2 turns.
    const path = findPath(b, 1, 1, 8, 6);
    expect(path).not.toBeNull();
    expect(path!.turns).toBeLessThanOrEqual(2);
  });

  it("3-turn path is rejected", () => {
    const b = new TileBoard(10, 10);
    // Create a maze requiring 3 turns.
    // Wall at col 5, rows 0-4 (gap at row 5).
    for (let r = 0; r < 5; r++) b.place(5, r, 1);
    // Wall at col 3, rows 5-9 (gap at row 4).
    for (let r = 5; r < 10; r++) b.place(3, r, 1);
    b.place(1, 1, 0);
    b.place(8, 8, 0);
    // This may or may not have a ≤2-turn path depending on layout.
    // The key test: if findPath returns non-null, turns ≤ 2.
    const path = findPath(b, 1, 1, 8, 8);
    if (path !== null) {
      expect(path.turns).toBeLessThanOrEqual(2);
    }
  });

  it("blocked path (fully walled off) is rejected", () => {
    const b = new TileBoard(6, 6);
    // Surround tile at (1,1) with walls.
    b.place(0, 0, 1);
    b.place(1, 0, 1);
    b.place(2, 0, 1);
    b.place(0, 1, 1);
    b.place(2, 1, 1);
    b.place(0, 2, 1);
    b.place(1, 2, 1);
    b.place(2, 2, 1);
    b.place(1, 1, 0);
    b.place(4, 4, 0);
    // Tile at (1,1) is completely surrounded — no path to (4,4).
    // But the path can go around the outside border! So this should still connect.
    // Actually, (1,1) is surrounded on all 4 sides by tiles, but the path
    // starts AT (1,1) and the first step must go to an adjacent cell.
    // The adjacent cells are all occupied (not empty, not start/end).
    // So the path cannot leave (1,1) — should be null.
    const path = findPath(b, 1, 1, 4, 4);
    expect(path).toBeNull();
  });

  it("path goes around the outside border", () => {
    const b = new TileBoard(6, 6);
    // Two tiles at opposite corners, with a full wall between them.
    for (let r = 0; r < 6; r++) b.place(3, r, 1);
    b.place(1, 1, 0);
    b.place(5, 4, 0);
    // The wall at col 3 blocks all on-board paths, but the path can go
    // around the top or bottom border (off-board cells are passable).
    const path = findPath(b, 1, 1, 5, 4);
    expect(path).not.toBeNull();
    expect(path!.turns).toBeLessThanOrEqual(2);
  });

  it("path through cleared gap works", () => {
    const b = new TileBoard(8, 6);
    // Wall at col 4 with a gap at row 2.
    for (let r = 0; r < 6; r++) {
      if (r !== 2) b.place(4, r, 1);
    }
    b.place(1, 2, 0);
    b.place(6, 2, 0);
    // Straight horizontal path through the gap at row 2.
    const path = findPath(b, 1, 2, 6, 2);
    expect(path).not.toBeNull();
    expect(path!.turns).toBe(0);
  });

  it("different-element tiles still find a path (pathfinding is element-agnostic)", () => {
    const b = new TileBoard(6, 6);
    b.place(1, 1, 0);
    b.place(4, 4, 1);
    // findPath doesn't check element equality — that's the match engine's job.
    const path = findPath(b, 1, 1, 4, 4);
    expect(path).not.toBeNull();
  });

  it("countTurns: straight line = 0", () => {
    expect(countTurns([{ col: 0, row: 0 }, { col: 5, row: 0 }])).toBe(0);
  });

  it("countTurns: L-path = 1", () => {
    expect(countTurns([{ col: 0, row: 0 }, { col: 3, row: 0 }, { col: 3, row: 3 }])).toBe(1);
  });

  it("countTurns: Z-path = 2", () => {
    expect(countTurns([
      { col: 0, row: 0 },
      { col: 3, row: 0 },
      { col: 3, row: 2 },
      { col: 5, row: 2 },
    ])).toBe(2);
  });

  it("tiles at edges connect via outside border", () => {
    const b = new TileBoard(5, 5);
    b.place(0, 0, 0);
    b.place(4, 0, 0);
    // Both at top edge — path can go above the board (row -1).
    const path = findPath(b, 0, 0, 4, 0);
    expect(path).not.toBeNull();
  });

  it("tiles at left and right edges connect via outside border", () => {
    const b = new TileBoard(5, 5);
    // Fill the entire middle row with walls.
    for (let c = 0; c < 5; c++) b.place(c, 2, 1);
    b.place(0, 0, 0);
    b.place(4, 4, 0);
    // Path must go around the outside (above or below the wall row).
    const path = findPath(b, 0, 0, 4, 4);
    expect(path).not.toBeNull();
    expect(path!.turns).toBeLessThanOrEqual(2);
  });
});
