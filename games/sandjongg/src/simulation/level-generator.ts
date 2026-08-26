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
import type { GameMode, LevelSpec } from "../shared/types";
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

export interface GenerateLevelOptions {
  /** When true, avoid placing the same element in orthogonally-adjacent cells
   *  (4-neighbour). Best-effort: relaxed if no element fits to avoid stalling. */
  noAdjacentSame?: boolean;
  /** Override board columns (0 = use level-based scaling). */
  cols?: number;
  /** Override board rows (0 = use level-based scaling). */
  rows?: number;
  /** Game mode — drives generation strategy. Defaults to "sandjongg". */
  mode?: GameMode;
}

/**
 * Generate a solvable board for a given level.
 *
 * Sandjongg mode uses reverse construction: start with an empty board of the
 * shape, then repeatedly pick two random empty cells that are connectable
 * (findPath succeeds) and place a pair of a random element. This guarantees
 * the board is solvable in forward play because every pair was placed at a
 * connectable position.
 *
 * Mahjongg mode uses random pair assignment over a layered pyramid layout,
 * then verifies solvability with the (path-free) Mahjongg solver, retrying
 * with re-shuffles until a solvable deal is found.
 *
 * If the shape has an odd number of cells, the last cell is left empty.
 */
export function generateLevel(
  level: number,
  seed: number,
  opts: GenerateLevelOptions = {},
): { board: TileBoard; spec: LevelSpec } {
  const mode: GameMode = opts.mode ?? "sandjongg";
  if (mode === "mahjongg") {
    return generateMahjonggLevel(level, seed, opts);
  }
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = makeRng(seed + attempt * 0x9e3779b9);
    const result = tryGenerate(level, rng, opts);
    if (result !== null) return result;
  }
  // Fallback: simple rectangle that's guaranteed solvable.
  const rng = makeRng(seed);
  const result = tryGenerate(1, rng, {});
  if (result !== null) return result;
  // Ultimate fallback: empty board (should never happen).
  const { cols, rows } = levelDims(level);
  return {
    board: new TileBoard(cols, rows, 1),
    spec: { level, shape: "rectangle", cols, rows, layers: 1, tileCount: 0 },
  };
}

/** True if an orthogonal neighbour of (col,row,layer) already holds `element`. */
function hasAdjacentSame(board: TileBoard, col: number, row: number, layer: number, element: number): boolean {
  const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of neighbours) {
    const t = board.at(col + dx, row + dy, layer);
    if (t !== null && t.element === element) return true;
  }
  return false;
}

