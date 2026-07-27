// ============================================================================
// Weather System — dynamic weather, rare events, rain collectors
// ============================================================================

import { WeatherType, WeatherState, BiomeType } from "../../shared/types";
import {
  WEATHER_CLEAR_CHANCE, WEATHER_FULL_CLEAR, WEATHER_PARTLY_CLOUDY,
  WEATHER_OVERCAST, WEATHER_MAX_DURATION, WEATHER_MIN_DURATION,
  WEATHER_RARE_EVENT_CHANCE, RAIN_COLLECTOR_FILL_RATE,
  NIGHT_START_FRAC, NIGHT_END_FRAC,
} from "../../shared/constants";
import { BiomeSystem } from "../world/BiomeSystem";

export class WeatherSystem {
  private state: WeatherState;
  private biomeSystem: BiomeSystem;
  private rainCollectors: Map<number, number> = new Map(); // entityId -> water amount
  private targetWindSpeed = 2; // set once per weather transition, not re-rolled every tick
  private weatherIntensityMul = 1.0; // from game rules
  private simTime = 0; // accumulated simulation time in seconds (deterministic)

  constructor(biomeSystem: BiomeSystem, weatherIntensityMul = 1.0) {
    this.biomeSystem = biomeSystem;
    this.weatherIntensityMul = weatherIntensityMul;
    this.state = {
      type: WeatherType.Clear,
      intensity: 0,
      windDirection: { x: 1, y: 0, z: 0 },
      windSpeed: 2,
      visibility: 1.0,
      temperature: 20,
      duration: 60,
      cooldown: 0,
      isRareEvent: false,
    };
  }

  tick(dt: number, timeOfDay: number): void {
    this.simTime += dt;
    this.state.duration -= dt;
    this.state.cooldown -= dt;

    if (this.state.duration <= 0 && this.state.cooldown <= 0) {
      this.transitionWeather(timeOfDay);
    }

    // Update wind
    this.updateWind(dt);

    // Update visibility based on weather
    this.updateVisibility(dt);

    // Update temperature based on weather and time of day
    this.updateTemperature(dt, timeOfDay);

    // Update rain collectors
    if (this.state.type === WeatherType.Rain || this.state.type === WeatherType.Storm ||
        this.state.type === WeatherType.HellStorm) {
      for (const [id, amount] of this.rainCollectors) {
        const newAmount = Math.min(50, amount + RAIN_COLLECTOR_FILL_RATE * dt * this.state.intensity);
        this.rainCollectors.set(id, newAmount);
      }
    }
  }

  private transitionWeather(timeOfDay: number): void {
    const isNight = timeOfDay > NIGHT_START_FRAC || timeOfDay < NIGHT_END_FRAC;
    const roll = Math.random();

    // 80% chance of clear weather
    if (roll < WEATHER_CLEAR_CHANCE) {
      // Within clear weather: 30% fully clear, 40% partly cloudy, 30% overcast
      const cloudRoll = Math.random();
      if (cloudRoll < WEATHER_FULL_CLEAR) {
        this.state.type = WeatherType.Clear;
        this.state.intensity = 0;
      } else if (cloudRoll < WEATHER_FULL_CLEAR + WEATHER_PARTLY_CLOUDY) {
        this.state.type = WeatherType.PartlyCloudy;
        this.state.intensity = 0.3 * this.weatherIntensityMul;
      } else {
        this.state.type = WeatherType.Overcast;
        this.state.intensity = 0.6 * this.weatherIntensityMul;
      }
    } else {
      // Storm weather
      const stormRoll = Math.random();
      if (stormRoll < 0.4) {
        this.state.type = WeatherType.Rain;
        this.state.intensity = (0.5 + Math.random() * 0.3) * this.weatherIntensityMul;
      } else if (stormRoll < 0.65) {
        this.state.type = WeatherType.Storm;
        this.state.intensity = (0.7 + Math.random() * 0.3) * this.weatherIntensityMul;
      } else if (stormRoll < 0.85) {
        this.state.type = WeatherType.Fog;
        this.state.intensity = 0.4 * this.weatherIntensityMul;
      } else {
        this.state.type = WeatherType.Snow;
        this.state.intensity = 0.5 * this.weatherIntensityMul;
      }
    }

    // Rare event check — independent of storm weather.
    // Eclipse and HellStorm are more likely during storms; FullMoon only at night.
    if (Math.random() < WEATHER_RARE_EVENT_CHANCE) {
      const rareRoll = Math.random();
      if (rareRoll < 0.34) {
        this.state.type = WeatherType.Eclipse;
        this.state.intensity = 0.8;
        this.state.isRareEvent = true;
      } else if (rareRoll < 0.67 && isNight) {
        this.state.type = WeatherType.FullMoon;
        this.state.intensity = 0.3;
        this.state.isRareEvent = true;
      } else {
        this.state.type = WeatherType.HellStorm;
        this.state.intensity = 1.0 * this.weatherIntensityMul;
        this.state.isRareEvent = true;
      }
    } else {
      this.state.isRareEvent = false;
    }

    // Set duration — rare events last longer; FullMoon lasts until dawn
    if (this.state.type === WeatherType.FullMoon && isNight) {
      // Estimate remaining night time in seconds (dayDuration from rules)
      // timeOfDay wraps 0..1; night goes from NIGHT_START_FRAC through 1.0 to NIGHT_END_FRAC
      let remainingFrac: number;
      if (timeOfDay > NIGHT_START_FRAC) {
        remainingFrac = (1.0 - timeOfDay) + NIGHT_END_FRAC;
      } else {
        remainingFrac = NIGHT_END_FRAC - timeOfDay;
      }
      // Convert fraction to seconds using the default day duration
      this.state.duration = Math.max(WEATHER_MIN_DURATION, remainingFrac * 1200);
    } else if (this.state.isRareEvent) {
      this.state.duration = WEATHER_MAX_DURATION;
    } else {
      this.state.duration = WEATHER_MIN_DURATION + Math.random() * (WEATHER_MAX_DURATION - WEATHER_MIN_DURATION);
    }
    this.state.cooldown = 5; // brief cooldown before next transition

    // Set wind speed target once per transition — not re-rolled every tick.
    // This prevents perpetual jitter in wave amplitude/phase that made
    // the water surface "freak out" during storms.
    if (this.state.type === WeatherType.Storm || this.state.type === WeatherType.HellStorm) {
      this.targetWindSpeed = 15 + Math.random() * 10;
    } else if (this.state.type === WeatherType.Rain) {
      this.targetWindSpeed = 8 + Math.random() * 4;
    } else if (this.state.type === WeatherType.Overcast || this.state.type === WeatherType.Snow) {
      this.targetWindSpeed = 5;
    } else {
      this.targetWindSpeed = 2;
    }
  }

