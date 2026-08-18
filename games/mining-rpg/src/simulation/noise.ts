// ============================================================================
// Mining RPG noise — game-specific wrappers over engine value noise.
//
// Generic helpers (fbm2D, valueNoise2D, hash2, smoothstep) have been promoted
// to @downdraft/core. This file keeps only the game-specific wrappers
// (cellHash, worldFbm, worldValueNoise) and re-exports mulberry32 + fbm2D
// for backward compatibility with existing importers.
// ============================================================================

import { fbm2D, mulberry32, valueNoise2D } from "@downdraft/core";
export { fbm2D, mulberry32 };

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
