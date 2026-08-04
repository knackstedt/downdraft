import { describe, expect, it } from "bun:test";
import {
    DEFAULT_SPLAT_CONFIG,
    GAUSSIAN_SPLAT_SHADER,
    SPLAT_FLOATS_PER_VERTEX,
    packSplatToVertexBuffer,
    sortSplatsByDepth,
    type GaussianSplat,
} from "./gaussian-splat";

describe("gaussian-splat", () => {
  describe("DEFAULT_SPLAT_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_SPLAT_CONFIG.maxSplats).toBe(1_000_000);
      expect(DEFAULT_SPLAT_CONFIG.enableSorting).toBe(true);
      expect(DEFAULT_SPLAT_CONFIG.sphericalHarmonicsDegree).toBe(0);
    });
  });

  describe("SPLAT_FLOATS_PER_VERTEX", () => {
    it("is 14 (3 pos + 4 rot + 3 scale + 4 color)", () => {
      expect(SPLAT_FLOATS_PER_VERTEX).toBe(14);
    });
  });

  describe("sortSplatsByDepth", () => {
    it("sorts back-to-front", () => {
      const splat: GaussianSplat = {
        id: "test",
        position: new Float32Array([
          0, 0, 0,   // splat 0 at origin
          0, 0, 10,  // splat 1 far away
          0, 0, 5,   // splat 2 medium distance
        ]),
        scale: new Float32Array(9),
        rotation: new Float32Array(12),
        color: new Float32Array(12),
        count: 3,
      };

      const indices = sortSplatsByDepth(splat, [0, 0, 0]);
      // Back to front: splat 1 (depth 100) > splat 2 (depth 25) > splat 0 (depth 0)
      expect(indices[0]).toBe(1);
      expect(indices[1]).toBe(2);
      expect(indices[2]).toBe(0);
    });

    it("handles single splat", () => {
      const splat: GaussianSplat = {
        id: "test",
        position: new Float32Array([1, 2, 3]),
        scale: new Float32Array(3),
        rotation: new Float32Array(4),
        color: new Float32Array(4),
        count: 1,
      };
      const indices = sortSplatsByDepth(splat, [0, 0, 0]);
      expect(indices.length).toBe(1);
      expect(indices[0]).toBe(0);
    });

    it("handles empty splat", () => {
      const splat: GaussianSplat = {
        id: "test",
        position: new Float32Array(0),
        scale: new Float32Array(0),
        rotation: new Float32Array(0),
        color: new Float32Array(0),
        count: 0,
      };
      const indices = sortSplatsByDepth(splat, [0, 0, 0]);
      expect(indices.length).toBe(0);
    });
  });

  describe("packSplatToVertexBuffer", () => {
    it("packs splat data into vertex buffer", () => {
      const splat: GaussianSplat = {
        id: "test",
        position: new Float32Array([1, 2, 3, 4, 5, 6]),
        scale: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
        rotation: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
        color: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
        count: 2,
      };

      const buf = packSplatToVertexBuffer(splat);
      expect(buf.length).toBe(2 * SPLAT_FLOATS_PER_VERTEX);

      // First splat
      expect(buf[0]).toBe(1); // pos.x
      expect(buf[1]).toBe(2); // pos.y
      expect(buf[2]).toBe(3); // pos.z
      expect(buf[3]).toBe(1); // rot.w
      expect(buf[7]).toBeCloseTo(0.1); // scale.x
      expect(buf[10]).toBe(1); // color.r
      expect(buf[13]).toBe(1); // color.a

      // Second splat
      const offset = SPLAT_FLOATS_PER_VERTEX;
      expect(buf[offset]).toBe(4); // pos.x
      expect(buf[offset + 3]).toBe(0); // rot.w (second splat: [0,1,0,0])
      expect(buf[offset + 4]).toBe(1); // rot.x
      expect(buf[offset + 11]).toBeCloseTo(1); // color.g (second splat: [0,1,0,1])
    });

    it("handles empty splat", () => {
      const splat: GaussianSplat = {
        id: "test",
        position: new Float32Array(0),
        scale: new Float32Array(0),
        rotation: new Float32Array(0),
        color: new Float32Array(0),
        count: 0,
      };
      const buf = packSplatToVertexBuffer(splat);
      expect(buf.length).toBe(0);
    });
  });

  describe("GAUSSIAN_SPLAT_SHADER", () => {
    it("contains vertex and fragment shaders", () => {
      expect(GAUSSIAN_SPLAT_SHADER).toContain("vs_main");
      expect(GAUSSIAN_SPLAT_SHADER).toContain("fs_main");
      expect(GAUSSIAN_SPLAT_SHADER).toContain("quatRotate");
      expect(GAUSSIAN_SPLAT_SHADER).toContain("discard");
    });

    it("uses Gaussian falloff in fragment shader", () => {
      expect(GAUSSIAN_SPLAT_SHADER).toContain("exp(-d");
    });
  });
});
