import { describe, expect, it } from "bun:test";
import { computeHzbSize, nextPowerOf2 } from "./hzb";

describe("Hzb sizing", () => {
  it("nextPowerOf2 rounds up to powers of two", () => {
    expect(nextPowerOf2(1)).toBe(1);
    expect(nextPowerOf2(1920)).toBe(2048);
    expect(nextPowerOf2(1080)).toBe(2048);
  });

  it("computeHzbSize returns power-of-two dimensions and mip levels", () => {
    const size = computeHzbSize(1920, 1080);
    expect(size.width).toBe(2048);
    expect(size.height).toBe(2048);
    expect(size.levels).toBe(12);
  });
});