function tryGenerate(
  level: number,
  rng: () => number,
  opts: GenerateLevelOptions,
): { board: TileBoard; spec: LevelSpec } | null {
  const shape = levelShape(level);
  const dims = (opts.cols && opts.cols > 0 && opts.rows && opts.rows > 0)
    ? { cols: opts.cols, rows: opts.rows }
    : levelDims(level);
  const cols = Math.min(MAX_COLS, dims.cols);
  const rows = Math.min(MAX_ROWS, dims.rows);
  const numLayers = levelLayers(level);
  const mask = shapeMask(shape, cols, rows);
  const noAdjacent = !!opts.noAdjacentSame;

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

    // Reverse construction on this layer. Retry with fresh shuffles if the
    // pairing stalls — different pairing orders produce different intermediate
    // board states, so a re-roll can avoid a dead end that a different order
    // would have sidestepped. If no attempt fills the layer completely, keep
    // the best (most-filled) partial attempt rather than discarding it.
    const maxLayerAttempts = 2;
    let layerComplete = false;
    let bestPlaced = -1;
    let bestSnapshot: Int8Array | null = null; // element per usableCell, -1 = empty
    for (let attempt = 0; attempt < maxLayerAttempts; attempt++) {
      // Clear any tiles placed on this layer by a previous (stalled) attempt.
      for (const { col, row } of usableCells) {
        board.remove(col, row, layer);
      }
      const remaining = [...usableCells];
      let stalled = false;

      while (remaining.length >= 2) {
        // Pair interior cells first (centrality-ordered) so they get paired
        // while the board is still empty and paths are clear. Edge cells —
        // which can always route around the 1-cell border ring — are left
        // for last. Random tie-breaking preserves board variety.
        const shuffledFirst = centralityOrder(remaining, cols, rows, rng);
        let found = false;

        for (const i1 of shuffledFirst) {
          const cell1 = remaining[i1];
          // Pick an element. When the no-adjacent constraint is active, try each
          // element in a shuffled order and pick the first that doesn't create an
          // orthogonal same-element neighbour at either cell of the pair. If none
          // qualify, relax to a random element so generation doesn't stall.
          let element = Math.floor(rng() * NUM_ELEMENTS);
          if (noAdjacent) {
            const order = shuffleIndices(NUM_ELEMENTS, rng);
            let chosen = -1;
            for (const el of order) {
              // Check cell1 against existing neighbours; cell2 is still empty so
              // only cell1's neighbours matter here, but we also avoid cell1 and
              // cell2 being orthogonally adjacent with the same element after both
              // are placed — checked below before committing.
              if (!hasAdjacentSame(board, cell1.col, cell1.row, layer, el)) {
                chosen = el;
                break;
              }
            }
            element = chosen >= 0 ? chosen : element;
          }

          const shuffledSecond = centralityOrder(remaining, cols, rows, rng);
          for (const i2 of shuffledSecond) {
            if (i2 === i1) continue;
            const cell2 = remaining[i2];
            const path = findPath(board, cell1.col, cell1.row, cell2.col, cell2.row, layer);
            if (path !== null) {
              // Enforce the no-adjacent constraint for cell2 as well, and that the
              // two cells of the pair aren't orthogonally adjacent (which would
              // place the same element side-by-side). If violated, skip this cell2
              // and try another — the outer loop will retry with a new cell1.
              if (noAdjacent) {
                if (hasAdjacentSame(board, cell2.col, cell2.row, layer, element)) continue;
                const areAdjacent = Math.abs(cell1.col - cell2.col) + Math.abs(cell1.row - cell2.row) === 1;
                if (areAdjacent) continue;
              }
              board.place(cell1.col, cell1.row, element, layer);
              board.place(cell2.col, cell2.row, element, layer);
              remaining.splice(Math.max(i1, i2), 1);
              remaining.splice(Math.min(i1, i2), 1);
              found = true;
              break;
            }
          }
          if (found) break;
        }

        if (!found) { stalled = true; break; }
      }

      if (!stalled) {
        layerComplete = true;
        break;
      }

      // Snapshot this partial attempt if it placed more tiles than any prior.
      const snapshot = new Int8Array(usableCells.length);
      let placedCount = 0;
      for (let i = 0; i < usableCells.length; i++) {
        const t = board.at(usableCells[i].col, usableCells[i].row, layer);
        if (t) { snapshot[i] = t.element; placedCount++; }
        else { snapshot[i] = -1; }
      }
      if (placedCount > bestPlaced) {
        bestPlaced = placedCount;
        bestSnapshot = snapshot;
      }
    }

    if (!layerComplete && bestSnapshot) {
      // Restore the best partial fill (fewest gaps).
      for (let i = 0; i < usableCells.length; i++) {
        const { col, row } = usableCells[i];
        board.remove(col, row, layer);
        if (bestSnapshot[i] >= 0) {
          board.place(col, row, bestSnapshot[i], layer);
        }
      }
    }
  }

  // Recompute placed count from the board (layer retries may have changed it).
  let placed = 0;
  for (let l = 0; l < numLayers; l++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (board.at(c, r, l) !== null) placed++;
      }
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

// ============================================================================
// Mahjongg (classic layered solitaire) generation.
//
// A layered pyramid layout is built from the shape mask (layer 0 = full shape,
// each higher layer inset by one cell per side). Element pairs are dealt
// randomly across the layout positions, then solvability is verified with the
// path-free Mahjongg solver. We retry with re-shuffles (and fresh seeds) until
// a solvable deal is found.
// ============================================================================

/** Build the layered layout — list of (col,row,layer) positions — for a
 *  Mahjongg board. Higher layers are inset pyramids so lower-layer tiles have
 *  exposed horizontal sides (required by the free-tile rule). */
function buildMahjonggLayout(
  shape: BoardShape,
  cols: number,
  rows: number,
  numLayers: number,
): { col: number; row: number; layer: number }[] {
  const mask = shapeMask(shape, cols, rows);
  const positions: { col: number; row: number; layer: number }[] = [];
  for (let layer = 0; layer < numLayers; layer++) {
    const inset = layer;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!mask[c + r * cols]) continue;
        // Inset: keep only cells fully surrounded by `inset` ring of shape.
        if (inset > 0) {
          let ok = true;
          for (let dy = -inset; dy <= inset && ok; dy++) {
            for (let dx = -inset; dx <= inset && ok; dx++) {
              if (Math.abs(dx) + Math.abs(dy) <= inset) {
                const nc = c + dx, nr = r + dy;
                if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || !mask[nc + nr * cols]) ok = false;
              }
            }
          }
          if (!ok) continue;
        }
        positions.push({ col: c, row: r, layer });
      }
    }
  }
  return positions;
}

