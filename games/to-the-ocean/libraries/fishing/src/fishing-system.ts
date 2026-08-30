// ============================================================================
// Fishing System — Dredge-style tension/reaction minigame
// Reusable plugin: depends on interfaces, not game-specific types
// ============================================================================

import { createRng } from "@to-the-ocean/util/rng";
import type {
    AddItemFn,
    FishingBiomeProvider,
    FishingConfig,
    FishingEventFn,
    FishingInput,
    FishingMinigame, FishingPlayer,
    FishingWeatherProvider,
    WaterProvider,
} from "./types";
import { DEFAULT_FISHING_CONFIG, FISHING_KEY, FishingMethod } from "./types";

// Player flags — games can use these or define their own
const FISHING_FLAG_FISHING = 1 << 5;
const FISHING_FLAG_SWIMMING = 1 << 4;
const FISHING_FLAG_PILOTING = 1 << 6;

// Biome constants for catch pool — games can override via catchPoolProvider
const BIOME_OCEAN = 7;
const BIOME_DEEP_OCEAN = 8;
const BIOME_TROPICAL = 4;
const BIOME_ARCTIC = 1;
const BIOME_CORAL_REEF = 9;
const BIOME_VOLCANIC = 11;
const BIOME_HELL = 13;
const BIOME_GARBAGE_PATCH = 12;

// Weather types for difficulty
const WEATHER_STORM = 4;
const WEATHER_HELL_STORM = 8;
const WEATHER_RAIN = 3;
const WEATHER_FOG = 5;
const WEATHER_OVERCAST = 2;

export interface FishingDeps {
  biomeProvider: FishingBiomeProvider;
  weatherProvider: FishingWeatherProvider;
  waterProvider: WaterProvider;
  addItem: AddItemFn;
  onEvent: FishingEventFn;
  getCatchPool?: (biome: number, method: FishingMethod, tier: number) => string[];
}

export class FishingSystem {
  private minigames = new Map<number, FishingMinigame>();
  private prevFPressed = new Map<number, boolean>();
  private deps: FishingDeps;
  private config: FishingConfig;
  private rng: () => number;

