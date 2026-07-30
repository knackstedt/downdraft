import type { SABChannel } from "@downdraft/core";
import { defineChannel } from "@downdraft/core/sab/define";
import type { GerstnerWaveConfig } from "./gerstner.ts";
import { DEFAULT_WAVE_CONFIG, gerstnerDisplacement, gerstnerHeight, gerstnerNormal, packWaveUniforms } from "./gerstner.ts";

export const WaterRenderChannel = defineChannel({
  name: "water-render",
  magic: 0x57415252,
  version: 1,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: {
    waveData: { type: "f32", count: 32 },
    deepColor: { type: "f32", count: 4 },
    shallowColor: { type: "f32", count: 4 },
    foamColor: { type: "f32", count: 4 },
    time: { type: "f32" },
    cameraPos: { type: "f32", count: 3 },
  },
});

export interface WaterRenderResources {
  waveUniforms: Float32Array;
  sabChannel: SABChannel | null;
  writer: ReturnType<typeof WaterRenderChannel.writer> | null;
}

export class WaterRenderPass {
  readonly name = "water";
  private config: GerstnerWaveConfig;
  private time = 0;
  private sabChannel: SABChannel | null = null;
  private writer: ReturnType<typeof WaterRenderChannel.writer> | null = null;
  private cameraPos: [number, number, number] = [0, 0, 0];

  constructor(config?: Partial<GerstnerWaveConfig>) {
    this.config = { ...DEFAULT_WAVE_CONFIG, ...config };
  }

  setSABChannel(channel: SABChannel): void {
    this.sabChannel = channel;
    this.writer = WaterRenderChannel.writer(channel.buffer);
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
      writer: this.writer,
    };
  }

  writeSAB(): void {
    if (!this.writer) return;
    const w = this.writer;
    const waveUniforms = packWaveUniforms(this.config, this.time);
    for (let i = 0; i < 32; i++) {
      (w.fields.waveData as Float32Array)[i] = waveUniforms[i] ?? 0;
    }
    for (let i = 0; i < 4; i++) {
      (w.fields.deepColor as Float32Array)[i] = this.config.deepColor[i];
      (w.fields.shallowColor as Float32Array)[i] = this.config.shallowColor[i];
      (w.fields.foamColor as Float32Array)[i] = this.config.foamColor[i];
    }
    (w.fields.time as Float32Array)[0] = this.time;
    (w.fields.cameraPos as Float32Array)[0] = this.cameraPos[0];
    (w.fields.cameraPos as Float32Array)[1] = this.cameraPos[1];
    (w.fields.cameraPos as Float32Array)[2] = this.cameraPos[2];
    w.bumpSequence();
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
    this.writer = null;
  }
}
