// Trig lookup table for water wave computation
// 4096 entries over 2π — linear interpolation, ~16-bit precision.
// Replaces ~458K Math.sin/Math.cos calls per tick with array lookups.

const SIN_TABLE_SIZE = 4096;
const SIN_TABLE: Float32Array = (() => {
  const t = new Float32Array(SIN_TABLE_SIZE);
  for (let i = 0; i < SIN_TABLE_SIZE; i++) {
    t[i] = Math.sin((i / SIN_TABLE_SIZE) * Math.PI * 2);
  }
  return t;
})();
const COS_TABLE: Float32Array = (() => {
  const t = new Float32Array(SIN_TABLE_SIZE);
  for (let i = 0; i < SIN_TABLE_SIZE; i++) {
    t[i] = Math.cos((i / SIN_TABLE_SIZE) * Math.PI * 2);
  }
  return t;
})();
const SIN_SCALE = SIN_TABLE_SIZE / (Math.PI * 2);
const SIN_MASK = SIN_TABLE_SIZE - 1;

export function fastSin(x: number): number {
  const idx = ((x * SIN_SCALE) | 0) & SIN_MASK;
  const frac = x * SIN_SCALE - (x * SIN_SCALE | 0);
  const a = SIN_TABLE[idx];
  const b = SIN_TABLE[(idx + 1) & SIN_MASK];
  return a + (b - a) * frac;
}

export function fastCos(x: number): number {
  const idx = ((x * SIN_SCALE) | 0) & SIN_MASK;
  const frac = x * SIN_SCALE - (x * SIN_SCALE | 0);
  const a = COS_TABLE[idx];
  const b = COS_TABLE[(idx + 1) & SIN_MASK];
  return a + (b - a) * frac;
}
