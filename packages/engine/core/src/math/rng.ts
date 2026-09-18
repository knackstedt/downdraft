// ============================================================================
// Seeded PRNG — mulberry32, a fast 32-bit seeded pseudo-random generator.
// ============================================================================
//
// Used by procedural generation (Perlin noise, terrain, ore veins) and any
// system that needs deterministic randomness from a seed. Games should import
// from here instead of redefining mulberry32 locally.

export type RngFn = () => number;

/**
 * Create a seeded PRNG function (mulberry32 algorithm).
 * Returns a function that produces floats in [0, 1) from a 32-bit state.
 */
export function mulberry32(seed: number): RngFn {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Alias for mulberry32 — create a seeded RNG function. */
export function createRng(seed: number): RngFn {
  return mulberry32(seed);
}
