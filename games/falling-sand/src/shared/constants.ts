import { computeGridDims as computeGridDimsShared } from "@downdraft/library-sand";

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
 *
 * Delegates to the shared `computeGridDims` from @downdraft/library-sand.
 */
export function computeGridDims(canvasW: number, canvasH: number): { w: number; h: number } {
  return computeGridDimsShared(canvasW, canvasH, {
    baseCellPx: BASE_CELL_PX,
    maxGridW: MAX_GRID_W,
    maxGridH: MAX_GRID_H,
  });
}
