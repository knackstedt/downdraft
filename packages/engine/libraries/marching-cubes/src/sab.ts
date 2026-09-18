import type { SABChannel } from "@downdraft/engine";
import { defineChannel } from "@downdraft/engine/sab/define";

export const TerrainChannel = defineChannel({
  name: "terrain",
  magic: 0x54455252,
  version: 1,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: {
    heightmap: { type: "f32", count: 64 },
    chunkX: { type: "i32" },
    chunkZ: { type: "i32" },
  },
});

export class TerrainSABChannel {
  private writer: ReturnType<typeof TerrainChannel.writer>;
  private reader: ReturnType<typeof TerrainChannel.reader>;

  constructor(channel: SABChannel) {
    this.writer = TerrainChannel.writer(channel.buffer);
    this.reader = TerrainChannel.reader(channel.buffer);
  }

  write(heightmap: Float32Array, chunkX: number, chunkZ: number): void {
    const w = this.writer;
    for (let i = 0; i < Math.min(heightmap.length, 64); i++) {
      (w.fields.heightmap as Float32Array)[i] = heightmap[i];
    }
    (w.fields.chunkX as Int32Array)[0] = chunkX;
    (w.fields.chunkZ as Int32Array)[0] = chunkZ;
    w.bumpSequence();
  }

  read(): { heightmap: Float32Array; chunkX: number; chunkZ: number } | null {
    const data = this.reader.snapshot();
    if (!data) return null;
    return {
      heightmap: new Float32Array(data.heightmap as number[]),
      chunkX: data.chunkX as number,
      chunkZ: data.chunkZ as number,
    };
  }
}
