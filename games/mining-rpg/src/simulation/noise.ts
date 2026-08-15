// ============================================================================
// Seeded 2D value noise + fBm for procedural terrain generation.
//
// Deterministic: same seed + same (x, y) always produces the same value.
// Uses a hash-based gradient noise (Perlin-like) with integer lattice hashing
// via a seeded PRNG. No external dependencies.
// ============================================================================

// --- Seeded PRNG (mulberry32) ---

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Hash function for gradient noise lattice points ---

function hash2(x: number, y: number, seed: number): number {
  // Integer hash with seed — returns [0, 1)
  let h = (x * 374761393 + y * 668265263 + seed * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// --- 2D Value noise with smooth interpolation ---

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2D(x: number, y: number, seed: number): number {
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

// --- Fractional Brownian Motion (fBm) — multi-octave noise ---

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

// --- Seeded hash for ore/lake placement decisions ---

/**
 * Deterministic hash for a (cx, cy, localX, localY, seed) tuple.
 * Returns [0, 1). Used for per-cell ore/lake probability checks.
 */
export function cellHash(
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  seed: number,
): number {
  const h =
    (cx * 73856093) ^
    (cy * 19349663) ^
    (lx * 83492791) ^
    (ly * 1299721) ^
    (seed * 362437);
  let v = h | 0;
  v = (v ^ (v >>> 13)) * 1274126177;
  v = v ^ (v >>> 16);
  return (v >>> 0) / 4294967296;
}

// --- World-coordinate noise (converts chunk-local to world coords) ---

/**
 * fBm noise at world cell coordinates (wx, wy).
 * Uses the chunk offset to produce continuous noise across chunk boundaries.
 */
export function worldFbm(
  wx: number,
  wy: number,
  seed: number,
  scale: number = 0.05,
  octaves: number = 4,
): number {
  return fbm2D(wx * scale, wy * scale, seed, octaves);
}

/**
 * Value noise at world cell coordinates (wx, wy).
 */
export function worldValueNoise(
  wx: number,
  wy: number,
  seed: number,
  scale: number = 0.1,
): number {
  return valueNoise2D(wx * scale, wy * scale, seed);
}
