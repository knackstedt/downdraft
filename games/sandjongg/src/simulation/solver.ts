// ============================================================================
// Solver — check if a board is solvable (can be fully cleared).
//
// Uses a randomized greedy approach with backtracking: at each step, pick a
// random valid pair, remove it, and recurse. If stuck, backtrack and try a
// different pair. Randomization helps avoid worst-case backtracking patterns.
// Bounded by a total attempt limit to avoid pathological cases.
//
// Multi-layer aware: only selectable tiles (top of stack) can be matched,
// and pathfinding operates within the same layer.
// ============================================================================

import { MAX_LAYERS } from "../shared/constants";
import type { Hint, Tile } from "../shared/types";
import { TileBoard } from "./board";
import { findPath } from "./pathfinding";

const MAX_ATTEMPTS = 100_000;

/**
 * Check if the board can be fully cleared by a sequence of valid matches.
 * Returns true if solvable, false if not (or if the search exceeds the attempt limit).
 */
export function isSolvable(board: TileBoard): boolean {
  if (board.isCleared()) return true;
  let seed = 0x12345678;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const ctx = { attempts: 0, rng };
  const snapshot = snapshotBoard(board);
  const result = solveGreedy(board, ctx);
  restoreBoard(board, snapshot);
  return result;
}

interface SolveCtx {
  attempts: number;
  rng: () => number;
}

function solveGreedy(board: TileBoard, ctx: SolveCtx): boolean {
  if (ctx.attempts > MAX_ATTEMPTS) return false;
  if (board.remainingCount() === 0) return true;

  const pairs = findAllPairs(board);
  if (pairs.length === 0) return false;

  shuffleInPlace(pairs, ctx.rng);

  for (const [a, b] of pairs) {
    ctx.attempts++;
    if (ctx.attempts > MAX_ATTEMPTS) return false;

    const savedA = { col: a.col, row: a.row, layer: a.layer, element: a.element };
    const savedB = { col: b.col, row: b.row, layer: b.layer, element: b.element };
    board.remove(a.col, a.row, a.layer);
    board.remove(b.col, b.row, b.layer);

    if (solveGreedy(board, ctx)) {
      board.place(savedA.col, savedA.row, savedA.element, savedA.layer);
      board.place(savedB.col, savedB.row, savedB.element, savedB.layer);
      return true;
    }

    board.place(savedA.col, savedA.row, savedA.element, savedA.layer);
    board.place(savedB.col, savedB.row, savedB.element, savedB.layer);
  }

  return false;
}

/** Find all valid matchable pairs among selectable tiles. */
function findAllPairs(board: TileBoard): [Tile, Tile][] {
  // Only selectable tiles can be matched.
  const tiles = board.selectableTiles();
  const byElement = new Map<number, Tile[]>();
  for (const t of tiles) {
    let group = byElement.get(t.element);
    if (!group) {
      group = [];
      byElement.set(t.element, group);
    }
    group.push(t);
  }

  const pairs: [Tile, Tile][] = [];
  for (const group of byElement.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        // Only same-layer tiles can be matched (pathfinding is per-layer).
        if (group[i].layer !== group[j].layer) continue;
        const path = findPath(board, group[i].col, group[i].row, group[j].col, group[j].row, group[i].layer);
        if (path !== null) {
          pairs.push([group[i], group[j]]);
        }
      }
    }
  }
  return pairs;
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function snapshotBoard(board: TileBoard): number[] {
  const snap = new Array(board.tiles.length);
  for (let i = 0; i < board.tiles.length; i++) {
    snap[i] = board.tiles[i] !== null ? board.tiles[i]!.element : -1;
  }
  return snap;
}

function restoreBoard(board: TileBoard, snap: number[]): void {
  for (let i = 0; i < snap.length; i++) {
    if (snap[i] >= 0) {
      const layer = i % MAX_LAYERS;
      const posIdx = Math.floor(i / MAX_LAYERS);
      const col = posIdx % board.cols;
      const row = Math.floor(posIdx / board.cols);
      if (board.tiles[i] === null) {
        board.tiles[i] = { id: board["nextId"]++, element: snap[i], col, row, layer };
      }
    } else {
      board.tiles[i] = null;
    }
  }
}

/**
 * Find a valid pair to match (for the Hint button).
 * Returns the first valid pair found, or null if none exists.
 */
export function findHint(board: TileBoard): Hint | null {
  const tiles = board.selectableTiles();
  const byElement = new Map<number, Tile[]>();
  for (const t of tiles) {
    let group = byElement.get(t.element);
    if (!group) {
      group = [];
      byElement.set(t.element, group);
    }
    group.push(t);
  }

  for (const group of byElement.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].layer !== group[j].layer) continue;
        const path = findPath(board, group[i].col, group[i].row, group[j].col, group[j].row, group[i].layer);
        if (path !== null) {
          return {
            a: { col: group[i].col, row: group[i].row, layer: group[i].layer },
            b: { col: group[j].col, row: group[j].row, layer: group[j].layer },
            element: group[i].element,
          };
        }
      }
    }
  }
  return null;
}

/**
 * Check if any valid match exists on the board.
 */
export function hasAnyMatch(board: TileBoard): boolean {
  return findHint(board) !== null;
}
