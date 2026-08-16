// Maximum grid dimensions — the SharedArrayBuffer is allocated at this size.
// The actual grid dimensions are computed from the canvas buffer dimensions
// and may be smaller than these maximums.
export const MAX_GRID_W = 512;
export const MAX_GRID_H = 512;
export const CELL_BYTES = 4;

// Cauldron wall thickness in cells
export const CAULDRON_WALL_THICKNESS = 3;

// Target canvas buffer pixels per grid cell. Higher = larger grains.
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

  let w = Math.floor(canvasW / cellPx);
  let h = Math.floor(canvasH / cellPx);

  w = Math.max(32, w);
  h = Math.max(32, h);

  if (w > MAX_GRID_W || h > MAX_GRID_H) {
    const scale = Math.min(MAX_GRID_W / w, MAX_GRID_H / h);
    w = Math.max(32, Math.floor(w * scale));
    h = Math.max(32, Math.floor(h * scale));
  }

  return { w, h };
}
