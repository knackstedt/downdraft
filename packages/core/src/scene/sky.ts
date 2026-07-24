export interface DayNightConfig {
  dayDuration: number;
  startTime: number;
  sunColor: [number, number, number];
  moonColor: [number, number, number];
  sunIntensity: number;
  moonIntensity: number;
  ambientColor: [number, number, number];
  ambientIntensity: number;
  latitude: number;
  axialTilt: number;
}

export const DEFAULT_DAY_NIGHT_CONFIG: DayNightConfig = {
  dayDuration: 120,
  startTime: 6.0,
  sunColor: [1.0, 0.95, 0.85],
  moonColor: [0.5, 0.6, 0.8],
  sunIntensity: 3.0,
  moonIntensity: 0.3,
  ambientColor: [0.3, 0.35, 0.4],
  ambientIntensity: 0.5,
  latitude: 45.0,
  axialTilt: 23.5,
};

export interface SunMoonState {
  sunDirection: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  moonDirection: [number, number, number];
  moonColor: [number, number, number];
  moonIntensity: number;
  ambientColor: [number, number, number];
  ambientIntensity: number;
  timeOfDay: number;
  dayPhase: "dawn" | "day" | "dusk" | "night";
}

export class DayNightCycle {
  private config: DayNightConfig;
  private time: number;

  constructor(config?: Partial<DayNightConfig>) {
    this.config = { ...DEFAULT_DAY_NIGHT_CONFIG, ...config };
    this.time = this.config.startTime;
  }

  update(dt: number): void {
    this.time += (24 / this.config.dayDuration) * dt;
    while (this.time >= 24) this.time -= 24;
  }

  getState(): SunMoonState {
    const t = this.time;
    const sunAngle = ((t - 6) / 24) * Math.PI * 2;
    const moonAngle = sunAngle + Math.PI;

    const latRad = (this.config.latitude * Math.PI) / 180;
    const tiltRad = (this.config.axialTilt * Math.PI) / 180;

    const sunDir: [number, number, number] = [
      Math.cos(sunAngle) * Math.cos(latRad),
      Math.sin(sunAngle),
      Math.cos(sunAngle) * Math.sin(latRad) * Math.cos(tiltRad),
    ];
    const sunLen = Math.sqrt(sunDir[0] ** 2 + sunDir[1] ** 2 + sunDir[2] ** 2);
    sunDir[0] /= sunLen; sunDir[1] /= sunLen; sunDir[2] /= sunLen;

    const moonDir: [number, number, number] = [
      Math.cos(moonAngle) * Math.cos(latRad),
      Math.sin(moonAngle),
      Math.cos(moonAngle) * Math.sin(latRad) * Math.cos(tiltRad),
    ];
    const moonLen = Math.sqrt(moonDir[0] ** 2 + moonDir[1] ** 2 + moonDir[2] ** 2);
    moonDir[0] /= moonLen; moonDir[1] /= moonLen; moonDir[2] /= moonLen;

    const sunHeight = sunDir[1];
    const moonHeight = moonDir[1];

    let sunIntensity = 0;
    let moonIntensity = 0;
    let dayPhase: SunMoonState["dayPhase"] = "night";

    if (sunHeight > 0.1) {
      sunIntensity = this.config.sunIntensity * Math.min(1, sunHeight * 2);
      dayPhase = "day";
    } else if (sunHeight > -0.1) {
      const t2 = (sunHeight + 0.1) / 0.2;
      sunIntensity = this.config.sunIntensity * t2 * 0.5;
      dayPhase = t < 12 ? "dawn" : "dusk";
    }

    if (moonHeight > 0.1) {
      moonIntensity = this.config.moonIntensity * Math.min(1, moonHeight * 2);
      if (dayPhase === "night") dayPhase = "night";
    } else if (moonHeight > -0.1) {
      moonIntensity = this.config.moonIntensity * ((moonHeight + 0.1) / 0.2) * 0.5;
    }

    const ambientIntensity = this.config.ambientIntensity * (0.3 + 0.7 * Math.max(0, sunHeight));

    let sunColor = [...this.config.sunColor] as [number, number, number];
    if (dayPhase === "dawn" || dayPhase === "dusk") {
      const warmth = 1 - Math.abs(sunHeight) * 5;
      sunColor[0] = Math.min(1, this.config.sunColor[0] + warmth * 0.3);
      sunColor[1] = Math.max(0, this.config.sunColor[1] - warmth * 0.2);
      sunColor[2] = Math.max(0, this.config.sunColor[2] - warmth * 0.4);
    }

    return {
      sunDirection: sunDir,
      sunColor,
      sunIntensity,
      moonDirection: moonDir,
      moonColor: this.config.moonColor,
      moonIntensity,
      ambientColor: this.config.ambientColor,
      ambientIntensity,
      timeOfDay: this.time,
      dayPhase,
    };
  }

