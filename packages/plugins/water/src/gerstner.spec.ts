import {
  gerstnerHeight,
  gerstnerDisplacement,
  gerstnerNormal,
  packWaveData,
  packWaveUniforms,
  DEFAULT_WAVE_CONFIG,
  type GerstnerWaveParams,
} from "./gerstner.ts";

describe("Gerstner Waves", () => {
  const singleWave: GerstnerWaveParams[] = [
    { direction: [1, 0], amplitude: 0.5, wavelength: 10, speed: 1.0, steepness: 0.8 },
  ];

  describe("gerstnerHeight", () => {
    it("should return 0 at origin with zero amplitude", () => {
      const waves: GerstnerWaveParams[] = [
        { direction: [1, 0], amplitude: 0, wavelength: 10, speed: 1, steepness: 0.8 },
      ];
      expect(gerstnerHeight(0, 0, 0, waves)).toBe(0);
    });

    it("should return 0 at time=0, position=0 for sine wave", () => {
      expect(gerstnerHeight(0, 0, 0, singleWave)).toBe(0);
    });

    it("should be periodic with wavelength", () => {
      const wave = singleWave[0];
      const h1 = gerstnerHeight(0, 0, 0, singleWave);
      const h2 = gerstnerHeight(wave.wavelength, 0, 0, singleWave);
      expect(h1).toBeCloseTo(h2, 5);
    });

    it("should sum multiple waves", () => {
      const waves: GerstnerWaveParams[] = [
        { direction: [1, 0], amplitude: 0.3, wavelength: 10, speed: 1, steepness: 0.8 },
        { direction: [0, 1], amplitude: 0.2, wavelength: 5, speed: 1, steepness: 0.6 },
      ];
      const h = gerstnerHeight(1, 1, 0.5, waves);
      expect(h).not.toBe(0);
    });

    it("should normalize direction vector", () => {
      const waves: GerstnerWaveParams[] = [
        { direction: [2, 0], amplitude: 0.5, wavelength: 10, speed: 1, steepness: 0.8 },
      ];
      const h1 = gerstnerHeight(1, 0, 0, waves);
      const h2 = gerstnerHeight(1, 0, 0, singleWave);
      expect(h1).toBeCloseTo(h2, 5);
    });
  });

  describe("gerstnerDisplacement", () => {
    it("should return original x,z when amplitude is 0", () => {
      const waves: GerstnerWaveParams[] = [
        { direction: [1, 0], amplitude: 0, wavelength: 10, speed: 1, steepness: 0.8 },
      ];
      const d = gerstnerDisplacement(5, 7, 0, waves);
      expect(d.x).toBe(5);
      expect(d.z).toBe(7);
      expect(d.y).toBe(0);
    });

    it("should displace y by amplitude * sin(phase)", () => {
      const d = gerstnerDisplacement(0, 0, 0, singleWave);
      expect(d.y).toBeCloseTo(0, 5);
    });

    it("should displace x,z horizontally based on steepness", () => {
      const d = gerstnerDisplacement(0, 0, 0, singleWave);
      expect(d.x).toBeCloseTo(singleWave[0].steepness * singleWave[0].amplitude, 5);
      expect(d.z).toBe(0);
    });

    it("should handle multiple waves", () => {
      const waves = DEFAULT_WAVE_CONFIG.waves;
      const d = gerstnerDisplacement(1, 1, 0.5, waves);
      expect(typeof d.x).toBe("number");
      expect(typeof d.y).toBe("number");
      expect(typeof d.z).toBe("number");
    });
  });

  describe("gerstnerNormal", () => {
    it("should return a normalized vector", () => {
      const n = gerstnerNormal(1, 1, 0.5, singleWave);
      const len = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2);
      expect(len).toBeCloseTo(1, 3);
    });

    it("should return upward normal for flat surface (zero amplitude)", () => {
      const waves: GerstnerWaveParams[] = [
        { direction: [1, 0], amplitude: 0, wavelength: 10, speed: 1, steepness: 0.8 },
      ];
      const n = gerstnerNormal(0, 0, 0, waves);
      expect(n[1]).toBeGreaterThan(0);
    });

    it("should handle multiple waves", () => {
      const n = gerstnerNormal(1, 1, 0.5, DEFAULT_WAVE_CONFIG.waves);
      expect(n.length).toBe(3);
      const len = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2);
      expect(len).toBeCloseTo(1, 2);
    });
  });

  describe("packWaveData", () => {
    it("should return Float32Array of length 16", () => {
      const data = packWaveData(DEFAULT_WAVE_CONFIG, 0);
      expect(data).toBeInstanceOf(Float32Array);
      expect(data.length).toBe(16);
    });

    it("should pack up to 4 waves", () => {
      const data = packWaveData(DEFAULT_WAVE_CONFIG, 0);
      expect(data[0]).toBe(DEFAULT_WAVE_CONFIG.waves[0].direction[0]);
      expect(data[2]).toBe(DEFAULT_WAVE_CONFIG.waves[0].amplitude);
    });

    it("should fill unused wave slots with zeros", () => {
      const config = { ...DEFAULT_WAVE_CONFIG, waves: [DEFAULT_WAVE_CONFIG.waves[0]] };
      const data = packWaveData(config, 0);
      expect(data[4]).toBe(0);
      expect(data[5]).toBe(0);
    });
  });

  describe("packWaveUniforms", () => {
    it("should return Float32Array of length 32", () => {
      const data = packWaveUniforms(DEFAULT_WAVE_CONFIG, 1.5);
      expect(data).toBeInstanceOf(Float32Array);
      expect(data.length).toBe(32);
    });

    it("should pack wave parameters in first 24 slots", () => {
      const data = packWaveUniforms(DEFAULT_WAVE_CONFIG, 0);
      const w0 = DEFAULT_WAVE_CONFIG.waves[0];
      expect(data[0]).toBe(w0.direction[0]);
      expect(data[1]).toBe(w0.direction[1]);
      expect(data[2]).toBe(w0.amplitude);
      expect(data[4]).toBe(w0.speed);
      expect(data[5]).toBe(w0.steepness);
    });

    it("should pack config values in slots 24-31", () => {
      const time = 2.5;
      const data = packWaveUniforms(DEFAULT_WAVE_CONFIG, time);
      expect(data[24]).toBe(DEFAULT_WAVE_CONFIG.tiling);
      expect(data[25]).toBe(DEFAULT_WAVE_CONFIG.normalStrength);
      expect(data[30]).toBe(time);
      expect(data[31]).toBe(DEFAULT_WAVE_CONFIG.windSpeed);
    });
  });

  describe("DEFAULT_WAVE_CONFIG", () => {
    it("should have 4 waves by default", () => {
      expect(DEFAULT_WAVE_CONFIG.waves.length).toBe(4);
    });

    it("should have valid color values", () => {
      expect(DEFAULT_WAVE_CONFIG.deepColor.length).toBe(4);
      expect(DEFAULT_WAVE_CONFIG.shallowColor.length).toBe(4);
      expect(DEFAULT_WAVE_CONFIG.foamColor.length).toBe(4);
    });
  });
});
