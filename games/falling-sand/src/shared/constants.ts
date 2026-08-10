// Maximum grid dimensions — the SharedArrayBuffer is allocated at this size.
// The actual grid dimensions are computed from the viewport aspect ratio
// and may be smaller than these maximums.
export const MAX_GRID_W = 512;
export const MAX_GRID_H = 512;
export const CELL_BYTES = 4;
export const MAX_MAGNETS = 8;

// Target CSS pixels per grid cell at 1x DPR. On higher-DPI displays the
// cell size scales up so cells remain roughly the same physical size.
//   1080p (DPR 1): 2 CSS px per cell → 960×540 grid on 1920×1080
//   4K     (DPR 2): 4 CSS px per cell → 960×540 grid on 3840×2160
const BASE_CELL_SIZE = 2;

/** Compute grid dimensions from viewport CSS pixels and device pixel ratio. */
export function computeGridDims(cssW: number, cssH: number): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const cellSize = BASE_CELL_SIZE * dpr;
  const w = Math.max(32, Math.min(MAX_GRID_W, Math.floor(cssW / cellSize)));
  const h = Math.max(32, Math.min(MAX_GRID_H, Math.floor(cssH / cellSize)));
  return { w, h };
}
