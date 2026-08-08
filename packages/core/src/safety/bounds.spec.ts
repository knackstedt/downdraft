import {
  assertBounds,
  assertCount,
  assertFinite,
  assertPositive,
  clamp,
  clampSafeInt,
  MAX_VERTEX_COUNT,
  MAX_DECOMPRESS_SIZE,
} from "./bounds";

describe("safety/bounds", () => {
  describe("assertBounds", () => {
    it("passes when offset + length <= max", () => {
      expect(() => assertBounds("test", 0, 100, 200)).not.toThrow();
      expect(() => assertBounds("test", 100, 100, 200)).not.toThrow();
    });

    it("throws when offset + length > max", () => {
      expect(() => assertBounds("test", 100, 200, 200)).toThrow(RangeError);
      expect(() => assertBounds("test", 0, 201, 200)).toThrow(RangeError);
    });

    it("throws on negative offset", () => {
      expect(() => assertBounds("test", -1, 10, 200)).toThrow(RangeError);
    });

    it("throws on negative length", () => {
      expect(() => assertBounds("test", 0, -1, 200)).toThrow(RangeError);
    });
  });

  describe("assertCount", () => {
    it("passes for valid counts", () => {
      expect(() => assertCount("test", 0, 100)).not.toThrow();
      expect(() => assertCount("test", 50, 100)).not.toThrow();
      expect(() => assertCount("test", 100, 100)).not.toThrow();
    });

    it("throws for count exceeding max", () => {
      expect(() => assertCount("test", 101, 100)).toThrow(RangeError);
    });

    it("throws for negative count", () => {
      expect(() => assertCount("test", -1, 100)).toThrow(RangeError);
    });

    it("throws for non-integer count", () => {
      expect(() => assertCount("test", 1.5, 100)).toThrow(RangeError);
    });

    it("uses MAX_VERTEX_COUNT correctly", () => {
      expect(() => assertCount("vertices", MAX_VERTEX_COUNT, MAX_VERTEX_COUNT)).not.toThrow();
      expect(() => assertCount("vertices", MAX_VERTEX_COUNT + 1, MAX_VERTEX_COUNT)).toThrow();
    });
  });

  describe("assertFinite", () => {
    it("passes for finite numbers", () => {
      expect(() => assertFinite("test", 0)).not.toThrow();
      expect(() => assertFinite("test", -1.5)).not.toThrow();
      expect(() => assertFinite("test", 1e10)).not.toThrow();
    });

    it("throws for NaN", () => {
      expect(() => assertFinite("test", NaN)).toThrow(RangeError);
    });

    it("throws for Infinity", () => {
      expect(() => assertFinite("test", Infinity)).toThrow(RangeError);
      expect(() => assertFinite("test", -Infinity)).toThrow(RangeError);
    });
  });

  describe("assertPositive", () => {
    it("passes for positive finite numbers", () => {
      expect(() => assertPositive("test", 1)).not.toThrow();
      expect(() => assertPositive("test", 0.001)).not.toThrow();
    });

    it("throws for zero", () => {
      expect(() => assertPositive("test", 0)).toThrow(RangeError);
    });

    it("throws for negative", () => {
      expect(() => assertPositive("test", -1)).toThrow(RangeError);
    });

    it("throws for NaN", () => {
      expect(() => assertPositive("test", NaN)).toThrow(RangeError);
    });
  });

  describe("clamp", () => {
    it("clamps to range", () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });
  });

  describe("clampSafeInt", () => {
    it("clamps to [0, MAX_SAFE_INTEGER]", () => {
      expect(clampSafeInt(100)).toBe(100);
      expect(clampSafeInt(-1)).toBe(0);
      expect(clampSafeInt(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
      expect(clampSafeInt(Number.MAX_SAFE_INTEGER + 1)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("returns 0 for non-finite", () => {
      expect(clampSafeInt(NaN)).toBe(0);
      expect(clampSafeInt(Infinity)).toBe(0);
    });
  });

  describe("MAX_DECOMPRESS_SIZE", () => {
    it("is 512 MB", () => {
      expect(MAX_DECOMPRESS_SIZE).toBe(512 * 1024 * 1024);
    });
  });
});
