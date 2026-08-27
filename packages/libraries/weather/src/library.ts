// ============================================================================
// WeatherLib — declarative engine library descriptor for @downdraft/library-weather
//
// Dynamic weather simulation with rare events, rain collectors, wind, and
// visibility. WeatherSystem depends on a BiomeProvider interface (game-supplied)
// to drive biome-aware weather transitions.
//
// Games declare `libraries: [WeatherLib]` (or
// `[[WeatherLib, { weatherIntensityMul: 1.5 }]]` to override config) in their
// GameModule. The host creates the WeatherSystem (sim-side) during sim worker
// init and exposes it via the WeatherTok token.
//
// Games that need full control can still import WeatherSystem directly
// (escape hatch). Note: a BiomeProvider must be provided to the constructor —
// games supply it via the config or inject it from another library/plugin.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { WeatherSystem } from "./weather-system";
import { DEFAULT_WEATHER_CONFIG, type BiomeProvider, type WeatherConfig } from "./types";

// ── Config ──

export interface WeatherLibConfig {
  /** Game-supplied biome provider (required for biome-aware transitions). */
  biomeProvider: BiomeProvider;
  /** Multiplier for weather intensity (0 = calm, 1 = normal, >1 = extreme). Default: 1. */
  weatherIntensityMul?: number;
  /** Partial weather config overrides (merged with DEFAULT_WEATHER_CONFIG). */
  weatherConfig?: Partial<WeatherConfig>;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side WeatherSystem. Inject in sim systems. */
export const WeatherTok = resourceToken<WeatherSystem>("weather:system");

// ── Descriptor ──

export const WeatherLib: EngineLibrary<WeatherLibConfig> = {
  name: "weather",
  version: "1.0.0",

  provides: [WeatherTok],

  sim: {
    create(config, ctx) {
      const weather = new WeatherSystem(
        config.biomeProvider,
        config.weatherIntensityMul ?? 1.0,
        config.weatherConfig,
      );
      ctx.provide(WeatherTok, weather);
      return weather;
    },
    dispose(_weather) {
      // WeatherSystem holds no GPU resources or external handles — it is
      // pure simulation state (weather type, wind, visibility, rain
      // collectors). No explicit destroy/cleanup method is needed.
    },
    // tick is game-specific (calls weather.tick(dt, timeOfDay) each sim
    // step) — games wire this via onReady or a sim tick system.
  },

  tickPhase: "pre-physics",

  defaultConfig: {
    biomeProvider: undefined as unknown as BiomeProvider,
    weatherIntensityMul: 1.0,
    weatherConfig: DEFAULT_WEATHER_CONFIG,
  },
};
