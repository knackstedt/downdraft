// ============================================================================
// Wildlife Definitions — all wildlife species
// ============================================================================

import { WildlifeSpecies, EntityType, BiomeType, FishingMethod } from "../types";

export const WILDLIFE: Record<string, WildlifeSpecies> = {
  // Fish
  mackerel: { id: "mackerel", name: "Mackerel", type: EntityType.Fish, health: 10, speed: 2, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean], minDepth: 0, maxDepth: 50, isHostile: false, isTameable: false, drops: [{ itemId: "mackerel", chance: 1, quantity: 1 }], spawnWeight: 10, minGroupSize: 3, maxGroupSize: 8 },
  tuna: { id: "tuna", name: "Tuna", type: EntityType.Fish, health: 20, speed: 4, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.Tropical], minDepth: 0, maxDepth: 80, isHostile: false, isTameable: false, drops: [{ itemId: "tuna", chance: 1, quantity: 1 }], spawnWeight: 5, minGroupSize: 1, maxGroupSize: 4 },
  cod: { id: "cod", name: "Cod", type: EntityType.Fish, health: 15, speed: 1.5, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.Arctic], minDepth: 0, maxDepth: 100, isHostile: false, isTameable: false, drops: [{ itemId: "cod", chance: 1, quantity: 1 }], spawnWeight: 8, minGroupSize: 2, maxGroupSize: 6 },
  parrotfish: { id: "parrotfish", name: "Parrotfish", type: EntityType.Fish, health: 8, speed: 1, damage: 0, detectionRange: 0, biomes: [BiomeType.CoralReef], minDepth: 0, maxDepth: 20, isHostile: false, isTameable: false, drops: [{ itemId: "parrotfish", chance: 1, quantity: 1 }], spawnWeight: 8, minGroupSize: 2, maxGroupSize: 5 },

  // Hostile
  shark: { id: "shark", name: "Shark", type: EntityType.Shark, health: 80, speed: 5, damage: 30, detectionRange: 30, biomes: [BiomeType.Ocean, BiomeType.DeepOcean, BiomeType.Tropical, BiomeType.GarbagePatch], minDepth: 0, maxDepth: 100, isHostile: true, isTameable: false, drops: [{ itemId: "blubber", chance: 0.5, quantity: 1 }], spawnWeight: 3, minGroupSize: 1, maxGroupSize: 3 },
  eel: { id: "eel", name: "Electric Eel", type: EntityType.Eel, health: 30, speed: 1, damage: 20, detectionRange: 5, biomes: [BiomeType.DeepOcean, BiomeType.KelpForest, BiomeType.Volcanic], minDepth: 10, maxDepth: 200, isHostile: true, isTameable: false, drops: [], spawnWeight: 2, minGroupSize: 1, maxGroupSize: 1 },
  jellyfish: { id: "jellyfish", name: "Jellyfish", type: EntityType.Jellyfish, health: 15, speed: 0.3, damage: 5, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.DeepOcean, BiomeType.CoralReef, BiomeType.GarbagePatch], minDepth: 0, maxDepth: 50, isHostile: false, isTameable: false, drops: [], spawnWeight: 4, minGroupSize: 3, maxGroupSize: 10 },
  devil_shrimp: { id: "devil_shrimp", name: "Devil Shrimp", type: EntityType.DevilShrimp, health: 120, speed: 3, damage: 50, detectionRange: 40, biomes: [BiomeType.Volcanic, BiomeType.Hell], minDepth: 20, maxDepth: 300, isHostile: true, isTameable: false, drops: [{ itemId: "obsidian", chance: 0.3, quantity: 1 }], spawnWeight: 1, minGroupSize: 1, maxGroupSize: 1 },

  // Passive
  whale: { id: "whale", name: "Whale", type: EntityType.Whale, health: 200, speed: 1, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.DeepOcean, BiomeType.Arctic], minDepth: 0, maxDepth: 50, isHostile: false, isTameable: false, drops: [{ itemId: "blubber", chance: 1, quantity: 5 }], spawnWeight: 1, minGroupSize: 1, maxGroupSize: 2 },
  dolphin: { id: "dolphin", name: "Dolphin", type: EntityType.Dolphin, health: 60, speed: 4, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.Tropical], minDepth: 0, maxDepth: 30, isHostile: false, isTameable: true, drops: [], spawnWeight: 2, minGroupSize: 2, maxGroupSize: 6 },
  turtle: { id: "turtle", name: "Sea Turtle", type: EntityType.Turtle, health: 50, speed: 0.5, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.CoralReef, BiomeType.KelpForest, BiomeType.Arctic], minDepth: 0, maxDepth: 30, isHostile: false, isTameable: true, drops: [], spawnWeight: 2, minGroupSize: 1, maxGroupSize: 3 },
  crustacean: { id: "crustacean", name: "Crab", type: EntityType.Crustacean, health: 20, speed: 0.5, damage: 0, detectionRange: 0, biomes: [BiomeType.Ocean, BiomeType.CoralReef, BiomeType.KelpForest, BiomeType.Arctic, BiomeType.GarbagePatch], minDepth: 10, maxDepth: 50, isHostile: false, isTameable: false, drops: [], spawnWeight: 5, minGroupSize: 1, maxGroupSize: 4 },
  coral: { id: "coral", name: "Coral", type: EntityType.Coral, health: 10, speed: 0, damage: 0, detectionRange: 0, biomes: [BiomeType.CoralReef], minDepth: 5, maxDepth: 20, isHostile: false, isTameable: false, drops: [{ itemId: "coral_fragment", chance: 1, quantity: 1 }], spawnWeight: 6, minGroupSize: 1, maxGroupSize: 1 },

  // Gag
  moose: { id: "moose", name: "Underwater Moose", type: EntityType.Moose, health: 150, speed: 0.2, damage: 0, detectionRange: 0, biomes: [BiomeType.DeepOcean], minDepth: 30, maxDepth: 50, isHostile: false, isTameable: false, drops: [], spawnWeight: 0.1, minGroupSize: 1, maxGroupSize: 1 },
};

export function getWildlife(id: string): WildlifeSpecies | null {
  return WILDLIFE[id] ?? null;
}
