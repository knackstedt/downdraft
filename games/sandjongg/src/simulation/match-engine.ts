// ============================================================================
// Match engine — validate matches, compute score + combo, produce crumble events.
// ============================================================================

import { BASE_MATCH_SCORE, COMBO_MULTIPLIER_STEP, COMBO_WINDOW_MS, PATH_BONUS_PER_SEGMENT, TILE_CELL_SIZE } from "../shared/constants";
import { elementToMaterial } from "../shared/elements";
import type { CrumbleEvent, MatchResult, Tile } from "../shared/types";
import { TileBoard } from "./board";
import { countTurns, findPath } from "./pathfinding";

export interface MatchEngineState {
  combo: number;
  lastMatchTime: number;
}

/**
 * Attempt a match between two tiles.
 * @param board The game board.
 * @param a First tile position.
 * @param b Second tile position.
 * @param state Mutable combo state (combo count + last match timestamp).
 * @param now Current timestamp (ms) for combo windowing.
 * @param boardOriginSandCol The sand-cell column of the board's top-left corner.
 * @param boardOriginSandRow The sand-cell row of the board's top-left corner.
 */
export function attemptMatch(
  board: TileBoard,
  aCol: number, aRow: number, aLayer: number,
  bCol: number, bRow: number, bLayer: number,
  state: MatchEngineState,
  now: number,
  boardOriginSandCol: number,
  boardOriginSandRow: number,
  tileSandW: number = TILE_CELL_SIZE,
  tileSandH: number = TILE_CELL_SIZE,
): MatchResult {
  const tileA = board.at(aCol, aRow, aLayer);
  const tileB = board.at(bCol, bRow, bLayer);

  if (tileA === null || tileB === null) {
    return { ok: false, path: null, score: 0, combo: state.combo, crumble: [], reason: "no-tile" };
  }
  if (tileA === tileB) {
    return { ok: false, path: null, score: 0, combo: state.combo, crumble: [], reason: "same-tile" };
  }
  if (tileA.element !== tileB.element) {
    return { ok: false, path: null, score: 0, combo: state.combo, crumble: [], reason: "different-element" };
  }
  // Tiles must be on the same layer for pathfinding. Checked before
  // selectability so a cross-layer attempt reports the more specific cause
  // (under the per-layer top-down lock a lower-layer tile would otherwise be
  // rejected as "not-selectable" first).
  if (aLayer !== bLayer) {
    return { ok: false, path: null, score: 0, combo: state.combo, crumble: [], reason: "different-layer" };
  }
  // Both tiles must be selectable (on the highest occupied layer).
  if (!board.isSelectable(aCol, aRow, aLayer) || !board.isSelectable(bCol, bRow, bLayer)) {
    return { ok: false, path: null, score: 0, combo: state.combo, crumble: [], reason: "not-selectable" };
  }

  const path = findPath(board, aCol, aRow, bCol, bRow, aLayer);
  if (path === null) {
    return { ok: false, path: null, score: 0, combo: state.combo, crumble: [], reason: "no-path" };
  }

  // Valid match! Compute combo.
  let combo = 1;
  if (now - state.lastMatchTime <= COMBO_WINDOW_MS && state.combo > 0) {
    combo = state.combo + 1;
  }
  state.combo = combo;
  state.lastMatchTime = now;

  // Compute score.
  const turns = countTurns(path.points);
  const segments = path.points.length - 1;
  const multiplier = 1 + (combo - 1) * COMBO_MULTIPLIER_STEP;
  const baseScore = BASE_MATCH_SCORE + turns * PATH_BONUS_PER_SEGMENT + segments * PATH_BONUS_PER_SEGMENT;
  const score = Math.round(baseScore * multiplier);

  // Produce crumble events.
  const crumble: CrumbleEvent[] = [
    makeCrumble(tileA, boardOriginSandCol, boardOriginSandRow, tileSandW, tileSandH),
    makeCrumble(tileB, boardOriginSandCol, boardOriginSandRow, tileSandW, tileSandH),
  ];

  // Remove tiles from the board.
  board.remove(aCol, aRow, aLayer);
  board.remove(bCol, bRow, bLayer);

  return { ok: true, path, score, combo, crumble };
}

function makeCrumble(
  tile: Tile,
  boardOriginSandCol: number,
  boardOriginSandRow: number,
  tileSandW: number,
  tileSandH: number,
): CrumbleEvent {
  return {
    tile,
    element: tile.element,
    sandMaterial: elementToMaterial(tile.element),
    sandCol: Math.round(boardOriginSandCol + tile.col * tileSandW),
    sandRow: Math.round(boardOriginSandRow + tile.row * tileSandH),
    sandW: Math.max(1, Math.round(tileSandW)),
    sandH: Math.max(1, Math.round(tileSandH)),
  };
}

/** Reset combo state (e.g. on new game or level change). */
export function resetComboState(): MatchEngineState {
  return { combo: 0, lastMatchTime: 0 };
}
