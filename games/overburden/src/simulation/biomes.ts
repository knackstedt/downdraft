// ============================================================================
// Overburden — biome system
//
// A low-frequency noise field assigns each world X column a biome. Biomes
// control surface height, surface/dirt block types, tree species, and cave
// parameters. The world is a horizontal cylinder (wraps east↔west), so biomes
// vary primarily along X — you walk east/west to find deserts, oceans, and
// mountains.
//
// Two noise fields drive biome selection:
//   elevationNoise — very low freq, controls ocean ↔ land ↔ mountain
//   aridityNoise   — low freq, controls desert ↔ plains (land only)
//
// Biome boundaries use smoothstep interpolation so surface height transitions
// are gradual (no sheer cliffs at biome borders).
//
// Layer terminology (see AGENTS.md / grid-builder-worker.ts):
//   Layer 1 = foreground front (Z=0)     — main terrain
//   Layer 2 = foreground back (Z=-1)     — same terrain, darker
//   Layer 3 = background main (Z=-2)     — trees + back wall
//   Layer 4 = back wall only (Z=-3)      — terrain back wall, no trees
// Caves carve layers 1 & 2 (foreground) only; layers 3 & 4 (background)
// remain as stone cave walls.
// ============================================================================

import { fbm2D } from "@downdraft/core";
import { SEA_LEVEL, SURFACE_Y } from "../shared/constants";

// --- Biome types ---
export type Biome = "ocean" | "plains" | "desert" | "mountain";

export interface BiomeInfo {
  biome: Biome;
  /** Surface height (world Y) at this column. */
  surfaceY: number;
  /** Dirt/sand depth below the surface block. */
  dirtDepth: number;
  /** Tree spawn chance per grass/surface cell (0 = no trees). */
  treeChance: number;
  /** Elevation noise value [0,1) at this column. */
  elevation: number;
  /** Aridity noise value [0,1) at this column. */
  aridity: number;
}

// --- Noise scales ---
// Very low frequency for large biome regions (hundreds of blocks wide).
const ELEVATION_SCALE = 0.0008; // ~1250-block wavelength → large biomes
const ARIDITY_SCALE = 0.0006;   // ~1670-block wavelength → large deserts
const DETAIL_SCALE = 0.005;     // higher freq surface detail (rolling hills)

// --- Biome thresholds ---
// Tuned for fbm2D with value noise, which tends to cluster around 0.5 and
// rarely hits the extremes of [0, 1). These thresholds produce roughly:
//   ~15% ocean, ~50% plains, ~20% desert, ~15% mountain
const OCEAN_THRESHOLD = 0.38;    // elevation < this → ocean
const MOUNTAIN_THRESHOLD = 0.62; // elevation > this → mountain
const DESERT_THRESHOLD = 0.60;   // aridity > this (and land) → desert

// --- Smoothstep ---
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Compute the biome + surface info for a given world X column.
 * Deterministic: same wx + seed always produces the same result.
 */
