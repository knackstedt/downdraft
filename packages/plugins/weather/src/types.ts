// ============================================================================
// Weather Plugin — Types and Interfaces
// ============================================================================

export enum WeatherType {
  Clear = 0,
  PartlyCloudy = 1,
  Overcast = 2,
  Rain = 3,
  Storm = 4,
  Fog = 5,
  Eclipse = 6,
  FullMoon = 7,
  HellStorm = 8,
  Snow = 9,
}

export interface WeatherState {
  type: WeatherType;
  intensity: number;
  windDirection: { x: number; y: number; z: number };
  windSpeed: number;
  visibility: number;
  temperature: number;
  duration: number;
  cooldown: number;
  isRareEvent: boolean;
}

// Biome provider interface — games implement this to supply biome data
export interface BiomeProvider {
  getBiomeAt(worldX: number, worldZ: number): number;
  getBiomeName(biome: number): string;
  getTemperatureRange(biome: number): { min: number; max: number };
}

// Weather config — games can override these values
export interface WeatherConfig {
  clearChance: number;
  fullClearChance: number;
  partlyCloudyChance: number;
  overcastChance: number;
  maxDuration: number;
  minDuration: number;
  rareEventChance: number;
  rainCollectorCapacity: number;
  rainCollectorFillRate: number;
  nightStartFrac: number;
  nightEndFrac: number;
}

export const DEFAULT_WEATHER_CONFIG: WeatherConfig = {
  clearChance: 0.80,
  fullClearChance: 0.30,
  partlyCloudyChance: 0.40,
  overcastChance: 0.30,
  maxDuration: 300,
  minDuration: 60,
  rareEventChance: 0.02,
  rainCollectorCapacity: 50,
  rainCollectorFillRate: 5,
  nightStartFrac: 0.7,
  nightEndFrac: 0.25,
};