function generateMahjonggLevel(
  level: number,
  seed: number,
  opts: GenerateLevelOptions,
): { board: TileBoard; spec: LevelSpec } {
  const shape = levelShape(level);
  const dims = (opts.cols && opts.cols > 0 && opts.rows && opts.rows > 0)
    ? { cols: opts.cols, rows: opts.rows }
    : levelDims(level);
  const cols = Math.min(MAX_COLS, dims.cols);
  const rows = Math.min(MAX_ROWS, dims.rows);
  // Mahjongg feels best with more layers; use the level-based layer count but
  // at least 2 so the stacking/free-tile rule is meaningful.
  const numLayers = Math.max(2, levelLayers(level));
  const noAdjacent = !!opts.noAdjacentSame;

  const layout = buildMahjonggLayout(shape, cols, rows, numLayers);
  // Even number of tiles — drop the last position if odd.
  const usable = layout.length % 2 === 0 ? layout : layout.slice(0, layout.length - 1);
  if (usable.length < 2) {
    // Layout too small — fall back to a flat rectangle.
    const board = new TileBoard(cols, rows, 1, "mahjongg");
    return { board, spec: { level, shape, cols, rows, layers: 1, tileCount: 0, mode: "mahjongg" } };
  }

  const maxSeedAttempts = 20;
  const maxShuffleAttempts = 12;
  for (let seedAttempt = 0; seedAttempt < maxSeedAttempts; seedAttempt++) {
    const rng = makeRng(seed + seedAttempt * 0x9e3779b9);
    for (let shuffleAttempt = 0; shuffleAttempt < maxShuffleAttempts; shuffleAttempt++) {
      const board = new TileBoard(cols, rows, numLayers, "mahjongg");
      // Deal pairs: pick an element for each pair of positions.
      const posOrder = shuffleIndices(usable.length, rng);
      for (let i = 0; i + 1 < posOrder.length; i += 2) {
        const p1 = usable[posOrder[i]];
        const p2 = usable[posOrder[i + 1]];
        let element = Math.floor(rng() * NUM_ELEMENTS);
        if (noAdjacent) {
          const order = shuffleIndices(NUM_ELEMENTS, rng);
          let chosen = -1;
          for (const el of order) {
            if (!hasAdjacentSame(board, p1.col, p1.row, p1.layer, el) &&
                !hasAdjacentSame(board, p2.col, p2.row, p2.layer, el)) {
              chosen = el;
              break;
            }
          }
          element = chosen >= 0 ? chosen : element;
        }
        board.place(p1.col, p1.row, element, p1.layer);
        board.place(p2.col, p2.row, element, p2.layer);
      }

      // Verify solvability. The Mahjongg solver is path-free so we can afford
      // to check larger boards than the sandjongg verifier.
      if (isSolvable(board)) {
        let placed = 0;
        for (let l = 0; l < numLayers; l++) {
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (board.at(c, r, l) !== null) placed++;
            }
          }
        }
        return { board, spec: { level, shape, cols, rows, layers: numLayers, tileCount: placed, mode: "mahjongg" } };
      }
    }
  }

  // Fallback: a small flat rectangle dealt as pairs (guaranteed solvable for a
  // 2-tile board). Keep mode = mahjongg so the rules still apply.
  const fbCols = Math.min(cols, 8);
  const fbRows = Math.min(rows, 6);
  const fb = new TileBoard(fbCols, fbRows, 1, "mahjongg");
  fb.place(0, 0, 0, 0);
  fb.place(fbCols - 1, 0, 0, 0);
  return { board: fb, spec: { level, shape: "rectangle", cols: fbCols, rows: fbRows, layers: 1, tileCount: 2, mode: "mahjongg" } };
}

/**
 * Return index order that prioritises the most central cells (furthest from
 * the board edge). Interior cells are harder to connect once the board fills
 * up — they can't route around the border ring — so pairing them first (while
 * the board is still empty) avoids stranding them. Random tie-breaking (via
 * rng) preserves board variety across seeds. The jitter is < 1 so it only
 * reorders cells within the same centrality tier.
 */
function centralityOrder(
  cells: { col: number; row: number }[],
  cols: number,
  rows: number,
  rng: () => number,
): number[] {
  const keys = cells.map((cell, i) => ({
    i,
    key: -Math.min(cell.col, cell.row, cols - 1 - cell.col, rows - 1 - cell.row) + rng() * 0.99,
  }));
  keys.sort((a, b) => a.key - b.key);
  return keys.map((k) => k.i);
}
