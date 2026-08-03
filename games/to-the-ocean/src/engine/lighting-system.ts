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
  protected device: GPUDevice | null;
  protected weatherBlend: WeatherBlend;

  // Pooled return object for getLightingParams (avoids per-frame allocation)
  private pooledResult = {
    sunDir: [0, 0, 0] as [number, number, number],
    sunIntensity: 0,
    sunBrightness: 0,
    moonDir: [0, 0, 0] as [number, number, number],
    moonIntensity: 0,
    ambient: 0,
    fogDensity: 0,
    wetness: 0,
    fogColor: [0.0, 0.1, 0.2] as [number, number, number],
  };

  constructor(device: GPUDevice | null) {
    this.device = device;
    this.weatherBlend = new WeatherBlend(30.0);
  }

  // Calculate lighting parameters based on time of day and weather
  getLightingParams(timeOfDay: number, weatherType: WeatherType, visibility: number) {
    const sunAngle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const cosA = Math.cos(sunAngle);
    const sinA = Math.sin(sunAngle);
    const rawZ = 0.3;
    const sunLen = Math.sqrt(cosA * cosA + sinA * sinA + rawZ * rawZ);

    const result = this.pooledResult;
    result.sunDir[0] = cosA / sunLen;
    result.sunDir[1] = sinA / sunLen;
    result.sunDir[2] = rawZ / sunLen;
    result.moonDir[0] = -result.sunDir[0];
    result.moonDir[1] = -result.sunDir[1];
    result.moonDir[2] = -result.sunDir[2];
    result.moonIntensity = Math.max(0, -sinA);

    // Blend lighting using the shared WeatherBlend from the plugin
    const blended = this.weatherBlend.getLightingParams(timeOfDay, weatherType, visibility);
    result.ambient = blended.ambient;
    result.sunIntensity = blended.sunIntensity;
    result.wetness = blended.wetness;
    result.sunBrightness = blended.sunIntensity * SUN_BRIGHTNESS;

    // Visibility affects fog distance
    result.fogDensity = (1 - visibility) * 0.01;

    return result;
  }

  updateWeatherBlend(weatherType: WeatherType, dt: number): void {
    this.weatherBlend.update(weatherType, dt);
  }
}
