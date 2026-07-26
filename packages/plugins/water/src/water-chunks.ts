export const CHUNK_SIZE = 64;
export const CHUNK_OVERLAP = 2;
export const CHUNK_GRID = CHUNK_SIZE + 2 * CHUNK_OVERLAP; // 68
export const MAX_CHUNKS = 25;
export const CHUNK_WORLD_SIZE = CHUNK_SIZE * 4; // 256m at 4m patch

export interface WaterChunk {
  chunkX: number;
  chunkZ: number;
  originX: number;
  originZ: number;
  heights: Float32Array; // CHUNK_GRID * CHUNK_GRID
}
