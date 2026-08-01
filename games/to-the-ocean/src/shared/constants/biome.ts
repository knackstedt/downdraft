// Biome properties, security levels, port capabilities, and island resources

import { BiomeType, IslandSize, PortSize, SecurityLevel } from "../types";

// --- Biome Properties ---

export const BIOME_TEMPERATURES: Record<BiomeType, { min: number; max: number }> = {
  [BiomeType.Lake]: { min: 15, max: 25 },
  [BiomeType.Arctic]: { min: -20, max: 5 },
  [BiomeType.Desert]: { min: 30, max: 45 },
  [BiomeType.BorealForest]: { min: -5, max: 15 },
  [BiomeType.Tropical]: { min: 25, max: 35 },
  [BiomeType.SubTropical]: { min: 20, max: 30 },
  [BiomeType.Freshwater]: { min: 10, max: 22 },
  [BiomeType.Ocean]: { min: 15, max: 25 },
  [BiomeType.DeepOcean]: { min: 5, max: 15 },
  [BiomeType.CoralReef]: { min: 22, max: 30 },
  [BiomeType.KelpForest]: { min: 10, max: 18 },
  [BiomeType.Volcanic]: { min: 35, max: 60 },
  [BiomeType.GarbagePatch]: { min: 15, max: 25 },
  [BiomeType.Hell]: { min: 50, max: 80 },
};

export const BIOME_NAMES: Record<BiomeType, string> = {
  [BiomeType.Lake]: "Lake",
  [BiomeType.Arctic]: "Arctic",
  [BiomeType.Desert]: "Desert",
  [BiomeType.BorealForest]: "Boreal Forest",
  [BiomeType.Tropical]: "Tropical",
  [BiomeType.SubTropical]: "Sub-Tropical",
  [BiomeType.Freshwater]: "Freshwater",
  [BiomeType.Ocean]: "Ocean",
  [BiomeType.DeepOcean]: "Deep Ocean",
  [BiomeType.CoralReef]: "Coral Reef",
  [BiomeType.KelpForest]: "Kelp Forest",
  [BiomeType.Volcanic]: "Volcanic",
  [BiomeType.GarbagePatch]: "Garbage Patch",
  [BiomeType.Hell]: "Hell",
};

export const SECURITY_COLORS: Record<SecurityLevel, string> = {
  [SecurityLevel.Safe]: "#4ade80",
  [SecurityLevel.Moderate]: "#facc15",
  [SecurityLevel.High]: "#f87171",
  [SecurityLevel.Extreme]: "#7f1d1d",
};

export const SECURITY_NAMES: Record<SecurityLevel, string> = {
  [SecurityLevel.Safe]: "Safe",
  [SecurityLevel.Moderate]: "Moderate",
  [SecurityLevel.High]: "High Danger",
  [SecurityLevel.Extreme]: "Extreme Danger",
};

// --- Port Properties ---

export const PORT_CAPABILITIES: Record<PortSize, string[]> = {
  [PortSize.Small]: ["trading", "fishing", "inn", "supplies", "licenses"],
  [PortSize.Medium]: ["trading", "fishing", "inn", "supplies", "licenses", "shipyard", "hull_modification", "storage"],
  [PortSize.Large]: ["trading", "fishing", "inn", "supplies", "licenses", "shipyard", "hull_modification", "storage"],
};

export const PORT_MAX_HULL_SIZE: Record<PortSize, number> = {
  [PortSize.Small]: 0,        // can't modify hull
  [PortSize.Medium]: 50,      // limited hull volume
  [PortSize.Large]: 200,     // full hull volume
};

// --- Island Properties ---

export const ISLAND_RESOURCES: Record<IslandSize, number> = {
  [IslandSize.Small]: 5,
  [IslandSize.Medium]: 15,
  [IslandSize.Large]: 30,
};
