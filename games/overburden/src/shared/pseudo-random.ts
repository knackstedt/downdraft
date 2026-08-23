// ============================================================================
// Overburden — deterministic pseudo-random (FNV-1a hash)
//
// Shared by the simulation systems (tree-sim, crop-growth, blockheads-worker)
// so all deterministic rolls use the same algorithm. The salt may be a string
// or a number; string salts are hashed char-by-char, number salts are XORed
// directly as an integer.
//
// Returns a float in [0, 1) derived from the raw 32-bit hash.
// ============================================================================

/** Compute the raw FNV-1a 32-bit hash for (x, y, tick, salt). */
export function hashFnv1a(x: number, y: number, tick: number, salt: string | number): number {
  let h = 2166136261 ^ x;
  h = Math.imul(h, 16777619) ^ y;
  h = Math.imul(h, 16777619) ^ tick;
  if (typeof salt === "string") {
    for (let i = 0; i < salt.length; i++) {
      h = Math.imul(h, 16777619) ^ salt.charCodeAt(i);
    }
  } else {
    h = Math.imul(h, 16777619) ^ salt;
  }
  return h >>> 0;
}

/** Deterministic roll in [0, 1) from (x, y, tick, salt). */
export function pseudoRandom(x: number, y: number, tick: number, salt: string | number): number {
  return (hashFnv1a(x, y, tick, salt) % 100000) / 100000;
}
