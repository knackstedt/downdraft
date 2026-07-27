// ============================================================================
// Fishing System — Dredge-style tension/reaction minigame
// ============================================================================

import { InputBufferReader, KEY } from "../../shared/input-buffer";
import { SimPlayer } from "../Simulation";
import { BiomeSystem } from "../world/BiomeSystem";
import { WeatherSystem } from "../weather/WeatherSystem";
import { FishingMethod, BiomeType, WeatherType } from "../../shared/types";
import {
  FISHING_TENSION_MAX, FISHING_TENSION_BREAK, FISHING_TENSION_SLIP,
  FISHING_PERFECT_ZONE, FISHING_MINIGAME_DURATION,
  FISHING_REEL_POWER, FISHING_FISH_PULL_MULT,
  FISHING_GOOD_ZONE_MIN, FISHING_GOOD_ZONE_MAX,
  FISHING_PROGRESS_RATE, FISHING_PERFECT_PROGRESS_RATE,
  FISHING_PROGRESS_DECAY,
  FISHING_REEL_DIR_MIN_TIME, FISHING_REEL_DIR_MAX_TIME,
  FISHING_CAST_RANGE,
} from "../../shared/constants";
import { PLR_FLAG } from "../../shared/sim-buffer";
import { addItem } from "../inventory/InventorySystem";
import { WaterBufferWriter } from "../../shared/water-buffer";
import { SimToMainMessage } from "../../shared/types";

interface FishingMinigame {
  active: boolean;
  method: FishingMethod;
  tension: number;       // 0-100, target zone is FISHING_TENSION_BREAK..FISHING_TENSION_SLIP
  fishStrength: number;   // how hard the fish pulls
  fishSize: number;
  fishRarity: number;
  progress: number;       // 0-1, when 1 = caught
  duration: number;       // seconds elapsed
  reelDir: number;        // -1 or 1, which direction to reel
  reelTimer: number;      // time until reel direction changes
  catchPool: string[];    // possible catches
}

export class FishingSystem {
  private minigames = new Map<number, FishingMinigame>(); // playerIdx -> minigame
  private prevFPressed = new Map<number, boolean>();
  private biomeSystem: BiomeSystem;
  private weatherSystem: WeatherSystem;
  private waterWriter: WaterBufferWriter;
  private _onEvent: (msg: SimToMainMessage) => void;

  constructor(biomeSystem: BiomeSystem, weatherSystem: WeatherSystem, waterWriter: WaterBufferWriter, onEvent: (msg: SimToMainMessage) => void) {
    this.biomeSystem = biomeSystem;
    this.weatherSystem = weatherSystem;
    this.waterWriter = waterWriter;
    this._onEvent = onEvent;
  }

