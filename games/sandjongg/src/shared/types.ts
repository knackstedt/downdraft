// ============================================================================
// Sandjongg shared types
// ============================================================================

import type { BoardShape } from "./constants";

/** A tile on the board. */
export interface Tile {
  /** Unique id within the board (used for tracking). */
  id: number;
  /** Element index (0..11). */
  element: number;
  /** Column (0..cols-1). */
  col: number;
  /** Row (0..rows-1). */
  row: number;
  /** Layer (0 = bottom, increasing upward). */
  layer: number;
}

/** A point on the board grid. */
export interface BoardPoint {
  col: number;
  row: number;
  layer: number;
}

/** A connect path between two tiles (Shisen-Sho: ≤2 turns). */
export interface Path {
  /** Ordered list of waypoints (including start and end tile positions). */
  points: BoardPoint[];
  /** Number of turns (0, 1, or 2). */
  turns: number;
}

/** Result of a match attempt. */
export interface MatchResult {
  ok: boolean;
  /** The connect path if ok. */
  path: Path | null;
  /** Score awarded (0 if not ok). */
  score: number;
  /** Combo count after this match (1 = first in chain). */
  combo: number;
  /** Crumble events: one per matched tile. */
  crumble: CrumbleEvent[];
  /** Error reason if not ok. */
  reason?: string;
}

/** A tile crumbling into sand. */
export interface CrumbleEvent {
  tile: Tile;
  element: number;
  /** Sand material id to spawn. */
  sandMaterial: number;
  /** Top-left sand-cell col of the tile footprint. */
  sandCol: number;
  /** Top-left sand-cell row of the tile footprint. */
  sandRow: number;
}

/** Level specification. */
export interface LevelSpec {
  level: number;
  shape: BoardShape;
  cols: number;
  rows: number;
  /** Number of layers (1 = flat). */
  layers: number;
  /** Number of tiles placed. */
  tileCount: number;
}

/** Score state persisted in saves. */
export interface ScoreState {
  level: number;
  score: number;
  combo: number;
  highScore: number;
}

/** Serialized board for saves. */
export interface SerializedBoard {
  cols: number;
  rows: number;
  /** Number of layers (1 = flat board). */
  maxLayers?: number;
  /** Flat array: element id per tile slot, -1 = empty.
   *  Indexed as tiles[(col + row*cols) * maxLayers + layer]. */
  tiles: number[];
  nextId: number;
}

/** Hint result: a valid pair to match. */
export interface Hint {
  a: BoardPoint;
  b: BoardPoint;
  element: number;
}
