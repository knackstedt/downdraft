// ============================================================================
// Water Buffer — SharedArrayBuffer for water heightfield data
// ============================================================================

import { defineChannel } from "@downdraft/core/sab/define";

export const WaterChannel = defineChannel({
  name: "game-water",
  magic: 0x57415452,
  version: 1,
  mode: "grid",
  header: {
    size: 64,
    fields: {
      gridSize: { type: "u32" },
      patchSize: { type: "u32" },
      originX: { type: "i32" },
      originZ: { type: "i32" },
    },
  },
  grid: {
    size: 256,
    layers: {
      heights: { type: "f32", components: 1 },
      normals: { type: "f32", components: 3 },
      flow: { type: "f32", components: 2 },
    },
  },
});

export const WATER_MAGIC = 0x57415452;
export const WATER_VERSION = 1;
export const WATER_GRID = 256;
export const WATER_HEIGHT_OFFSET = 64;
export const WATER_NORMAL_OFFSET = WATER_HEIGHT_OFFSET + WATER_GRID * WATER_GRID * 4;
export const WATER_FLOW_OFFSET = WATER_NORMAL_OFFSET + WATER_GRID * WATER_GRID * 12;

// Header field offsets (u32 indices within header, after reserved magic/version/sequence)
export const WATER_HDR = {
  MAGIC: 0,
  VERSION: 1,
  GRID_SIZE: 3,
  PATCH_SIZE: 4,
  SEQUENCE: 2,
  ORIGIN_X: 5,
  ORIGIN_Z: 6,
} as const;

export class WaterBufferWriter {
  private writer: ReturnType<typeof WaterChannel.writer>;
  heights: Float32Array;
  normals: Float32Array;
  flow: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.writer = WaterChannel.writer(sab);
    this.heights = this.writer.layers.heights;
    this.normals = this.writer.layers.normals;
    this.flow = this.writer.layers.flow;
  }

  init(patchSize: number) {
    const w = this.writer;
    const h = WaterChannel.offsets.header;
    w.header.u32[h.gridSize] = WATER_GRID;
    w.header.u32[h.patchSize] = patchSize;
    w.header.i32[h.originX] = 0;
    w.header.i32[h.originZ] = 0;
  }

  getPatchSize(): number { return this.writer.header.u32[WaterChannel.offsets.header.patchSize]; }

  getOrigin(): { x: number; z: number } {
    return {
      x: this.writer.header.i32[WaterChannel.offsets.header.originX],
      z: this.writer.header.i32[WaterChannel.offsets.header.originZ],
    };
  }

  setOrigin(x: number, z: number) {
    this.writer.header.i32[WaterChannel.offsets.header.originX] = x;
    this.writer.header.i32[WaterChannel.offsets.header.originZ] = z;
  }

  incrementSequence() {
    this.writer.bumpSequence();
  }

  setHeight(gx: number, gz: number, h: number) {
    this.heights[gz * WATER_GRID + gx] = h;
  }

  getHeight(gx: number, gz: number): number {
    return this.heights[gz * WATER_GRID + gx];
  }

  sampleHeight(gx: number, gz: number): number {
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(x0 + 1, WATER_GRID - 1);
    const z1 = Math.min(z0 + 1, WATER_GRID - 1);
    const fx = gx - x0;
    const fz = gz - z0;

    const h00 = this.heights[z0 * WATER_GRID + x0];
    const h10 = this.heights[z0 * WATER_GRID + x1];
    const h01 = this.heights[z1 * WATER_GRID + x0];
    const h11 = this.heights[z1 * WATER_GRID + x1];

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fz) + h1 * fz;
  }
}

export class WaterBufferReader {
  private reader: ReturnType<typeof WaterChannel.reader>;
  heights: Float32Array;
  normals: Float32Array;
  flow: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.reader = WaterChannel.reader(sab);
    this.heights = this.reader.layers.heights;
    this.normals = this.reader.layers.normals;
    this.flow = this.reader.layers.flow;
  }

  isValid(): boolean {
    return this.reader.isValid();
  }

  getSequence(): number { return this.reader.getSequence(); }
  getGridSize(): number { return this.reader.header.u32[WaterChannel.offsets.header.gridSize]; }
  getPatchSize(): number { return this.reader.header.u32[WaterChannel.offsets.header.patchSize]; }
  getOrigin(): { x: number; z: number } {
    return {
      x: this.reader.header.i32[WaterChannel.offsets.header.originX],
      z: this.reader.header.i32[WaterChannel.offsets.header.originZ],
    };
  }

  sampleHeight(gx: number, gz: number): number {
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(x0 + 1, WATER_GRID - 1);
    const z1 = Math.min(z0 + 1, WATER_GRID - 1);
    const fx = gx - x0;
    const fz = gz - z0;

    const h00 = this.heights[z0 * WATER_GRID + x0];
    const h10 = this.heights[z0 * WATER_GRID + x1];
    const h01 = this.heights[z1 * WATER_GRID + x0];
    const h11 = this.heights[z1 * WATER_GRID + x1];

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fz) + h1 * fz;
  }
}
