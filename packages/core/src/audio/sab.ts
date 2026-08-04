import type { SABChannel } from "../plugin/plugin";
import { defineChannel } from "../sab/define";
import type { AudioListenerState } from "./interface";

export const AudioSABChannelDef = defineChannel({
  name: "audio-position",
  magic: 0x41554449,
  version: 1,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: {
    sourcePositions: { type: "f32", count: 32 },
    listenerPosition: { type: "f32", count: 3 },
    listenerOrientation: { type: "f32", count: 4 },
  },
});

export interface AudioSABData {
  sourcePositions: number[];
  listenerPosition: number[];
  listenerOrientation: number[];
}

export class AudioSABChannel {
  private writer: ReturnType<typeof AudioSABChannelDef.writer>;
  private reader: ReturnType<typeof AudioSABChannelDef.reader>;
  private sourcePositions: number[] = new Array(32).fill(0);
  private listener: AudioListenerState = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    gain: 1.0,
  };

  constructor(channel: SABChannel) {
    this.writer = AudioSABChannelDef.writer(channel.buffer);
    this.reader = AudioSABChannelDef.reader(channel.buffer);
  }

  setListener(listener: AudioListenerState): void {
    this.listener = listener;
  }

  setSourcePositions(positions: Array<[number, number, number]>): void {
    for (let i = 0; i < 32; i++) {
      const offset = i * 3;
      if (i < positions.length) {
        this.sourcePositions[offset] = positions[i][0];
        this.sourcePositions[offset + 1] = positions[i][1];
        this.sourcePositions[offset + 2] = positions[i][2];
      } else {
        this.sourcePositions[offset] = 0;
        this.sourcePositions[offset + 1] = 0;
        this.sourcePositions[offset + 2] = 0;
      }
    }
  }

  write(): void {
    const w = this.writer;
    const off = AudioSABChannelDef.offsets.fields;
    for (let i = 0; i < 32; i++) {
      (w.fields.sourcePositions as Float32Array)[i] = this.sourcePositions[i];
    }
    (w.fields.listenerPosition as Float32Array)[0] = this.listener.position[0];
    (w.fields.listenerPosition as Float32Array)[1] = this.listener.position[1];
    (w.fields.listenerPosition as Float32Array)[2] = this.listener.position[2];
    (w.fields.listenerOrientation as Float32Array)[0] = this.listener.orientation[0];
    (w.fields.listenerOrientation as Float32Array)[1] = this.listener.orientation[1];
    (w.fields.listenerOrientation as Float32Array)[2] = this.listener.orientation[2];
    (w.fields.listenerOrientation as Float32Array)[3] = this.listener.orientation[3] ?? 0;
    w.bumpSequence();
  }

  read(): AudioSABData | null {
    const data = this.reader.snapshot();
    if (!data) return null;
    return {
      sourcePositions: data.sourcePositions as number[],
      listenerPosition: data.listenerPosition as number[],
      listenerOrientation: data.listenerOrientation as number[],
    };
  }
}
