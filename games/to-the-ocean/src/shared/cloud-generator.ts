// ============================================================================
// CloudGenerator — generates continuous cloud layer voxel fields from 3D Perlin noise
// Each layer is a single large field sampled from world-space noise coordinates.
// The mesh covers a region around the player and scrolls as the player moves.
// ============================================================================

import { PerlinNoise3D } from "./perlin-noise-3d";
import { VoxelField } from "./terrain-types";
import { WeatherType } from "./types";

// --- Cloud layer types ---
export type CloudLayerType = "cirrus" | "cumulus" | "stratus";

// --- Cloud configuration ---
export const CLOUD_CONFIG = {
  // Each layer is one continuous noise field
  layers: {
    cirrus: {
      altitude: 900,
      voxelSize: 18,       // chunky → low-poly
      dimX: 48, dimY: 6,  dimZ: 48,  // ~864 x 108 x 864 world units
      noiseScale: 0.0035,  // world-space noise frequency (low = big blobs)
      noiseOctaves: 4,
      noisePersistence: 0.55,
      noiseLacunarity: 2.1,
      thickness: 0.45,     // vertical thickness factor
      threshold: 0.48,     // noise above this = cloud
      yStretch: 0.3,       // flatten vertically
    },
    cumulus: {
      altitude: 500,
      voxelSize: 16,
      dimX: 56, dimY: 14, dimZ: 56,  // ~896 x 224 x 896 world units
      noiseScale: 0.004,
      noiseOctaves: 5,
      noisePersistence: 0.5,
      noiseLacunarity: 2.0,
      thickness: 0.6,
      threshold: 0.45,
      yStretch: 0.5,
    },
    stratus: {
      altitude: 250,
      voxelSize: 18,
      dimX: 64, dimY: 5,  dimZ: 64,  // ~1152 x 90 x 1152 world units
      noiseScale: 0.0025,
      noiseOctaves: 4,
      noisePersistence: 0.6,
      noiseLacunarity: 2.2,
      thickness: 0.35,
      threshold: 0.42,
      yStretch: 0.2,       // very flat
    },
  } as Record<CloudLayerType, {
    altitude: number; voxelSize: number; dimX: number; dimY: number; dimZ: number;
    noiseScale: number; noiseOctaves: number; noisePersistence: number; noiseLacunarity: number;
    thickness: number; threshold: number; yStretch: number;
  }>,

  // Weather affects coverage threshold
  weatherCoverage: {
    [WeatherType.Clear]: 0.15,
    [WeatherType.PartlyCloudy]: 0.4,
    [WeatherType.Overcast]: 0.8,
    [WeatherType.Rain]: 0.85,
    [WeatherType.Storm]: 0.95,
    [WeatherType.Fog]: 0.7,
    [WeatherType.Snow]: 0.75,
    [WeatherType.HellStorm]: 0.9,
    [WeatherType.Eclipse]: 0.6,
    [WeatherType.FullMoon]: 0.2,
  } as Record<number, number>,

  // How far player must move (in world units) before a layer regenerates
  regenDistance: 200,

  // Performance
  maxLayerGenPerFrame: 1,
  layerGenTimeBudgetMs: 12,
};