  tick(dt: number, input: InputBufferReader, players: SimPlayer[], playerCount: number): void {
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;

      // F key starts fishing (edge-triggered)
      const fPressed = input.isKeyDown(i, KEY.F);
      const fWasPressed = this.prevFPressed.get(i) ?? false;
      if (fPressed && !fWasPressed && !this.isFishing(i)) {
        // Don't start fishing while swimming — F is used for boarding boats in water
        if (p.flags & PLR_FLAG.SWIMMING) {
          this.prevFPressed.set(i, fPressed);
          continue;
        }
        // Don't start fishing while piloting a ship
        if (p.flags & PLR_FLAG.PILOTING) {
          this.prevFPressed.set(i, fPressed);
          continue;
        }
        // Check water proximity — player must be near water
        if (!this.isNearWater(p.position.x, p.position.z)) {
          this.emitFishingResult(i, false, "No water nearby!", null);
          this.prevFPressed.set(i, fPressed);
          continue;
        }
        const biome = this.biomeSystem.getBiomeAt(p.position.x, p.position.z);
        this.startMinigame(i, FishingMethod.LineFishing, biome, 1);
        p.flags |= PLR_FLAG.FISHING;
      }
      this.prevFPressed.set(i, fPressed);

      const mg = this.minigames.get(i);
      if (!mg || !mg.active) {
        // Clear fishing flag if no active minigame
        if (p.flags & PLR_FLAG.FISHING) p.flags &= ~PLR_FLAG.FISHING;
        continue;
      }

      mg.duration += dt;

      // Fish pulls — direction alternates, creating a push-pull rhythm.
      // When reelDir is +1, the fish pulls tension up.
      // When reelDir is -1, the fish relaxes (tension drifts down naturally).
      const weatherMult = this.getWeatherDifficultyMult();
      const fishPull = mg.fishStrength * weatherMult * dt * FISHING_FISH_PULL_MULT;
      if (mg.reelDir > 0) {
        mg.tension += fishPull;
      } else {
        // Fish rests — slight natural tension decay
        mg.tension -= fishPull * 0.3;
      }

      // Player reels — hold left mouse button or space to reel
      const isReeling = input.isMouseDown(i, 0) || input.isKeyDown(i, KEY.SPACE);
      if (isReeling) {
        mg.tension -= FISHING_REEL_POWER * dt;
      }

      // Clamp tension
      mg.tension = Math.max(0, Math.min(FISHING_TENSION_MAX, mg.tension));

      // Check fail conditions
      if (mg.tension <= FISHING_TENSION_BREAK) {
        // Line breaks
        this.endMinigame(i, false, "Line broke!", p);
        continue;
      }
      if (mg.tension >= FISHING_TENSION_SLIP) {
        // Fish escapes
        this.endMinigame(i, false, "Fish escaped!", p);
        continue;
      }

      // Progress when in the "good zone" (not too tight, not too loose)
      const inGoodZone = mg.tension > FISHING_GOOD_ZONE_MIN && mg.tension < FISHING_GOOD_ZONE_MAX;
      // Perfect zone is a narrow band centered on 50
      const perfectHalf = FISHING_PERFECT_ZONE * FISHING_TENSION_MAX * 0.5;
      const inPerfectZone = Math.abs(mg.tension - 50) < perfectHalf;
      if (inPerfectZone) {
        mg.progress += dt * FISHING_PERFECT_PROGRESS_RATE * (1 - mg.fishRarity * 0.1);
      } else if (inGoodZone) {
        mg.progress += dt * FISHING_PROGRESS_RATE * (1 - mg.fishRarity * 0.1);
      } else {
        mg.progress -= dt * FISHING_PROGRESS_DECAY;
      }
      mg.progress = Math.max(0, Math.min(1, mg.progress));

      // Check success
      if (mg.progress >= 1) {
        this.endMinigame(i, true, "Caught!", p);
        continue;
      }

      // Timeout
      if (mg.duration >= FISHING_MINIGAME_DURATION) {
        this.endMinigame(i, false, "Time up!", p);
        continue;
      }

      // Reel direction change (reaction element)
      mg.reelTimer -= dt;
      if (mg.reelTimer <= 0) {
        mg.reelDir = -mg.reelDir;
        mg.reelTimer = FISHING_REEL_DIR_MIN_TIME + Math.random() * (FISHING_REEL_DIR_MAX_TIME - FISHING_REEL_DIR_MIN_TIME);
      }
    }
  }

  startMinigame(
    playerIdx: number,
    method: FishingMethod,
    biome: BiomeType,
    equipmentTier: number,
  ): void {
    const weather = this.weatherSystem.getState();
    const visibility = weather.visibility;

    // Determine catch pool based on biome and method
    const catchPool = this.getCatchPool(biome, method, equipmentTier);

    // Determine fish stats
    const fishRarity = Math.min(5, Math.floor(Math.random() * (equipmentTier + 1) + Math.random() * 2));
    const fishSize = 0.3 + Math.random() * (1 + equipmentTier * 0.5);
    const fishStrength = 0.5 + fishRarity * 0.2 + fishSize * 0.3;

    this.minigames.set(playerIdx, {
      active: true,
      method,
      tension: 50,
      fishStrength,
      fishSize,
      fishRarity,
      progress: 0,
      duration: 0,
      reelDir: 1,
      reelTimer: 2,
      catchPool,
    });
  }

  private endMinigame(playerIdx: number, success: boolean, reason: string, player: SimPlayer): void {
    const mg = this.minigames.get(playerIdx);
    if (!mg) return;
    mg.active = false;

    // Clear fishing flag immediately
    player.flags &= ~PLR_FLAG.FISHING;

    let catchId: string | null = null;
    if (success) {
      catchId = mg.catchPool[Math.floor(Math.random() * mg.catchPool.length)];
      const remaining = addItem(player.inventory, catchId, 1);
      if (remaining > 0) {
        console.log(`[Fishing] Player ${playerIdx} caught ${catchId} but inventory full`);
        this.emitFishingResult(playerIdx, true, `Caught ${catchId}! (inventory full)`, catchId);
      } else {
        console.log(`[Fishing] Player ${playerIdx} caught: ${catchId} (${reason})`);
        this.emitFishingResult(playerIdx, true, `Caught ${catchId}!`, catchId);
      }
    } else {
      console.log(`[Fishing] Player ${playerIdx} failed: ${reason}`);
      this.emitFishingResult(playerIdx, false, reason, null);
    }

    // Clean up the dead minigame entry
    this.minigames.delete(playerIdx);
  }

  private emitFishingResult(playerIdx: number, success: boolean, message: string, catchId: string | null): void {
    this._onEvent({
      kind: "fishing_result",
      data: { playerIdx, success, message, catchId },
    });
  }

  private getCatchPool(biome: BiomeType, method: FishingMethod, tier: number): string[] {
    const pool: string[] = [];

    // Fish based on biome
    switch (biome) {
      case BiomeType.Ocean:
        pool.push("mackerel", "tuna", "cod", "bass");
        if (tier >= 2) pool.push("swordfish", "marlin");
        break;
      case BiomeType.DeepOcean:
        pool.push("anglerfish", "gulper_eel", "deep_sea_bass");
        if (tier >= 3) pool.push("abyssal_pearl", "colossal_squid");
        break;
      case BiomeType.Tropical:
        pool.push("parrotfish", "angel_fish", "barracuda");
        if (tier >= 2) pool.push("mahi_mahi", "wahoo");
        break;
      case BiomeType.Arctic:
        pool.push("arctic_char", "cod", "halibut");
        if (tier >= 2) pool.push("narwhal_horn", "arctic_lobster");
        break;
      case BiomeType.CoralReef:
        pool.push("clownfish", "butterfly_fish", "reef_shark");
        if (tier >= 2) pool.push("pearl", "coral_fragment");
        break;
      case BiomeType.Volcanic:
      case BiomeType.Hell:
        pool.push("lava_eel", "obsidian_fish");
        if (tier >= 3) pool.push("demon_fin", "hellstone_fish");
        break;
      case BiomeType.GarbagePatch:
        pool.push("mutant_fish", "plastic_fish");
        break;
      default:
        pool.push("common_fish", "small_fish");
    }

    // Junk items (always possible)
    if (Math.random() < 0.15) {
      pool.push("discarded_net", "broken_rod", "old_boot", "bait_scraps");
    }

    // Rare junk (cosmetic or gag)
    if (Math.random() < 0.02) {
      const rareJunk = ["dvd", "rubber_duck", "vhs_tape", "vinyl_record", "old_radio"];
      pool.push(rareJunk[Math.floor(Math.random() * rareJunk.length)]);
    }

    return pool;
  }

  private getWeatherDifficultyMult(): number {
    const weather = this.weatherSystem.getState();
    switch (weather.type) {
      case WeatherType.Storm:
      case WeatherType.HellStorm:
        return 1.5;
      case WeatherType.Rain:
        return 1.2;
      case WeatherType.Fog:
        return 1.3;
      case WeatherType.Overcast:
        return 1.1;
      default:
        return 1.0;
    }
  }

  getMinigameState(playerIdx: number): FishingMinigame | null {
    return this.minigames.get(playerIdx) ?? null;
  }

  isFishing(playerIdx: number): boolean {
    return this.minigames.get(playerIdx)?.active ?? false;
  }

  private isNearWater(x: number, z: number): boolean {
    // Sample water height at the player's position and at several offsets within cast range
    // If any nearby point has water above terrain, the player is near water
    const patchSize = this.waterWriter.getPatchSize() || 4;
    const origin = this.waterWriter.getOrigin();
    const WATER_GRID = 256;

    // Check a few sample points within cast range
    const offsets = [
      [0, 0], [10, 0], [-10, 0], [0, 10], [0, -10],
      [20, 0], [-20, 0], [0, 20], [0, -20],
    ];
    for (let i = 0; i < offsets.length; i++) {
      const sx = x + offsets[i][0];
      const sz = z + offsets[i][1];
      const gx = ((sx - origin.x) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
      const gz = ((sz - origin.z) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
      const waterHeight = this.waterWriter.sampleHeight(gx, gz);
      // If water height is reasonable (not -1000 from water cutout), there's water here
      if (waterHeight > -100) return true;
    }
    return false;
  }
}
