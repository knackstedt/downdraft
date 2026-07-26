// ─── Weather System (parity with to-the-ocean WeatherSystem.ts) ──

import { system, Stage, createLogger } from "@downdraft/core";
import {
  WeatherType,
  WEATHER_CLEAR_CHANCE, WEATHER_FULL_CLEAR, WEATHER_PARTLY_CLOUDY, WEATHER_OVERCAST,
  WEATHER_MAX_DURATION, WEATHER_MIN_DURATION, WEATHER_RARE_EVENT_CHANCE,
  RAIN_COLLECTOR_CAPACITY, RAIN_COLLECTOR_FILL_RATE,
  NIGHT_START_FRAC, NIGHT_END_FRAC,
} from "./constants.ts";
import { waterPhysics } from "./water.ts";

const log = createLogger();

// ─── Weather State ────────────────────────────────────────

export const weatherState = {
  type: WeatherType.Clear,
  intensity: 0,
  windSpeed: 2,
  windDirX: 1,
  windDirZ: 0,
  visibility: 1.0,
  ambientTemp: 20,
  duration: 60,
  cooldown: 0,
  isRareEvent: false,
};

// Smoothly-interpolated visual state (lerps toward target over ~30s)
export const weatherVisualCurrent = {
  skyColor: [0.5, 0.7, 0.85] as [number, number, number],
  waterColor: [0.08, 0.22, 0.45] as [number, number, number],
  fogColor: [0.5, 0.7, 0.85] as [number, number, number],
  fogDensity: 0.002,
  lightIntensity: 1.0,
};

// Rain collectors: entityId -> water amount
export const rainCollectors = new Map<number, number>();
let weatherTargetWindSpeed = 2;
let weatherSimTime = 0;
let weatherIntensityMul = 1.0;

// ─── Weather Helper Functions ─────────────────────────────

function defaultIntensityFor(type: WeatherType): number {
  switch (type) {
    case WeatherType.Clear: return 0;
    case WeatherType.PartlyCloudy: return 0.3;
    case WeatherType.Overcast: return 0.6;
    case WeatherType.Rain: return 0.6;
    case WeatherType.Storm: return 0.8;
    case WeatherType.Fog: return 0.4;
    case WeatherType.Eclipse: return 0.8;
    case WeatherType.FullMoon: return 0.3;
    case WeatherType.HellStorm: return 1.0;
    case WeatherType.Snow: return 0.5;
    default: return 0;
  }
}

export function weatherIsRaining(): boolean {
  return weatherState.type === WeatherType.Rain ||
    weatherState.type === WeatherType.Storm ||
    weatherState.type === WeatherType.HellStorm;
}

export function weatherIsStormy(): boolean {
  return weatherState.type === WeatherType.Storm ||
    weatherState.type === WeatherType.HellStorm;
}

export function weatherIsRareEvent(): boolean {
  return weatherState.isRareEvent;
}

export function weatherIsHellStorm(): boolean {
  return weatherState.type === WeatherType.HellStorm;
}

export function registerRainCollector(entityId: number): void {
  rainCollectors.set(entityId, 0);
}

export function unregisterRainCollector(entityId: number): void {
  rainCollectors.delete(entityId);
}

export function getRainCollectorAmount(entityId: number): number {
  return rainCollectors.get(entityId) ?? 0;
}

export function useRainCollectorWater(entityId: number, amount: number): number {
  const current = rainCollectors.get(entityId) ?? 0;
  const used = Math.min(current, amount);
  rainCollectors.set(entityId, current - used);
  return used;
}

export function setWeatherType(type: WeatherType, intensity?: number): void {
  weatherState.type = type;
  weatherState.intensity = intensity ?? defaultIntensityFor(type);
  weatherState.isRareEvent = false;
  weatherState.duration = WEATHER_MAX_DURATION;
  weatherState.cooldown = 5;
}

export function setWeatherIntensityMul(mul: number): void {
  weatherIntensityMul = mul;
}

