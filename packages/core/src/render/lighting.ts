import { vec3, type Vec3 } from "wgpu-matrix";

export enum LightType {
  Directional = "directional",
  Point = "point",
  Spot = "spot",
}

export interface DirectionalLight {
  type: LightType.Directional;
  direction: Vec3;
  color: Vec3;
  intensity: number;
  castShadows: boolean;
  shadowMapSize: number;
  shadowBias: number;
}

export interface PointLight {
  type: LightType.Point;
  position: Vec3;
  color: Vec3;
  intensity: number;
  range: number;
  attenuation: number;
}

export interface SpotLight {
  type: LightType.Spot;
  position: Vec3;
  direction: Vec3;
  color: Vec3;
  intensity: number;
  range: number;
  innerConeAngle: number;
  outerConeAngle: number;
}

export type Light = DirectionalLight | PointLight | SpotLight;

export const MAX_POINT_LIGHTS = 8;

export interface LightUniformData {
  directional: {
    direction: Vec3;
    color: Vec3;
    intensity: number;
    castShadows: number;
  };
  pointLights: Array<{
    position: Vec3;
    color: Vec3;
    intensity: number;
    range: number;
  }>;
  pointLightCount: number;
  ambientColor: Vec3;
  ambientIntensity: number;
}

export function createDefaultLightUniform(): LightUniformData {
  return {
    directional: {
      direction: vec3.normalize(vec3.create(0.5, 0.8, 0.3)),
      color: vec3.create(1, 1, 0.95),
      intensity: 3.0,
      castShadows: 1,
    },
    pointLights: [],
    pointLightCount: 0,
    ambientColor: vec3.create(0.3, 0.3, 0.35),
    ambientIntensity: 0.3,
  };
}

export function packLightUniform(data: LightUniformData): Float32Array {
  const buf = new Float32Array(16);
  let offset = 0;

  buf[offset++] = data.directional.direction[0];
  buf[offset++] = data.directional.direction[1];
  buf[offset++] = data.directional.direction[2];
  buf[offset++] = data.directional.intensity;

  buf[offset++] = data.directional.color[0];
  buf[offset++] = data.directional.color[1];
  buf[offset++] = data.directional.color[2];
  buf[offset++] = data.directional.castShadows;

  buf[offset++] = data.ambientColor[0];
  buf[offset++] = data.ambientColor[1];
  buf[offset++] = data.ambientColor[2];
  buf[offset++] = data.ambientIntensity;

  buf[offset++] = data.pointLightCount;
  buf[offset++] = 0;
  buf[offset++] = 0;
  buf[offset++] = 0;

  return buf;
}

export function packPointLights(data: LightUniformData): Float32Array {
  const buf = new Float32Array(MAX_POINT_LIGHTS * 8);
  for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
    const light = data.pointLights[i];
    const base = i * 8;
    if (light) {
      buf[base + 0] = light.position[0];
      buf[base + 1] = light.position[1];
      buf[base + 2] = light.position[2];
      buf[base + 3] = light.intensity;
      buf[base + 4] = light.color[0];
      buf[base + 5] = light.color[1];
      buf[base + 6] = light.color[2];
      buf[base + 7] = light.range;
    }
  }
  return buf;
}

export function createDirectionalLight(
  direction: Vec3,
  color: Vec3 = vec3.create(1, 1, 1),
  intensity: number = 3.0,
  castShadows: boolean = true,
): DirectionalLight {
  return {
    type: LightType.Directional,
    direction: vec3.normalize(direction),
    color,
    intensity,
    castShadows,
    shadowMapSize: 2048,
    shadowBias: 0.001,
  };
}

export function createPointLight(
  position: Vec3,
  color: Vec3 = vec3.create(1, 1, 1),
  intensity: number = 1.0,
  range: number = 20.0,
): PointLight {
  return {
    type: LightType.Point,
    position,
    color,
    intensity,
    range,
    attenuation: 2.0,
  };
}
