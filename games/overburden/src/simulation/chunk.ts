// ============================================================================
// Overburden — chunk data structure
// ============================================================================

import { CHUNK_CELLS, CHUNK_W } from "../shared/constants";
import type { Chunk } from "../shared/types";

export function createChunk(cx: number, cy: number): Chunk {
  return {
    cx,
    cy,
    foreground: new Uint16Array(CHUNK_CELLS),
    background: new Uint16Array(CHUNK_CELLS),
    mask: new Uint8Array(CHUNK_CELLS),
    vfx: new Uint32Array(CHUNK_CELLS),
    light: new Uint8Array(4 * CHUNK_CELLS), // RGBA8 per cell
    explored: new Uint8Array(CHUNK_CELLS),
    generated: false,
    terrainGenerated: false,
    active: false,
    dirty: false,
  };
}

// --- Cell indexing ---
// Cells are stored row-major: index = y * CHUNK_W + x
export function cellIndex(lx: number, ly: number): number {
  return ly * CHUNK_W + lx;
}

export function cellX(index: number): number {
  return index % CHUNK_W;
}

export function cellY(index: number): number {
  return Math.floor(index / CHUNK_W);
}

// --- Block access ---
export function getBlock(chunk: Chunk, lx: number, ly: number): number {
  return chunk.foreground[cellIndex(lx, ly)];
}

export function setBlock(chunk: Chunk, lx: number, ly: number, blockId: number): void {
  chunk.foreground[cellIndex(lx, ly)] = blockId;
  chunk.dirty = true;
}

export function getBackground(chunk: Chunk, lx: number, ly: number): number {
  return chunk.background[cellIndex(lx, ly)];
}

export function setBackground(chunk: Chunk, lx: number, ly: number, blockId: number): void {
  chunk.background[cellIndex(lx, ly)] = blockId;
  chunk.dirty = true;
}

export function getLight(chunk: Chunk, lx: number, ly: number): number {
  return chunk.light[cellIndex(lx, ly)];
}

export function setLight(chunk: Chunk, lx: number, ly: number, level: number): void {
  chunk.light[cellIndex(lx, ly)] = level;
}

export function isExplored(chunk: Chunk, lx: number, ly: number): boolean {
  return chunk.explored[cellIndex(lx, ly)] !== 0;
}

export function setExplored(chunk: Chunk, lx: number, ly: number): void {
  chunk.explored[cellIndex(lx, ly)] = 1;
}