  setTime(time: number): void {
    this.time = ((time % 24) + 24) % 24;
  }

  getTime(): number {
    return this.time;
  }

  getConfig(): DayNightConfig {
    return this.config;
  }

  setConfig(config: Partial<DayNightConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export interface FogConfig {
  color: [number, number, number];
  density: number;
  start: number;
  end: number;
  fogType: "linear" | "exponential" | "exponential2";
  heightFalloff: number;
  maxDistance: number;
}

export const DEFAULT_FOG_CONFIG: FogConfig = {
  color: [0.5, 0.6, 0.7],
  density: 0.02,
  start: 20,
  end: 200,
  fogType: "linear",
  heightFalloff: 0.01,
  maxDistance: 500,
};

export class FogSystem {
  private config: FogConfig;

  constructor(config?: Partial<FogConfig>) {
    this.config = { ...DEFAULT_FOG_CONFIG, ...config };
  }

  computeFogFactor(distance: number, height: number = 0): number {
    let factor: number;
    switch (this.config.fogType) {
      case "linear":
        factor = (distance - this.config.start) / (this.config.end - this.config.start);
        break;
      case "exponential":
        factor = 1 - Math.exp(-this.config.density * distance);
        break;
      case "exponential2":
        factor = 1 - Math.exp(-((this.config.density * distance) ** 2));
        break;
    }
    const heightFactor = Math.exp(-this.config.heightFalloff * Math.abs(height));
    return Math.min(1, Math.max(0, factor * heightFactor));
  }

  blendColor(baseColor: [number, number, number], distance: number, height: number = 0): [number, number, number] {
    const factor = this.computeFogFactor(distance, height);
    return [
      baseColor[0] * (1 - factor) + this.config.color[0] * factor,
      baseColor[1] * (1 - factor) + this.config.color[1] * factor,
      baseColor[2] * (1 - factor) + this.config.color[2] * factor,
    ];
  }

  getConfig(): FogConfig {
    return this.config;
  }

  setConfig(config: Partial<FogConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export interface AtmosphereConfig {
  sunIntensity: number;
  rayleighCoefficient: number;
  mieCoefficient: number;
  mieDirection: number;
  planetRadius: number;
  atmosphereRadius: number;
  samples: number;
}

export const DEFAULT_ATMOSPHERE_CONFIG: AtmosphereConfig = {
  sunIntensity: 22.0,
  rayleighCoefficient: 1.0,
  mieCoefficient: 0.005,
  mieDirection: 0.758,
  planetRadius: 6371,
  atmosphereRadius: 6471,
  samples: 16,
};

export function computeSkyColor(
  sunDirection: [number, number, number],
  viewDirection: [number, number, number],
  config: AtmosphereConfig = DEFAULT_ATMOSPHERE_CONFIG,
): [number, number, number] {
  const cosSunView = Math.max(0, viewDirection[0] * sunDirection[0] + viewDirection[1] * sunDirection[1] + viewDirection[2] * sunDirection[2]);
  const cosSunZenith = Math.max(0, sunDirection[1]);
  const cosViewZenith = Math.max(0, viewDirection[1]);

  const rayleigh = config.rayleighCoefficient;
  const mie = config.mieCoefficient;

  const rayleighSun = rayleigh / (cosSunZenith + 0.001);
  const mieSun = mie / (cosSunZenith + 0.001);

  const rayleighView = rayleigh / (cosViewZenith + 0.001);
  const mieView = mie / (cosViewZenith + 0.001);

  const totalRayleigh = rayleighSun + rayleighView;
  const totalMie = mieSun + mieView;

  const rayleighColor: [number, number, number] = [5.8, 13.5, 33.1];
  const mieColor: [number, number, number] = [1.0, 1.0, 1.0];

  const phase = (1 + config.mieDirection ** 2) / (1 + config.mieCoefficient ** 2 - 2 * config.mieCoefficient * cosSunView) ** 1.5;

  const r = Math.exp(-totalRayleigh * rayleighColor[0] - totalMie * mieColor[0] * phase) * 3.0;
  const g = Math.exp(-totalRayleigh * rayleighColor[1] - totalMie * mieColor[1] * phase) * 3.0;
  const b = Math.exp(-totalRayleigh * rayleighColor[2] - totalMie * mieColor[2] * phase) * 3.0;

  return [Math.min(1, r), Math.min(1, g), Math.min(1, b)];
}
