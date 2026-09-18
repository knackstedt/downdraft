import type { Vec3 } from "wgpu-matrix";

export type LightShapeType = 0 | 1 | 2; // 0=point, 1=spot, 2=rect-area

export interface ClusterGridConfig {
  clusterX: number;
  clusterY: number;
  clusterZ: number;
  maxLightsPerCluster: number;
  maxTotalLights: number;
  nearPlane: number;
  farPlane: number;
  depthDistributionScale: number;
}

export const DEFAULT_CLUSTER_CONFIG: ClusterGridConfig = {
  clusterX: 16,
  clusterY: 8,
  clusterZ: 24,
  maxLightsPerCluster: 128,
  maxTotalLights: 1024,
  nearPlane: 0.1,
  farPlane: 1000.0,
  depthDistributionScale: 3.0,
};

export interface GPULightData {
  position: Vec3;
  radius: number;
  color: Vec3;
  intensity: number;
  direction: Vec3;
  type: number;
  innerConeCos: number;
  outerConeCos: number;
  range: number;
  width: number;
  height: number;
  _pad: number;
  _pad2: number;
}

export const LIGHT_DATA_SIZE = 64; // 16 floats per light = 64 bytes
export const LIGHT_DATA_FLOATS = 16;

export interface ClusterUniforms {
  clusterDimensions: [number, number, number];
  screenDimensions: [number, number];
  nearPlane: number;
  farPlane: number;
  depthScale: number;
  numLights: number;
  _pad: number;
}

export const CLUSTER_UNIFORM_SIZE = 32; // 8 floats

export const CLUSTER_GRID_FLOATS_PER_ENTRY = 2; // offset, count
export const CLUSTER_GRID_ENTRY_SIZE = 8; // 2 * u32 = 8 bytes

export function computeClusterCount(config: ClusterGridConfig): number {
  return config.clusterX * config.clusterY * config.clusterZ;
}

export function computeLightIndexListSize(config: ClusterGridConfig): number {
  return computeClusterCount(config) * config.maxLightsPerCluster;
}

export function computeClusterGridBufferSize(config: ClusterGridConfig): number {
  return computeClusterCount(config) * CLUSTER_GRID_ENTRY_SIZE;
}

export function computeLightDataBufferSize(config: ClusterGridConfig): number {
  return config.maxTotalLights * LIGHT_DATA_SIZE;
}

export function depthSliceToNear(
  slice: number,
  clusterZ: number,
  near: number,
  far: number,
  scale: number,
): number {
  const linearDist = near + (far - near) * (slice / clusterZ);
  return near * Math.pow(far / near, slice / clusterZ);
}

export function worldDepthToSlice(
  depth: number,
  clusterZ: number,
  near: number,
  far: number,
  _scale: number,
): number {
  if (depth <= near) return 0;
  if (depth >= far) return clusterZ - 1;
  const logDepth = Math.log(depth / near) / Math.log(far / near);
  return Math.min(Math.floor(logDepth * clusterZ), clusterZ - 1);
}

export function screenPosToClusterXY(
  screenX: number,
  screenY: number,
  clusterX: number,
  clusterY: number,
): [number, number] {
  const cx = Math.min(Math.floor(screenX * clusterX), clusterX - 1);
  const cy = Math.min(Math.floor(screenY * clusterY), clusterY - 1);
  return [cx, cy];
}

export function clusterIndex3D(
  cx: number,
  cy: number,
  cz: number,
  clusterX: number,
  clusterY: number,
): number {
  return cx + cy * clusterX + cz * clusterX * clusterY;
}

export function packLightToStorageBuffer(light: {
  position: Vec3;
  color: Vec3;
  intensity: number;
  range: number;
  direction?: Vec3;
  type?: LightShapeType;
  innerConeCos?: number;
  outerConeCos?: number;
  width?: number;
  height?: number;
}): Float32Array {
  const buf = new Float32Array(LIGHT_DATA_FLOATS);
  buf[0] = light.position[0];
  buf[1] = light.position[1];
  buf[2] = light.position[2];
  buf[3] = light.range;
  buf[4] = light.color[0];
  buf[5] = light.color[1];
  buf[6] = light.color[2];
  buf[7] = light.intensity;
  buf[8] = light.direction ? light.direction[0] : 0;
  buf[9] = light.direction ? light.direction[1] : 0;
  buf[10] = light.direction ? light.direction[2] : 0;
  buf[11] = light.type ?? 0;
  buf[12] = light.innerConeCos ?? 0;
  buf[13] = light.outerConeCos ?? 0;
  buf[14] = light.width ?? 0;
  buf[15] = light.height ?? 0;
  return buf;
}

export function packLightsArray(
  lights: Array<ReturnType<typeof Object> & {
    position: Vec3;
    color: Vec3;
    intensity: number;
    range: number;
    direction?: Vec3;
    type?: LightShapeType;
    innerConeCos?: number;
    outerConeCos?: number;
    width?: number;
    height?: number;
  }>,
  maxLights: number,
): Float32Array {
  const buf = new Float32Array(maxLights * LIGHT_DATA_FLOATS);
  for (let i = 0; i < Math.min(lights.length, maxLights); i++) {
    const packed = packLightToStorageBuffer(lights[i]);
    buf.set(packed, i * LIGHT_DATA_FLOATS);
  }
  return buf;
}

export function packClusterUniforms(
  config: ClusterGridConfig,
  screenWidth: number,
  screenHeight: number,
  numLights: number,
): Float32Array {
  const buf = new Float32Array(8);
  buf[0] = config.clusterX;
  buf[1] = config.clusterY;
  buf[2] = config.clusterZ;
  buf[3] = screenWidth;
  buf[4] = screenHeight;
  buf[5] = config.nearPlane;
  buf[6] = config.farPlane;
  buf[7] = numLights;
  return buf;
}
