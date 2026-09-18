export interface FroxelGridConfig {
  froxelX: number;
  froxelY: number;
  froxelZ: number;
  nearPlane: number;
  farPlane: number;
  maxLightsPerFroxel: number;
}

export const DEFAULT_FROXEL_CONFIG: FroxelGridConfig = {
  froxelX: 80,
  froxelY: 45,
  froxelZ: 64,
  nearPlane: 0.5,
  farPlane: 200.0,
  maxLightsPerFroxel: 8,
};

export interface VolumetricFogConfig {
  density: number;
  anisotropy: number;
  scattering: [number, number, number];
  absorption: [number, number, number];
  enabled: boolean;
}

export const DEFAULT_VOLUMETRIC_FOG: VolumetricFogConfig = {
  density: 0.02,
  anisotropy: 0.5,
  scattering: [0.8, 0.9, 1.0],
  absorption: [0.1, 0.1, 0.1],
  enabled: false,
};

export function computeFroxelCount(config: FroxelGridConfig): number {
  return config.froxelX * config.froxelY * config.froxelZ;
}

export function computeFroxelGridBufferSize(config: FroxelGridConfig): number {
  return computeFroxelCount(config) * 8; // offset + count (2 * u32)
}

export function computeFroxelLightIndexListSize(config: FroxelGridConfig): number {
  return computeFroxelCount(config) * config.maxLightsPerFroxel;
}

export function computeFroxelScatteringTextureSize(config: FroxelGridConfig): number {
  return config.froxelX * config.froxelY * config.froxelZ * 4 * 4; // rgba16float = 8 bytes per texel
}

export function froxelDepthToSlice(
  depth: number,
  froxelZ: number,
  near: number,
  far: number,
): number {
  if (depth <= near) return 0;
  if (depth >= far) return froxelZ - 1;
  const logDepth = Math.log(depth / near) / Math.log(far / near);
  return Math.min(Math.floor(logDepth * froxelZ), froxelZ - 1);
}

export function froxelSliceToNear(
  slice: number,
  froxelZ: number,
  near: number,
  far: number,
): number {
  return near * Math.pow(far / near, slice / froxelZ);
}

export function froxelSliceToFar(
  slice: number,
  froxelZ: number,
  near: number,
  far: number,
): number {
  return froxelSliceToNear(slice + 1, froxelZ, near, far);
}

export function screenPosToFroxelXY(
  screenX: number,
  screenY: number,
  froxelX: number,
  froxelY: number,
): [number, number] {
  const fx = Math.min(Math.floor(screenX * froxelX), froxelX - 1);
  const fy = Math.min(Math.floor(screenY * froxelY), froxelY - 1);
  return [fx, fy];
}

export function froxelIndex3D(
  fx: number,
  fy: number,
  fz: number,
  froxelX: number,
  froxelY: number,
): number {
  return fx + fy * froxelX + fz * froxelX * froxelY;
}

export function packVolumetricUniforms(
  config: VolumetricFogConfig,
  froxelConfig: FroxelGridConfig,
  screenWidth: number,
  screenHeight: number,
  numLights: number,
): Float32Array {
  const buf = new Float32Array(16);
  buf[0] = froxelConfig.froxelX;
  buf[1] = froxelConfig.froxelY;
  buf[2] = froxelConfig.froxelZ;
  buf[3] = screenWidth;
  buf[4] = screenHeight;
  buf[5] = froxelConfig.nearPlane;
  buf[6] = froxelConfig.farPlane;
  buf[7] = numLights;
  buf[8] = config.density;
  buf[9] = config.anisotropy;
  buf[10] = config.scattering[0];
  buf[11] = config.scattering[1];
  buf[12] = config.scattering[2];
  buf[13] = config.absorption[0];
  buf[14] = config.absorption[1];
  buf[15] = config.absorption[2];
  return buf;
}

export function computeMiePhase(
  cosTheta: number,
  anisotropy: number,
): number {
  const g = anisotropy;
  const g2 = g * g;
  const denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (3.0 * (1.0 - g2)) / (8.0 * Math.PI * denom * Math.sqrt(denom));
}

export function computeExtinction(
  density: number,
  scattering: [number, number, number],
  absorption: [number, number, number],
): [number, number, number] {
  return [
    density * (scattering[0] + absorption[0]),
    density * (scattering[1] + absorption[1]),
    density * (scattering[2] + absorption[2]),
  ];
}

export function computeOpticalDepth(
  density: number,
  extinction: [number, number, number],
  distance: number,
): [number, number, number] {
  return [
    extinction[0] * density * distance,
    extinction[1] * density * distance,
    extinction[2] * density * distance,
  ];
}

export function computeTransmittance(
  opticalDepth: [number, number, number],
): [number, number, number] {
  return [
    Math.exp(-opticalDepth[0]),
    Math.exp(-opticalDepth[1]),
    Math.exp(-opticalDepth[2]),
  ];
}