  constructor(deps: FishingDeps, config?: Partial<FishingConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_FISHING_CONFIG, ...config };
    this.rng = createRng(0xF151A1);
  }

  resetTransientState(): void {
    this.minigames.clear();
    this.prevFPressed.clear();
  }

  setRngSeed(seed: number): void {
    this.rng = createRng(seed);
  }

  tick(dt: number, input: FishingInput, players: FishingPlayer[], playerCount: number): void {
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;

      const fPressed = input.isKeyDown(i, FISHING_KEY.F);
      const fWasPressed = this.prevFPressed.get(i) ?? false;
      if (fPressed && !fWasPressed && !this.isFishing(i)) {
        if (p.flags & FISHING_FLAG_SWIMMING) {
          this.prevFPressed.set(i, fPressed);
          continue;
        }
        if (p.flags & FISHING_FLAG_PILOTING) {
          this.prevFPressed.set(i, fPressed);
          continue;
        }
        if (!this.isNearWater(p.position.x, p.position.z)) {
          this.emitFishingResult(i, false, "No water nearby!", null);
          this.prevFPressed.set(i, fPressed);
          continue;
        }
        const biome = this.deps.biomeProvider.getBiomeAt(p.position.x, p.position.z);
        this.startMinigame(i, FishingMethod.LineFishing, biome, 1);
        p.flags |= FISHING_FLAG_FISHING;
      }
      this.prevFPressed.set(i, fPressed);

      const mg = this.minigames.get(i);
      if (!mg || !mg.active) {
        if (p.flags & FISHING_FLAG_FISHING) p.flags &= ~FISHING_FLAG_FISHING;
        continue;
      }

      mg.duration += dt;

      const weatherMult = this.getWeatherDifficultyMult();
      const fishPull = mg.fishStrength * weatherMult * dt * this.config.fishPullMult;
      if (mg.reelDir > 0) {
        mg.tension += fishPull;
      } else {
        mg.tension -= fishPull * 0.3;
      }

      const isReeling = input.isMouseDown(i, 0) || input.isKeyDown(i, FISHING_KEY.SPACE);
      if (isReeling) {
        mg.tension -= this.config.reelPower * dt;
      }

      mg.tension = Math.max(0, Math.min(this.config.tensionMax, mg.tension));

      if (mg.tension <= this.config.tensionBreak) {
        this.endMinigame(i, false, "Line broke!", p);
        continue;
      }
      if (mg.tension >= this.config.tensionSlip) {
        this.endMinigame(i, false, "Fish escaped!", p);
        continue;
      }

      const inGoodZone = mg.tension > this.config.goodZoneMin && mg.tension < this.config.goodZoneMax;
      const perfectHalf = this.config.perfectZone * this.config.tensionMax * 0.5;
      const inPerfectZone = Math.abs(mg.tension - 50) < perfectHalf;
      if (inPerfectZone) {
        mg.progress += dt * this.config.perfectProgressRate * (1 - mg.fishRarity * 0.1);
      } else if (inGoodZone) {
        mg.progress += dt * this.config.progressRate * (1 - mg.fishRarity * 0.1);
      } else {
        mg.progress -= dt * this.config.progressDecay;
      }
      mg.progress = Math.max(0, Math.min(1, mg.progress));

      if (mg.progress >= 1) {
        this.endMinigame(i, true, "Caught!", p);
        continue;
      }

      if (mg.duration >= this.config.minigameDuration) {
        this.endMinigame(i, false, "Time up!", p);
        continue;
      }

      mg.reelTimer -= dt;
      if (mg.reelTimer <= 0) {
        mg.reelDir = -mg.reelDir;
        mg.reelTimer = this.config.reelDirMinTime + this.rng() * (this.config.reelDirMaxTime - this.config.reelDirMinTime);
      }
    }
  }

  startMinigame(playerIdx: number, method: FishingMethod, biome: number, equipmentTier: number): void {
    const catchPool = this.deps.getCatchPool
      ? this.deps.getCatchPool(biome, method, equipmentTier)
      : this.getDefaultCatchPool(biome, method, equipmentTier);

    const fishRarity = Math.min(5, Math.floor(this.rng() * (equipmentTier + 1) + this.rng() * 2));
    const fishSize = 0.3 + this.rng() * (1 + equipmentTier * 0.5);
    const fishStrength = 0.5 + fishRarity * 0.2 + fishSize * 0.3;

    this.minigames.set(playerIdx, {
      active: true, method, tension: 50, fishStrength, fishSize, fishRarity,
      progress: 0, duration: 0, reelDir: 1, reelTimer: 2, catchPool,
    });
  }

  private endMinigame(playerIdx: number, success: boolean, reason: string, player: FishingPlayer): void {
    const mg = this.minigames.get(playerIdx);
    if (!mg) return;
    mg.active = false;
    player.flags &= ~FISHING_FLAG_FISHING;

    let catchId: string | null = null;
    if (success) {
      if (mg.catchPool.length === 0) {
        this.emitFishingResult(playerIdx, true, "Caught nothing! (empty pool)", null);
        this.minigames.delete(playerIdx);
        return;
      }
      catchId = mg.catchPool[Math.floor(this.rng() * mg.catchPool.length)];
      const remaining = this.deps.addItem(player.inventory, catchId, 1);
      if (remaining > 0) {
        this.emitFishingResult(playerIdx, true, `Caught ${catchId}! (inventory full)`, catchId);
      } else {
        this.emitFishingResult(playerIdx, true, `Caught ${catchId}!`, catchId);
      }
    } else {
      this.emitFishingResult(playerIdx, false, reason, null);
    }

    this.minigames.delete(playerIdx);
  }

  private emitFishingResult(playerIdx: number, success: boolean, message: string, catchId: string | null): void {
    this.deps.onEvent({
      kind: "fishing_result",
      data: { playerIdx, success, message, catchId },
    });
  }

  private getDefaultCatchPool(biome: number, _method: FishingMethod, tier: number): string[] {
    const pool: string[] = [];

    switch (biome) {
      case BIOME_OCEAN:
        pool.push("mackerel", "tuna", "cod", "bass");
        if (tier >= 2) pool.push("swordfish", "marlin");
        break;
      case BIOME_DEEP_OCEAN:
        pool.push("anglerfish", "gulper_eel", "deep_sea_bass");
        if (tier >= 3) pool.push("abyssal_pearl", "colossal_squid");
        break;
      case BIOME_TROPICAL:
        pool.push("parrotfish", "angel_fish", "barracuda");
        if (tier >= 2) pool.push("mahi_mahi", "wahoo");
        break;
      case BIOME_ARCTIC:
        pool.push("arctic_char", "cod", "halibut");
        if (tier >= 2) pool.push("narwhal_horn", "arctic_lobster");
        break;
      case BIOME_CORAL_REEF:
        pool.push("clownfish", "butterfly_fish", "reef_shark");
        if (tier >= 2) pool.push("pearl", "coral_fragment");
        break;
      case BIOME_VOLCANIC:
      case BIOME_HELL:
        pool.push("lava_eel", "obsidian_fish");
        if (tier >= 3) pool.push("demon_fin", "hellstone_fish");
        break;
      case BIOME_GARBAGE_PATCH:
        pool.push("mutant_fish", "plastic_fish");
        break;
      default:
        pool.push("common_fish", "small_fish");
    }

    if (this.rng() < 0.15) {
      pool.push("discarded_net", "broken_rod", "old_boot", "bait_scraps");
    }

    if (this.rng() < 0.02) {
      const rareJunk = ["dvd", "rubber_duck", "vhs_tape", "vinyl_record", "old_radio"];
      pool.push(rareJunk[Math.floor(this.rng() * rareJunk.length)]);
    }

    return pool;
  }

  private getWeatherDifficultyMult(): number {
    const weather = this.deps.weatherProvider.getState();
    switch (weather.type) {
      case WEATHER_STORM:
      case WEATHER_HELL_STORM:
        return 1.5;
      case WEATHER_RAIN: return 1.2;
      case WEATHER_FOG: return 1.3;
      case WEATHER_OVERCAST: return 1.1;
      default: return 1.0;
    }
  }

  getMinigameState(playerIdx: number): FishingMinigame | null {
    return this.minigames.get(playerIdx) ?? null;
  }

  isFishing(playerIdx: number): boolean {
    return this.minigames.get(playerIdx)?.active ?? false;
  }

  private isNearWater(x: number, z: number): boolean {
    const patchSize = this.deps.waterProvider.getPatchSize() || 4;
    const origin = this.deps.waterProvider.getOrigin();
    const WATER_GRID = 256;

    const offsets = [
      [0, 0], [10, 0], [-10, 0], [0, 10], [0, -10],
      [20, 0], [-20, 0], [0, 20], [0, -20],
    ];
    for (let i = 0; i < offsets.length; i++) {
      const sx = x + offsets[i][0];
      const sz = z + offsets[i][1];
      const gx = ((sx - origin.x) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
      const gz = ((sz - origin.z) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
      const waterHeight = this.deps.waterProvider.sampleHeight(gx, gz);
      if (waterHeight > -100) return true;
    }
    return false;
  }
}
