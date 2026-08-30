// ============================================================================
// Survival Module — Types and Interfaces
// ============================================================================

import type { BiomeProvider, PlayerState } from "@to-the-ocean/shared/plugin-interfaces";

// Player flags — games can use these or define their own
export const SURVIVAL_FLAGS = {
  SLEEPING: 1 << 0,
  DEAD: 1 << 1,
  UNDERWATER: 1 << 2,
  NOCLIP: 1 << 8,
} as const;

// Player interface for survival system — games implement this or use a structurally compatible type
export interface SurvivalPlayer extends PlayerState {
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  maxOxygen: number;
  temperature: number;
}

// Biome provider interface for survival — extends BiomeProvider with temperature queries
export interface SurvivalBiomeProvider extends BiomeProvider {
  isColdBiome(biome: number): boolean;
  isHotBiome(biome: number): boolean;
  getAmbientTemperature(biome: number, timeOfDay: number): number;
}

export interface SurvivalConfig {
  oxygenDrainRate: number;
  oxygenRecoverRate: number;
  fallDamageThreshold: number;
  fallDamageMultiplier: number;
  nightStartFrac: number;
  nightEndFrac: number;
}

export const DEFAULT_SURVIVAL_CONFIG: SurvivalConfig = {
  oxygenDrainRate: 5,
  oxygenRecoverRate: 20,
  fallDamageThreshold: 8,
  fallDamageMultiplier: 5,
  nightStartFrac: 0.7,
  nightEndFrac: 0.25,
};
