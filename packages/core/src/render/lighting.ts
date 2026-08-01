import { vec3, type Vec3 } from "wgpu-matrix";

export enum LightType {
  Directional = "directional",
  Point = "point",
  Spot = "spot",
  Hemisphere = "hemisphere",
  RectArea = "rect-area",
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

export interface HemisphereLight {
  type: LightType.Hemisphere;
  direction: Vec3;
  skyColor: Vec3;
  groundColor: Vec3;
  intensity: number;
}

export interface RectAreaLight {
  type: LightType.RectArea;
  position: Vec3;
  direction: Vec3;
  width: number;
  height: number;
  color: Vec3;
  intensity: number;
}

export type Light = DirectionalLight | PointLight | SpotLight | HemisphereLight | RectAreaLight;

export const MAX_POINT_LIGHTS = 32;
export const MAX_SPOT_LIGHTS = 8;

export interface ShadowSettings {
  castShadows: boolean;
  shadowMapSize: number;
  bias: number;
  normalBias: number;
  cascadeCount: number;
  cascadeLambda: number;
  blendDistance: number;
}

export const DEFAULT_SHADOW_SETTINGS: ShadowSettings = {
  castShadows: true,
  shadowMapSize: 2048,
  bias: 0.001,
  normalBias: 0.02,
  cascadeCount: 4,
  cascadeLambda: 0.5,
  blendDistance: 0.15,
};

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
  spotLights: Array<{
    position: Vec3;
    direction: Vec3;
    color: Vec3;
    intensity: number;
    range: number;
    innerConeCos: number;
    outerConeCos: number;
  }>;
  spotLightCount: number;
  hemisphere: {
    direction: Vec3;
    skyColor: Vec3;
    groundColor: Vec3;
    intensity: number;
  };
  hasHemisphere: number;
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
    spotLights: [],
    spotLightCount: 0,
    hemisphere: {
      direction: vec3.create(0, 1, 0),
      skyColor: vec3.create(0.3, 0.35, 0.4),
      groundColor: vec3.create(0.15, 0.12, 0.1),
      intensity: 0.0,
    },
    hasHemisphere: 0,
    ambientColor: vec3.create(0.45, 0.5, 0.55),
    ambientIntensity: 0.6,
  };
}

