import { vec3 } from "wgpu-matrix";
import {
    LightType,
    MAX_POINT_LIGHTS,
    createDefaultLightUniform,
    createDirectionalLight,
    createPointLight,
    packLightUniform,
    packPointLights,
} from "./lighting.ts";

describe("Lighting", () => {
  it("should create a directional light with correct defaults", () => {
    const light = createDirectionalLight(vec3.create(1, 0, 0));
    expect(light.type).toBe(LightType.Directional);
    expect(light.direction[0]).toBeCloseTo(1);
    expect(light.intensity).toBe(3.0);
    expect(light.castShadows).toBe(true);
  });

  it("should create a point light with correct defaults", () => {
    const light = createPointLight(vec3.create(1, 2, 3));
    expect(light.type).toBe(LightType.Point);
    expect(light.position[0]).toBe(1);
    expect(light.position[1]).toBe(2);
    expect(light.position[2]).toBe(3);
    expect(light.range).toBe(20.0);
  });

  it("should create default light uniform with directional + ambient", () => {
    const data = createDefaultLightUniform();
    expect(data.directional.intensity).toBe(3.0);
    expect(data.ambientIntensity).toBe(0.6);
    expect(data.pointLightCount).toBe(0);
  });

  it("should pack light uniform into Float32Array of size 16", () => {
    const data = createDefaultLightUniform();
    const packed = packLightUniform(data);
    expect(packed.length).toBe(16);
    // First 3 values are direction
    expect(packed[0]).toBeCloseTo(data.directional.direction[0]);
    // 4th value is intensity
    expect(packed[3]).toBe(3.0);
  });

  it("should pack point lights into Float32Array of correct size", () => {
    const data = createDefaultLightUniform();
    data.pointLights = [
      { position: vec3.create(1, 2, 3), color: vec3.create(1, 1, 1), intensity: 2, range: 10, type: LightType.Point, attenuation: 2 },
    ];
    data.pointLightCount = 1;

    const packed = packPointLights(data);
    expect(packed.length).toBe(MAX_POINT_LIGHTS * 8);
    expect(packed[0]).toBe(1); // position.x
    expect(packed[3]).toBe(2); // intensity
    expect(packed[4]).toBe(1); // color.r
    expect(packed[7]).toBe(10); // range
  });

  it("should zero-fill unused point light slots", () => {
    const data = createDefaultLightUniform();
    const packed = packPointLights(data);
    // All slots should be 0 since no point lights
    for (let i = 0; i < packed.length; i++) {
      expect(packed[i]).toBe(0);
    }
  });
});
