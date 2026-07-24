export interface GerstnerWaveParams {
  direction: [number, number];
  amplitude: number;
  wavelength: number;
  speed: number;
  steepness: number;
}

export interface GerstnerWaveConfig {
  waves: GerstnerWaveParams[];
  windDirection: [number, number];
  windSpeed: number;
  deepColor: [number, number, number, number];
  shallowColor: [number, number, number, number];
  foamColor: [number, number, number, number];
  foamThreshold: number;
  tiling: number;
  normalStrength: number;
  refractionStrength: number;
  reflectionStrength: number;
  depth: number;
}

export const DEFAULT_WAVE_CONFIG: GerstnerWaveConfig = {
  waves: [
    { direction: [1, 0], amplitude: 0.5, wavelength: 10, speed: 1.0, steepness: 0.8 },
    { direction: [0.7, 0.7], amplitude: 0.25, wavelength: 5, speed: 1.2, steepness: 0.6 },
    { direction: [-0.5, 0.8], amplitude: 0.15, wavelength: 3, speed: 1.5, steepness: 0.5 },
    { direction: [0.3, -0.9], amplitude: 0.08, wavelength: 1.5, speed: 2.0, steepness: 0.4 },
  ],
  windDirection: [1, 0],
  windSpeed: 1.0,
  deepColor: [0.04, 0.1, 0.2, 1.0],
  shallowColor: [0.2, 0.5, 0.7, 1.0],
  foamColor: [0.9, 0.95, 1.0, 1.0],
  foamThreshold: 0.8,
  tiling: 4.0,
  normalStrength: 1.0,
  refractionStrength: 0.02,
  reflectionStrength: 0.6,
  depth: 20.0,
};

export function gerstnerHeight(
  x: number,
  z: number,
  time: number,
  waves: GerstnerWaveParams[],
): number {
  let height = 0;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const k = (2 * Math.PI) / w.wavelength;
    const dirLen = Math.sqrt(w.direction[0] ** 2 + w.direction[1] ** 2);
    const dx = dirLen > 0 ? w.direction[0] / dirLen : 1;
    const dz = dirLen > 0 ? w.direction[1] / dirLen : 0;
    const phase = k * (dx * x + dz * z) - w.speed * time * 2 * Math.PI;
    height += w.amplitude * Math.sin(phase);
  }
  return height;
}

export function gerstnerDisplacement(
  x: number,
  z: number,
  time: number,
  waves: GerstnerWaveParams[],
): { x: number; y: number; z: number } {
  let dx = 0;
  let dy = 0;
  let dz = 0;

  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const k = (2 * Math.PI) / w.wavelength;
    const dirLen = Math.sqrt(w.direction[0] ** 2 + w.direction[1] ** 2);
    const nx = dirLen > 0 ? w.direction[0] / dirLen : 1;
    const nz = dirLen > 0 ? w.direction[1] / dirLen : 0;
    const phase = k * (nx * x + nz * z) - w.speed * time * 2 * Math.PI;
    const qa = w.steepness * w.amplitude;
    const c = Math.cos(phase);
    const s = Math.sin(phase);

    dx += qa * nx * c;
    dz += qa * nz * c;
    dy += w.amplitude * s;
  }

  return { x: x + dx, y: dy, z: z + dz };
}

export function gerstnerNormal(
  x: number,
  z: number,
  time: number,
  waves: GerstnerWaveParams[],
): [number, number, number] {
  const eps = 0.01;
  const h = gerstnerDisplacement(x, z, time, waves);
  const hx = gerstnerDisplacement(x + eps, z, time, waves);
  const hz = gerstnerDisplacement(x, z + eps, time, waves);

  const tx = hx.y - h.y;
  const tz = hz.y - h.y;
  const len = Math.sqrt(tx * tx + tz * tz + eps * eps);
  return [-tx / len, eps / len, -tz / len];
}

export function packWaveData(config: GerstnerWaveConfig, time: number): Float32Array {
  const data = new Float32Array(16);
  const waves = config.waves.slice(0, 4);
  for (let i = 0; i < 4; i++) {
    const w = waves[i] ?? { direction: [0, 0], amplitude: 0, wavelength: 1, speed: 0, steepness: 0 };
    const offset = i * 4;
    data[offset] = w.direction[0];
    data[offset + 1] = w.direction[1];
    data[offset + 2] = w.amplitude;
    data[offset + 3] = (2 * Math.PI) / w.wavelength;
  }
  return data;
}

export function packWaveUniforms(config: GerstnerWaveConfig, time: number): Float32Array {
  const data = new Float32Array(32);
  const waves = config.waves.slice(0, 4);
  for (let i = 0; i < 4; i++) {
    const w = waves[i] ?? { direction: [0, 0], amplitude: 0, wavelength: 1, speed: 0, steepness: 0 };
    const offset = i * 6;
    data[offset] = w.direction[0];
    data[offset + 1] = w.direction[1];
    data[offset + 2] = w.amplitude;
    data[offset + 3] = (2 * Math.PI) / w.wavelength;
    data[offset + 4] = w.speed;
    data[offset + 5] = w.steepness;
  }
  data[24] = config.tiling;
  data[25] = config.normalStrength;
  data[26] = config.refractionStrength;
  data[27] = config.reflectionStrength;
  data[28] = config.foamThreshold;
  data[29] = config.depth;
  data[30] = time;
  data[31] = config.windSpeed;
  return data;
}
