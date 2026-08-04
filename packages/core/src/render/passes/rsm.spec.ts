import { describe, it, expect } from "bun:test";
import {
  DEFAULT_RSM_CONFIG,
  VPL_FLOATS,
  VPL_SIZE,
  packVPLsToBuffer,
  sampleRSMToVPLs,
  type VPLData,
} from "./gi-types";

describe("gi-types", () => {
  describe("DEFAULT_RSM_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_RSM_CONFIG.resolution).toBe(512);
      expect(DEFAULT_RSM_CONFIG.maxVPLs).toBe(512);
      expect(DEFAULT_RSM_CONFIG.intensity).toBe(1.0);
      expect(DEFAULT_RSM_CONFIG.enabled).toBe(false);
    });
  });

  describe("VPL constants", () => {
    it("VPL_FLOATS is 12", () => {
      expect(VPL_FLOATS).toBe(12);
    });

    it("VPL_SIZE is 48 bytes", () => {
      expect(VPL_SIZE).toBe(48);
    });
  });

  describe("packVPLsToBuffer", () => {
    it("packs VPLs into correct buffer size", () => {
      const vpls: VPLData[] = [
        {
          position: [1, 2, 3],
          color: [0.5, 0.25, 0.1],
          intensity: 2.0,
          range: 10,
          normal: [0, 1, 0],
        },
      ];
      const buf = packVPLsToBuffer(vpls, 16);
      expect(buf.length).toBe(16 * VPL_FLOATS);
    });

    it("packs position and range correctly", () => {
      const vpls: VPLData[] = [
        {
          position: [1, 2, 3],
          color: [1, 1, 1],
          intensity: 1,
          range: 15,
          normal: [0, 1, 0],
        },
      ];
      const buf = packVPLsToBuffer(vpls, 4);
      expect(buf[0]).toBe(1);
      expect(buf[1]).toBe(2);
      expect(buf[2]).toBe(3);
      expect(buf[3]).toBe(15); // range
    });

    it("packs color and intensity correctly", () => {
      const vpls: VPLData[] = [
        {
          position: [0, 0, 0],
          color: [0.5, 0.25, 0.1],
          intensity: 3.0,
          range: 10,
          normal: [0, 1, 0],
        },
      ];
      const buf = packVPLsToBuffer(vpls, 4);
      expect(buf[4]).toBeCloseTo(0.5);
      expect(buf[5]).toBeCloseTo(0.25);
      expect(buf[6]).toBeCloseTo(0.1);
      expect(buf[7]).toBe(3.0); // intensity
    });

    it("packs normal correctly", () => {
      const vpls: VPLData[] = [
        {
          position: [0, 0, 0],
          color: [1, 1, 1],
          intensity: 1,
          range: 10,
          normal: [0.5, 0.5, 0.707],
        },
      ];
      const buf = packVPLsToBuffer(vpls, 4);
      expect(buf[8]).toBeCloseTo(0.5);
      expect(buf[9]).toBeCloseTo(0.5);
      expect(buf[10]).toBeCloseTo(0.707);
    });

    it("handles empty VPL array", () => {
      const buf = packVPLsToBuffer([], 8);
      expect(buf.length).toBe(8 * VPL_FLOATS);
      // All zeros
      expect(buf[0]).toBe(0);
    });

    it("truncates to maxVPLs", () => {
      const vpls: VPLData[] = Array.from({ length: 10 }, (_, i) => ({
        position: [i, 0, 0],
        color: [1, 1, 1],
        intensity: 1,
        range: 5,
        normal: [0, 1, 0],
      }));
      const buf = packVPLsToBuffer(vpls, 4);
      expect(buf.length).toBe(4 * VPL_FLOATS);
      // Only first 4 VPLs packed
      expect(buf[0]).toBe(0);
      expect(buf[VPL_FLOATS]).toBe(1);
      expect(buf[2 * VPL_FLOATS]).toBe(2);
      expect(buf[3 * VPL_FLOATS]).toBe(3);
    });
  });

  describe("sampleRSMToVPLs", () => {
    it("returns empty array for all-sky depth", () => {
      const width = 4;
      const height = 4;
      const rsmDepth = new Float32Array(width * height).fill(1.0);
      const rsmAlbedo = new Float32Array(width * height * 4);
      const rsmNormal = new Float32Array(width * height * 4);
      const rsmFlux = new Float32Array(width * height * 3);
      const lightViewProj = new Float32Array(16);
      const invLightViewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

      const vpls = sampleRSMToVPLs(
        rsmDepth, rsmAlbedo, rsmNormal, rsmFlux,
        width, height, lightViewProj, invLightViewProj,
        16, 1.0, 0.15,
      );
      expect(vpls.length).toBe(0);
    });

    it("generates VPLs from valid depth pixels", () => {
      const width = 4;
      const height = 4;
      const rsmDepth = new Float32Array(width * height).fill(0.5);
      const rsmAlbedo = new Float32Array(width * height * 4).fill(0.8);
      const rsmNormal = new Float32Array(width * height * 4);
      // Set normals to up (0, 1, 0) encoded as 0.5, 1.0, 0.5
      for (let i = 0; i < width * height; i++) {
        rsmNormal[i * 4 + 1] = 1.0;
        rsmNormal[i * 4] = 0.5;
        rsmNormal[i * 4 + 2] = 0.5;
      }
      const rsmFlux = new Float32Array(width * height * 3).fill(1.0);
      const lightViewProj = new Float32Array(16);
      const invLightViewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

      const vpls = sampleRSMToVPLs(
        rsmDepth, rsmAlbedo, rsmNormal, rsmFlux,
        width, height, lightViewProj, invLightViewProj,
        4, 1.0, 0.15,
      );
      expect(vpls.length).toBeGreaterThan(0);
      expect(vpls.length).toBeLessThanOrEqual(4);
    });
  });
});
