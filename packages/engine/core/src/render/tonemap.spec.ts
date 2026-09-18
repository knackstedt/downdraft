import {
  DEFAULT_TONE_MAPPING_SETTINGS,
  ToneMappingOperator,
  getToneMappingOperatorIndex,
  TONE_MAPPING_SHADER_CHUNK,
} from "./tonemap";

describe("ToneMapping", () => {
  describe("ToneMappingOperator enum", () => {
    it("should have 9 operators", () => {
      const values = Object.values(ToneMappingOperator);
      expect(values.length).toBe(9);
    });

    it("should have string values", () => {
      expect(ToneMappingOperator.ACES).toBe("aces");
      expect(ToneMappingOperator.Reinhard).toBe("reinhard");
      expect(ToneMappingOperator.AgX).toBe("agx");
      expect(ToneMappingOperator.Uchimura).toBe("uchimura");
    });

    it("should include None as first operator", () => {
      expect(ToneMappingOperator.None).toBe("none");
    });
  });

  describe("DEFAULT_TONE_MAPPING_SETTINGS", () => {
    it("should default to ACES operator", () => {
      expect(DEFAULT_TONE_MAPPING_SETTINGS.operator).toBe(ToneMappingOperator.ACES);
    });

    it("should have exposure of 1.0", () => {
      expect(DEFAULT_TONE_MAPPING_SETTINGS.exposure).toBe(1.0);
    });

    it("should have gamma of 2.2", () => {
      expect(DEFAULT_TONE_MAPPING_SETTINGS.gamma).toBe(2.2);
    });

    it("should have whitePoint of 11.2", () => {
      expect(DEFAULT_TONE_MAPPING_SETTINGS.whitePoint).toBe(11.2);
    });
  });

  describe("getToneMappingOperatorIndex", () => {
    it("should return 0 for None", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.None)).toBe(0);
    });

    it("should return 1 for ACES", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.ACES)).toBe(1);
    });

    it("should return 2 for ACESFilmic", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.ACESFilmic)).toBe(2);
    });

    it("should return 3 for Reinhard", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.Reinhard)).toBe(3);
    });

    it("should return 4 for Reinhard2", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.Reinhard2)).toBe(4);
    });

    it("should return 5 for Uncharted2", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.Uncharted2)).toBe(5);
    });

    it("should return 6 for Filmic", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.Filmic)).toBe(6);
    });

    it("should return 7 for AgX", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.AgX)).toBe(7);
    });

    it("should return 8 for Uchimura", () => {
      expect(getToneMappingOperatorIndex(ToneMappingOperator.Uchimura)).toBe(8);
    });

    it("should return contiguous indices 0-8", () => {
      const ops = Object.values(ToneMappingOperator);
      const indices = ops.map((op) => getToneMappingOperatorIndex(op));
      indices.sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }
    });
  });

  describe("TONE_MAPPING_SHADER_CHUNK", () => {
    it("should be a non-empty string", () => {
      expect(typeof TONE_MAPPING_SHADER_CHUNK).toBe("string");
      expect(TONE_MAPPING_SHADER_CHUNK.length).toBeGreaterThan(100);
    });

    it("should contain all tonemapping functions", () => {
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapNone");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapACES");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapACESFilmic");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapReinhard");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapReinhard2");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapUncharted2");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapFilmic");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapAgX");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("tonemapUchimura");
    });

    it("should contain applyToneMapping dispatch function", () => {
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("applyToneMapping");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("switch");
    });

    it("should contain color space conversion functions", () => {
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("linearToSRGB");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("srgbToLinear");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("linearToDisplayP3");
    });

    it("should contain ToneMappingOp enum matching JS enum indices", () => {
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("None = 0");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("ACES = 1");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("Reinhard = 3");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("AgX = 7");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("Uchimura = 8");
    });

    it("should contain ToneMappingUniforms struct", () => {
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("struct ToneMappingUniforms");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("operator: u32");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("exposure: f32");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("gamma: f32");
      expect(TONE_MAPPING_SHADER_CHUNK).toContain("whitePoint: f32");
    });
  });
});
