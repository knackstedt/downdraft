import type { SABChannel } from "@downdraft/core";
import { defineChannel } from "@downdraft/core/sab/define";
import { packWaveData, type GerstnerWaveConfig } from "./gerstner.ts";

export const WaterSimChannel = defineChannel({
  name: "water-sim",
  magic: 0x57415453,
  version: 1,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: {
    waveData: { type: "f32", count: 16 },
    time: { type: "f32" },
  },
});

export class WaterSABChannel {
  private writer: ReturnType<typeof WaterSimChannel.writer>;
  private reader: ReturnType<typeof WaterSimChannel.reader>;
  private config: GerstnerWaveConfig;
  private time = 0;

  constructor(channel: SABChannel, config: GerstnerWaveConfig) {
    this.writer = WaterSimChannel.writer(channel.buffer);
    this.reader = WaterSimChannel.reader(channel.buffer);
    this.config = config;
  }

  update(dt: number): void {
    this.time += dt;
  }

  write(): void {
    const waveData = packWaveData(this.config, this.time);
    const w = this.writer;
    for (let i = 0; i < 16; i++) {
      (w.fields.waveData as Float32Array)[i] = waveData[i] ?? 0;
    }
    (w.fields.time as Float32Array)[0] = this.time;
    w.bumpSequence();
  }

  read(): { waveData: Float32Array; time: number } | null {
    const data = this.reader.snapshot();
    if (!data) return null;
    return {
      waveData: new Float32Array(data.waveData as number[]),
      time: data.time as number,
    };
  }

  getTime(): number {
    return this.time;
  }
}
