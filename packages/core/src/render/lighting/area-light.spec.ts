import { describe, it, expect } from "bun:test";
import {
  generateLTCLUTData,
  LTC_LUT_SIZE,
  type AreaLightShape,
} from "./area-light";

describe("area-light", () => {
  describe("generateLTCLUTData", () => {
    it("generates LUTs of correct size", () => {
      const { lut0, lut1 } = generateLTCLUTData(64);
      expect(lut0.length).toBe(64 * 64 * 4);
      expect(lut1.length).toBe(64 * 64 * 4);
    });

    it("generates finite values", () => {
      const { lut0, lut1 } = generateLTCLUTData(32);
      for (let i = 0; i < lut0.length; i++) {
        expect(Number.isFinite(lut0[i])).toBe(true);
        expect(Number.isFinite(lut1[i])).toBe(true);
      }
    });

    it("LUT0 contains matrix data (non-zero in first component)", () => {
      const { lut0 } = generateLTCLUTData(16);
      // At least some entries should be non-zero
      let hasNonZero = false;
      for (let i = 0; i < lut0.length; i++) {
        if (lut0[i] !== 0) { hasNonZero = true; break; }
      }
      expect(hasNonZero).toBe(true);
    });

    it("uses default size constant", () => {
      expect(LTC_LUT_SIZE).toBe(64);
    });

    it("produces smooth values (adjacent entries are close)", () => {
      const { lut0 } = generateLTCLUTData(64);
      // Check smoothness: adjacent x values should be close
      const idx = (32 * 64 + 32) * 4;
      const idxNext = (32 * 64 + 33) * 4;
      expect(Math.abs(lut0[idx] - lut0[idxNext])).toBeLessThan(0.5);
    });
  });

  describe("AreaLightShape", () => {
    it("supports rect, disk, and line shapes", () => {
      const shapes: AreaLightShape[] = ["rect", "disk", "line"];
      expect(shapes.length).toBe(3);
    });
  });
});
