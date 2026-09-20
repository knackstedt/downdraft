import { describe, expect, it } from "bun:test";
import {
    CLUSTER_GRID_ENTRY_SIZE,
    DEFAULT_CLUSTER_CONFIG,
    LIGHT_DATA_FLOATS,
    LIGHT_DATA_SIZE,
    clusterIndex3D,
    computeClusterCount,
    computeClusterGridBufferSize,
    computeLightDataBufferSize,
    computeLightIndexListSize,
    depthSliceToNear,
    packClusterUniforms,
    packLightToStorageBuffer,
    screenPosToClusterXY,
    worldDepthToSlice,
} from "./cluster-types";

describe("cluster-types", () => {
  describe("DEFAULT_CLUSTER_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_CLUSTER_CONFIG.clusterX).toBe(16);
      expect(DEFAULT_CLUSTER_CONFIG.clusterY).toBe(8);
      expect(DEFAULT_CLUSTER_CONFIG.clusterZ).toBe(24);
      expect(DEFAULT_CLUSTER_CONFIG.maxLightsPerCluster).toBe(128);
      expect(DEFAULT_CLUSTER_CONFIG.maxTotalLights).toBe(1024);
    });
  });

  describe("computeClusterCount", () => {
    it("computes total cluster count", () => {
      expect(computeClusterCount(DEFAULT_CLUSTER_CONFIG)).toBe(16 * 8 * 24);
      expect(computeClusterCount(DEFAULT_CLUSTER_CONFIG)).toBe(3072);
    });

    it("handles custom configs", () => {
      expect(computeClusterCount({ ...DEFAULT_CLUSTER_CONFIG, clusterX: 32, clusterY: 16, clusterZ: 48 })).toBe(32 * 16 * 48);
    });
  });

  describe("buffer size computations", () => {
    it("computeLightDataBufferSize", () => {
      const size = computeLightDataBufferSize(DEFAULT_CLUSTER_CONFIG);
      expect(size).toBe(1024 * LIGHT_DATA_SIZE);
      expect(size).toBe(1024 * 64);
    });

    it("computeClusterGridBufferSize", () => {
      const size = computeClusterGridBufferSize(DEFAULT_CLUSTER_CONFIG);
      expect(size).toBe(3072 * CLUSTER_GRID_ENTRY_SIZE);
      expect(size).toBe(3072 * 8);
    });

    it("computeLightIndexListSize", () => {
      const size = computeLightIndexListSize(DEFAULT_CLUSTER_CONFIG);
      expect(size).toBe(3072 * 128);
    });
  });

  describe("clusterIndex3D", () => {
    it("computes linear index from 3D coords", () => {
      const idx = clusterIndex3D(2, 3, 4, 16, 8);
      expect(idx).toBe(2 + 3 * 16 + 4 * 16 * 8);
      expect(idx).toBe(562);
    });

    it("wraps correctly at boundaries", () => {
      const idx = clusterIndex3D(0, 0, 0, 16, 8);
      expect(idx).toBe(0);
    });
  });

  describe("depthSliceToNear", () => {
    it("returns near plane for slice 0", () => {
      expect(depthSliceToNear(0, 24, 0.1, 1000, 3)).toBeCloseTo(0.1);
    });

    it("returns far plane for last slice", () => {
      expect(depthSliceToNear(24, 24, 0.1, 1000, 3)).toBeCloseTo(1000);
    });

    it("produces exponential distribution", () => {
      const mid = depthSliceToNear(12, 24, 0.1, 1000, 3);
      // At 50% through, exponential should give sqrt(0.1 * 1000) ≈ 10
      expect(mid).toBeCloseTo(Math.sqrt(0.1 * 1000), 1);
    });
  });

  describe("worldDepthToSlice", () => {
    it("returns 0 for depth at near plane", () => {
      expect(worldDepthToSlice(0.1, 24, 0.1, 1000, 3)).toBe(0);
    });

    it("returns last slice for depth at far plane", () => {
      expect(worldDepthToSlice(1000, 24, 0.1, 1000, 3)).toBe(23);
    });

    it("returns increasing slices for increasing depth", () => {
      const s1 = worldDepthToSlice(1, 24, 0.1, 1000, 3);
      const s2 = worldDepthToSlice(10, 24, 0.1, 1000, 3);
      const s3 = worldDepthToSlice(100, 24, 0.1, 1000, 3);
      expect(s1).toBeLessThan(s2);
      expect(s2).toBeLessThan(s3);
    });

    it("clamps to valid range", () => {
      expect(worldDepthToSlice(0.05, 24, 0.1, 1000, 3)).toBe(0);
      expect(worldDepthToSlice(2000, 24, 0.1, 1000, 3)).toBe(23);
    });
  });

  describe("screenPosToClusterXY", () => {
    it("maps (0,0) to cluster (0,0)", () => {
      const [cx, cy] = screenPosToClusterXY(0, 0, 16, 8);
      expect(cx).toBe(0);
      expect(cy).toBe(0);
    });

    it("maps (1,1) to last cluster", () => {
      const [cx, cy] = screenPosToClusterXY(1, 1, 16, 8);
      expect(cx).toBe(15);
      expect(cy).toBe(7);
    });

    it("maps center to middle cluster", () => {
      const [cx, cy] = screenPosToClusterXY(0.5, 0.5, 16, 8);
      expect(cx).toBe(8);
      expect(cy).toBe(4);
    });

    it("clamps to valid range", () => {
      const [cx, cy] = screenPosToClusterXY(1.5, -0.5, 16, 8);
      expect(cx).toBe(15);
      expect(cy).toBe(-4); // Math.floor(-0.5 * 8) = -4
    });
  });

  describe("packClusterUniforms", () => {
    it("packs into correct float array", () => {
      const packed = packClusterUniforms(DEFAULT_CLUSTER_CONFIG, 1920, 1080, 64);
      expect(packed.length).toBe(8);
      expect(packed[0]).toBe(16);
      expect(packed[1]).toBe(8);
      expect(packed[2]).toBe(24);
      expect(packed[3]).toBe(1920);
      expect(packed[4]).toBe(1080);
      expect(packed[5]).toBeCloseTo(0.1);
      expect(packed[6]).toBe(1000);
      expect(packed[7]).toBe(64);
    });
  });

  describe("packLightToStorageBuffer", () => {
    it("packs a point light correctly", () => {
      const packed = packLightToStorageBuffer({
        position: new Float32Array([1, 2, 3]),
        color: new Float32Array([1, 0.5, 0.25]),
        intensity: 5,
        range: 20,
        type: 0,
      });
      expect(packed.length).toBe(LIGHT_DATA_FLOATS);
      expect(packed[0]).toBe(1);
      expect(packed[1]).toBe(2);
      expect(packed[2]).toBe(3);
      expect(packed[3]).toBe(20); // range in .w
      expect(packed[4]).toBe(1);
      expect(packed[5]).toBeCloseTo(0.5);
      expect(packed[6]).toBeCloseTo(0.25);
      expect(packed[7]).toBe(5); // intensity in .w
      expect(packed[11]).toBe(0); // type = point
    });

    it("packs a spot light with cone angles", () => {
      const packed = packLightToStorageBuffer({
        position: new Float32Array([0, 5, 0]),
        color: new Float32Array([1, 1, 1]),
        intensity: 3,
        range: 30,
        direction: new Float32Array([0, -1, 0]),
        type: 1,
        innerConeCos: 0.8,
        outerConeCos: 0.6,
      });
      expect(packed[8]).toBe(0);
      expect(packed[9]).toBe(-1);
      expect(packed[10]).toBe(0);
      expect(packed[11]).toBe(1); // type = spot
      expect(packed[12]).toBeCloseTo(0.8); // innerConeCos
      expect(packed[13]).toBeCloseTo(0.6); // outerConeCos
    });

    it("packs a rect area light with dimensions", () => {
      const packed = packLightToStorageBuffer({
        position: new Float32Array([2, 3, 4]),
        color: new Float32Array([0.8, 0.8, 1]),
        intensity: 2,
        range: 15,
        direction: new Float32Array([0, 0, -1]),
        type: 2,
        width: 4,
        height: 2,
      });
      expect(packed[11]).toBe(2); // type = rect-area
      expect(packed[14]).toBe(4); // width
      expect(packed[15]).toBe(2); // height
    });
  });
});
