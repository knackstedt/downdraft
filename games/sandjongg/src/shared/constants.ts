// ============================================================================
// Sandjongg constants
// ============================================================================

import { computeGridDims as computeGridDimsShared } from "@downdraft/library-sand";

// Maximum sand grid dimensions — the SharedArrayBuffer is allocated at this size.
// Must be large enough for the board (MAX_COLS * TILE_CELL_SIZE) + walls + pit.
// 24 cols * 20 cells = 480 + 4 walls = 484 → round up to 512.
export const MAX_GRID_W = 512;
export const MAX_GRID_H = 512;

// Each tile occupies a TILE_CELL_SIZE × TILE_CELL_SIZE block of sand cells.
// When a tile crumbles, sand is painted across this footprint.
// Sized so the sand footprint roughly matches the on-screen tile size
// (BASE_CELL_PX=3, tilePx≈64 → 64/3 ≈ 22 cells per tile).
export const TILE_CELL_SIZE = 20;

// Rows of sand cells reserved below the board for the falling-sand pit.
export const PIT_ROWS = 80;

// Thickness of the pit walls (in sand cells).
export const WALL_THICKNESS = 2;

// Max board dimensions (in tiles). Raised to support custom large boards
// (the cols/rows sliders in the settings panel). The sand-grid footprint is
// synced from the renderer's visual layout, so larger boards pan within the
// viewport rather than overflowing the sand grid.
export const MAX_COLS = 48;
export const MAX_ROWS = 32;

// Maximum number of tile layers (stacked tiles in Mahjongg style).
export const MAX_LAYERS = 5;

// Max total tiles on the board (for SAB board-region sizing).
export const MAX_TILES = MAX_COLS * MAX_ROWS * MAX_LAYERS;

// Combo: consecutive matches within this window (ms) increment the combo.
export const COMBO_WINDOW_MS = 4000;

// Score constants.
export const BASE_MATCH_SCORE = 100;
export const PATH_BONUS_PER_SEGMENT = 10;
export const COMBO_MULTIPLIER_STEP = 0.5; // combo N → multiplier = 1 + (N-1)*step

// Target canvas buffer pixels per grid cell. Higher = larger grains.
const BASE_CELL_PX = 3;

/**
 * Compute sand grid dimensions from the canvas buffer dimensions.
 * The grid is sized so that the board + pit fit within MAX_GRID_W/H.
 * Delegates to the shared `computeGridDims` from @downdraft/library-sand.
 */
export function computeGridDims(canvasW: number, canvasH: number): { w: number; h: number } {
  return computeGridDimsShared(canvasW, canvasH, {
    baseCellPx: BASE_CELL_PX,
    maxGridW: MAX_GRID_W,
    maxGridH: MAX_GRID_H,
    // Align to 4 so that skipMaskBytes (W*H) is a multiple of 4, keeping
    // the histogramOffset 4-byte aligned for Uint32Array views in SandStepPool.
    align: 4,
  });
}

/**
 * Board shape identifiers for procedural level generation.
 */
export type BoardShape = "rectangle" | "pyramid" | "cross" | "diamond" | "hourglass";

export const ALL_SHAPES: BoardShape[] = ["rectangle", "pyramid", "cross", "diamond", "hourglass"];
