import { describe, it, expect } from "bun:test";
import {
  parseIES,
  iesProfileToTextureData,
  type IESProfile,
} from "./ies-parser.ts";

const SIMPLE_IES = `IESNA:LM-63-2002
TILT=NONE
[_LUMINAIRE] Test Fixture
[_LAMP] LED Module
1000 1.0 5 1 1 1 0 0 0
0 22.5 45 67.5 90
0
100 80 60 40 20
`;

describe("ies-parser", () => {
  describe("parseIES", () => {
    it("parses a simple IES file", () => {
      const profile = parseIES(SIMPLE_IES, { label: "test" });
      expect(profile.label).toBe("test");
      expect(profile.lumens).toBe(1000);
      expect(profile.candelaMultiplier).toBe(1.0);
      expect(profile.numVerticalAngles).toBe(5);
      expect(profile.numHorizontalAngles).toBe(1);
      expect(profile.photometricType).toBe(1);
    });

    it("parses vertical angles correctly", () => {
      const profile = parseIES(SIMPLE_IES);
      expect(profile.verticalAngles.length).toBe(5);
      expect(profile.verticalAngles[0]).toBe(0);
      expect(profile.verticalAngles[1]).toBeCloseTo(22.5);
      expect(profile.verticalAngles[4]).toBe(90);
    });

    it("parses candela values correctly", () => {
      const profile = parseIES(SIMPLE_IES);
      expect(profile.candelaValues.length).toBe(5);
      expect(profile.candelaValues[0]).toBe(100);
      expect(profile.candelaValues[1]).toBe(80);
      expect(profile.candelaValues[4]).toBe(20);
    });

    it("handles empty lines gracefully", () => {
      const iesWithBlanks = `IESNA:LM-63-2002

TILT=NONE

[_LUMINAIRE] Test

500 1.0 3 1 1 1 0 0 0
0 45 90
0
50 25 10
`;
      const profile = parseIES(iesWithBlanks);
      expect(profile.lumens).toBe(500);
      expect(profile.numVerticalAngles).toBe(3);
      expect(profile.verticalAngles[1]).toBe(45);
    });
  });

  describe("iesProfileToTextureData", () => {
    it("converts profile to texture data", () => {
      const profile: IESProfile = {
        label: "test",
        photometricType: 1,
        lumens: 1000,
        candelaMultiplier: 1.0,
        numVerticalAngles: 3,
        numHorizontalAngles: 2,
        verticalAngles: new Float32Array([0, 45, 90]),
        horizontalAngles: new Float32Array([0, 180]),
        candelaValues: new Float32Array([100, 50, 10, 100, 50, 10]),
        width: 0,
        height: 0,
      };

      const { data, width, height } = iesProfileToTextureData(profile);
      expect(width).toBe(2);
      expect(height).toBe(3);
      expect(data.length).toBe(6);
      expect(data[0]).toBe(100);
      expect(data[5]).toBe(10);
    });

    it("respects max texture size", () => {
      const profile: IESProfile = {
        label: "test",
        photometricType: 1,
        lumens: 1000,
        candelaMultiplier: 1.0,
        numVerticalAngles: 200,
        numHorizontalAngles: 400,
        verticalAngles: new Float32Array(200),
        horizontalAngles: new Float32Array(400),
        candelaValues: new Float32Array(400 * 200),
        width: 0,
        height: 0,
      };

      const { width, height } = iesProfileToTextureData(profile, 180, 90);
      expect(width).toBe(180);
      expect(height).toBe(90);
    });

    it("applies candela multiplier", () => {
      const profile: IESProfile = {
        label: "test",
        photometricType: 1,
        lumens: 1000,
        candelaMultiplier: 2.0,
        numVerticalAngles: 2,
        numHorizontalAngles: 1,
        verticalAngles: new Float32Array([0, 90]),
        horizontalAngles: new Float32Array([0]),
        candelaValues: new Float32Array([50, 25]),
        width: 0,
        height: 0,
      };

      const { data } = iesProfileToTextureData(profile);
      expect(data[0]).toBe(100); // 50 * 2.0
      expect(data[1]).toBe(50);  // 25 * 2.0
    });
  });
});
