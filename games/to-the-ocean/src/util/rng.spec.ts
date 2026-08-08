import { describe, expect, it } from "bun:test";
import { createRng, mulberry32 } from "./rng";

describe("mulberry32 seeded RNG", () => {
  it("produces deterministic sequence for same seed", () => {
    const rng1 = mulberry32(12345);
    const rng2 = mulberry32(12345);
    const seq1: number[] = [];
    const seq2: number[] = [];
    for (let i = 0; i < 100; i++) {
      seq1.push(rng1());
      seq2.push(rng2());
    }
    expect(seq1).toEqual(seq2);
  });

  it("produces different sequences for different seeds", () => {
    const rng1 = mulberry32(12345);
    const rng2 = mulberry32(54321);
    const seq1: number[] = [];
    const seq2: number[] = [];
    for (let i = 0; i < 100; i++) {
      seq1.push(rng1());
      seq2.push(rng2());
    }
    expect(seq1).not.toEqual(seq2);
  });

  it("produces values in [0, 1)", () => {
    const rng = mulberry32(99999);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("createRng produces same result as mulberry32", () => {
    const rng1 = createRng(42);
    const rng2 = mulberry32(42);
    expect(rng1()).toBe(rng2());
  });
});
