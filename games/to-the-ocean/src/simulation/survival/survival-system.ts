// ============================================================================
// Survival System — re-exports from @downdraft/plugin-survival
// ============================================================================
// The game's BiomeSystem + ChunkManager are combined into a SurvivalBiomeProvider.
// SimPlayer is structurally compatible with the plugin's SurvivalPlayer interface.
// PLR_FLAG values match SURVIVAL_FLAGS bit positions.
//

import { DEFAULT_SURVIVAL_CONFIG, SurvivalSystem as PluginSurvivalSystem, type SurvivalBiomeProvider, type SurvivalConfig } from "@downdraft/plugin-survival";
import {
    NIGHT_END_FRAC,
    NIGHT_START_FRAC,
    PLAYER_FALL_DAMAGE_MULTIPLIER,
    PLAYER_FALL_DAMAGE_THRESHOLD,
    PLAYER_OXYGEN_DRAIN_RATE, PLAYER_OXYGEN_RECOVER_RATE,
} from "../../shared/constants";
import { BiomeType } from "../../shared/types";
import { BiomeSystem } from "../world/biome-system";
import { ChunkManager } from "../world/chunk-manager";

const GAME_SURVIVAL_CONFIG: SurvivalConfig = {
  ...DEFAULT_SURVIVAL_CONFIG,
  oxygenDrainRate: PLAYER_OXYGEN_DRAIN_RATE,
  oxygenRecoverRate: PLAYER_OXYGEN_RECOVER_RATE,
  fallDamageThreshold: PLAYER_FALL_DAMAGE_THRESHOLD,
  fallDamageMultiplier: PLAYER_FALL_DAMAGE_MULTIPLIER,
  nightStartFrac: NIGHT_START_FRAC,
  nightEndFrac: NIGHT_END_FRAC,
};

export class SurvivalBiomeAdapter implements SurvivalBiomeProvider {
  constructor(
    private chunkManager: ChunkManager,
    private biomeSystem: BiomeSystem,
  ) {}

  getBiomeAt(worldX: number, worldZ: number): number {
    return this.chunkManager.getBiomeAt(worldX, worldZ);
  }

  isColdBiome(biome: number): boolean {
    return this.biomeSystem.isColdBiome(biome as BiomeType);
  }

  isHotBiome(biome: number): boolean {
    return this.biomeSystem.isHotBiome(biome as BiomeType);
  }

  getAmbientTemperature(biome: number, timeOfDay: number): number {
    return this.biomeSystem.getAmbientTemperature(biome as BiomeType, timeOfDay);
  }
}

export class SurvivalSystem extends PluginSurvivalSystem {
  constructor(rules: Record<string, number | boolean>) {
    super(rules, GAME_SURVIVAL_CONFIG);
  }
}
