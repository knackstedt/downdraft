// ============================================================================
// Biome System — biome properties, effects, and queries
// ============================================================================

import { BiomeType } from "../../shared/types";
import { BIOME_TEMPERATURES, BIOME_NAMES } from "../../shared/constants";

export class BiomeSystem {
  getBiomeAt(worldX: number, worldZ: number): BiomeType {
    return BiomeType.Ocean;
  }

  getBiomeName(biome: BiomeType): string {
    return BIOME_NAMES[biome] ?? "Unknown";
  }

  getTemperatureRange(biome: BiomeType): { min: number; max: number } {
    return BIOME_TEMPERATURES[biome] ?? { min: 15, max: 25 };
  }

  getAmbientTemperature(biome: BiomeType, timeOfDay: number): number {
    const range = this.getTemperatureRange(biome);
    // Temperature varies through the day
    const dayFactor = Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
    const base = range.min + (range.max - range.min) * dayFactor;
    return base;
  }

  isColdBiome(biome: BiomeType): boolean {
    return biome === BiomeType.Arctic || biome === BiomeType.BorealForest || biome === BiomeType.DeepOcean;
  }

  isHotBiome(biome: BiomeType): boolean {
    return biome === BiomeType.Desert || biome === BiomeType.Volcanic || biome === BiomeType.Hell;
  }

  isUnderwaterBiome(biome: BiomeType): boolean {
    return biome === BiomeType.DeepOcean || biome === BiomeType.CoralReef || biome === BiomeType.KelpForest ||
           biome === BiomeType.Volcanic || biome === BiomeType.Hell;
  }

  getVisibilityModifier(biome: BiomeType): number {
    switch (biome) {
      case BiomeType.GarbagePatch: return 0.6;
      case BiomeType.DeepOcean: return 0.7;
      case BiomeType.Hell: return 0.5;
      case BiomeType.Volcanic: return 0.7;
      default: return 1.0;
    }
  }

  getAudioModifier(biome: BiomeType): { ambient: string; intensity: number } {
    switch (biome) {
      case BiomeType.Arctic:
        return { ambient: "wind_cold", intensity: 0.8 };
      case BiomeType.Tropical:
      case BiomeType.SubTropical:
        return { ambient: "tropical", intensity: 0.5 };
      case BiomeType.Volcanic:
      case BiomeType.Hell:
        return { ambient: "volcanic_rumble", intensity: 0.9 };
      case BiomeType.DeepOcean:
        return { ambient: "deep_ocean", intensity: 0.6 };
      case BiomeType.GarbagePatch:
        return { ambient: "industrial", intensity: 0.4 };
      default:
        return { ambient: "ocean_waves", intensity: 0.5 };
    }
  }

  getGuiColorModifier(biome: BiomeType, securityLevel: number): { r: number; g: number; b: number } {
    // Base biome tint
    let r = 1, g = 1, b = 1;
    switch (biome) {
      case BiomeType.Arctic: r = 0.8; g = 0.9; b = 1.0; break;
      case BiomeType.Volcanic: r = 1.0; g = 0.7; b = 0.5; break;
      case BiomeType.Hell: r = 0.8; g = 0.3; b = 0.2; break;
      case BiomeType.Tropical: r = 0.9; g = 1.0; b = 0.8; break;
      case BiomeType.GarbagePatch: r = 0.8; g = 0.8; b = 0.7; break;
    }
    // Security level shifts toward red
    if (securityLevel >= 2) {
      r = Math.min(1, r + 0.2);
      g = Math.max(0.3, g - 0.3);
      b = Math.max(0.3, b - 0.3);
    }
    if (securityLevel >= 3) {
      r = Math.min(1, r + 0.2);
      g = Math.max(0.1, g - 0.2);
      b = Math.max(0.1, b - 0.2);
    }
    return { r, g, b };
  }
}
