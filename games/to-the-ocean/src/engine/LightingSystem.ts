// ============================================================================
// Lighting System — directional sun/moon, ambient, bioluminescent
// ============================================================================

import { WeatherType } from "@shared/types";

export class LightingSystem {
  protected device: GPUDevice;

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

    // Ambient light level
    let ambient = 0.3 + sunIntensityRaw * 0.4;

    // Weather reduces both ambient and directional sunlight (clouds block sun)
    let sunIntensity = sunIntensityRaw;
    if (weatherType === WeatherType.PartlyCloudy) { ambient *= 0.9; sunIntensity *= 0.85; }
    if (weatherType === WeatherType.Overcast) { ambient *= 0.7; sunIntensity *= 0.4; }
    if (weatherType === WeatherType.Rain) { ambient *= 0.6; sunIntensity *= 0.3; }
    if (weatherType === WeatherType.Storm) { ambient *= 0.4; sunIntensity *= 0.15; }
    if (weatherType === WeatherType.Fog) { ambient *= 0.5; sunIntensity *= 0.2; }
    if (weatherType === WeatherType.HellStorm) { ambient *= 0.3; sunIntensity *= 0.1; }
    if (weatherType === WeatherType.Eclipse) { ambient *= 0.2; sunIntensity *= 0.05; }
    if (weatherType === WeatherType.Snow) { ambient *= 0.7; sunIntensity *= 0.4; }
    if (weatherType === WeatherType.FullMoon) ambient += moonIntensity * 0.15;

    // Visibility affects fog distance
    const fogDensity = (1 - visibility) * 0.01;

    return {
      sunDir,
      sunIntensity,
      moonDir,
      moonIntensity,
      ambient,
      fogDensity,
      fogColor: [0.0, 0.1, 0.2] as [number, number, number],
    };
  }
}
