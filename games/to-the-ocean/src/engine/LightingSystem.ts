// ============================================================================
// Lighting System — directional sun/moon, ambient, bioluminescent
// ============================================================================
// Uses WeatherBlend from @downdraft/plugin-weather for smooth transitions.
//

import { WeatherBlend } from "@downdraft/plugin-weather";
import { WeatherType } from "@shared/types";

// Base sun brightness multiplier for PBR radiance — matches core engine default (3.0).
// The raw sunIntensity (0..1) is kept for systems that use it as a blend factor (water, clouds).
const SUN_BRIGHTNESS = 3.0;

export class LightingSystem {
  protected device: GPUDevice;
  protected weatherBlend: WeatherBlend;

  constructor(device: GPUDevice) {
    this.device = device;
    this.weatherBlend = new WeatherBlend(30.0);
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

    // Blend lighting using the shared WeatherBlend from the plugin
    const blended = this.weatherBlend.getLightingParams(timeOfDay, weatherType, visibility);
    const ambient = blended.ambient;
    const sunIntensity = blended.sunIntensity;
    const wetness = blended.wetness;

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

  updateWeatherBlend(weatherType: WeatherType, dt: number): void {
    this.weatherBlend.update(weatherType, dt);
  }
}
