// ============================================================================
// Sandjongg constants
// ============================================================================

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

// Max board dimensions (in tiles).
export const MAX_COLS = 24;
export const MAX_ROWS = 16;

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
 */
export function computeGridDims(canvasW: number, canvasH: number): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const cellPx = BASE_CELL_PX * dpr;

  let w = Math.floor(canvasW / cellPx);
  let h = Math.floor(canvasH / cellPx);

  w = Math.max(32, w);
  h = Math.max(32, h);

  if (w > MAX_GRID_W || h > MAX_GRID_H) {
    const scale = Math.min(MAX_GRID_W / w, MAX_GRID_H / h);
    w = Math.max(32, Math.floor(w * scale));
    h = Math.max(32, Math.floor(h * scale));
  }

  // Align to 4 so that skipMaskBytes (W*H) is a multiple of 4, keeping
  // the histogramOffset 4-byte aligned for Uint32Array views in SandStepPool.
  w = Math.floor(w / 4) * 4;
  h = Math.floor(h / 4) * 4;

  return { w, h };
}

/**
 * Board shape identifiers for procedural level generation.
 */
export type BoardShape = "rectangle" | "pyramid" | "cross" | "diamond" | "hourglass";

export const ALL_SHAPES: BoardShape[] = ["rectangle", "pyramid", "cross", "diamond", "hourglass"];
