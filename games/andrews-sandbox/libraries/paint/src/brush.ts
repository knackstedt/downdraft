// BrushStroke + rasterizeStroke — stub (Phase 5)
export interface BrushStroke {
  points: Array<{ u: number; v: number; pressure: number }>;
  color: string;
  size: number;
  hardness: number;
}

export function rasterizeStroke(stroke: BrushStroke, bitmap: Uint8ClampedArray, width: number, height: number): void {
  // TODO: Phase 5 — rasterize brush stroke into bitmap
}
