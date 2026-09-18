// ============================================================================
// Fast trig — lookup-table-based sin/cos with linear interpolation
// ============================================================================
//
// 4096 entries over 2π — ~16-bit precision. Replaces expensive Math.sin/
// Math.cos calls in hot loops (e.g. water wave computation: ~458K calls/tick)
// with array lookups + lerp.

const TABLE_SIZE = 4096;
const SCALE = TABLE_SIZE / (Math.PI * 2);
const MASK = TABLE_SIZE - 1;

const SIN_TABLE: Float32Array = (() => {
  const t = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    t[i] = Math.sin((i / TABLE_SIZE) * Math.PI * 2);
  }
  return t;
})();

const COS_TABLE: Float32Array = (() => {
  const t = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    t[i] = Math.cos((i / TABLE_SIZE) * Math.PI * 2);
  }
  return t;
})();

/** Fast sin via lookup table with linear interpolation. ~16-bit precision. */
export function fastSin(x: number): number {
  const scaled = x * SCALE;
  const idx = (scaled | 0) & MASK;
  const frac = scaled - (scaled | 0);
  const a = SIN_TABLE[idx];
  const b = SIN_TABLE[(idx + 1) & MASK];
  return a + (b - a) * frac;
}

/** Fast cos via lookup table with linear interpolation. ~16-bit precision. */
export function fastCos(x: number): number {
  const scaled = x * SCALE;
  const idx = (scaled | 0) & MASK;
  const frac = scaled - (scaled | 0);
  const a = COS_TABLE[idx];
  const b = COS_TABLE[(idx + 1) & MASK];
  return a + (b - a) * frac;
}
