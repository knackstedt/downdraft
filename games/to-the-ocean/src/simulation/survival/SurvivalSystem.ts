// ============================================================================
// Survival System — hunger, thirst, oxygen, temperature, sleep
// ============================================================================

import { SimPlayer } from "../Simulation";
import { EntityFlags } from "../../shared/types";
import { BiomeSystem } from "../world/BiomeSystem";
import { WeatherSystem } from "../weather/WeatherSystem";
import { ChunkManager } from "../world/ChunkManager";
import { BiomeType, CameraMode } from "../../shared/types";
import {
  PLAYER_OXYGEN_DRAIN_RATE, PLAYER_OXYGEN_RECOVER_RATE,
  PLAYER_FALL_DAMAGE_THRESHOLD, PLAYER_FALL_DAMAGE_MULTIPLIER,
  NIGHT_START_FRAC, NIGHT_END_FRAC,
} from "../../shared/constants";
import { PLR_FLAG } from "../../shared/sim-buffer";

export class SurvivalSystem {
  private rules: Record<string, number | boolean>;
  private prevY: number[] = [];

  constructor(rules: Record<string, number | boolean>) {
    this.rules = rules;
  }

  updateRules(rules: Record<string, number | boolean>): void {
    this.rules = rules;
  }

  tick(
    dt: number,
    players: SimPlayer[],
    playerCount: number,
    timeOfDay: number,
    weather: WeatherSystem,
    biomeSystem: BiomeSystem,
    chunkManager: ChunkManager,
  ): void {
    const hungerRate = (this.rules.hungerRate as number) || 0.8;
    const thirstRate = (this.rules.thirstRate as number) || 1.0;
    const oxygenRate = (this.rules.oxygenRate as number) || 5;
    const tempRate = (this.rules.temperatureRate as number) || 2.0;

    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;

      // Get biome at player position
      const biome = chunkManager.getBiomeAt(p.position.x, p.position.z) as BiomeType;
      const isUnderwater = (p.flags & PLR_FLAG.UNDERWATER) !== 0;
      const isNoclip = (p.flags & PLR_FLAG.NOCLIP) !== 0;
      const isCold = biomeSystem.isColdBiome(biome);
      const isHot = biomeSystem.isHotBiome(biome);
      const weatherTemp = weather.getTemperature();

      // Oxygen (skip when noclipping — dev vclip doesn't drown)
      if (isUnderwater && !isNoclip) {
        p.oxygen = Math.max(0, p.oxygen - oxygenRate * dt);
        if (p.oxygen <= 0) {
          p.health -= 5 * dt; // drowning damage
        }
      } else {
        p.oxygen = Math.min(p.maxOxygen, p.oxygen + PLAYER_OXYGEN_RECOVER_RATE * dt);
      }

      // Hunger
      p.hunger = Math.max(0, p.hunger - hungerRate * dt);
      if (p.hunger <= 0) {
        p.health -= 2 * dt; // starvation damage
      }

      // Thirst
      p.thirst = Math.max(0, p.thirst - thirstRate * dt);
      if (p.thirst <= 0) {
        p.health -= 3 * dt; // dehydration damage
      }

      // Temperature
      const ambientTemp = biomeSystem.getAmbientTemperature(biome, timeOfDay) + (weatherTemp - 20) * 0.3;
      if (isCold && ambientTemp < 10) {
        p.temperature = Math.max(0, p.temperature - tempRate * dt);
      } else if (isHot && ambientTemp > 35) {
        p.temperature = Math.min(100, p.temperature + tempRate * dt);
      } else {
        // Drift toward 50 (comfortable)
        p.temperature += (50 - p.temperature) * 0.01 * dt;
      }

      // Temperature damage
      if (p.temperature < 20) {
        p.health -= (20 - p.temperature) * 0.1 * dt;
      } else if (p.temperature > 80) {
        p.health -= (p.temperature - 80) * 0.1 * dt;
      }

      // Fall damage (skip when noclipping — vclip flight isn't falling)
      if (!isNoclip && this.prevY[i] !== undefined) {
        const fallDist = this.prevY[i] - p.position.y;
        const fallSpeed = this.prevY[i] - p.position.y;
        if (fallDist > PLAYER_FALL_DAMAGE_THRESHOLD && fallSpeed > 0) {
          p.health -= (fallDist - PLAYER_FALL_DAMAGE_THRESHOLD) * PLAYER_FALL_DAMAGE_MULTIPLIER;
        }
      }
      this.prevY[i] = p.position.y;

      // Death check
      if (p.health <= 0) {
        p.health = 0;
        p.flags |= PLR_FLAG.DEAD;
      }

      // Sleeping: recover health slowly
      if (p.flags & PLR_FLAG.SLEEPING) {
        p.health = Math.min(p.maxHealth, p.health + 5 * dt);
        // Can't move while sleeping
      }
    }
  }

  // Player eats food
  eat(player: SimPlayer, amount: number): void {
    player.hunger = Math.min(100, player.hunger + amount);
  }

  // Player drinks water
  drink(player: SimPlayer, amount: number): void {
    player.thirst = Math.min(100, player.thirst + amount);
  }

  // Player goes to sleep
  sleep(player: SimPlayer): void {
    player.flags |= PLR_FLAG.SLEEPING;
  }

  // Player wakes up
  wake(player: SimPlayer): void {
    player.flags &= ~PLR_FLAG.SLEEPING;
  }

  // Player respawns at bed
  respawn(player: SimPlayer, bedPosition: { x: number; y: number; z: number }): void {
    player.health = player.maxHealth;
    player.hunger = 50;
    player.thirst = 50;
    player.oxygen = player.maxOxygen;
    player.temperature = 50;
    player.flags &= ~PLR_FLAG.DEAD;
    player.flags &= ~PLR_FLAG.SLEEPING;
    player.position = { ...bedPosition };
  }
}