  private updateWind(dt: number): void {
    // Wind direction slowly rotates — use deterministic sim time, not wall clock
    const angle = this.simTime / 10000;
    this.state.windDirection.x = Math.cos(angle);
    this.state.windDirection.z = Math.sin(angle);

    // Smooth toward the target wind speed set at transition time.
    // dt * 0.5 gives a ~2s time constant — fast enough to ramp up for
    // storms, slow enough to avoid frame-to-frame jitter.
    this.state.windSpeed += (this.targetWindSpeed - this.state.windSpeed) * dt * 0.5;
  }

  private updateVisibility(dt: number): void {
    let targetVisibility = 1.0;

    switch (this.state.type) {
      case WeatherType.Clear:
        targetVisibility = 1.0;
        break;
      case WeatherType.PartlyCloudy:
        targetVisibility = 0.9;
        break;
      case WeatherType.Overcast:
        targetVisibility = 0.75;
        break;
      case WeatherType.Rain:
        targetVisibility = 0.5 + (1 - this.state.intensity) * 0.3;
        break;
      case WeatherType.Storm:
        targetVisibility = 0.3;
        break;
      case WeatherType.Fog:
        targetVisibility = 0.2;
        break;
      case WeatherType.Eclipse:
        targetVisibility = 0.4;
        break;
      case WeatherType.HellStorm:
        targetVisibility = 0.25;
        break;
      case WeatherType.FullMoon:
        targetVisibility = 0.7;
        break;
      case WeatherType.Snow:
        targetVisibility = 0.4;
        break;
    }

    // dt-scaled lerp — ~2s time constant at 0.5/s rate
    const lerpFactor = Math.min(1, dt * 0.5);
    this.state.visibility += (targetVisibility - this.state.visibility) * lerpFactor;
  }

  private updateTemperature(dt: number, timeOfDay: number): void {
    // Base temperature follows a day/night cycle (peaks at midday, dips at night)
    const dayFactor = Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
    let targetTemp = 15 + dayFactor * 10; // 15C at night, 25C at midday

    // Weather modifies temperature
    switch (this.state.type) {
      case WeatherType.Storm:
      case WeatherType.HellStorm:
        targetTemp -= 5;
        break;
      case WeatherType.Rain:
        targetTemp -= 3;
        break;
      case WeatherType.Snow:
        targetTemp -= 15;
        break;
      case WeatherType.Fog:
        targetTemp -= 2;
        break;
      case WeatherType.Eclipse:
        targetTemp -= 10;
        break;
    }

    // Smooth toward target (~60s time constant)
    const lerpFactor = Math.min(1, dt / 60);
    this.state.temperature += (targetTemp - this.state.temperature) * lerpFactor;
  }

  getState(): WeatherState {
    return { ...this.state };
  }

  isRaining(): boolean {
    return this.state.type === WeatherType.Rain || this.state.type === WeatherType.Storm ||
           this.state.type === WeatherType.HellStorm;
  }

  isStormy(): boolean {
    return this.state.type === WeatherType.Storm || this.state.type === WeatherType.HellStorm;
  }

  isRareEvent(): boolean {
    return this.state.isRareEvent;
  }

  isHellStorm(): boolean {
    return this.state.type === WeatherType.HellStorm;
  }

  getWindSpeed(): number {
    return this.state.windSpeed;
  }

  getWindDirection(): { x: number; z: number } {
    return { x: this.state.windDirection.x, z: this.state.windDirection.z };
  }

  getVisibility(): number {
    return this.state.visibility;
  }

  getTemperature(): number {
    return this.state.temperature;
  }

  setTemperature(temp: number): void {
    this.state.temperature = temp;
  }

  setWeatherType(type: WeatherType, intensity?: number): void {
    this.state.type = type;
    this.state.intensity = intensity ?? this.defaultIntensityFor(type);
    this.state.isRareEvent = false;
    this.state.duration = WEATHER_MAX_DURATION;
    this.state.cooldown = 5;
  }

  setWeatherIntensityMul(mul: number): void {
    this.weatherIntensityMul = mul;
  }

  private defaultIntensityFor(type: WeatherType): number {
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

  // Rain collector management
  registerRainCollector(entityId: number): void {
    this.rainCollectors.set(entityId, 0);
  }

  unregisterRainCollector(entityId: number): void {
    this.rainCollectors.delete(entityId);
  }

  getRainCollectorAmount(entityId: number): number {
    return this.rainCollectors.get(entityId) ?? 0;
  }

  useRainCollectorWater(entityId: number, amount: number): number {
    const current = this.rainCollectors.get(entityId) ?? 0;
    const used = Math.min(current, amount);
    this.rainCollectors.set(entityId, current - used);
    return used;
  }
}
