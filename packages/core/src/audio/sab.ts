import type { SABChannel } from "../plugin/plugin.ts";
import { SeqlockBuffer, createLayout, type BufferLayout } from "../sab/seqlock.ts";
import type { AudioListenerState } from "./interface.ts";

export const AUDIO_SAB_LAYOUT: BufferLayout = createLayout([
  { name: "sourcePositions", type: "f32", count: 32 },
  { name: "listenerPosition", type: "f32", count: 3 },
  { name: "listenerOrientation", type: "f32", count: 4 },
]);

export interface AudioSABData {
  sourcePositions: number[];
  listenerPosition: number[];
  listenerOrientation: number[];
}

export class AudioSABChannel {
  private seqlock: SeqlockBuffer;
  private sourcePositions: number[] = new Array(32).fill(0);
  private listener: AudioListenerState = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    gain: 1.0,
  };

  constructor(channel: SABChannel) {
    this.seqlock = new SeqlockBuffer(channel.buffer, AUDIO_SAB_LAYOUT);
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
    this.seqlock.write({
      sourcePositions: this.sourcePositions,
      listenerPosition: [...this.listener.position],
      listenerOrientation: [...this.listener.orientation],
    });
  }

  read(): AudioSABData | null {
    const data = this.seqlock.read();
    if (!data) return null;
    return {
      sourcePositions: data.sourcePositions as number[],
      listenerPosition: data.listenerPosition as number[],
      listenerOrientation: data.listenerOrientation as number[],
    };
  }
}
