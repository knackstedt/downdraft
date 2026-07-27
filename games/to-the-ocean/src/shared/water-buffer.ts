// ============================================================================
// Water Buffer — SharedArrayBuffer for water heightfield data
// ============================================================================

export const WATER_MAGIC = 0x57415452; // 'WATR'
export const WATER_VERSION = 1;

// Header (64 bytes / 16 u32s)
// [0] magic, [1] version, [2] gridSize, [3] patchSize (meters)
// [4] sequence (atomic), [5] originX (i32), [6] originZ (i32)
// [7..15] reserved

export const WATER_HDR = {
  MAGIC: 0,
  VERSION: 1,
  GRID_SIZE: 2,
  PATCH_SIZE: 3,
  SEQUENCE: 4,
  ORIGIN_X: 5,
  ORIGIN_Z: 6,
} as const;

// Data layout after 64-byte header:
// - heights: gridSize * gridSize * f32 (4 bytes each)
// - normals: gridSize * gridSize * f32x3 (12 bytes each)
// - flow:    gridSize * gridSize * f32x2 (8 bytes each)

export const WATER_GRID = 256;
export const WATER_HEIGHT_OFFSET = 64;
export const WATER_NORMAL_OFFSET = WATER_HEIGHT_OFFSET + WATER_GRID * WATER_GRID * 4;
export const WATER_FLOW_OFFSET = WATER_NORMAL_OFFSET + WATER_GRID * WATER_GRID * 12;

export class WaterBufferWriter {
  private sab: SharedArrayBuffer;
  private u32: Uint32Array;
  private i32: Int32Array;
  private f32: Float32Array;
  heights: Float32Array;
  normals: Float32Array;
  flow: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.i32 = new Int32Array(sab);
    this.f32 = new Float32Array(sab);
    this.heights = new Float32Array(sab, WATER_HEIGHT_OFFSET, WATER_GRID * WATER_GRID);
    this.normals = new Float32Array(sab, WATER_NORMAL_OFFSET, WATER_GRID * WATER_GRID * 3);
    this.flow = new Float32Array(sab, WATER_FLOW_OFFSET, WATER_GRID * WATER_GRID * 2);
  }

  init(patchSize: number) {
    this.u32[WATER_HDR.MAGIC] = WATER_MAGIC;
    this.u32[WATER_HDR.VERSION] = WATER_VERSION;
    this.u32[WATER_HDR.GRID_SIZE] = WATER_GRID;
    this.u32[WATER_HDR.PATCH_SIZE] = patchSize;
    this.i32[WATER_HDR.ORIGIN_X] = 0;
    this.i32[WATER_HDR.ORIGIN_Z] = 0;
  }

  getPatchSize(): number { return this.u32[WATER_HDR.PATCH_SIZE]; }

  getOrigin(): { x: number; z: number } {
    return { x: this.i32[WATER_HDR.ORIGIN_X], z: this.i32[WATER_HDR.ORIGIN_Z] };
  }

  setOrigin(x: number, z: number) {
    this.i32[WATER_HDR.ORIGIN_X] = x;
    this.i32[WATER_HDR.ORIGIN_Z] = z;
  }

  incrementSequence() {
    Atomics.add(this.u32, WATER_HDR.SEQUENCE, 1);
  }

  setHeight(gx: number, gz: number, h: number) {
    this.heights[gz * WATER_GRID + gx] = h;
  }

  getHeight(gx: number, gz: number): number {
    return this.heights[gz * WATER_GRID + gx];
  }

  // Bilinear sample at fractional grid coordinates
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
  private sab: SharedArrayBuffer;
  private u32: Uint32Array;
  private i32: Int32Array;
  heights: Float32Array;
  normals: Float32Array;
  flow: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.i32 = new Int32Array(sab);
    this.heights = new Float32Array(sab, WATER_HEIGHT_OFFSET, WATER_GRID * WATER_GRID);
    this.normals = new Float32Array(sab, WATER_NORMAL_OFFSET, WATER_GRID * WATER_GRID * 3);
    this.flow = new Float32Array(sab, WATER_FLOW_OFFSET, WATER_GRID * WATER_GRID * 2);
  }

  isValid(): boolean {
    return this.u32[WATER_HDR.MAGIC] === WATER_MAGIC;
  }

  getSequence(): number { return Atomics.load(this.u32, WATER_HDR.SEQUENCE); }
  getGridSize(): number { return this.u32[WATER_HDR.GRID_SIZE]; }
  getPatchSize(): number { return this.u32[WATER_HDR.PATCH_SIZE]; }
  getOrigin(): { x: number; z: number } {
    return { x: this.i32[WATER_HDR.ORIGIN_X], z: this.i32[WATER_HDR.ORIGIN_Z] };
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