export function transitionWeather(timeOfDay: number): void {
  const isNight = timeOfDay > NIGHT_START_FRAC || timeOfDay < NIGHT_END_FRAC;
  const roll = Math.random();

  if (roll < WEATHER_CLEAR_CHANCE) {
    const cloudRoll = Math.random();
    if (cloudRoll < WEATHER_FULL_CLEAR) {
      weatherState.type = WeatherType.Clear;
      weatherState.intensity = 0;
    } else if (cloudRoll < WEATHER_FULL_CLEAR + WEATHER_PARTLY_CLOUDY) {
      weatherState.type = WeatherType.PartlyCloudy;
      weatherState.intensity = 0.3 * weatherIntensityMul;
    } else {
      weatherState.type = WeatherType.Overcast;
      weatherState.intensity = 0.6 * weatherIntensityMul;
    }
  } else {
    const stormRoll = Math.random();
    if (stormRoll < 0.4) {
      weatherState.type = WeatherType.Rain;
      weatherState.intensity = (0.5 + Math.random() * 0.3) * weatherIntensityMul;
    } else if (stormRoll < 0.65) {
      weatherState.type = WeatherType.Storm;
      weatherState.intensity = (0.7 + Math.random() * 0.3) * weatherIntensityMul;
    } else if (stormRoll < 0.85) {
      weatherState.type = WeatherType.Fog;
      weatherState.intensity = 0.4 * weatherIntensityMul;
    } else {
      weatherState.type = WeatherType.Snow;
      weatherState.intensity = 0.5 * weatherIntensityMul;
    }
  }

  // Rare event check
  if (Math.random() < WEATHER_RARE_EVENT_CHANCE) {
    const rareRoll = Math.random();
    if (rareRoll < 0.34) {
      weatherState.type = WeatherType.Eclipse;
      weatherState.intensity = 0.8;
      weatherState.isRareEvent = true;
    } else if (rareRoll < 0.67 && isNight) {
      weatherState.type = WeatherType.FullMoon;
      weatherState.intensity = 0.3;
      weatherState.isRareEvent = true;
    } else {
      weatherState.type = WeatherType.HellStorm;
      weatherState.intensity = 1.0 * weatherIntensityMul;
      weatherState.isRareEvent = true;
    }
  } else {
    weatherState.isRareEvent = false;
  }

  // Duration
  if (weatherState.type === WeatherType.FullMoon && isNight) {
    let remainingFrac: number;
    if (timeOfDay > NIGHT_START_FRAC) {
      remainingFrac = (1.0 - timeOfDay) + NIGHT_END_FRAC;
    } else {
      remainingFrac = NIGHT_END_FRAC - timeOfDay;
    }
    weatherState.duration = Math.max(WEATHER_MIN_DURATION, remainingFrac * 1200);
  } else if (weatherState.isRareEvent) {
    weatherState.duration = WEATHER_MAX_DURATION;
  } else {
    weatherState.duration = WEATHER_MIN_DURATION + Math.random() * (WEATHER_MAX_DURATION - WEATHER_MIN_DURATION);
  }
  weatherState.cooldown = 5;

  // Wind speed target
  if (weatherState.type === WeatherType.Storm || weatherState.type === WeatherType.HellStorm) {
    weatherTargetWindSpeed = 15 + Math.random() * 10;
  } else if (weatherState.type === WeatherType.Rain) {
    weatherTargetWindSpeed = 8 + Math.random() * 4;
  } else if (weatherState.type === WeatherType.Overcast || weatherState.type === WeatherType.Snow) {
    weatherTargetWindSpeed = 5;
  } else {
    weatherTargetWindSpeed = 2;
  }
}

// ─── Weather Visual Blend ─────────────────────────────────

