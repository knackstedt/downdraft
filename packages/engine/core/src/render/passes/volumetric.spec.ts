import { describe, expect, it } from "bun:test";
import {
    DEFAULT_FROXEL_CONFIG,
    DEFAULT_VOLUMETRIC_FOG,
    computeExtinction,
    computeFroxelCount,
    computeFroxelGridBufferSize,
    computeFroxelLightIndexListSize,
    computeMiePhase,
    computeOpticalDepth,
    computeTransmittance,
    froxelDepthToSlice,
    froxelIndex3D,
    froxelSliceToFar,
    froxelSliceToNear,
    packVolumetricUniforms,
    screenPosToFroxelXY,
} from "./volumetric-types";

describe("volumetric-types", () => {
  describe("DEFAULT_FROXEL_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_FROXEL_CONFIG.froxelX).toBe(80);
      expect(DEFAULT_FROXEL_CONFIG.froxelY).toBe(45);
      expect(DEFAULT_FROXEL_CONFIG.froxelZ).toBe(64);
      expect(DEFAULT_FROXEL_CONFIG.maxLightsPerFroxel).toBe(8);
    });
  });

  describe("DEFAULT_VOLUMETRIC_FOG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_VOLUMETRIC_FOG.density).toBe(0.02);
      expect(DEFAULT_VOLUMETRIC_FOG.anisotropy).toBe(0.5);
      expect(DEFAULT_VOLUMETRIC_FOG.enabled).toBe(false);
    });
  });

  describe("computeFroxelCount", () => {
    it("computes total froxel count", () => {
      expect(computeFroxelCount(DEFAULT_FROXEL_CONFIG)).toBe(80 * 45 * 64);
    });
  });

  describe("buffer sizes", () => {
    it("computeFroxelGridBufferSize", () => {
      const size = computeFroxelGridBufferSize(DEFAULT_FROXEL_CONFIG);
      expect(size).toBe(80 * 45 * 64 * 8);
    });

    it("computeFroxelLightIndexListSize", () => {
      const size = computeFroxelLightIndexListSize(DEFAULT_FROXEL_CONFIG);
      expect(size).toBe(80 * 45 * 64 * 8);
    });
  });

  describe("froxelDepthToSlice", () => {
    it("returns 0 for depth at near plane", () => {
      expect(froxelDepthToSlice(0.5, 64, 0.5, 200)).toBe(0);
    });

    it("returns last slice for depth at far plane", () => {
      expect(froxelDepthToSlice(200, 64, 0.5, 200)).toBe(63);
    });

    it("returns increasing slices for increasing depth", () => {
      const s1 = froxelDepthToSlice(1, 64, 0.5, 200);
      const s2 = froxelDepthToSlice(10, 64, 0.5, 200);
      const s3 = froxelDepthToSlice(50, 64, 0.5, 200);
      expect(s1).toBeLessThan(s2);
      expect(s2).toBeLessThan(s3);
    });
  });

  describe("froxelSliceToNear / froxelSliceToFar", () => {
    it("returns near plane for slice 0", () => {
      expect(froxelSliceToNear(0, 64, 0.5, 200)).toBeCloseTo(0.5);
    });

    it("returns far plane for last slice", () => {
      expect(froxelSliceToFar(63, 64, 0.5, 200)).toBeCloseTo(200);
    });

    it("slice far > slice near", () => {
      const near = froxelSliceToNear(10, 64, 0.5, 200);
      const far = froxelSliceToFar(10, 64, 0.5, 200);
      expect(far).toBeGreaterThan(near);
    });
  });

  describe("screenPosToFroxelXY", () => {
    it("maps (0,0) to (0,0)", () => {
      const [fx, fy] = screenPosToFroxelXY(0, 0, 80, 45);
      expect(fx).toBe(0);
      expect(fy).toBe(0);
    });

    it("maps (1,1) to last froxel", () => {
      const [fx, fy] = screenPosToFroxelXY(1, 1, 80, 45);
      expect(fx).toBe(79);
      expect(fy).toBe(44);
    });
  });

  describe("froxelIndex3D", () => {
    it("computes linear index", () => {
      const idx = froxelIndex3D(5, 3, 2, 80, 45);
      expect(idx).toBe(5 + 3 * 80 + 2 * 80 * 45);
    });
  });

  describe("packVolumetricUniforms", () => {
    it("packs into 16-float array", () => {
      const packed = packVolumetricUniforms(DEFAULT_VOLUMETRIC_FOG, DEFAULT_FROXEL_CONFIG, 1920, 1080, 32);
      expect(packed.length).toBe(16);
      expect(packed[0]).toBe(80);
      expect(packed[1]).toBe(45);
      expect(packed[2]).toBe(64);
      expect(packed[3]).toBe(1920);
      expect(packed[4]).toBe(1080);
      expect(packed[8]).toBeCloseTo(0.02);
      expect(packed[9]).toBeCloseTo(0.5);
    });
  });

  describe("computeMiePhase", () => {
    it("returns positive value for forward scattering", () => {
      const phase = computeMiePhase(1.0, 0.5);
      expect(phase).toBeGreaterThan(0);
    });

    it("returns symmetric values for ±cosTheta when g=0", () => {
      const p1 = computeMiePhase(0.5, 0.0);
      const p2 = computeMiePhase(-0.5, 0.0);
      expect(p1).toBeCloseTo(p2);
    });

    it("isotropic g=0 gives 3/(8*pi)", () => {
      const phase = computeMiePhase(0.0, 0.0);
      expect(phase).toBeCloseTo(3.0 / (8.0 * Math.PI));
    });
  });

  describe("computeExtinction", () => {
    it("computes extinction as (scattering + absorption) * density", () => {
      const ext = computeExtinction(0.5, [0.8, 0.9, 1.0], [0.1, 0.1, 0.1]);
      expect(ext[0]).toBeCloseTo(0.5 * (0.8 + 0.1));
      expect(ext[1]).toBeCloseTo(0.5 * (0.9 + 0.1));
      expect(ext[2]).toBeCloseTo(0.5 * (1.0 + 0.1));
    });
  });

  describe("computeOpticalDepth", () => {
    it("computes optical depth as extinction * density * distance", () => {
      const od = computeOpticalDepth(0.5, [0.5, 0.5, 0.5], 10);
      expect(od[0]).toBeCloseTo(2.5);
      expect(od[1]).toBeCloseTo(2.5);
      expect(od[2]).toBeCloseTo(2.5);
    });
  });

  describe("computeTransmittance", () => {
    it("computes exp(-opticalDepth)", () => {
      const t = computeTransmittance([1, 1, 1]);
      expect(t[0]).toBeCloseTo(Math.exp(-1));
      expect(t[1]).toBeCloseTo(Math.exp(-1));
      expect(t[2]).toBeCloseTo(Math.exp(-1));
    });

    it("returns 1 for zero optical depth", () => {
      const t = computeTransmittance([0, 0, 0]);
      expect(t[0]).toBeCloseTo(1);
      expect(t[1]).toBeCloseTo(1);
      expect(t[2]).toBeCloseTo(1);
    });
  });
});