export function biomeAt(wx: number, seed: number): BiomeInfo {
  const elevation = fbm2D(wx * ELEVATION_SCALE, 0, seed + 100, 4, 2.0, 0.5);
  const aridity = fbm2D(wx * ARIDITY_SCALE, 0, seed + 200, 3, 2.0, 0.5);
  const detail = fbm2D(wx * DETAIL_SCALE, 0, seed, 4, 2.0, 0.5);

  // --- Determine biome from elevation + aridity ---
  let biome: Biome;
  if (elevation < OCEAN_THRESHOLD) {
    biome = "ocean";
  } else if (elevation > MOUNTAIN_THRESHOLD) {
    biome = "mountain";
  } else if (aridity > DESERT_THRESHOLD) {
    biome = "desert";
  } else {
    biome = "plains";
  }

  // --- Surface height with smooth transitions ---
  // The elevation noise maps to a continuous height curve:
  //   0.0 → SEA_LEVEL - 45  (deep ocean floor)
  //   OCEAN_THRESHOLD → SEA_LEVEL - 3  (shoreline, just below sea level)
  //   mid-land → SURFACE_Y  (plains/desert)
  //   MOUNTAIN_THRESHOLD → SURFACE_Y + 25  (mountain base)
  //   1.0 → SURFACE_Y + 140  (mountain peak)
  let baseHeight: number;

  if (elevation < OCEAN_THRESHOLD) {
    // Ocean: floor is BELOW sea level (Y > SEA_LEVEL since Y increases downward).
    // t=0 (deepest) → SEA_LEVEL + 45, t=1 (shore) → SEA_LEVEL + 8
    const t = smoothstep(elevation / OCEAN_THRESHOLD);
    baseHeight = (SEA_LEVEL + 45) - Math.floor(t * 37); // SEA_LEVEL+45 to SEA_LEVEL+8
  } else if (elevation < MOUNTAIN_THRESHOLD) {
    // Land (plains/desert): interpolate from shoreline to mountain base
    const t = smoothstep((elevation - OCEAN_THRESHOLD) / (MOUNTAIN_THRESHOLD - OCEAN_THRESHOLD));
    baseHeight = (SEA_LEVEL - 3) + Math.floor(t * (SURFACE_Y - SEA_LEVEL + 33)); // SEA_LEVEL-3 to SURFACE_Y+30
  } else {
    // Mountain: interpolate from mountain base to peak
    const t = smoothstep((elevation - MOUNTAIN_THRESHOLD) / (1 - MOUNTAIN_THRESHOLD));
    baseHeight = (SURFACE_Y + 30) + Math.floor(t * 120); // SURFACE_Y+30 to SURFACE_Y+150
  }

  // --- Detail noise (amplitude varies by biome) ---
  let detailAmp: number;
  switch (biome) {
    case "ocean": detailAmp = 5; break;    // gentle undulating floor
    case "desert": detailAmp = 6; break;   // very flat dunes
    case "mountain": detailAmp = 25; break; // jagged peaks
    default: detailAmp = 18; break;        // rolling hills
  }
  const detailOffset = Math.floor(detail * detailAmp * 2 - detailAmp);

  const surfaceY = baseHeight + detailOffset;

  // --- Dirt depth varies by biome ---
  let dirtDepth: number;
  switch (biome) {
    case "ocean": dirtDepth = 3 + Math.floor(detail * 4); break;     // 3-6 sand
    case "desert": dirtDepth = 8 + Math.floor(detail * 8); break;    // 8-15 sand
    case "mountain": dirtDepth = 2 + Math.floor(detail * 3); break;  // 2-4 dirt (thin)
    default: dirtDepth = 4 + Math.floor(detail * 6); break;          // 4-9 dirt
  }

  // --- Tree chance varies by biome ---
  let treeChance: number;
  switch (biome) {
    case "ocean": treeChance = 0; break;     // no trees underwater
    case "desert": treeChance = 0.005; break; // rare (occasional palm)
    case "mountain": treeChance = 0.03; break; // sparse (spruce)
    default: treeChance = 0.05; break;        // normal density
  }

  return { biome, surfaceY, dirtDepth, treeChance, elevation, aridity };
}

/**
 * Check whether a column is in a transition zone between two biomes.
 * Used by terrain-gen to blend surface blocks near biome borders.
 * Returns a blend factor [0, 1] where 0 = fully in the current biome,
 * 1 = fully in the next biome.
 */
export function biomeBlendFactor(wx: number, seed: number): number {
  // Use the raw elevation noise distance from thresholds to determine
  // how close we are to a biome boundary.
  const info = biomeAt(wx, seed);
  const e = info.elevation;
  const blendWidth = 0.04; // ±4% of noise range for blending

  if (e < OCEAN_THRESHOLD + blendWidth && e > OCEAN_THRESHOLD - blendWidth) {
    return clamp01(1 - Math.abs(e - OCEAN_THRESHOLD) / blendWidth);
  }
  if (e < MOUNTAIN_THRESHOLD + blendWidth && e > MOUNTAIN_THRESHOLD - blendWidth) {
    return clamp01(1 - Math.abs(e - MOUNTAIN_THRESHOLD) / blendWidth);
  }
  return 0;
}