// Smoothstep helper
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Generate a cloud layer voxel field centered on (centerX, centerZ).
// The field is sampled from world-space Perlin noise so it tiles seamlessly
// as the player moves — we just shift the sampling origin.
export function generateCloudLayerField(
  layerType: CloudLayerType,
  centerX: number,
  centerZ: number,
  weatherType: WeatherType = WeatherType.PartlyCloudy,
  windOffsetX: number = 0,
  windOffsetZ: number = 0,
): VoxelField {
  const cfg = CLOUD_CONFIG.layers[layerType];
  const noise = new PerlinNoise3D(0xC10D5 ^ layerType.charCodeAt(0));
  const detailNoise = new PerlinNoise3D(0xDE7A15 ^ layerType.charCodeAt(0));

  const dimX = cfg.dimX;
  const dimY = cfg.dimY;
  const dimZ = cfg.dimZ;
  const vs = cfg.voxelSize;
  const totalVoxels = dimX * dimY * dimZ;
  const data = new Float32Array(totalVoxels);

  // World-space extents
  const xExtent = (dimX - 1) * vs * 0.5;
  const yExtent = (dimY - 1) * vs * 0.5;
  const zExtent = (dimZ - 1) * vs * 0.5;

  // Weather maps directly to cloud coverage via threshold
  // coverage 0.15 (clear) → threshold ~0.72 → ~5% clouds
  // coverage 0.40 (partly cloudy) → threshold ~0.52 → ~30% clouds
  // coverage 0.80 (overcast) → threshold ~0.20 → ~95% clouds
  // coverage 0.95 (storm) → threshold ~0.08 → ~100% clouds
  const coverage = CLOUD_CONFIG.weatherCoverage[weatherType] ?? 0.4;
  // Map coverage [0..1] to threshold [0.80..0.05] — higher coverage = lower threshold = more cloud
  const threshold = 0.80 - coverage * 0.75;

  const dimYDimZ = dimY * dimZ;
  const dimZ_ = dimZ;
  const noiseScale = cfg.noiseScale;
  const noiseOctaves = cfg.noiseOctaves;
  const noisePersistence = cfg.noisePersistence;
  const noiseLacunarity = cfg.noiseLacunarity;
  const yStretch = cfg.yStretch;

  // World-space sampling origin — shifted by wind offset for drift effect
  const worldOriginX = centerX - xExtent - windOffsetX;
  const worldOriginZ = centerZ - zExtent - windOffsetZ;

  for (let vx = 0; vx < dimX; vx++) {
    const wx = worldOriginX + vx * vs;
    for (let vy = 0; vy < dimY; vy++) {
      const wy = (vy / (dimY - 1) - 0.5) * 2.0; // [-1, 1]
      for (let vz = 0; vz < dimZ; vz++) {
        const wz = worldOriginZ + vz * vs;

        // Primary FBM noise in world space — y is stretched to flatten clouds
        let n = noise.fbm3D(
          wx * noiseScale, wy * noiseScale / yStretch, wz * noiseScale,
          noiseOctaves, noisePersistence, noiseLacunarity,
        );
        // Remap [-1,1] → [0,1]
        n = n * 0.5 + 0.5;

        // Detail noise for lumpy surface
        const detail = detailNoise.fbm3D(
          wx * noiseScale * 3, wy * noiseScale * 3 / yStretch, wz * noiseScale * 3,
          3, 0.4, 2.0,
        );
        n = n * 0.75 + (detail * 0.5 + 0.5) * 0.25;

        // Vertical thickness falloff — clouds are thickest at mid-height
        const vertFalloff = 1.0 - smoothstep01(cfg.thickness, 1.0, Math.abs(wy));

        // Density: negative = solid (cloud), positive = empty (sky)
        // MC convention: val < iso(0) = solid
        let density = threshold - n;

        // Apply vertical falloff: push density positive (less solid) at top/bottom edges
        density += (1.0 - vertFalloff) * 0.5;

        // Edge fade: fade cloud density at horizontal field boundaries
        // so the mesh doesn't have hard edges when it regenerates
        const edgeX = Math.min(vx, dimX - 1 - vx) / (dimX * 0.5);
        const edgeZ = Math.min(vz, dimZ - 1 - vz) / (dimZ * 0.5);
        const edgeFade = Math.min(edgeX, edgeZ);
        if (edgeFade < 0.15) {
          density += (0.15 - edgeFade) * 3.0;
        }

        data[vx * dimYDimZ + vy * dimZ_ + vz] = density;
      }
    }
  }

  return {
    data,
    dimX, dimY, dimZ,
    voxelSize: vs,
    originX: -xExtent,
    originY: -yExtent,
    originZ: -zExtent,
    isoLevel: 0.0,
    radius: Math.max(xExtent, yExtent, zExtent),
  };
}
