// ============================================================================
// Value noise — seeded 2D value noise with fBm for procedural generation
// ============================================================================
//
// Deterministic: same seed + same (x, y) always produces the same value.
// Uses hash-based lattice interpolation (simpler and faster than Perlin
// gradient noise, but less natural-looking). Used for procedural terrain generation.

/** Integer hash for (x, y, seed) — returns [0, 1). */
export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smoothstep interpolation: 3t² - 2t³ */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise via bilinear interpolation of hashed lattice values. Returns [0, 1). */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);

  const ux = smoothstep(fx);
  const uy = smoothstep(fy);

  return (
    a * (1 - ux) * (1 - uy) +
    b * ux * (1 - uy) +
    c * (1 - ux) * uy +
    d * ux * uy
  );
}

/** Multi-octave 2D value noise (fractal Brownian motion). Returns [0, 1). */
export function fbm2D(
  x: number,
  y: number,
  seed: number,
  octaves: number = 4,
  lacunarity: number = 2.0,
  gain: number = 0.5,
): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1.0;
  let maxAmplitude = 0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise2D(x * frequency, y * frequency, seed + i * 1013);
    maxAmplitude += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return value / maxAmplitude;
}
