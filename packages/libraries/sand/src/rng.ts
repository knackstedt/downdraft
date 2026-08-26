// ============================================================================
// SandRNG — fast xorshift32 PRNG for the sand simulation.
//
// Replaces Math.random() in hot loops. Math.random() is ~10x slower than
// xorshift32 in V8 because it draws from a cryptographic-quality entropy
// source. The sand simulation calls the PRNG dozens of times per active cell
// per frame, so this is a measurable speedup.
//
// State is per-SandWorld instance (not global) so multiple worlds don't
// correlate. reseed() enables deterministic test mode.
// ============================================================================

export class SandRNG {
  private state: number;

  constructor(seed: number = 0x9e3779b9) {
    // xorshift32 requires non-zero state; default to a golden-ratio constant
    this.state = (seed >>> 0) || 0x12345678;
  }

  /** Re-seed the PRNG (for deterministic test mode). */
  reseed(seed: number): void {
    this.state = (seed >>> 0) || 0x12345678;
  }

  /** Draw a u32 from the xorshift32 sequence. */
  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  /** Draw a float in [0, 1) — drop-in replacement for Math.random(). */
  random(): number {
    // 24-bit mantissa for a clean [0,1) range
    return (this.nextU32() >>> 8) * (1.0 / 16777216.0);
  }

  /** Random shade index 0-3 — drop-in replacement for randomShade(). */
  randomShade(): number {
    return this.nextU32() & 3;
  }

  /** Random integer in [0, max). */
  randomInt(max: number): number {
    return (this.nextU32() >>> 0) % max;
  }
}
