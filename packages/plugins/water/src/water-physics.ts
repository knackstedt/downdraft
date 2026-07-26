// ============================================================================
// Water Physics — updates the 256×256 heightfield grid each tick
// Combines Gerstner waves + wind chop + shore damping + shore ring waves
// Ported from to-the-ocean's simulation water buffer update logic
// ============================================================================

import { type GerstnerWaveParams } from "./gerstner.ts";
import { type ShoreSource, shoreDamping, shoreDisplacement, waterCutout } from "./shore-damping.ts";
import { WATER_GRID, WaterBuffer } from "./water-buffer.ts";

interface PrecomputedWave {
  k: number;
  dx: number;
  dz: number;
  amplitude: number;
  speedFactor: number;
}

export interface WaterPhysicsConfig {
  waves: GerstnerWaveParams[];
  windSpeed: number;
  windDirX: number;
  windDirZ: number;
  waterLevel: number;
}

export const DEFAULT_PHYSICS_CONFIG: WaterPhysicsConfig = {
  waves: [
    { direction: [1, 0], amplitude: 0.5, wavelength: 10, speed: 1.0, steepness: 0.75 },
    { direction: [0.7, 0.7], amplitude: 0.25, wavelength: 5, speed: 1.2, steepness: 0.6 },
    { direction: [-0.5, 0.8], amplitude: 0.15, wavelength: 3, speed: 1.5, steepness: 0.5 },
    { direction: [0.3, -0.9], amplitude: 0.08, wavelength: 1.5, speed: 2.0, steepness: 0.4 },
  ],
  windSpeed: 3,
  windDirX: 1,
  windDirZ: 0,
  waterLevel: 0,
};

function windChopAmp(windSpeed: number): number {
  const ss = Math.max(0, Math.min(1, (windSpeed - 2) / 23));
  return 0.15 + ss * 0.65;
}

export class WaterPhysics {
  private buffer: WaterBuffer;
  private config: WaterPhysicsConfig;
  private time = 0;
  private shoreSources: ShoreSource[] = [];
  private shoreCount = 0;
  private precomputedWaves: PrecomputedWave[] = [];
  private gerstnerPhase: Float64Array;
  private shoreBandEndSq: Float64Array;
  private shoreCutoutRSq: Float64Array;
  private shoreDampR: Float64Array;
  private shoreDampRange: Float64Array;

  constructor(buffer: WaterBuffer, config?: Partial<WaterPhysicsConfig>) {
    this.buffer = buffer;
    this.config = { ...DEFAULT_PHYSICS_CONFIG, ...config };
    this.precomputeWaves();
    for (let i = 0; i < 128; i++) {
      this.shoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
    }
    this.gerstnerPhase = new Float64Array(8);
    this.shoreBandEndSq = new Float64Array(128);
    this.shoreCutoutRSq = new Float64Array(128);
    this.shoreDampR = new Float64Array(128);
    this.shoreDampRange = new Float64Array(128);
  }

  private precomputeWaves(): void {
    this.precomputedWaves = this.config.waves.map(w => {
      const k = (2 * Math.PI) / w.wavelength;
      const dirLen = Math.sqrt(w.direction[0] ** 2 + w.direction[1] ** 2);
      return {
        k,
        dx: dirLen > 0 ? w.direction[0] / dirLen : 1,
        dz: dirLen > 0 ? w.direction[1] / dirLen : 0,
        amplitude: w.amplitude,
        speedFactor: w.speed * 2 * Math.PI,
      };
    });
  }

  getConfig(): WaterPhysicsConfig { return this.config; }
  setConfig(config: Partial<WaterPhysicsConfig>): void {
    this.config = { ...this.config, ...config };
    this.precomputeWaves();
  }

  getBuffer(): WaterBuffer { return this.buffer; }

  setShoreSources(sources: ShoreSource[], count: number): void {
    this.shoreSources = sources;
    this.shoreCount = count;
  }

