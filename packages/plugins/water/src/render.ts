import type { GerstnerWaveConfig } from "./gerstner.ts";
import { packWaveUniforms, DEFAULT_WAVE_CONFIG, gerstnerHeight, gerstnerDisplacement, gerstnerNormal } from "./gerstner.ts";
import type { SABChannel } from "@downdraft/core";
import { SeqlockBuffer, createLayout, type BufferLayout } from "@downdraft/core";

export const WATER_RENDER_LAYOUT: BufferLayout = createLayout([
  { name: "waveData", type: "f32", count: 32 },
  { name: "deepColor", type: "f32", count: 4 },
  { name: "shallowColor", type: "f32", count: 4 },
  { name: "foamColor", type: "f32", count: 4 },
  { name: "time", type: "f32", count: 1 },
  { name: "cameraPos", type: "f32", count: 3 },
]);

export interface WaterRenderResources {
  waveUniforms: Float32Array;
  sabChannel: SABChannel | null;
  seqlock: SeqlockBuffer | null;
}

export class WaterRenderPass {
  readonly name = "water";
  private config: GerstnerWaveConfig;
  private time = 0;
  private sabChannel: SABChannel | null = null;
  private seqlock: SeqlockBuffer | null = null;
  private cameraPos: [number, number, number] = [0, 0, 0];

  constructor(config?: Partial<GerstnerWaveConfig>) {
    this.config = { ...DEFAULT_WAVE_CONFIG, ...config };
  }

  setSABChannel(channel: SABChannel): void {
    this.sabChannel = channel;
    this.seqlock = new SeqlockBuffer(channel.buffer, WATER_RENDER_LAYOUT);
  }

  setCameraPos(pos: [number, number, number]): void {
    this.cameraPos = pos;
  }

  update(dt: number): void {
    this.time += dt;
  }

  getConfig(): GerstnerWaveConfig {
    return this.config;
  }

  setConfig(config: Partial<GerstnerWaveConfig>): void {
    this.config = { ...this.config, ...config };
  }

  prepare(): WaterRenderResources {
    const waveUniforms = packWaveUniforms(this.config, this.time);
    return {
      waveUniforms,
      sabChannel: this.sabChannel,
      seqlock: this.seqlock,
    };
  }

  writeSAB(): void {
    if (!this.seqlock) return;
    const waveUniforms = packWaveUniforms(this.config, this.time);
    this.seqlock.write({
      waveData: waveUniforms,
      deepColor: new Float32Array(this.config.deepColor),
      shallowColor: new Float32Array(this.config.shallowColor),
      foamColor: new Float32Array(this.config.foamColor),
      time: this.time,
      cameraPos: new Float32Array(this.cameraPos),
    });
  }

  getWaveHeight(x: number, z: number): number {
    return gerstnerHeight(x, z, this.time, this.config.waves);
  }

  getWaveDisplacement(x: number, z: number): { x: number; y: number; z: number } {
    return gerstnerDisplacement(x, z, this.time, this.config.waves);
  }

  getWaveNormal(x: number, z: number): [number, number, number] {
    return gerstnerNormal(x, z, this.time, this.config.waves);
  }

  destroy(): void {
    this.sabChannel = null;
    this.seqlock = null;
  }
}
