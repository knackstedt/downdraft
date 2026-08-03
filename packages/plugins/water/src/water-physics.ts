// ============================================================================
// Water Physics — updates the 256×256 heightfield grid each tick
// Combines Gerstner waves + wind chop + shore damping + shore ring waves
// Ported from to-the-ocean's simulation water buffer update logic
// ============================================================================

import { type ShoreSource, shoreDamping, shoreDisplacement, waterCutout } from "./shore-damping.ts";
import { WaterBuffer } from "./water-buffer.ts";
import { CHUNK_GRID, CHUNK_OVERLAP, CHUNK_WORLD_SIZE, MAX_CHUNKS, type WaterChunk } from "./water-chunks.ts";
import { MAX_WAKES, type WakeSource } from "./wave-sources.ts";

interface PrecomputedWave {
  k: number;
  dx: number;
  dz: number;
  amplitude: number;
  speedFactor: number;
}

export interface GerstnerWaveParams {
  direction: [number, number];
  amplitude: number;
  wavelength: number;
  speed: number;
  steepness: number;
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
  private chunks: Map<string, WaterChunk> = new Map();
  private activeChunks: WaterChunk[] = [];

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
    const renderDist = this.config.waterRenderDistance;
    const renderDistSq = renderDist * renderDist;

    // Precompute wave phases and shore data
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

    // Determine which chunks should be active (fixed positions, loaded in circle around player)
    const playerChunkX = Math.floor(playerX / CHUNK_WORLD_SIZE);
    const playerChunkZ = Math.floor(playerZ / CHUNK_WORLD_SIZE);
    const chunksPerSide = Math.ceil(renderDist / CHUNK_WORLD_SIZE) + 1;

    const newActive: WaterChunk[] = [];
    const seenKeys = new Set<string>();

    for (let cz = playerChunkZ - chunksPerSide; cz <= playerChunkZ + chunksPerSide; cz++) {
      for (let cx = playerChunkX - chunksPerSide; cx <= playerChunkX + chunksPerSide; cx++) {
        // Check if chunk center is within render distance (plus chunk radius for overlap)
        const chunkCenterX = cx * CHUNK_WORLD_SIZE + CHUNK_WORLD_SIZE / 2;
        const chunkCenterZ = cz * CHUNK_WORLD_SIZE + CHUNK_WORLD_SIZE / 2;
        const ddx = chunkCenterX - playerX;
        const ddz = chunkCenterZ - playerZ;
        const chunkRadius = CHUNK_WORLD_SIZE * 0.75;
        if (ddx * ddx + ddz * ddz > (renderDist + chunkRadius) * (renderDist + chunkRadius)) continue;
        if (newActive.length >= MAX_CHUNKS) continue;

        const key = cx + "," + cz;
        seenKeys.add(key);

        let chunk = this.chunks.get(key);
        if (!chunk) {
          chunk = {
            chunkX: cx,
            chunkZ: cz,
            originX: cx * CHUNK_WORLD_SIZE - CHUNK_OVERLAP * patchSize,
            originZ: cz * CHUNK_WORLD_SIZE - CHUNK_OVERLAP * patchSize,
            heights: new Float32Array(CHUNK_GRID * CHUNK_GRID),
          };
          this.chunks.set(key, chunk);
        }
        newActive.push(chunk);
      }
    }

    // Remove inactive chunks
    for (const [key] of this.chunks) {
      if (!seenKeys.has(key)) this.chunks.delete(key);
    }
    this.activeChunks = newActive;

