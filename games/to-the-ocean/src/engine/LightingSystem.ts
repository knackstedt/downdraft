// ============================================================================
// Lighting System — directional sun/moon, ambient, bioluminescent
// ============================================================================

import { WeatherType } from "@shared/types";

// Base sun brightness multiplier for PBR radiance — matches core engine default (3.0).
// The raw sunIntensity (0..1) is kept for systems that use it as a blend factor (water, clouds).
const SUN_BRIGHTNESS = 3.0;

export class LightingSystem {
  protected device: GPUDevice;

  protected prevWeatherType: WeatherType = WeatherType.Clear;
  protected displayedWeatherType: WeatherType = WeatherType.Clear;
  protected weatherBlend: number = 1.0;
  protected readonly weatherTransitionDuration: number = 30.0;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // Calculate lighting parameters based on time of day and weather
  getLightingParams(timeOfDay: number, weatherType: WeatherType, visibility: number) {
    // Sun angle — matches SkySystem calculation exactly
    const sunAngle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sunDirRaw: [number, number, number] = [
      Math.cos(sunAngle),
      Math.sin(sunAngle),
      0.3,
    ];
    const sunLen = Math.sqrt(sunDirRaw[0] ** 2 + sunDirRaw[1] ** 2 + sunDirRaw[2] ** 2);
    const sunDir: [number, number, number] = [
      sunDirRaw[0] / sunLen,
      sunDirRaw[1] / sunLen,
      sunDirRaw[2] / sunLen,
    ];
    const sunIntensityRaw = Math.max(0, Math.sin(sunAngle));

    // Moon (opposite of sun)
    const moonDir: [number, number, number] = [-sunDir[0], -sunDir[1], -sunDir[2]];
    const moonIntensity = Math.max(0, -Math.sin(sunAngle));

    // Ambient light level — boosted to compensate for the 1/π Lambertian factor in PBR shaders.
    // sqrt curve makes ambient ramp up faster at low sun angles (sky scattering is significant
    // even when the sun is near the horizon), while preserving the peak at noon.
    const baseAmbient = 0.7 + Math.sqrt(sunIntensityRaw) * 0.8;

    // Blend lighting between previous and current weather for smooth transitions
    const prev = this.applyWeatherLighting(this.prevWeatherType, baseAmbient, sunIntensityRaw, moonIntensity);
    const curr = this.applyWeatherLighting(this.displayedWeatherType, baseAmbient, sunIntensityRaw, moonIntensity);
    const easedBlend = this.weatherBlend * this.weatherBlend * (3 - 2 * this.weatherBlend);
    const ambient = prev.ambient + (curr.ambient - prev.ambient) * easedBlend;
    const sunIntensity = prev.sunIntensity + (curr.sunIntensity - prev.sunIntensity) * easedBlend;

    // Wetness factor — 0 when dry, ramps up for rain/storm/hellstorm
    const prevWetness = this.weatherWetness(this.prevWeatherType);
    const currWetness = this.weatherWetness(this.displayedWeatherType);
    const wetness = prevWetness + (currWetness - prevWetness) * easedBlend;

    // Visibility affects fog distance
    const fogDensity = (1 - visibility) * 0.01;

    return {
      sunDir,
      sunIntensity,
      // PBR-scaled brightness for entity/island shaders (radiance = vec3(sunBrightness))
      sunBrightness: sunIntensity * SUN_BRIGHTNESS,
      moonDir,
      moonIntensity,
      ambient,
      fogDensity,
      wetness,
      fogColor: [0.0, 0.1, 0.2] as [number, number, number],
    };
  }

  private applyWeatherLighting(
    weatherType: WeatherType,
    baseAmbient: number,
    baseSunIntensity: number,
    moonIntensity: number,
  ): { ambient: number; sunIntensity: number } {
    let ambient = baseAmbient;
    let sunIntensity = baseSunIntensity;
    if (weatherType === WeatherType.PartlyCloudy) { ambient *= 0.9; sunIntensity *= 0.85; }
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

  updateWeatherBlend(weatherType: WeatherType, dt: number): void {
    if (weatherType !== this.displayedWeatherType) {
      this.prevWeatherType = this.displayedWeatherType;
      this.displayedWeatherType = weatherType;
      this.weatherBlend = 0.0;
    }
    if (this.weatherBlend < 1.0) {
      this.weatherBlend = Math.min(1.0, this.weatherBlend + dt / this.weatherTransitionDuration);
    }
  }
}
