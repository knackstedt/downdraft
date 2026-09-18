// ============================================================================
// Water Buffer — 256×256 heightfield grid for water physics + rendering sync
// Water buffer definitions
// ============================================================================

export const WATER_GRID = 256;
export const WATER_HEIGHT_OFFSET = 64; // 16 u32 header
export const WATER_NORMAL_OFFSET = WATER_HEIGHT_OFFSET + WATER_GRID * WATER_GRID * 4;
export const WATER_FLOW_OFFSET = WATER_NORMAL_OFFSET + WATER_GRID * WATER_GRID * 12;
export const WATER_BUFFER_BYTES = WATER_FLOW_OFFSET + WATER_GRID * WATER_GRID * 8;

const WATER_HDR = {
  GRID_SIZE: 2,
  PATCH_SIZE: 3,
  ORIGIN_X: 5,
  ORIGIN_Z: 6,
} as const;

export class WaterBuffer {
  private buffer: ArrayBuffer;
  private u32: Uint32Array;
  private i32: Int32Array;
  heights: Float32Array;
  normals: Float32Array;
  flow: Float32Array;
  private patchSize: number;
  private originX = 0;
  private originZ = 0;

  constructor(patchSize = 4) {
    this.buffer = new ArrayBuffer(WATER_BUFFER_BYTES);
    this.u32 = new Uint32Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
    this.heights = new Float32Array(this.buffer, WATER_HEIGHT_OFFSET, WATER_GRID * WATER_GRID);
    this.normals = new Float32Array(this.buffer, WATER_NORMAL_OFFSET, WATER_GRID * WATER_GRID * 3);
    this.flow = new Float32Array(this.buffer, WATER_FLOW_OFFSET, WATER_GRID * WATER_GRID * 2);
    this.patchSize = patchSize;
    this.u32[WATER_HDR.GRID_SIZE] = WATER_GRID;
    this.u32[WATER_HDR.PATCH_SIZE] = patchSize;
  }

  getGridSize(): number { return WATER_GRID; }
  getPatchSize(): number { return this.patchSize; }
  getOrigin(): { x: number; z: number } { return { x: this.originX, z: this.originZ }; }
  setOrigin(x: number, z: number): void {
    this.originX = x;
    this.originZ = z;
    this.i32[WATER_HDR.ORIGIN_X] = x;
    this.i32[WATER_HDR.ORIGIN_Z] = z;
  }

  setHeight(gx: number, gz: number, h: number): void {
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

  sampleWorldHeight(worldX: number, worldZ: number): number {
    const gx = ((worldX - this.originX) / this.patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    const gz = ((worldZ - this.originZ) / this.patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    return this.sampleHeight(gx, gz);
  }

  getHeightsRef(): Float32Array {
    return this.heights;
  }

  getBuffer(): ArrayBuffer {
    return this.buffer;
  }
}
