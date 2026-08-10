// Maximum grid dimensions — the SharedArrayBuffer is allocated at this size.
// The actual grid dimensions are computed from the canvas buffer dimensions
// and may be smaller than these maximums.
export const MAX_GRID_W = 512;
export const MAX_GRID_H = 512;
export const CELL_BYTES = 4;

// Target canvas buffer pixels per grid cell. Higher = larger grains.
//   1080p (DPR 1): cellPx = 2 → cells are 2×2 buffer pixels
//   4K     (DPR 2): cellPx = 4 → cells are 4×4 buffer pixels
const BASE_CELL_PX = 2;

/**
 * Compute grid dimensions from the **canvas buffer dimensions** (not CSS pixels).
 * Uses a single `cellPx` value for both axes so cells are always square (1:1).
 * If the computed size exceeds MAX_GRID_W/H, both dimensions are scaled down
 * proportionally to preserve the aspect ratio.
 */
export function computeGridDims(canvasW: number, canvasH: number): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const cellPx = BASE_CELL_PX * dpr;

  // Target: one cell per cellPx canvas pixels, same for both axes
  let w = Math.floor(canvasW / cellPx);
  let h = Math.floor(canvasH / cellPx);

  // Clamp to minimums
  w = Math.max(32, w);
  h = Math.max(32, h);

  // If either dimension exceeds the max, scale BOTH proportionally
  // to preserve aspect ratio (guarantees 1:1 cells).
  if (w > MAX_GRID_W || h > MAX_GRID_H) {
    const scale = Math.min(MAX_GRID_W / w, MAX_GRID_H / h);
    w = Math.max(32, Math.floor(w * scale));
    h = Math.max(32, Math.floor(h * scale));
  }

  return { w, h };
}
