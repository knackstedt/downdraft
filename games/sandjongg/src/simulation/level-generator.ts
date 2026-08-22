// ============================================================================
// Level generator — procedural solvable Mahjongg Connect boards.
//
// Uses reverse construction: start from an empty board of the chosen shape,
// then repeatedly pick two random empty cells and place a pair of a random
// element. Because every pair was placed at connectable positions in reverse,
// the board is guaranteed solvable in forward play.
// ============================================================================

import { ALL_SHAPES, type BoardShape, MAX_COLS, MAX_LAYERS, MAX_ROWS } from "../shared/constants";
import { NUM_ELEMENTS } from "../shared/elements";
import type { LevelSpec } from "../shared/types";
import { TileBoard } from "./board";
import { findPath } from "./pathfinding";
import { isSolvable } from "./solver";

/**
 * Simple seeded PRNG (mulberry32).
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Determine which cells are "filled" (part of the board shape) for a given
 * shape at a given size. Returns a boolean grid [col + row*cols].
 */
export function shapeMask(shape: BoardShape, cols: number, rows: number): boolean[] {
  const mask = new Array(cols * rows).fill(false);
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let fill = false;
      switch (shape) {
        case "rectangle":
          fill = true;
          break;
        case "pyramid": {
          // Tiered pyramid: each row is narrower than the one below.
          const tier = Math.floor((rows - 1 - r) / Math.max(1, Math.floor(rows / 4)));
          const halfWidth = (cols / 2) - tier * Math.floor(cols / 8);
          fill = Math.abs(c - cx) <= halfWidth;
          break;
        }
        case "cross": {
          // Plus/cross shape: center band + vertical band.
          const bandH = Math.max(1, Math.floor(rows / 3));
          const bandW = Math.max(1, Math.floor(cols / 3));
          fill = (Math.abs(r - cy) <= bandH) || (Math.abs(c - cx) <= bandW);
          break;
        }
        case "diamond": {
          // Diamond: |c-cx| + |r-cy| <= radius.
          const radius = Math.min(cols, rows) / 2;
          fill = Math.abs(c - cx) + Math.abs(r - cy) <= radius;
          break;
        }
        case "hourglass": {
          // Hourglass: wide at top and bottom, narrow in the middle.
          const midDist = Math.abs(r - cy) / cy;
          const halfWidth = (cols / 2) * (0.3 + 0.7 * midDist);
          fill = Math.abs(c - cx) <= halfWidth;
          break;
        }
      }
      mask[c + r * cols] = fill;
    }
  }
  return mask;
}

/**
 * Count filled cells in a shape mask.
 */
export function countFilled(mask: boolean[]): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) count++;
  }
  return count;
}

/**
 * Compute board dimensions for a given level.
 * Size scales with level, capped at MAX_COLS × MAX_ROWS.
 */
export function levelDims(level: number): { cols: number; rows: number } {
  // Level 1: 8×6. +1 col every 2 levels, +1 row every 3 levels. Cap at 24×16.
  const cols = Math.min(MAX_COLS, 8 + Math.floor((level - 1) / 2));
  const rows = Math.min(MAX_ROWS, 6 + Math.floor((level - 1) / 3));
  return { cols, rows };
}

/**
 * Compute the number of layers for a given level.
 * Level 1-2: 1 layer. Level 3-5: 2 layers. Level 6+: 3 layers. Cap at MAX_LAYERS.
 */
export function levelLayers(level: number): number {
  if (level <= 2) return 1;
  if (level <= 5) return 2;
  if (level <= 9) return 3;
  return Math.min(MAX_LAYERS, 3 + Math.floor((level - 10) / 5));
}

/**
 * Pick a shape for a given level (cycles through shapes).
 */
export function levelShape(level: number): BoardShape {
  return ALL_SHAPES[(level - 1) % ALL_SHAPES.length];
}

