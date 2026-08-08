// ============================================================================
// ChunkedVoxelField — chunked voxel storage for on-demand generation
// ============================================================================
// Stores voxel data in fixed-size chunks for memory-efficient terrain.
// Only non-empty chunks are allocated in the buffer, indexed via chunkOffsets.
//
// Chunk classification (chunkClass) reduces memory by skipping chunks that are
// entirely solid (FullSolid) or entirely empty (FullEmpty) — only surface chunks
// (Full) get buffer space allocated.
//

export const CHUNK_EMPTY = 0;   // FullEmpty: all voxels below isoLevel
export const CHUNK_SOLID = 1;   // FullSolid: all voxels above isoLevel
export const CHUNK_FULL = 2;    // Full: contains surface, needs buffer storage

export interface ChunkedVoxelField {
  dimX: number;
  dimY: number;
  dimZ: number;
  voxelSize: number;
  originX: number;
  originY: number;
  originZ: number;
  isoLevel: number;
  radius: number;

  chunkSize: number;
  chunkBits: number;
  chunkMask: number;
  chunkDimX: number;
  chunkDimY: number;
  chunkDimZ: number;
  voxelsPerChunk: number;

  buffer: ArrayBuffer;
  view: Float32Array;
  chunkOffsets: Int32Array;
  chunkGenerated: Uint8Array;
  chunkClass: Uint8Array;       // 0=FullEmpty, 1=FullSolid, 2=Full
  totalChunkSlots: number;
  nextChunkOffset: number;

  chunkX: number;
  chunkZ: number;
  isPort: boolean;
}

export function createChunkedVoxelField(
  chunkX: number,
  chunkZ: number,
  radius: number,
  voxelSize: number,
  dimX: number,
  dimY: number,
  dimZ: number,
  originX: number,
  originY: number,
  originZ: number,
  isoLevel: number = 0.0,
  chunkSize: number = 32,
  isPort: boolean = false,
  maxVoxelMemory: number = 160_000_000,
): ChunkedVoxelField {
  const chunkBits = Math.log2(chunkSize) | 0;
  const chunkMask = chunkSize - 1;
  const chunkDimX = Math.ceil(dimX / chunkSize);
  const chunkDimY = Math.ceil(dimY / chunkSize);
  const chunkDimZ = Math.ceil(dimZ / chunkSize);
  const voxelsPerChunk = chunkSize * chunkSize * chunkSize;
  const totalChunks = chunkDimX * chunkDimY * chunkDimZ;

  const maxFloats = Math.floor(maxVoxelMemory / 4);
  const maxChunkSlots = Math.floor(maxFloats / voxelsPerChunk);
  const totalChunkSlots = Math.min(totalChunks, maxChunkSlots);

  const buffer = new ArrayBuffer(totalChunkSlots * voxelsPerChunk * 4);
  const view = new Float32Array(buffer);
  const chunkOffsets = new Int32Array(totalChunks).fill(-1);
  const chunkGenerated = new Uint8Array(totalChunks);
  const chunkClass = new Uint8Array(totalChunks); // default 0 = FullEmpty

  return {
    dimX, dimY, dimZ,
    voxelSize,
    originX, originY, originZ,
    isoLevel,
    radius,
    chunkSize, chunkBits, chunkMask,
    chunkDimX, chunkDimY, chunkDimZ,
    voxelsPerChunk,
    buffer, view,
    chunkOffsets, chunkGenerated, chunkClass,
    totalChunkSlots,
    nextChunkOffset: 0,
    chunkX, chunkZ,
    isPort,
  };
}

export function getChunkedVoxel(field: ChunkedVoxelField, x: number, y: number, z: number): number {
  if (x < 0 || x >= field.dimX || y < 0 || y >= field.dimY || z < 0 || z >= field.dimZ) return -1.0;
  const cx = x >>> field.chunkBits;
  const cy = y >>> field.chunkBits;
  const cz = z >>> field.chunkBits;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  const cls = field.chunkClass[chunkIdx];
  if (cls === CHUNK_SOLID) return 1.0;   // FullSolid sentinel
  if (cls === CHUNK_EMPTY) return -1.0;  // FullEmpty sentinel
  // CHUNK_FULL: look up in buffer
  const offset = field.chunkOffsets[chunkIdx];
  if (offset < 0) return -1.0;
  const lx = x & field.chunkMask;
  const ly = y & field.chunkMask;
  const lz = z & field.chunkMask;
  const cs = field.chunkSize;
  return field.view[offset + lx * cs * cs + ly * cs + lz];
}

export function setChunkedVoxel(field: ChunkedVoxelField, x: number, y: number, z: number, value: number): void {
  if (x < 0 || x >= field.dimX || y < 0 || y >= field.dimY || z < 0 || z >= field.dimZ) return;
  const cx = x >>> field.chunkBits;
  const cy = y >>> field.chunkBits;
  const cz = z >>> field.chunkBits;
  const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
  const cls = field.chunkClass[chunkIdx];
  if (cls !== CHUNK_FULL) return;  // Only write to Full chunks; others need promotion first
  const offset = field.chunkOffsets[chunkIdx];
  if (offset < 0) return;
  const lx = x & field.chunkMask;
  const ly = y & field.chunkMask;
  const lz = z & field.chunkMask;
  const cs = field.chunkSize;
  field.view[offset + lx * cs * cs + ly * cs + lz] = value;
}

export function isChunkEmpty(field: ChunkedVoxelField, chunkIdx: number): boolean {
  return field.chunkOffsets[chunkIdx] < 0;
}

export function isChunkGenerated(field: ChunkedVoxelField, chunkIdx: number): boolean {
  return field.chunkGenerated[chunkIdx] === 1;
}

export function allocateChunk(field: ChunkedVoxelField, chunkIdx: number): number {
  if (chunkIdx < 0 || chunkIdx >= field.chunkOffsets.length) return -1;
  if (field.chunkOffsets[chunkIdx] >= 0) return field.chunkOffsets[chunkIdx];
  if (field.nextChunkOffset + field.voxelsPerChunk > field.view.length) return -1;
  const offset = field.nextChunkOffset;
  field.nextChunkOffset += field.voxelsPerChunk;
  field.chunkOffsets[chunkIdx] = offset;
  field.chunkClass[chunkIdx] = CHUNK_FULL;
  return offset;
}

export function markChunkGenerated(field: ChunkedVoxelField, chunkIdx: number): void {
  field.chunkGenerated[chunkIdx] = 1;
}

// Promote a FullSolid or FullEmpty chunk to Full so it can be deformed.
// Allocates buffer space and returns the offset, or -1 if no space.
export function promoteChunk(field: ChunkedVoxelField, chunkIdx: number): number {
  if (field.chunkClass[chunkIdx] === CHUNK_FULL && field.chunkOffsets[chunkIdx] >= 0) {
    return field.chunkOffsets[chunkIdx];
  }
  const offset = allocateChunk(field, chunkIdx);
  if (offset < 0) return -1;
  // Fill with sentinel values based on previous class
  const vpc = field.voxelsPerChunk;
  if (field.chunkClass[chunkIdx] === CHUNK_SOLID || field.chunkClass[chunkIdx] === CHUNK_FULL) {
    field.view.fill(1.0, offset, offset + vpc);
  } else {
    field.view.fill(-1.0, offset, offset + vpc);
  }
  field.chunkClass[chunkIdx] = CHUNK_FULL;
  field.chunkGenerated[chunkIdx] = 1; // mark as generated (sentinel data)
  return offset;
}