export function packLightUniform(data: LightUniformData): Float32Array {
  const buf = new Float32Array(32);
  let offset = 0;

  // Directional light (vec4 * 2 = 8 floats)
  buf[offset++] = data.directional.direction[0];
  buf[offset++] = data.directional.direction[1];
  buf[offset++] = data.directional.direction[2];
  buf[offset++] = data.directional.intensity;

  buf[offset++] = data.directional.color[0];
  buf[offset++] = data.directional.color[1];
  buf[offset++] = data.directional.color[2];
  buf[offset++] = data.directional.castShadows;

  // Hemisphere light (vec4 * 3 = 12 floats)
  // hemiDirIntensity.w = intensity * hasHemisphere (shader checks < 0.5 to fallback to flat ambient)
  const hemiActive = data.hasHemisphere > 0.5 ? data.hemisphere.intensity : 0.0;
  buf[offset++] = data.hemisphere.direction[0];
  buf[offset++] = data.hemisphere.direction[1];
  buf[offset++] = data.hemisphere.direction[2];
  buf[offset++] = hemiActive;

  buf[offset++] = data.hemisphere.skyColor[0];
  buf[offset++] = data.hemisphere.skyColor[1];
  buf[offset++] = data.hemisphere.skyColor[2];
  buf[offset++] = data.hasHemisphere;

  buf[offset++] = data.hemisphere.groundColor[0];
  buf[offset++] = data.hemisphere.groundColor[1];
  buf[offset++] = data.hemisphere.groundColor[2];
  buf[offset++] = 0; // pad

  // Ambient + counts (vec4 * 2 = 8 floats)
  buf[offset++] = data.ambientColor[0];
  buf[offset++] = data.ambientColor[1];
  buf[offset++] = data.ambientColor[2];
  buf[offset++] = data.ambientIntensity;

  buf[offset++] = data.pointLightCount;
  buf[offset++] = data.spotLightCount;
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

export function packSpotLights(data: LightUniformData): Float32Array {
  const buf = new Float32Array(MAX_SPOT_LIGHTS * 12);
  for (let i = 0; i < MAX_SPOT_LIGHTS; i++) {
    const light = data.spotLights[i];
    const base = i * 12;
    if (light) {
      buf[base + 0] = light.position[0];
      buf[base + 1] = light.position[1];
      buf[base + 2] = light.position[2];
      buf[base + 3] = light.intensity;
      buf[base + 4] = light.direction[0];
      buf[base + 5] = light.direction[1];
      buf[base + 6] = light.direction[2];
      buf[base + 7] = light.range;
      buf[base + 8] = light.color[0];
      buf[base + 9] = light.color[1];
      buf[base + 10] = light.color[2];
      buf[base + 11] = light.innerConeCos;
      // outerConeCos packed in the next vec4's .w — but we need it per-light
      // Actually, let's use a different layout: 3 vec4s per spot light
      // vec4: position.xyz + intensity
      // vec4: direction.xyz + range
      // vec4: color.xyz + innerConeCos
      // We need outerConeCos too — use 4 vec4s (16 floats) per spot light
    }
  }
  return buf;
}

export function packSpotLightsExtended(data: LightUniformData): Float32Array {
  const buf = new Float32Array(MAX_SPOT_LIGHTS * 16);
  for (let i = 0; i < MAX_SPOT_LIGHTS; i++) {
    const light = data.spotLights[i];
    const base = i * 16;
    if (light) {
      // vec4: position.xyz + intensity
      buf[base + 0] = light.position[0];
      buf[base + 1] = light.position[1];
      buf[base + 2] = light.position[2];
      buf[base + 3] = light.intensity;
      // vec4: direction.xyz + range
      buf[base + 4] = light.direction[0];
      buf[base + 5] = light.direction[1];
      buf[base + 6] = light.direction[2];
      buf[base + 7] = light.range;
      // vec4: color.xyz + innerConeCos
      buf[base + 8] = light.color[0];
      buf[base + 9] = light.color[1];
      buf[base + 10] = light.color[2];
      buf[base + 11] = light.innerConeCos;
      // vec4: outerConeCos + pad
      buf[base + 12] = light.outerConeCos;
      buf[base + 13] = 0;
      buf[base + 14] = 0;
      buf[base + 15] = 0;
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

export function createSpotLight(
  position: Vec3,
  direction: Vec3,
  color: Vec3 = vec3.create(1, 1, 1),
  intensity: number = 2.0,
  range: number = 30.0,
  innerConeAngle: number = 0.5,
  outerConeAngle: number = 0.7,
): SpotLight {
  return {
    type: LightType.Spot,
    position,
    direction: vec3.normalize(direction),
    color,
    intensity,
    range,
    innerConeAngle,
    outerConeAngle,
  };
}

export function createHemisphereLight(
  direction: Vec3 = vec3.create(0, 1, 0),
  skyColor: Vec3 = vec3.create(0.3, 0.35, 0.4),
  groundColor: Vec3 = vec3.create(0.15, 0.12, 0.1),
  intensity: number = 0.5,
): HemisphereLight {
  return {
    type: LightType.Hemisphere,
    direction: vec3.normalize(direction),
    skyColor,
    groundColor,
    intensity,
  };
}

export function createRectAreaLight(
  position: Vec3,
  direction: Vec3,
  width: number = 2.0,
  height: number = 2.0,
  color: Vec3 = vec3.create(1, 1, 1),
  intensity: number = 2.0,
): RectAreaLight {
  return {
    type: LightType.RectArea,
    position,
    direction: vec3.normalize(direction),
    width,
    height,
    color,
    intensity,
  };
}