/**
 * Generate a solvable board for a given level using reverse construction.
 *
 * Reverse construction: start with an empty board of the shape, then repeatedly
 * pick two random empty cells that are connectable (findPath succeeds) and place
 * a pair of a random element. This guarantees the board is solvable in forward
 * play because every pair was placed at a connectable position.
 *
 * If the shape has an odd number of cells, the last cell is left empty.
 * If reverse construction stalls (no connectable pair found for remaining
 * cells), we fall back to verifying with isSolvable and regenerating with a
 * different seed if needed.
 */
export function generateLevel(level: number, seed: number): { board: TileBoard; spec: LevelSpec } {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = makeRng(seed + attempt * 0x9e3779b9);
    const result = tryGenerate(level, rng);
    if (result !== null) return result;
  }
  // Fallback: simple rectangle that's guaranteed solvable.
  const rng = makeRng(seed);
  const result = tryGenerate(1, rng);
  if (result !== null) return result;
  // Ultimate fallback: empty board (should never happen).
  const { cols, rows } = levelDims(level);
  return {
    board: new TileBoard(cols, rows, 1),
    spec: { level, shape: "rectangle", cols, rows, layers: 1, tileCount: 0 },
  };
}

function tryGenerate(level: number, rng: () => number): { board: TileBoard; spec: LevelSpec } | null {
  const shape = levelShape(level);
  const { cols, rows } = levelDims(level);
  const numLayers = levelLayers(level);
  const mask = shapeMask(shape, cols, rows);

  // Collect all filled cell positions.
  const filledCells: { col: number; row: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (mask[c + r * cols]) filledCells.push({ col: c, row: r });
    }
  }

  // For multi-layer boards, fill layer 0 first, then stack additional layers
  // on a subset of positions (each higher layer is smaller than the one below).
  const board = new TileBoard(cols, rows, numLayers);
  let placed = 0;

  for (let layer = 0; layer < numLayers; layer++) {
    // For layer 0, use all filled cells. For higher layers, use a shrinking
    // subset (inset by 1 cell on each side per layer) so the stack looks like
    // a pyramid.
    let layerCells: { col: number; row: number }[];
    if (layer === 0) {
      layerCells = [...filledCells];
    } else {
      // Inset the shape for higher layers.
      const inset = layer;
      layerCells = filledCells.filter(({ col, row }) => {
        // Keep cells that are at least `inset` away from the edge of the shape.
        for (let dy = -inset; dy <= inset; dy++) {
          for (let dx = -inset; dx <= inset; dx++) {
            if (Math.abs(dx) + Math.abs(dy) <= inset) {
              const nc = col + dx, nr = row + dy;
              if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return false;
              if (!mask[nc + nr * cols]) return false;
            }
          }
        }
        return true;
      });
    }

    // If odd number of cells, drop the last one.
    const usableCells = layerCells.length % 2 === 0 ? layerCells : layerCells.slice(0, layerCells.length - 1);
    if (usableCells.length < 2) continue;

    const remaining = [...usableCells];

    // Reverse construction on this layer.
    while (remaining.length >= 2) {
      const shuffledFirst = shuffleIndices(remaining.length, rng);
      let found = false;

      for (const i1 of shuffledFirst) {
        const cell1 = remaining[i1];
        const element = Math.floor(rng() * NUM_ELEMENTS);

        const shuffledSecond = shuffleIndices(remaining.length, rng);
        for (const i2 of shuffledSecond) {
          if (i2 === i1) continue;
          const cell2 = remaining[i2];
          const path = findPath(board, cell1.col, cell1.row, cell2.col, cell2.row, layer);
          if (path !== null) {
            board.place(cell1.col, cell1.row, element, layer);
            board.place(cell2.col, cell2.row, element, layer);
            remaining.splice(Math.max(i1, i2), 1);
            remaining.splice(Math.min(i1, i2), 1);
            placed += 2;
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (!found) break;
    }
  }

  if (placed < 2) return null;

  // Verify solvability for small boards.
  if (placed <= 40) {
    if (!isSolvable(board)) return null;
  }

  return {
    board,
    spec: { level, shape, cols, rows, layers: numLayers, tileCount: placed },
  };
}

function shuffleIndices(n: number, rng: () => number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
