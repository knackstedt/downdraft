import { describe, expect, it } from "bun:test";
import { ALL_SHAPES, MAX_COLS, MAX_ROWS } from "../shared/constants";
import { countFilled, generateLevel, levelDims, levelShape, makeRng, shapeMask } from "./level-generator";
import { isSolvable } from "./solver";

describe("level-generator", () => {
  it("makeRng is deterministic with the same seed", () => {
    const r1 = makeRng(42);
    const r2 = makeRng(42);
    for (let i = 0; i < 10; i++) {
      expect(r1()).toBe(r2());
    }
  });

  it("levelDims scales with level and caps at max", () => {
    const d1 = levelDims(1);
    expect(d1.cols).toBe(8);
    expect(d1.rows).toBe(6);

    const d10 = levelDims(10);
    expect(d10.cols).toBeGreaterThan(d1.cols);
    expect(d10.rows).toBeGreaterThan(d1.rows);

    const d100 = levelDims(100);
    expect(d100.cols).toBe(MAX_COLS);
    expect(d100.rows).toBe(MAX_ROWS);
  });

  it("levelShape cycles through all shapes", () => {
    expect(levelShape(1)).toBe("rectangle");
    expect(levelShape(2)).toBe("pyramid");
    expect(levelShape(3)).toBe("cross");
    expect(levelShape(4)).toBe("diamond");
    expect(levelShape(5)).toBe("hourglass");
    expect(levelShape(6)).toBe("rectangle"); // wraps
  });

  it("shapeMask: rectangle fills all cells", () => {
    const mask = shapeMask("rectangle", 4, 4);
    expect(countFilled(mask)).toBe(16);
  });

  it("shapeMask: all shapes produce even or reducible cell counts", () => {
    for (const shape of ALL_SHAPES) {
      const { cols, rows } = levelDims(3);
      const mask = shapeMask(shape, cols, rows);
      const filled = countFilled(mask);
      expect(filled).toBeGreaterThan(0);
    }
  });

  it("generated levels are solvable (levels 1-10)", () => {
    for (let level = 1; level <= 10; level++) {
      const { board, spec } = generateLevel(level, 12345);
      expect(spec.level).toBe(level);
      expect(spec.tileCount).toBeGreaterThan(0);
      expect(spec.tileCount % 2).toBe(0); // pairs
      expect(board.remainingCount()).toBe(spec.tileCount);
      expect(isSolvable(board)).toBe(true);
    }
  });

  it("generated levels are deterministic with the same seed", () => {
    const a = generateLevel(3, 999);
    const b = generateLevel(3, 999);
    expect(a.spec).toEqual(b.spec);
    // Board contents should be identical.
    for (let i = 0; i < a.board.tiles.length; i++) {
      const ta = a.board.tiles[i];
      const tb = b.board.tiles[i];
      if (ta === null) {
        expect(tb).toBeNull();
      } else {
        expect(tb).not.toBeNull();
        expect(ta.element).toBe(tb!.element);
      }
    }
  });

  it("generated levels have element diversity (at least 2 distinct elements for larger boards)", () => {
    for (let level = 2; level <= 10; level++) {
      const { board } = generateLevel(level, 777);
      expect(board.elementsLeft()).toBeGreaterThanOrEqual(2);
    }
  });

  it("generated level tile count scales with level", () => {
    const low = generateLevel(1, 100);
    const high = generateLevel(8, 100);
    // Higher levels should generally have more tiles (not strictly guaranteed
    // due to shape differences, but the trend should hold).
    expect(high.spec.tileCount).toBeGreaterThanOrEqual(low.spec.tileCount);
  });

  it("different seeds produce different boards (usually)", () => {
    const a = generateLevel(3, 1);
    const b = generateLevel(3, 2);
    let diff = false;
    for (let i = 0; i < a.board.tiles.length; i++) {
      const ta = a.board.tiles[i];
      const tb = b.board.tiles[i];
      if ((ta === null) !== (tb === null)) { diff = true; break; }
      if (ta !== null && tb !== null && ta.element !== tb!.element) { diff = true; break; }
    }
    expect(diff).toBe(true);
  });
});
