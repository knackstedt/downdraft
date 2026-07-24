import type { SABChannel } from "@downdraft/core";
import { SeqlockBuffer, createLayout, type BufferLayout } from "@downdraft/core";
import { packWaveData, type GerstnerWaveConfig } from "./gerstner.ts";

export const WATER_SAB_LAYOUT: BufferLayout = createLayout([
  { name: "waveData", type: "f32", count: 16 },
  { name: "time", type: "f32", count: 1 },
]);

export class WaterSABChannel {
  private seqlock: SeqlockBuffer;
  private config: GerstnerWaveConfig;
  private time = 0;

  constructor(channel: SABChannel, config: GerstnerWaveConfig) {
    this.seqlock = new SeqlockBuffer(channel.buffer, WATER_SAB_LAYOUT);
    this.config = config;
  }

  update(dt: number): void {
    this.time += dt;
  }

  write(): void {
    const waveData = packWaveData(this.config, this.time);
    this.seqlock.write({
      waveData,
      time: this.time,
    });
  }

  read(): { waveData: Float32Array; time: number } | null {
    const data = this.seqlock.read();
    if (!data) return null;
    return {
      waveData: data.waveData as Float32Array,
      time: data.time as number,
    };
  }

  getTime(): number {
    return this.time;
  }
}
