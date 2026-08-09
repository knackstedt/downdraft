// ============================================================================
// Fishing System — re-exports from @to-the-ocean/library-fishing
// ============================================================================
// The game's BiomeSystem, WeatherSystem, WaterBufferWriter, InputBufferReader,
// addItem, and onEvent are adapted to the plugin's interface-based deps.
// SimPlayer is structurally compatible with the plugin's FishingPlayer interface.
// PLR_FLAG values match the plugin's FISHING_FLAG bit positions.
//

import { DEFAULT_FISHING_CONFIG, FishingSystem as PluginFishingSystem, type FishingConfig, type FishingDeps, type FishingInput, type FishingPlayer } from "@to-the-ocean/library-fishing";
import { WeatherSystem } from "@downdraft/library-weather";
import {
    FISHING_CAST_RANGE,
    FISHING_FISH_PULL_MULT,
    FISHING_GOOD_ZONE_MAX,
    FISHING_GOOD_ZONE_MIN,
    FISHING_MINIGAME_DURATION,
    FISHING_PERFECT_PROGRESS_RATE,
    FISHING_PERFECT_ZONE,
    FISHING_PROGRESS_DECAY,
    FISHING_PROGRESS_RATE,
    FISHING_REEL_DIR_MAX_TIME,
    FISHING_REEL_DIR_MIN_TIME,
    FISHING_REEL_POWER,
    FISHING_TENSION_BREAK,
    FISHING_TENSION_MAX,
    FISHING_TENSION_SLIP,
} from "../../shared/constants";
import { InputBufferReader } from "../../shared/input-buffer";
import { SimToMainMessage } from "../../shared/types";
import { WaterBufferWriter } from "../../shared/water-buffer";
import { addItem } from "../inventory/inventory-system";
import { SimPlayer } from "../simulation";
import { BiomeSystem } from "../world/biome-system";


const GAME_FISHING_CONFIG: FishingConfig = {
  ...DEFAULT_FISHING_CONFIG,
  castRange: FISHING_CAST_RANGE,
  minigameDuration: FISHING_MINIGAME_DURATION,
  tensionMax: FISHING_TENSION_MAX,
  tensionBreak: FISHING_TENSION_BREAK,
  tensionSlip: FISHING_TENSION_SLIP,
  perfectZone: FISHING_PERFECT_ZONE,
  reelPower: FISHING_REEL_POWER,
  fishPullMult: FISHING_FISH_PULL_MULT,
  goodZoneMin: FISHING_GOOD_ZONE_MIN,
  goodZoneMax: FISHING_GOOD_ZONE_MAX,
  progressRate: FISHING_PROGRESS_RATE,
  perfectProgressRate: FISHING_PERFECT_PROGRESS_RATE,
  progressDecay: FISHING_PROGRESS_DECAY,
  reelDirMinTime: FISHING_REEL_DIR_MIN_TIME,
  reelDirMaxTime: FISHING_REEL_DIR_MAX_TIME,
};

export class FishingSystem extends PluginFishingSystem {
  constructor(
    biomeSystem: BiomeSystem,
    weatherSystem: WeatherSystem,
    waterWriter: WaterBufferWriter,
    onEvent: (msg: SimToMainMessage) => void,
  ) {
    const deps: FishingDeps = {
      biomeProvider: biomeSystem,
      weatherProvider: weatherSystem,
      waterProvider: waterWriter,
      addItem: addItem as unknown as FishingDeps["addItem"],
      onEvent: onEvent as unknown as FishingDeps["onEvent"],
    };
    super(deps, GAME_FISHING_CONFIG);
  }

  tick(dt: number, input: InputBufferReader, players: SimPlayer[], playerCount: number): void {
    super.tick(dt, input as unknown as FishingInput, players as unknown as FishingPlayer[], playerCount);
  }
}
