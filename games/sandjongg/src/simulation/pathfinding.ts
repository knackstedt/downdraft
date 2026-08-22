// ============================================================================
// Pathfinding — Shisen-Sho connect path finder.
//
// Two tiles connect iff a polyline of ≤2 turns (≤3 segments) exists between
// them where every intermediate cell is empty. The path may go around the
// outside of the board — off-board cells (the 1-cell border ring) count as
// empty. The start and end cells (the tiles themselves) are NOT checked for
// emptiness (they are the tiles being connected).
// ============================================================================

import type { BoardPoint, Path } from "../shared/types";
import { TileBoard } from "./board";

/** 4 cardinal directions. */
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/**
 * Check if a cell is "passable" for a path segment.
 * A cell is passable if it's in the 1-cell border ring around the board
 * (off-board, allows around-outside paths) or if it's an empty board cell.
 * The start and end tile positions are always passable (they are the tiles
 * being connected, so they're occupied by definition).
 *
 * The border ring is bounded to [-1, cols] × [-1, rows] to prevent the BFS
 * from exploring infinitely off-board.
 */
function isPassable(
  board: TileBoard,
  col: number,
  row: number,
  layer: number,
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
): boolean {
  // Bound the search to the 1-cell border ring: [-1, cols] × [-1, rows].
  if (col < -1 || col > board.cols || row < -1 || row > board.rows) return false;
  // Start and end are always passable.
  if (col === startCol && row === startRow) return true;
  if (col === endCol && row === endRow) return true;
  // Border ring (off-board but within bounds) is passable.
  if (col < 0 || col >= board.cols || row < 0 || row >= board.rows) return true;
  // On-board: must be empty on this layer.
  return board.isEmpty(col, row, layer);
}

/**
 * Find a connect path between two tiles using BFS over (position, direction, turns).
 * Returns the path if one exists with ≤2 turns, or null.
 *
 * Algorithm: BFS where state = (col, row, direction, turnsUsed). From each state,
 * we can either continue straight (same direction, no extra turn) or turn
 * (change direction, +1 turn). We explore all states with turns ≤ 2.
 * To get the actual path, we track parent pointers.
 */
export function findPath(
  board: TileBoard,
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  layer: number = 0,
): Path | null {
  // Same cell is not a valid match.
  if (startCol === endCol && startRow === endRow) return null;

  // BFS state: (col, row, direction, turns). direction = -1 means "not started yet".
  // We use a map keyed by "col,row,dir,turns" → parent state for path reconstruction.
  // The search space is small (board is ≤24×16, plus border ring), so this is fast.

  interface State {
    col: number;
    row: number;
    dir: number; // 0=up, 1=right, 2=down, 3=left, -1=start
    turns: number;
  }

  interface Parent {
    state: State;
    point: BoardPoint;
  }

  const visited = new Map<string, Parent>();
  const queue: State[] = [];

  // Start: can go in any of 4 directions with 0 turns.
  for (let d = 0; d < 4; d++) {
    const state: State = { col: startCol, row: startRow, dir: d, turns: 0 };
    const key = stateKey(state);
    visited.set(key, { state: { col: -1, row: -1, dir: -1, turns: -1 }, point: { col: startCol, row: startRow, layer } });
    queue.push(state);
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;

    // Move one step in the current direction.
    const nc = cur.col + DX[cur.dir];
    const nr = cur.row + DY[cur.dir];

    // Check if we've reached the end.
    if (nc === endCol && nr === endRow) {
      // Reconstruct path.
      const points: BoardPoint[] = [{ col: endCol, row: endRow, layer }];
      let traceKey = stateKey({ col: cur.col, row: cur.row, dir: cur.dir, turns: cur.turns });
      let traceState: State = cur;
      while (traceState.col !== startCol || traceState.row !== startRow || traceState.dir !== -1) {
        const parent = visited.get(traceKey);
        if (!parent) break;
        // Only add the point if it's different from the last (avoid duplicates at turns).
        const last = points[points.length - 1];
        if (last.col !== parent.point.col || last.row !== parent.point.row) {
          points.push(parent.point);
        }
        if (parent.state.dir === -1) break;
        traceState = parent.state;
        traceKey = stateKey(traceState);
      }
      // Add start point if not already there.
      const last = points[points.length - 1];
      if (last.col !== startCol || last.row !== startRow) {
        points.push({ col: startCol, row: startRow, layer });
      }
      points.reverse();
      return { points, turns: cur.turns };
    }

    // Check passability of the next cell.
    if (!isPassable(board, nc, nr, layer, startCol, startRow, endCol, endRow)) continue;

    // Continue straight (same direction, same turns).
    const straightState: State = { col: nc, row: nr, dir: cur.dir, turns: cur.turns };
    const straightKey = stateKey(straightState);
    if (!visited.has(straightKey)) {
      visited.set(straightKey, {
        state: cur,
        point: { col: nc, row: nr, layer },
      });
      queue.push(straightState);
    }

    // Turn (change direction, +1 turn) — only if turns < 2.
    if (cur.turns < 2) {
      for (let d = 0; d < 4; d++) {
        if (d === cur.dir) continue; // same direction = straight, already handled
        if (d === (cur.dir + 2) % 4) continue; // reverse direction = no progress
        const turnState: State = { col: nc, row: nr, dir: d, turns: cur.turns + 1 };
        const turnKey = stateKey(turnState);
        if (!visited.has(turnKey)) {
          visited.set(turnKey, {
            state: cur,
            point: { col: nc, row: nr, layer },
          });
          queue.push(turnState);
        }
      }
    }
  }

  return null;
}

function stateKey(s: { col: number; row: number; dir: number; turns: number }): string {
  return `${s.col},${s.row},${s.dir},${s.turns}`;
}

/**
 * Count the number of turns in a path (for scoring).
 */
export function countTurns(points: BoardPoint[]): number {
  if (points.length <= 2) return 0;
  let turns = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dx1 = cur.col - prev.col;
    const dy1 = cur.row - prev.row;
    const dx2 = next.col - cur.col;
    const dy2 = next.row - cur.row;
    if (dx1 !== dx2 || dy1 !== dy2) turns++;
  }
  return turns;
}
