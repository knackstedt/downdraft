// ============================================================================
// Water Physics — updates the 256×256 heightfield grid each tick
// Combines Gerstner waves + wind chop + shore damping + shore ring waves
// Ported from to-the-ocean's simulation water buffer update logic
// ============================================================================

import { type GerstnerWaveParams } from "./gerstner.ts";
import { type ShoreSource, shoreDamping, shoreDisplacement, waterCutout } from "./shore-damping.ts";
import { WATER_GRID, WaterBuffer } from "./water-buffer.ts";
import { type WakeSource, MAX_WAKES } from "./wave-sources.ts";

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
  waterRenderDistance: number; // radius in meters around player to simulate
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
  waterRenderDistance: 500, // 500m radius around player
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
  private wakeSources: WakeSource[] = [];
  private wakeCount = 0;
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
    for (let i = 0; i < MAX_WAKES; i++) {
      this.wakeSources.push({ x: 0, z: 0, dirX: 0, dirZ: 0, speed: 0 });
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

  setWakeSources(sources: WakeSource[], count: number): void {
    this.wakeSources = sources;
    this.wakeCount = count;
  }

  private weatherWaveScale(): number {
    // Scale Gerstner amplitudes by wind speed: calm=0.3x, moderate=0.6x, storm=2.5x
    const ws = this.config.windSpeed;
    return 0.3 + Math.max(0, ws - 2) * 0.1;
  }

  update(dt: number, playerX: number, playerZ: number): void {
    this.time += dt;
    const patchSize = this.buffer.getPatchSize();
    const gridSize = WATER_GRID;
    const gridWorldSize = gridSize * patchSize; // 1024m
    // Snap origin to chunk boundaries so waves don't shift when player moves
    // within a chunk. Chunks are gridWorldSize large, so origin only moves
    // when the player crosses a 1024m boundary.
    const originX = Math.floor((playerX - gridWorldSize / 2) / gridWorldSize) * gridWorldSize;
    const originZ = Math.floor((playerZ - gridWorldSize / 2) / gridWorldSize) * gridWorldSize;
    this.buffer.setOrigin(originX, originZ);

    const renderDist = this.config.waterRenderDistance;
    const renderDistSq = renderDist * renderDist;

    const heights = this.buffer.getHeightsRef();
    const chopAmp = windChopAmp(this.config.windSpeed);
    const waveScale = this.weatherWaveScale();
    const t = this.time;
    const waves = this.precomputedWaves;
    const numWaves = waves.length;
    const shoreSrcs = this.shoreSources;
    const shoreCnt = this.shoreCount;
    const wakeSrcs = this.wakeSources;
    const wakeCnt = this.wakeCount;

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

        // Skip cells outside render distance (circular mask around player)
        const ddx = worldX - playerX;
        const ddz = worldZ - playerZ;
        if (ddx * ddx + ddz * ddz > renderDistSq) {
          heights[rowOffset + gx] = -1000;
          continue;
        }

        let h = 0;
        for (let i = 0; i < numWaves; i++) {
          const w = waves[i];
          h += w.amplitude * waveScale * Math.sin(w.k * (w.dx * worldX + w.dz * worldZ) - this.gerstnerPhase[i]);
        }

        h += (Math.sin(worldX * 0.15 + chopT1a) * Math.cos(worldZ * 0.12 + chopT1b) * 0.6
            + Math.sin(worldX * 0.4 - chopT2a) * Math.cos(worldZ * 0.35 + chopT2b) * 0.15
            + Math.sin((worldX + worldZ) * 0.1 + chopT3) * 0.3) * chopAmp * waveScale;

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
              const ringH = Math.sin(ringDist * 0.2 + shoreTime) * (1.5 * shoal);
              const distFade = Math.exp(-Math.max(ringDist - dampRange, 0.0) * 0.08);
              shoreH += ringH * distFade * outerFade;
            }
          }
        }

        h *= damping;
        h += shoreH;

        // Wake displacement from moving vessels (V-shaped wake behind ship)
        for (let i = 0; i < wakeCnt; i++) {
          const ws = wakeSrcs[i];
          if (ws.speed < 0.5) continue;
          const dx = worldX - ws.x;
          const dz = worldZ - ws.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist > 40.0) continue;
          // Project onto ship direction (forward = behind ship for wake)
          const fwd = dx * ws.dirX + dz * ws.dirZ;
          const lat = -dx * ws.dirZ + dz * ws.dirX;
          // Wake is behind the ship (negative forward)
          if (fwd > 2.0) continue;
          const behind = -fwd;
          if (behind > 35.0) continue;
          // V-shaped wake spread
          const wakeSpread = 0.36;
          const wakeEdge = behind * wakeSpread;
          const latAbs = Math.abs(lat);
          if (latAbs > wakeEdge) continue;
          // Lateral fade
          const lateralFade = 1.0 - (latAbs / Math.max(wakeEdge, 0.001));
          // Distance fade
          const distFade = Math.exp(-behind * 0.04);
          // Speed factor
          const speedFactor = Math.min(ws.speed / 10.0, 1.5);
          // Wake ridges
          const k = 0.5;
          const ridge1 = Math.sin(behind * k - t * 3.0) * 0.4;
          const ridge2 = Math.sin(behind * k * 1.5 - t * 4.0) * 0.2;
          const wakeH = (ridge1 + ridge2) * distFade * lateralFade * speedFactor;
          h += wakeH * damping;
        }

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