  update(dt: number, cameraX: number, cameraZ: number): void {
    this.time += dt;
    const patchSize = this.buffer.getPatchSize();
    const gridSize = WATER_GRID;
    const halfGrid = (gridSize * patchSize) / 2;
    const originX = Math.round((cameraX - halfGrid) / patchSize) * patchSize;
    const originZ = Math.round((cameraZ - halfGrid) / patchSize) * patchSize;
    this.buffer.setOrigin(originX, originZ);

    const heights = this.buffer.getHeightsRef();
    const chopAmp = windChopAmp(this.config.windSpeed);
    const t = this.time;
    const waves = this.precomputedWaves;
    const numWaves = waves.length;
    const shoreSrcs = this.shoreSources;
    const shoreCnt = this.shoreCount;

    for (let i = 0; i < numWaves; i++) {
      this.gerstnerPhase[i] = waves[i].speedFactor * t;
    }
    for (let i = 0; i < shoreCnt; i++) {
      const src = shoreSrcs[i];
      const r = src.radius;
      const dampR = r * 1.2 + 8.0;
      this.shoreDampR[i] = dampR;
      this.shoreDampRange[i] = dampR - r;
      this.shoreBandEndSq[i] = (dampR + 20.0) * (dampR + 20.0);
      this.shoreCutoutRSq[i] = src.cutoutRadius * src.cutoutRadius;
    }

    const chopT1a = t * 0.12, chopT1b = t * 0.10;
    const chopT2a = t * 0.2,  chopT2b = t * 0.15;
    const chopT3 = t * 0.08;
    const shoreTime = t * 0.35;

    for (let gz = 0; gz < gridSize; gz++) {
      const worldZ = originZ + gz * patchSize;
      const rowOffset = gz * gridSize;
      for (let gx = 0; gx < gridSize; gx++) {
        const worldX = originX + gx * patchSize;

        let h = 0;
        for (let i = 0; i < numWaves; i++) {
          const w = waves[i];
          h += w.amplitude * Math.sin(w.k * (w.dx * worldX + w.dz * worldZ) - this.gerstnerPhase[i]);
        }

        h += (Math.sin(worldX * 0.15 + chopT1a) * Math.cos(worldZ * 0.12 + chopT1b) * 0.6
            + Math.sin(worldX * 0.4 - chopT2a) * Math.cos(worldZ * 0.35 + chopT2b) * 0.15
            + Math.sin((worldX + worldZ) * 0.1 + chopT3) * 0.3) * chopAmp;

        let damping = 1.0;
        let shoreH = 0.0;
        let cutout = false;
        for (let i = 0; i < shoreCnt; i++) {
          const src = shoreSrcs[i];
          const r = src.radius;
          const cr = src.cutoutRadius;
          if (r < 0.001 && cr < 0.001) continue;

          const sdx = worldX - src.x;
          const sdz = worldZ - src.z;
          const distSq = sdx * sdx + sdz * sdz;

          if (cr >= 0.001 && distSq < this.shoreCutoutRSq[i]) cutout = true;
          if (r < 0.001) continue;
          if (distSq > this.shoreBandEndSq[i]) continue;

          const dist = Math.sqrt(distSq);
          const flatR = r;
          const dampR = this.shoreDampR[i];
          const dampRange = this.shoreDampRange[i];

          let st = (dist - flatR) / dampRange;
          st = st < 0 ? 0 : st > 1 ? 1 : st;
          const smoothT = st * st * (3 - 2 * st);
          if (smoothT < damping) damping = smoothT;

          if (smoothT > 0.001) {
            const bandEnd = dampR + 20.0;
            const fadeW = 8.0;
            let ot = (dist - (bandEnd - fadeW)) / fadeW;
            ot = ot < 0 ? 0 : ot > 1 ? 1 : ot;
            const outerFade = 1.0 - ot * ot * (3 - 2 * ot);
            if (outerFade > 0.001) {
              const ringDist = dist - r;
              const shoal = 1.0 - smoothT * 0.6;
              const ringH = Math.sin(ringDist * 0.2 + shoreTime) * (0.5 * shoal);
              const distFade = Math.exp(-Math.max(ringDist - dampRange, 0.0) * 0.08);
              shoreH += ringH * distFade * outerFade;
            }
          }
        }

        h *= damping;
        h += shoreH;
        if (cutout) h = -1000;

        heights[rowOffset + gx] = h;
      }
    }
  }

  sampleWaterAt(worldX: number, worldZ: number): number {
    if (waterCutout(worldX, worldZ, this.shoreSources, this.shoreCount)) return -1000;
    const rawH = this.buffer.sampleWorldHeight(worldX, worldZ);
    const damping = shoreDamping(worldX, worldZ, this.shoreSources, this.shoreCount);
    const shore = shoreDisplacement(worldX, worldZ, this.time, this.shoreSources, this.shoreCount);
    return rawH * damping + shore;
  }

  getTime(): number { return this.time; }
}
