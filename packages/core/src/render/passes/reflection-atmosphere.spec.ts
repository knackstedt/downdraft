import { describe, it, expect } from "bun:test";
import {
  DEFAULT_REFLECTION_PROBE_CONFIG,
  ReflectionProbeManager,
} from "./reflection-probe.ts";
import {
  DEFAULT_ATMOSPHERE_CONFIG,
  computeAtmosphereDensity,
  computeRayleighScattering,
  computeMieScattering,
  computeSkyColor,
  ATMOSPHERE_SHADER_CHUNK,
} from "./atmosphere.ts";

describe("reflection-probe", () => {
  describe("DEFAULT_REFLECTION_PROBE_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_REFLECTION_PROBE_CONFIG.maxProbes).toBe(8);
      expect(DEFAULT_REFLECTION_PROBE_CONFIG.resolution).toBe(256);
      expect(DEFAULT_REFLECTION_PROBE_CONFIG.refreshRate).toBe(30);
    });
  });

  describe("ReflectionProbeManager (without device)", () => {
    it("creates and retrieves probes", () => {
      const mgr = new ReflectionProbeManager();
      const probe = mgr.addProbe("p1", [0, 0, 0], [-10, -10, -10], [10, 10, 10]);
      expect(probe).not.toBeNull();
      expect(probe!.id).toBe("p1");
      expect(mgr.getProbe("p1")).not.toBeNull();
    });

    it("returns null when max probes exceeded", () => {
      const mgr = new ReflectionProbeManager({ maxProbes: 2 });
      mgr.addProbe("p1", [0, 0, 0], [-1, -1, -1], [1, 1, 1]);
      mgr.addProbe("p2", [0, 0, 0], [-1, -1, -1], [1, 1, 1]);
      const p3 = mgr.addProbe("p3", [0, 0, 0], [-1, -1, -1], [1, 1, 1]);
      expect(p3).toBeNull();
    });

    it("finds probes containing a position", () => {
      const mgr = new ReflectionProbeManager();
      mgr.addProbe("p1", [0, 0, 0], [-10, -10, -10], [10, 10, 10], 1);
      mgr.addProbe("p2", [20, 0, 0], [15, -10, -10], [25, 10, 10], 2);
      const inside = mgr.findProbesForPosition([5, 0, 0]);
      expect(inside.length).toBe(1);
      expect(inside[0].id).toBe("p1");
    });

    it("computes probe weights", () => {
      const mgr = new ReflectionProbeManager();
      mgr.addProbe("p1", [0, 0, 0], [-10, -10, -10], [10, 10, 10], 1);
      mgr.addProbe("p2", [0, 0, 0], [-10, -10, -10], [10, 10, 10], 1);
      const weights = mgr.computeProbeWeights([0, 0, 0]);
      expect(weights.length).toBe(2);
      const total = weights.reduce((s, w) => s + w.weight, 0);
      expect(total).toBeCloseTo(1.0);
    });

    it("removes probes", () => {
      const mgr = new ReflectionProbeManager();
      mgr.addProbe("p1", [0, 0, 0], [-1, -1, -1], [1, 1, 1]);
      mgr.removeProbe("p1");
      expect(mgr.getProbe("p1")).toBeNull();
    });

    it("returns empty array for position outside all probes", () => {
      const mgr = new ReflectionProbeManager();
      mgr.addProbe("p1", [0, 0, 0], [-10, -10, -10], [10, 10, 10]);
      const inside = mgr.findProbesForPosition([100, 100, 100]);
      expect(inside.length).toBe(0);
    });
  });
});

describe("atmosphere", () => {
  describe("DEFAULT_ATMOSPHERE_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_ATMOSPHERE_CONFIG.planetRadius).toBe(6371e3);
      expect(DEFAULT_ATMOSPHERE_CONFIG.atmosphereRadius).toBe(6471e3);
      expect(DEFAULT_ATMOSPHERE_CONFIG.samples).toBe(16);
    });
  });

  describe("computeAtmosphereDensity", () => {
    it("returns 1 at planet surface", () => {
      const d = computeAtmosphereDensity(6371e3, 6371e3, 6471e3);
      expect(d).toBe(1.0);
    });

    it("returns 0 above atmosphere", () => {
      const d = computeAtmosphereDensity(6500e3, 6371e3, 6471e3);
      expect(d).toBe(0.0);
    });

    it("returns decreasing density with altitude", () => {
      const d1 = computeAtmosphereDensity(6371e3, 6371e3, 6471e3);
      const d2 = computeAtmosphereDensity(6400e3, 6371e3, 6471e3);
      const d3 = computeAtmosphereDensity(6450e3, 6371e3, 6471e3);
      expect(d1).toBeGreaterThan(d2);
      expect(d2).toBeGreaterThan(d3);
    });
  });

  describe("computeRayleighScattering", () => {
    it("scales by density", () => {
      const r1 = computeRayleighScattering([5.5e-6, 13e-6, 22.4e-6], [5.5e-6, 13e-6, 22.4e-6], 1.0);
      const r2 = computeRayleighScattering([5.5e-6, 13e-6, 22.4e-6], [5.5e-6, 13e-6, 22.4e-6], 0.5);
      expect(r2[0]).toBeCloseTo(r1[0] * 0.5);
    });
  });

  describe("computeMieScattering", () => {
    it("scales by density", () => {
      const m1 = computeMieScattering(21e-6, 1.0);
      const m2 = computeMieScattering(21e-6, 0.5);
      expect(m2).toBeCloseTo(m1 * 0.5);
    });
  });

  describe("computeSkyColor", () => {
    it("returns positive values for sun-aligned view", () => {
      const color = computeSkyColor([0, 1, 0], [0, 1, 0], DEFAULT_ATMOSPHERE_CONFIG);
      expect(color[0]).toBeGreaterThan(0);
      expect(color[1]).toBeGreaterThan(0);
      expect(color[2]).toBeGreaterThan(0);
    });

    it("blue is stronger than red (Rayleigh)", () => {
      const color = computeSkyColor([0, 1, 0], [0, 1, 0], DEFAULT_ATMOSPHERE_CONFIG);
      expect(color[2]).toBeGreaterThan(color[0]);
    });
  });

  describe("ATMOSPHERE_SHADER_CHUNK", () => {
    it("contains WGSL functions", () => {
      expect(ATMOSPHERE_SHADER_CHUNK).toContain("atmosphereDensity");
      expect(ATMOSPHERE_SHADER_CHUNK).toContain("rayleighPhase");
      expect(ATMOSPHERE_SHADER_CHUNK).toContain("miePhase");
      expect(ATMOSPHERE_SHADER_CHUNK).toContain("computeAtmosphereColor");
    });
  });
});
