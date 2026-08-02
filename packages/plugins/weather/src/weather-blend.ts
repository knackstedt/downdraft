// ============================================================================
// WeatherBlend — smooth weather transition blending for lighting/rendering
// ============================================================================
// Provides eased blending between previous and current weather states so
// lighting/rendering systems can smoothly transition over time.
//

import { WeatherType } from "./types.ts";

export interface WeatherLightingParams {
  ambient: number;
  sunIntensity: number;
  wetness: number;
}

export class WeatherBlend {
  private prevWeatherType: WeatherType = WeatherType.Clear;
  private displayedWeatherType: WeatherType = WeatherType.Clear;
  private blend: number = 1.0;
  private readonly transitionDuration: number;

  constructor(transitionDuration: number = 30.0) {
    this.transitionDuration = transitionDuration;
  }

  update(weatherType: WeatherType, dt: number): void {
    if (weatherType !== this.displayedWeatherType) {
      this.prevWeatherType = this.displayedWeatherType;
      this.displayedWeatherType = weatherType;
      this.blend = 0.0;
    }
    if (this.blend < 1.0) {
      this.blend = Math.min(1.0, this.blend + dt / this.transitionDuration);
    }
  }

  getBlendFactor(): number {
    return this.blend;
  }

  getEasedBlend(): number {
    return this.blend * this.blend * (3 - 2 * this.blend);
  }

  getPrevWeatherType(): WeatherType {
    return this.prevWeatherType;
  }

  getDisplayedWeatherType(): WeatherType {
    return this.displayedWeatherType;
  }

  isTransitioning(): boolean {
    return this.blend < 1.0;
  }

  blendValues(prev: number, curr: number): number {
    const t = this.getEasedBlend();
    return prev + (curr - prev) * t;
  }

  getLightingParams(
    timeOfDay: number,
    weatherType: WeatherType,
    visibility: number,
  ): WeatherLightingParams {
    const sunAngle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sunIntensityRaw = Math.max(0, Math.sin(sunAngle));
    const moonIntensity = Math.max(0, -Math.sin(sunAngle));
    const baseAmbient = 0.7 + Math.sqrt(sunIntensityRaw) * 0.8;

    const prev = this.applyWeatherLighting(this.prevWeatherType, baseAmbient, sunIntensityRaw, moonIntensity);
    const curr = this.applyWeatherLighting(this.displayedWeatherType, baseAmbient, sunIntensityRaw, moonIntensity);
    const ambient = this.blendValues(prev.ambient, curr.ambient);
    const sunIntensity = this.blendValues(prev.sunIntensity, curr.sunIntensity);

    const prevWetness = this.weatherWetness(this.prevWeatherType);
    const currWetness = this.weatherWetness(this.displayedWeatherType);
    const wetness = this.blendValues(prevWetness, currWetness);

    void visibility;

    return { ambient, sunIntensity, wetness };
  }

  private applyWeatherLighting(
    weatherType: WeatherType,
    baseAmbient: number,
    baseSunIntensity: number,
    moonIntensity: number,
  ): { ambient: number; sunIntensity: number } {
    let ambient = baseAmbient;
    let sunIntensity = baseSunIntensity;
    if (weatherType === WeatherType.PartlyCloudy) { ambient *= 0.97; sunIntensity *= 0.93; }
    if (weatherType === WeatherType.Overcast) { ambient *= 0.7; sunIntensity *= 0.4; }
    if (weatherType === WeatherType.Rain) { ambient *= 0.6; sunIntensity *= 0.3; }
    if (weatherType === WeatherType.Storm) { ambient *= 0.4; sunIntensity *= 0.15; }
    if (weatherType === WeatherType.Fog) { ambient *= 0.5; sunIntensity *= 0.2; }
    if (weatherType === WeatherType.HellStorm) { ambient *= 0.3; sunIntensity *= 0.1; }
    if (weatherType === WeatherType.Eclipse) { ambient *= 0.2; sunIntensity *= 0.05; }
    if (weatherType === WeatherType.Snow) { ambient *= 0.7; sunIntensity *= 0.4; }
    if (weatherType === WeatherType.FullMoon) ambient += moonIntensity * 0.15;
    return { ambient, sunIntensity };
  }

  private weatherWetness(weatherType: WeatherType): number {
    if (weatherType === WeatherType.Rain) return 0.7;
    if (weatherType === WeatherType.Storm) return 1.0;
    if (weatherType === WeatherType.HellStorm) return 1.0;
    return 0.0;
  }
}
