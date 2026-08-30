// ============================================================================
// Survival System — hunger, thirst, oxygen, temperature, sleep
// Reusable plugin: depends on interfaces, not game-specific types
// ============================================================================

import type { SurvivalBiomeProvider, SurvivalConfig, SurvivalPlayer } from "./types";
import { DEFAULT_SURVIVAL_CONFIG, SURVIVAL_FLAGS } from "./types";

// Minimal weather interface — only what survival needs
interface WeatherLike {
  getTemperature(): number;
}

export class SurvivalSystem {
  private rules: Record<string, number | boolean>;
  private config: SurvivalConfig;
  private prevY: number[] = [];

  constructor(rules: Record<string, number | boolean>, config?: Partial<SurvivalConfig>) {
    this.rules = rules;
    this.config = { ...DEFAULT_SURVIVAL_CONFIG, ...config };
  }

  updateRules(rules: Record<string, number | boolean>): void {
    this.rules = rules;
  }

  tick(
    dt: number,
    players: SurvivalPlayer[],
    playerCount: number,
    timeOfDay: number,
    weather: WeatherLike,
    biomeProvider: SurvivalBiomeProvider,
  ): void {
    const hungerRate = (this.rules.hungerRate as number) || 0.8;
    const thirstRate = (this.rules.thirstRate as number) || 1.0;
    const oxygenRate = (this.rules.oxygenRate as number) || this.config.oxygenDrainRate;
    const tempRate = (this.rules.temperatureRate as number) || 2.0;

    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;

      const biome = biomeProvider.getBiomeAt(p.position.x, p.position.z);
      const isUnderwater = (p.flags & SURVIVAL_FLAGS.UNDERWATER) !== 0;
      const isNoclip = (p.flags & SURVIVAL_FLAGS.NOCLIP) !== 0;
      const isCold = biomeProvider.isColdBiome(biome);
      const isHot = biomeProvider.isHotBiome(biome);
      const weatherTemp = weather.getTemperature();

      if (isUnderwater && !isNoclip) {
        p.oxygen = Math.max(0, p.oxygen - oxygenRate * dt);
        if (p.oxygen <= 0) {
          p.health -= 5 * dt;
        }
      } else {
        p.oxygen = Math.min(p.maxOxygen, p.oxygen + this.config.oxygenRecoverRate * dt);
      }

      p.hunger = Math.max(0, p.hunger - hungerRate * dt);
      if (p.hunger <= 0) {
        p.health -= 2 * dt;
      }

      p.thirst = Math.max(0, p.thirst - thirstRate * dt);
      if (p.thirst <= 0) {
        p.health -= 3 * dt;
      }

      const ambientTemp = biomeProvider.getAmbientTemperature(biome, timeOfDay) + (weatherTemp - 20) * 0.3;
      if (isCold && ambientTemp < 10) {
        p.temperature = Math.max(0, p.temperature - tempRate * dt);
      } else if (isHot && ambientTemp > 35) {
        p.temperature = Math.min(100, p.temperature + tempRate * dt);
      } else {
        p.temperature += (50 - p.temperature) * 0.01 * dt;
      }

      if (p.temperature < 20) {
        p.health -= (20 - p.temperature) * 0.1 * dt;
      } else if (p.temperature > 80) {
        p.health -= (p.temperature - 80) * 0.1 * dt;
      }

      if (!isNoclip && this.prevY[i] !== undefined) {
        const fallDist = this.prevY[i] - p.position.y;
        if (fallDist > this.config.fallDamageThreshold && fallDist > 0) {
          p.health -= (fallDist - this.config.fallDamageThreshold) * this.config.fallDamageMultiplier;
        }
      }
      this.prevY[i] = p.position.y;

      if (p.health <= 0) {
        p.health = 0;
        p.flags |= SURVIVAL_FLAGS.DEAD;
      }

      if (p.flags & SURVIVAL_FLAGS.SLEEPING) {
        p.health = Math.min(p.maxHealth, p.health + 5 * dt);
      }
    }
  }

  eat(player: SurvivalPlayer, amount: number): void {
    amount = Math.max(0, amount);
    player.hunger = Math.max(0, Math.min(100, player.hunger + amount));
  }

  drink(player: SurvivalPlayer, amount: number): void {
    amount = Math.max(0, amount);
    player.thirst = Math.max(0, Math.min(100, player.thirst + amount));
  }

  sleep(player: SurvivalPlayer): void {
    player.flags |= SURVIVAL_FLAGS.SLEEPING;
  }

  wake(player: SurvivalPlayer): void {
    player.flags &= ~SURVIVAL_FLAGS.SLEEPING;
  }

  respawn(player: SurvivalPlayer, bedPosition: { x: number; y: number; z: number }): void {
    player.health = player.maxHealth;
    player.hunger = 50;
    player.thirst = 50;
    player.oxygen = player.maxOxygen;
    player.temperature = 50;
    player.flags &= ~SURVIVAL_FLAGS.DEAD;
    player.flags &= ~SURVIVAL_FLAGS.SLEEPING;
    player.position = { ...bedPosition };
  }
}