function computeWeatherVisualTarget(): {
  skyColor: [number, number, number];
  waterColor: [number, number, number];
  fogColor: [number, number, number];
  fogDensity: number;
  lightIntensity: number;
  weatherType: number;
  isNight: boolean;
} {
  // Read timeOfDay from the world resource (set by lifecycle tick)
  // We use a module-level reference that lifecycle.ts sets each tick
  const tod = _currentTimeOfDay;
  const isNight = tod > NIGHT_START_FRAC || tod < NIGHT_END_FRAC;
  const dayFactor = Math.sin(tod * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;

  let skyR: number, skyG: number, skyB: number;
  if (isNight) {
    skyR = 0.02; skyG = 0.03; skyB = 0.08;
  } else {
    skyR = 0.15 + dayFactor * 0.35;
    skyG = 0.35 + dayFactor * 0.35;
    skyB = 0.55 + dayFactor * 0.30;
  }

  let waterR = 0.08, waterG = 0.22, waterB = 0.45;
  if (isNight) {
    waterR = 0.02; waterG = 0.06; waterB = 0.12;
  }

  let fogR = skyR, fogG = skyG, fogB = skyB;
  let fogDensity = 0.002;
  let lightIntensity = isNight ? 0.25 : 0.6 + dayFactor * 0.4;

  switch (weatherState.type) {
    case WeatherType.Clear: break;
    case WeatherType.PartlyCloudy:
      skyR *= 0.9; skyG *= 0.9; skyB *= 0.92;
      fogR = skyR; fogG = skyG; fogB = skyB;
      lightIntensity *= 0.9; break;
    case WeatherType.Overcast:
      skyR *= 0.5; skyG *= 0.55; skyB *= 0.6;
      waterR *= 0.6; waterG *= 0.6; waterB *= 0.65;
      fogR = skyR; fogG = skyG; fogB = skyB;
      fogDensity = 0.005; lightIntensity *= 0.6; break;
    case WeatherType.Rain:
      skyR *= 0.35; skyG *= 0.38; skyB *= 0.42;
      waterR *= 0.5; waterG *= 0.5; waterB *= 0.55;
      fogR = skyR; fogG = skyG; fogB = skyB;
      fogDensity = 0.008 + weatherState.intensity * 0.005;
      lightIntensity *= 0.45; break;
    case WeatherType.Storm:
      skyR *= 0.2; skyG *= 0.22; skyB *= 0.25;
      waterR *= 0.35; waterG *= 0.35; waterB *= 0.4;
      fogR = skyR; fogG = skyG; fogB = skyB;
      fogDensity = 0.015; lightIntensity *= 0.3; break;
    case WeatherType.Fog:
      skyR = 0.5; skyG = 0.55; skyB = 0.58;
      waterR = 0.3; waterG = 0.35; waterB = 0.38;
      fogR = 0.6; fogG = 0.62; fogB = 0.62;
      fogDensity = 0.04; lightIntensity *= 0.5; break;
    case WeatherType.Eclipse:
      skyR = 0.01; skyG = 0.01; skyB = 0.03;
      waterR = 0.01; waterG = 0.02; waterB = 0.04;
      fogR = 0.02; fogG = 0.02; fogB = 0.05;
      fogDensity = 0.01; lightIntensity = 0.1; break;
    case WeatherType.FullMoon:
      skyR = 0.05; skyG = 0.06; skyB = 0.12;
      waterR = 0.04; waterG = 0.08; waterB = 0.15;
      fogR = 0.08; fogG = 0.1; fogB = 0.15;
      fogDensity = 0.003; lightIntensity = 0.35; break;
    case WeatherType.HellStorm:
      skyR = 0.3; skyG = 0.05; skyB = 0.02;
      waterR = 0.2; waterG = 0.05; waterB = 0.03;
      fogR = 0.35; fogG = 0.08; fogB = 0.03;
      fogDensity = 0.02; lightIntensity = 0.4; break;
    case WeatherType.Snow:
      skyR = 0.6; skyG = 0.65; skyB = 0.7;
      waterR = 0.3; waterG = 0.38; waterB = 0.42;
      fogR = 0.7; fogG = 0.74; fogB = 0.78;
      fogDensity = 0.012; lightIntensity *= 0.55; break;
  }

  return {
    skyColor: [skyR, skyG, skyB],
    waterColor: [waterR, waterG, waterB],
    fogColor: [fogR, fogG, fogB],
    fogDensity,
    lightIntensity,
    weatherType: weatherState.type,
    isNight,
  };
}

// Module-level timeOfDay reference, updated by lifecycle tick
let _currentTimeOfDay = 0.3;
export function setCurrentTimeOfDay(tod: number) { _currentTimeOfDay = tod; }

function updateWeatherVisualBlend(dt: number): void {
  const target = computeWeatherVisualTarget();
  const k = Math.min(1, dt / 10);
  const c = weatherVisualCurrent;
  c.skyColor[0] += (target.skyColor[0] - c.skyColor[0]) * k;
  c.skyColor[1] += (target.skyColor[1] - c.skyColor[1]) * k;
  c.skyColor[2] += (target.skyColor[2] - c.skyColor[2]) * k;
  c.waterColor[0] += (target.waterColor[0] - c.waterColor[0]) * k;
  c.waterColor[1] += (target.waterColor[1] - c.waterColor[1]) * k;
  c.waterColor[2] += (target.waterColor[2] - c.waterColor[2]) * k;
  c.fogColor[0] += (target.fogColor[0] - c.fogColor[0]) * k;
  c.fogColor[1] += (target.fogColor[1] - c.fogColor[1]) * k;
  c.fogColor[2] += (target.fogColor[2] - c.fogColor[2]) * k;
  c.fogDensity += (target.fogDensity - c.fogDensity) * k;
  c.lightIntensity += (target.lightIntensity - c.lightIntensity) * k;
}

function updateWeatherVisibility(dt: number): void {
  let targetVisibility = 1.0;
  switch (weatherState.type) {
    case WeatherType.Clear: targetVisibility = 1.0; break;
    case WeatherType.PartlyCloudy: targetVisibility = 0.9; break;
    case WeatherType.Overcast: targetVisibility = 0.75; break;
    case WeatherType.Rain: targetVisibility = 0.5 + (1 - weatherState.intensity) * 0.3; break;
    case WeatherType.Storm: targetVisibility = 0.3; break;
    case WeatherType.Fog: targetVisibility = 0.2; break;
    case WeatherType.Eclipse: targetVisibility = 0.4; break;
    case WeatherType.HellStorm: targetVisibility = 0.25; break;
    case WeatherType.FullMoon: targetVisibility = 0.7; break;
    case WeatherType.Snow: targetVisibility = 0.4; break;
  }
  const lerpFactor = Math.min(1, dt * 0.5);
  weatherState.visibility += (targetVisibility - weatherState.visibility) * lerpFactor;
}

function updateWeatherTemperature(dt: number, timeOfDay: number): void {
  const dayFactor = Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
  let targetTemp = 15 + dayFactor * 10;

  switch (weatherState.type) {
    case WeatherType.Storm:
    case WeatherType.HellStorm:
      targetTemp -= 5; break;
    case WeatherType.Rain:
      targetTemp -= 3; break;
    case WeatherType.Snow:
      targetTemp -= 15; break;
    case WeatherType.Fog:
      targetTemp -= 2; break;
    case WeatherType.Eclipse:
      targetTemp -= 10; break;
  }

  const lerpFactor = Math.min(1, dt / 60);
  weatherState.ambientTemp += (targetTemp - weatherState.ambientTemp) * lerpFactor;
}

// ─── Weather System ───────────────────────────────────────

export const weatherSystem = system("weather", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  weatherSimTime += dt;
  weatherState.duration -= dt;
  weatherState.cooldown -= dt;

  const timeOfDay = ctx.world.getResource<number>("timeOfDay") ?? 0;
  _currentTimeOfDay = timeOfDay;

  if (weatherState.duration <= 0 && weatherState.cooldown <= 0) {
    transitionWeather(timeOfDay);
  }

  const windAngle = weatherSimTime / 10000;
  weatherState.windDirX = Math.cos(windAngle);
  weatherState.windDirZ = Math.sin(windAngle);

  weatherState.windSpeed += (weatherTargetWindSpeed - weatherState.windSpeed) * dt * 0.5;

  updateWeatherVisualBlend(dt);
  updateWeatherVisibility(dt);
  updateWeatherTemperature(dt, timeOfDay);

  if (weatherIsRaining()) {
    for (const [id, amount] of rainCollectors) {
      const newAmount = Math.min(RAIN_COLLECTOR_CAPACITY, amount + RAIN_COLLECTOR_FILL_RATE * dt * weatherState.intensity);
      rainCollectors.set(id, newAmount);
    }
  }
}, { queries: [] });

// ─── Weather Visual Export ────────────────────────────────

export function getWeatherVisual(): {
  skyColor: [number, number, number];
  waterColor: [number, number, number];
  fogColor: [number, number, number];
  fogDensity: number;
  lightIntensity: number;
  weatherType: number;
  isNight: boolean;
} {
  const target = computeWeatherVisualTarget();
  return {
    skyColor: [...weatherVisualCurrent.skyColor] as [number, number, number],
    waterColor: [...weatherVisualCurrent.waterColor] as [number, number, number],
    fogColor: [...weatherVisualCurrent.fogColor] as [number, number, number],
    fogDensity: weatherVisualCurrent.fogDensity,
    lightIntensity: weatherVisualCurrent.lightIntensity,
    weatherType: target.weatherType,
    isNight: target.isNight,
  };
}
