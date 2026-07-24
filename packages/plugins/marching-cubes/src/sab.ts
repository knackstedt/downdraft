import type { SABChannel } from "@downdraft/core";
import { SeqlockBuffer, createLayout, type BufferLayout } from "@downdraft/core";

export const TERRAIN_SAB_LAYOUT: BufferLayout = createLayout([
  { name: "heightmap", type: "f32", count: 64 },
  { name: "chunkX", type: "i32", count: 1 },
  { name: "chunkZ", type: "i32", count: 1 },
]);

export class TerrainSABChannel {
  private seqlock: SeqlockBuffer;

  constructor(channel: SABChannel) {
    this.seqlock = new SeqlockBuffer(channel.buffer, TERRAIN_SAB_LAYOUT);
  }

  write(heightmap: Float32Array, chunkX: number, chunkZ: number): void {
    const data = new Float32Array(64);
    for (let i = 0; i < Math.min(heightmap.length, 64); i++) {
      data[i] = heightmap[i];
    }
    this.seqlock.write({
      heightmap: data,
      chunkX,
      chunkZ,
    });
  }

  read(): { heightmap: Float32Array; chunkX: number; chunkZ: number } | null {
    const data = this.seqlock.read();
    if (!data) return null;
    return {
      heightmap: data.heightmap as Float32Array,
      chunkX: data.chunkX as number,
      chunkZ: data.chunkZ as number,
    };
  }
}
