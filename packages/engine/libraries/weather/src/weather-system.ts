// ============================================================================
// Weather System — dynamic weather, rare events, rain collectors
// Reusable plugin: depends on BiomeProvider interface, not game-specific types
// ============================================================================

import { WeatherType } from "./types";
import type { WeatherState, WeatherConfig, BiomeProvider } from "./types";
import { DEFAULT_WEATHER_CONFIG } from "./types";

export class WeatherSystem {
  private state: WeatherState;
  private biomeProvider: BiomeProvider;
  private config: WeatherConfig;
  private rainCollectors: Map<number, number> = new Map();
  private targetWindSpeed = 2;
  private weatherIntensityMul = 1.0;
  private simTime = 0;

  constructor(biomeProvider: BiomeProvider, weatherIntensityMul = 1.0, config?: Partial<WeatherConfig>) {
    this.biomeProvider = biomeProvider;
    this.weatherIntensityMul = weatherIntensityMul;
    this.config = { ...DEFAULT_WEATHER_CONFIG, ...config };
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

    this.updateWind(dt);
    this.updateVisibility(dt);
    this.updateTemperature(dt, timeOfDay);

    if (this.state.type === WeatherType.Rain || this.state.type === WeatherType.Storm ||
        this.state.type === WeatherType.HellStorm) {
      for (const [id, amount] of this.rainCollectors) {
        const newAmount = Math.min(
          this.config.rainCollectorCapacity,
          amount + this.config.rainCollectorFillRate * dt * this.state.intensity,
        );
        this.rainCollectors.set(id, newAmount);
      }
    }
  }

  private transitionWeather(timeOfDay: number): void {
    const isNight = timeOfDay > this.config.nightStartFrac || timeOfDay < this.config.nightEndFrac;
    const roll = Math.random();

    if (roll < this.config.clearChance) {
      const cloudRoll = Math.random();
      if (cloudRoll < this.config.fullClearChance) {
        this.state.type = WeatherType.Clear;
        this.state.intensity = 0;
      } else if (cloudRoll < this.config.fullClearChance + this.config.partlyCloudyChance) {
        this.state.type = WeatherType.PartlyCloudy;
        this.state.intensity = 0.3 * this.weatherIntensityMul;
      } else {
        this.state.type = WeatherType.Overcast;
        this.state.intensity = 0.6 * this.weatherIntensityMul;
      }
    } else {
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

    if (Math.random() < this.config.rareEventChance) {
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

    if (this.state.type === WeatherType.FullMoon && isNight) {
      let remainingFrac: number;
      if (timeOfDay > this.config.nightStartFrac) {
        remainingFrac = (1.0 - timeOfDay) + this.config.nightEndFrac;
      } else {
        remainingFrac = this.config.nightEndFrac - timeOfDay;
      }
      this.state.duration = Math.max(this.config.minDuration, remainingFrac * 1200);
    } else if (this.state.isRareEvent) {
      this.state.duration = this.config.maxDuration;
    } else {
      this.state.duration = this.config.minDuration + Math.random() * (this.config.maxDuration - this.config.minDuration);
    }
    this.state.cooldown = 5;

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
    const angle = this.simTime / 10000;
    this.state.windDirection.x = Math.cos(angle);
    this.state.windDirection.z = Math.sin(angle);
    this.state.windSpeed += (this.targetWindSpeed - this.state.windSpeed) * dt * 0.5;
  }

  private updateVisibility(dt: number): void {
    let targetVisibility = 1.0;

    switch (this.state.type) {
      case WeatherType.Clear: targetVisibility = 1.0; break;
      case WeatherType.PartlyCloudy: targetVisibility = 0.9; break;
      case WeatherType.Overcast: targetVisibility = 0.75; break;
      case WeatherType.Rain: targetVisibility = 0.5 + (1 - this.state.intensity) * 0.3; break;
      case WeatherType.Storm: targetVisibility = 0.3; break;
      case WeatherType.Fog: targetVisibility = 0.2; break;
      case WeatherType.Eclipse: targetVisibility = 0.4; break;
      case WeatherType.HellStorm: targetVisibility = 0.25; break;
      case WeatherType.FullMoon: targetVisibility = 0.7; break;
      case WeatherType.Snow: targetVisibility = 0.4; break;
    }

    const lerpFactor = Math.min(1, dt * 0.5);
    this.state.visibility += (targetVisibility - this.state.visibility) * lerpFactor;
  }

  private updateTemperature(dt: number, timeOfDay: number): void {
    const dayFactor = Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
    let targetTemp = 15 + dayFactor * 10;

    switch (this.state.type) {
      case WeatherType.Storm:
      case WeatherType.HellStorm:
        targetTemp -= 5; break;
      case WeatherType.Rain: targetTemp -= 3; break;
      case WeatherType.Snow: targetTemp -= 15; break;
      case WeatherType.Fog: targetTemp -= 2; break;
      case WeatherType.Eclipse: targetTemp -= 10; break;
    }

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
    this.state.duration = this.config.maxDuration;
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
