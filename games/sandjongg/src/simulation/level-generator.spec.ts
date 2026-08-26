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

  it("noAdjacentSame avoids orthogonal same-element neighbours", () => {
    // Use a large enough level that many pairs get placed, across several seeds.
    let anyAdjacent = false;
    for (let seed = 1; seed <= 8; seed++) {
      const { board } = generateLevel(8, seed, { noAdjacentSame: true });
      for (let l = 0; l < board.maxLayers; l++) {
        for (let r = 0; r < board.rows; r++) {
          for (let c = 0; c < board.cols; c++) {
            const t = board.at(c, r, l);
            if (!t) continue;
            const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const [dx, dy] of neighbours) {
              const n = board.at(c + dx, r + dy, l);
              if (n && n.element === t.element) { anyAdjacent = true; }
            }
          }
        }
      }
    }
    expect(anyAdjacent).toBe(false);
  });

  it("noAdjacentSame still produces solvable boards", () => {
    for (let level = 1; level <= 10; level++) {
      const { board } = generateLevel(level, 12345, { noAdjacentSame: true });
      expect(board.remainingCount()).toBeGreaterThan(0);
      expect(isSolvable(board)).toBe(true);
    }
  });

  it("custom dims override level-based dimensions", () => {
    const { spec } = generateLevel(1, 1, { cols: 20, rows: 14 });
    expect(spec.cols).toBe(20);
    expect(spec.rows).toBe(14);
  });

  it("custom dims are capped at MAX_COLS/MAX_ROWS", () => {
    const { spec } = generateLevel(1, 1, { cols: 999, rows: 999 });
    expect(spec.cols).toBe(MAX_COLS);
    expect(spec.rows).toBe(MAX_ROWS);
  });

  it("layers fill almost all usable cells (stalls reduced)", () => {
    // For each shape (levels 1-5 cycle through all shapes), the generated
    // board should fill nearly every usable cell on layer 0. The centrality-
    // ordered pairing eliminates most stalls; at most 1 pair (2 cells) may
    // remain unconnectable — a fundamental limit of greedy reverse
    // construction without backtracking.
    for (let level = 1; level <= 5; level++) {
      const shape = levelShape(level);
      for (let seed = 1; seed <= 5; seed++) {
        const { board, spec } = generateLevel(level, seed * 1000, { cols: 12, rows: 10 });
        expect(spec.shape).toBe(shape);
        const mask = shapeMask(shape, spec.cols, spec.rows);
        let filled = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i]) filled++;
        if (filled % 2 !== 0) filled -= 1;
        let layer0Tiles = 0;
        for (let r = 0; r < spec.rows; r++) {
          for (let c = 0; c < spec.cols; c++) {
            if (board.at(c, r, 0) !== null) layer0Tiles++;
          }
        }
        const gaps = filled - layer0Tiles;
        expect(gaps).toBeLessThanOrEqual(2); // at most 1 unpaired pair
      }
    }
  });
});
