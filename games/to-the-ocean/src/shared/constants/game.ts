// Day/night cycle, skinning limits, and game rules

import { GameMode } from "../types";
import { PRICE_RECOVERY_HOURS } from "./economy";
import { PLAYER_HUNGER_RATE, PLAYER_OXYGEN_DRAIN_RATE, PLAYER_TEMP_COLD_RATE, PLAYER_THIRST_RATE } from "./player";

// --- Day/Night ---

export const DAY_DURATION_SECONDS = 1200;    // 20 minutes real = 1 game day
export const NIGHT_START_FRAC = 0.7;         // 70% through day = night
export const NIGHT_END_FRAC = 0.25;          // 25% through day = dawn

// --- Skinning ---

export const MAX_BONES = 128;

// --- Default Game Rules ---

export const DEFAULT_GAME_RULES = {
  pvp: true,
  keepInventory: false,
  hungerRate: PLAYER_HUNGER_RATE,
  thirstRate: PLAYER_THIRST_RATE,
  oxygenRate: PLAYER_OXYGEN_DRAIN_RATE,
  temperatureRate: PLAYER_TEMP_COLD_RATE,
  priceRecoveryHours: PRICE_RECOVERY_HOURS,
  pirateSpawnMultiplier: 1.0,
  weatherIntensity: 1.0,
  dayDuration: DAY_DURATION_SECONDS,
  nightSkipThreshold: 0.5,
  collisionLodDistance: 250, // meters — entity pairs farther than this from all players skip collision
  portGenerationRate: 0.015,
  islandGenerationRate: 0.00000025,
  waterUpdateInterval: 1, // sim ticks between water height updates
};

export const GAMEMODE_RULES: Record<GameMode, Partial<typeof DEFAULT_GAME_RULES>> = {
  [GameMode.Creative]: {
    pvp: false,
    hungerRate: 0,
    thirstRate: 0,
    oxygenRate: 0,
    temperatureRate: 0,
    keepInventory: true,
    pirateSpawnMultiplier: 0,
    weatherIntensity: 0.5,
  },
  [GameMode.Survival]: {},
  [GameMode.Hardcore]: {
    keepInventory: false,
    pirateSpawnMultiplier: 1.5,
    weatherIntensity: 1.2,
  },
  [GameMode.Custom]: {},
};
