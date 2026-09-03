// ============================================================================
// computeGridDims — shared grid dimension calculator for sand/grid games
// ============================================================================
//
// Both falling-sand and sandjongg (and any future grid-based sand game) need
// to compute sand grid dimensions from canvas buffer pixels. The math is
// identical except for the base cell size, max grid bounds, and optional
// alignment. This shared utility eliminates the duplication.
//

export interface ComputeGridDimsOptions {
  /** Target canvas buffer pixels per grid cell (before DPR scaling). Higher = larger grains. */
  baseCellPx: number;
  /** Maximum grid width in cells (SAB is allocated at this size). */
  maxGridW: number;
  /** Maximum grid height in cells (SAB is allocated at this size). */
  maxGridH: number;
  /** Minimum grid dimension in cells. Default: 32. */
  minDim?: number;
  /**
   * Align grid dimensions to a multiple of this value (e.g. 4 for 4-byte
   * alignment of per-row buffers). Default: 1 (no alignment).
   */
  align?: number;
}

/**
 * Compute sand grid dimensions from canvas buffer dimensions (CSS × DPR).
 *
 * The grid is sized so that each cell covers `baseCellPx * dpr` canvas pixels,
 * keeping cell density consistent across HiDPI displays. If the computed size
 * exceeds `maxGridW`/`maxGridH`, both dimensions are scaled down proportionally
 * to preserve the aspect ratio (guarantees square cells).
 *
 * @param canvasW  Canvas backing-store width (CSS width × DPR).
 * @param canvasH  Canvas backing-store height (CSS height × DPR).
 * @param options  Configuration (base cell size, max grid, alignment).
 * @returns `{ w, h }` grid dimensions in cells.
 */
export function computeGridDims(
  canvasW: number,
  canvasH: number,
  options: ComputeGridDimsOptions,
): { w: number; h: number } {
  const { baseCellPx, maxGridW, maxGridH } = options;
  const minDim = options.minDim ?? 32;
  const align = options.align ?? 1;

  const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
  const cellPx = baseCellPx * dpr;

  let w = Math.floor(canvasW / cellPx);
  let h = Math.floor(canvasH / cellPx);

  // Clamp to minimums.
  w = Math.max(minDim, w);
  h = Math.max(minDim, h);

  // If either dimension exceeds the max, scale BOTH proportionally
  // to preserve aspect ratio (guarantees 1:1 cells).
  if (w > maxGridW || h > maxGridH) {
    const scale = Math.min(maxGridW / w, maxGridH / h);
    w = Math.max(minDim, Math.floor(w * scale));
    h = Math.max(minDim, Math.floor(h * scale));
  }

  // Align to a multiple of `align` (e.g. 4 for Uint32Array row alignment).
  if (align > 1) {
    w = Math.floor(w / align) * align;
    h = Math.floor(h / align) * align;
  }

  return { w, h };
}