    // Compute heights for each active chunk
    for (const chunk of newActive) {
      this.computeChunkHeights(chunk, playerX, playerZ, renderDistSq, patchSize, {
        chopAmp, waveScale, t, waves, numWaves, shoreSrcs, shoreCnt, wakeSrcs, wakeCnt,
        chopT1a, chopT1b, chopT2a, chopT2b, chopT3, shoreTime,
      });
    }
  }

  private computeChunkHeights(
    chunk: WaterChunk,
    playerX: number, playerZ: number, renderDistSq: number,
    patchSize: number,
    ctx: {
      chopAmp: number; waveScale: number; t: number;
      waves: PrecomputedWave[]; numWaves: number;
      shoreSrcs: ShoreSource[]; shoreCnt: number;
      wakeSrcs: WakeSource[]; wakeCnt: number;
      chopT1a: number; chopT1b: number; chopT2a: number; chopT2b: number;
      chopT3: number; shoreTime: number;
    },
  ): void {
    const heights = chunk.heights;
    const originX = chunk.originX;
    const originZ = chunk.originZ;

    for (let gz = 0; gz < CHUNK_GRID; gz++) {
      const worldZ = originZ + gz * patchSize;
      const rowOffset = gz * CHUNK_GRID;
      for (let gx = 0; gx < CHUNK_GRID; gx++) {
        const worldX = originX + gx * patchSize;

        // Skip cells outside render distance (circular mask around player)
        const ddx = worldX - playerX;
        const ddz = worldZ - playerZ;
        if (ddx * ddx + ddz * ddz > renderDistSq) {
          heights[rowOffset + gx] = -1000;
          continue;
        }

        let h = 0;
        for (let i = 0; i < ctx.numWaves; i++) {
          const w = ctx.waves[i];
          h += w.amplitude * ctx.waveScale * Math.sin(w.k * (w.dx * worldX + w.dz * worldZ) - this.gerstnerPhase[i]);
        }

        h += (Math.sin(worldX * 0.15 + ctx.chopT1a) * Math.cos(worldZ * 0.12 + ctx.chopT1b) * 0.6
            + Math.sin(worldX * 0.4 - ctx.chopT2a) * Math.cos(worldZ * 0.35 + ctx.chopT2b) * 0.15
            + Math.sin((worldX + worldZ) * 0.1 + ctx.chopT3) * 0.3) * ctx.chopAmp * ctx.waveScale;

        let damping = 1.0;
        let shoreH = 0.0;
        let cutout = false;
        for (let i = 0; i < ctx.shoreCnt; i++) {
          const src = ctx.shoreSrcs[i];
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
              const ringH = Math.sin(ringDist * 0.2 + ctx.shoreTime) * (1.5 * shoal);
              const distFade = Math.exp(-Math.max(ringDist - dampRange, 0.0) * 0.08);
              shoreH += ringH * distFade * outerFade;
            }
          }
        }

        h *= damping;
        h += shoreH;

        // Wake displacement from moving vessels
        for (let i = 0; i < ctx.wakeCnt; i++) {
          const ws = ctx.wakeSrcs[i];
          if (ws.speed < 0.5) continue;
          const dx = worldX - ws.x;
          const dz = worldZ - ws.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist > 40.0) continue;
          const fwd = dx * ws.dirX + dz * ws.dirZ;
          const lat = -dx * ws.dirZ + dz * ws.dirX;
          if (fwd > 2.0) continue;
          const behind = -fwd;
          if (behind > 35.0) continue;
          const wakeSpread = 0.36;
          const wakeEdge = behind * wakeSpread;
          const latAbs = Math.abs(lat);
          if (latAbs > wakeEdge) continue;
          const lateralFade = 1.0 - (latAbs / Math.max(wakeEdge, 0.001));
          const distFade = Math.exp(-behind * 0.04);
          const speedFactor = Math.min(ws.speed / 10.0, 1.5);
          const k = 0.5;
          const ridge1 = Math.sin(behind * k - ctx.t * 3.0) * 0.4;
          const ridge2 = Math.sin(behind * k * 1.5 - ctx.t * 4.0) * 0.2;
          const wakeH = (ridge1 + ridge2) * distFade * lateralFade * speedFactor;
          h += wakeH * damping;
        }

        if (cutout) h = -1000;

        heights[rowOffset + gx] = h;
      }
    }
  }

  getActiveChunks(): WaterChunk[] {
    return this.activeChunks;
  }

  sampleWaterAt(worldX: number, worldZ: number): number {
    if (waterCutout(worldX, worldZ, this.shoreSources, this.shoreCount)) return -1000;
    // Sample from active chunks
    const patchSize = this.buffer.getPatchSize();
    let rawH = 0;
    for (const chunk of this.activeChunks) {
      const gx = (worldX - chunk.originX) / patchSize;
      const gz = (worldZ - chunk.originZ) / patchSize;
      if (gx >= 0 && gx < CHUNK_GRID && gz >= 0 && gz < CHUNK_GRID) {
        const x0 = Math.floor(gx);
        const z0 = Math.floor(gz);
        const x1 = Math.min(x0 + 1, CHUNK_GRID - 1);
        const z1 = Math.min(z0 + 1, CHUNK_GRID - 1);
        const fx = gx - x0;
        const fz = gz - z0;
        const h00 = chunk.heights[z0 * CHUNK_GRID + x0];
        const h10 = chunk.heights[z0 * CHUNK_GRID + x1];
        const h01 = chunk.heights[z1 * CHUNK_GRID + x0];
        const h11 = chunk.heights[z1 * CHUNK_GRID + x1];
        if (h00 < -100 || h10 < -100 || h01 < -100 || h11 < -100) {
          rawH = -1000;
          break;
        }
        const h0 = h00 * (1 - fx) + h10 * fx;
        const h1 = h01 * (1 - fx) + h11 * fx;
        rawH = h0 * (1 - fz) + h1 * fz;
        break;
      }
    }
    if (rawH < -100) return -1000;
    const damping = shoreDamping(worldX, worldZ, this.shoreSources, this.shoreCount);
    const shore = shoreDisplacement(worldX, worldZ, this.time, this.shoreSources, this.shoreCount);
    return rawH * damping + shore;
  }

  getTime(): number { return this.time; }
}
