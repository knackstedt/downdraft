// ============================================================================
// Overburden — block world (chunked 6-plane grid with active grid streaming)
//
// Adapted from mining-rpg's ChunkWorld pattern:
// - Chunks of 64×64 blocks, stored in a Map keyed by "cx,cy"
// - Active grid: (2*R+1) × (2*R+1) chunks centered on the focused blockhead
// - Only active chunks are simulated + rendered
// - When the focused blockhead crosses a chunk boundary, the active grid rebuilds
// ============================================================================

import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_CELLS,
    ACTIVE_GRID_CHUNKS,
    ACTIVE_GRID_H,
    ACTIVE_GRID_RADIUS,
    ACTIVE_GRID_W,
    CHUNK_H,
    CHUNK_W,
    CHUNKS_X, CHUNKS_Y, WORLD_W
} from "../shared/constants";
import {
    MAP_REGION_COLS, MAP_REGION_ROWS,
    REGION_BLOCK_W,
    THUMB_CELLS, THUMB_H, THUMB_W,
    type MapRegionData, type MapStation
} from "../shared/map-buffer";
import type { Chunk } from "../shared/types";
import { createChunk, getBlock, setBlock as setChunkBlock } from "./chunk";
import {
    generateFeatures,
    generateTerrain, generateTrees,
    type ChunkAccessor
} from "./terrain-gen";

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export class BlockWorld implements ChunkAccessor {
  private chunks = new Map<string, Chunk>();
  // Pre-loaded saved chunks (restored from OPFS on init). When ensureChunk
  // creates a new chunk, it checks here first before generating from seed.
  savedChunks: Map<string, Chunk> = new Map();
  readonly seed: number;
  currentTick = 0;

  // Active grid origin (top-left chunk coordinates)
  private activeOriginCx = 0;
  private activeOriginCy = 0;
  needsRebuild = true;

  // Active grid data (contiguous arrays for sim + render)
  // These are the authoritative copies during simulation; synced back to chunks on rebuild.
  activeForeground: Uint16Array;
  activeBackground: Uint16Array;
  activeLight: Uint8Array;
  activeExplored: Uint8Array;
  activeVfx: Uint32Array; // station state (fuel, craft queue) + particle effects

  // Focus position (world coords of the focused blockhead)
  private focusX = WORLD_W / 2;
  private focusY = 700;

  constructor(seed: number) {
    this.seed = seed;
    this.activeForeground = new Uint16Array(ACTIVE_GRID_CELLS);
    this.activeBackground = new Uint16Array(ACTIVE_GRID_CELLS);
    this.activeLight = new Uint8Array(4 * ACTIVE_GRID_CELLS); // RGBA8 per cell
    this.activeExplored = new Uint8Array(ACTIVE_GRID_CELLS);
    this.activeVfx = new Uint32Array(ACTIVE_GRID_CELLS);
  }

  // --- Coordinate conversion ---
  worldToChunk(wx: number, wy: number): { cx: number; cy: number } {
    // Wrap X horizontally (cylinder world)
    const cx = ((Math.floor(wx / CHUNK_W) % CHUNKS_X) + CHUNKS_X) % CHUNKS_X;
    const cy = Math.floor(wy / CHUNK_H);
    return { cx, cy };
  }

  worldToActive(wx: number, wy: number): { x: number; y: number } {
    const ax = wx - this.activeOriginCx * CHUNK_W;
    const ay = wy - this.activeOriginCy * CHUNK_H;
    return { x: ax, y: ay };
  }

  activeToWorld(ax: number, ay: number): { x: number; y: number } {
    return {
      x: ax + this.activeOriginCx * CHUNK_W,
      y: ay + this.activeOriginCy * CHUNK_H,
    };
  }

  // --- Chunk management ---
  getChunk(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  ensureChunk(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      // Check saved chunks first (restored from OPFS on init)
      const saved = this.savedChunks.get(key);
      if (saved) {
        chunk = saved;
        this.savedChunks.delete(key);
      } else {
        chunk = createChunk(cx, cy);
      }
      this.chunks.set(key, chunk);
    }
    if (!chunk.generated) {
      // Phase 1: terrain (foreground + background base blocks)
      if (!chunk.terrainGenerated) {
        generateTerrain(chunk, this.seed);
      }
      // Phase 2: trees (with cross-chunk overflow via this as ChunkAccessor)
      generateTrees(chunk, this.seed, this);
      // Phase 3: features (wild crops + explored flags)
      generateFeatures(chunk, this.seed);
      chunk.generated = true;
    }
    return chunk;
  }

  /**
   * Ensure a chunk's terrain is generated (phase 1 only — no trees or
   * features). Used by tree overflow so that canopy/trunk blocks extending
   * into a neighbor chunk have terrain to sit on top of, without triggering
   * the neighbor's own tree generation (which would recurse).
   */
  ensureChunkTerrainOnly(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const saved = this.savedChunks.get(key);
      if (saved) {
        chunk = saved;
        this.savedChunks.delete(key);
      } else {
        chunk = createChunk(cx, cy);
      }
      this.chunks.set(key, chunk);
    }
    if (!chunk.terrainGenerated) {
      generateTerrain(chunk, this.seed);
    }
    return chunk;
  }

  // --- Block access (world coordinates) ---
  getBlockAt(wx: number, wy: number): number {
    const { cx, cy } = this.worldToChunk(wx, wy);
    const chunk = this.getChunk(cx, cy);
    if (!chunk) return 0; // air for unloaded chunks
    const lx = wx - cx * CHUNK_W;
    const ly = wy - cy * CHUNK_H;
    return getBlock(chunk, lx, ly);
  }

  setBlockAt(wx: number, wy: number, blockId: number): void {
    const { cx, cy } = this.worldToChunk(wx, wy);
    const chunk = this.ensureChunk(cx, cy);
    const lx = wx - cx * CHUNK_W;
    const ly = wy - cy * CHUNK_H;
    setChunkBlock(chunk, lx, ly, blockId);
    // Also update the active grid if this chunk is in the active grid
    const ax = wx - this.activeOriginCx * CHUNK_W;
    const ay = wy - this.activeOriginCy * CHUNK_H;
    if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H) {
      this.activeForeground[ay * ACTIVE_GRID_W + ax] = blockId;
    }
  }

  // --- Active grid management ---
  setFocus(wx: number, wy: number): void {
    this.focusX = wx;
    this.focusY = wy;
  }

  checkRebuild(): void {
    const { cx, cy } = this.worldToChunk(this.focusX, this.focusY);
    // Wrap originCx the same way rebuildActiveGrid does, so the comparison
    // doesn't falsely trigger a rebuild when the player wraps around the
    // cylinder world (which would cause a teleport).
    const newOriginCx = ((cx - ACTIVE_GRID_RADIUS) % CHUNKS_X + CHUNKS_X) % CHUNKS_X;
    const newOriginCy = Math.max(0, Math.min(CHUNKS_Y - ACTIVE_GRID_CHUNKS, cy - ACTIVE_GRID_RADIUS));
    if (newOriginCx !== this.activeOriginCx || newOriginCy !== this.activeOriginCy) {
      this.needsRebuild = true;
    }
  }

  rebuildActiveGrid(): void {
    // 1. Sync the current active grid back to chunks BEFORE computing the
    //    new origin. The active grid is the authoritative copy during sim —
    //    mining, placing, fluid flow, light propagation all modify it
    //    directly. If we don't save it back, those changes are lost when we
    //    clear + reload from chunk data.
    //    Use the CURRENT activeOrigin (still the old origin at this point).
    this.syncActiveToChunks(this.activeOriginCx, this.activeOriginCy);

    // 2. Compute new origin
    const { cx, cy } = this.worldToChunk(this.focusX, this.focusY);
    this.activeOriginCx = ((cx - ACTIVE_GRID_RADIUS) % CHUNKS_X + CHUNKS_X) % CHUNKS_X;
    this.activeOriginCy = Math.max(0, Math.min(CHUNKS_Y - ACTIVE_GRID_CHUNKS, cy - ACTIVE_GRID_RADIUS));

    // 3. Clear active grid
    this.activeForeground.fill(0);
    this.activeBackground.fill(0);
    this.activeLight.fill(0);
    this.activeExplored.fill(0);
    this.activeVfx.fill(0);

    // 4. Copy chunks into active grid
    for (let icy = 0; icy < ACTIVE_GRID_CHUNKS; icy++) {
      for (let icx = 0; icx < ACTIVE_GRID_CHUNKS; icx++) {
        const cx = (this.activeOriginCx + icx) % CHUNKS_X;
        const cy = this.activeOriginCy + icy;
        if (cy < 0 || cy >= CHUNKS_Y) continue;
        const chunk = this.ensureChunk(cx, cy);
        chunk.active = true;

        const activeOffset = icy * CHUNK_H * ACTIVE_GRID_W + icx * CHUNK_W;
        // Light is RGBA8 (4 bytes/cell); other planes are 1 element/cell.
        const lightActiveOffset = activeOffset * 4;
        for (let ly = 0; ly < CHUNK_H; ly++) {
          const srcOffset = ly * CHUNK_W;
          const dstOffset = activeOffset + ly * ACTIVE_GRID_W;
          this.activeForeground.set(
            chunk.foreground.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
          this.activeBackground.set(
            chunk.background.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
          this.activeLight.set(
            chunk.light.subarray(srcOffset * 4, (srcOffset + CHUNK_W) * 4),
            lightActiveOffset + ly * ACTIVE_GRID_W * 4,
          );
          this.activeExplored.set(
            chunk.explored.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
          this.activeVfx.set(
            chunk.vfx.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
        }
      }
    }

    this.needsRebuild = false;
  }

  /**
   * Sync the current active grid back to chunk storage, using the CURRENT
   * active origin. This must be called before saving dirty chunks to OPFS,
   * because mining/placing/fluid/light/explored all modify the active grid
   * directly — the chunk arrays stay stale until this sync runs. Without it,
   * saves write pre-edit chunk data and the player's changes are lost on
   * reload (unless a chunk-boundary rebuild happened to sync first).
   */
  syncActiveForSave(): void {
    this.syncActiveToChunks(this.activeOriginCx, this.activeOriginCy);
  }

  private syncActiveToChunks(originCx: number, originCy: number): void {
    for (let icy = 0; icy < ACTIVE_GRID_CHUNKS; icy++) {
      for (let icx = 0; icx < ACTIVE_GRID_CHUNKS; icx++) {
        const cx = (originCx + icx) % CHUNKS_X;
        const cy = originCy + icy;
        if (cy < 0 || cy >= CHUNKS_Y) continue;
        const chunk = this.getChunk(cx, cy);
        if (!chunk) continue;
        // Always sync back — the active grid is the authoritative copy
        // during simulation. Fluid flow, light propagation, and other sim
        // systems modify the active grid directly without marking chunks
        // dirty, so skipping non-dirty chunks would lose those changes.

        const activeOffset = icy * CHUNK_H * ACTIVE_GRID_W + icx * CHUNK_W;
        // Light is RGBA8 (4 bytes/cell); other planes are 1 element/cell.
        const lightActiveOffset = activeOffset * 4;
        for (let ly = 0; ly < CHUNK_H; ly++) {
          const dstOffset = ly * CHUNK_W;
          const srcOffset = activeOffset + ly * ACTIVE_GRID_W;
          chunk.foreground.set(
            this.activeForeground.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
          chunk.background.set(
            this.activeBackground.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
          chunk.light.set(
            this.activeLight.subarray(srcOffset * 4, (srcOffset + CHUNK_W) * 4),
            dstOffset * 4,
          );
          chunk.explored.set(
            this.activeExplored.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
          chunk.vfx.set(
            this.activeVfx.subarray(srcOffset, srcOffset + CHUNK_W),
            dstOffset,
          );
        }
        // Mark chunk dirty so it gets saved to OPFS (the active grid is
        // the authoritative copy — any changes during sim need to persist).
        chunk.dirty = true;
      }
    }
  }

  /** Iterate all loaded chunks (for saving dirty chunks to OPFS). */
  *allChunks(): IterableIterator<Chunk> {
    yield* this.chunks.values();
  }

  // --- Active grid block access (for sim + render) ---
  getActiveBlock(ax: number, ay: number): number {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return 0;
    return this.activeForeground[ay * ACTIVE_GRID_W + ax];
  }

  setActiveBlock(ax: number, ay: number, blockId: number): void {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return;
    this.activeForeground[ay * ACTIVE_GRID_W + ax] = blockId;
    // Mark the corresponding chunk as dirty
    const wx = ax + this.activeOriginCx * CHUNK_W;
    const wy = ay + this.activeOriginCy * CHUNK_H;
    const { cx, cy } = this.worldToChunk(wx, wy);
    const chunk = this.getChunk(cx, cy);
    if (chunk) chunk.dirty = true;
  }

  getActiveBackground(ax: number, ay: number): number {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return 0;
    return this.activeBackground[ay * ACTIVE_GRID_W + ax];
  }

  setActiveBackground(ax: number, ay: number, blockId: number): void {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return;
    this.activeBackground[ay * ACTIVE_GRID_W + ax] = blockId;
    // Mark the corresponding chunk as dirty
    const wx = ax + this.activeOriginCx * CHUNK_W;
    const wy = ay + this.activeOriginCy * CHUNK_H;
    const { cx, cy } = this.worldToChunk(wx, wy);
    const chunk = this.getChunk(cx, cy);
    if (chunk) chunk.dirty = true;
  }

  getActiveLight(ax: number, ay: number): number {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return 0;
    return this.activeLight[ay * ACTIVE_GRID_W + ax];
  }

  getActiveVfx(ax: number, ay: number): number {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return 0;
    return this.activeVfx[ay * ACTIVE_GRID_W + ax];
  }

  setActiveVfx(ax: number, ay: number, value: number): void {
    if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return;
    this.activeVfx[ay * ACTIVE_GRID_W + ax] = value;
    // Mark the corresponding chunk as dirty
    const wx = ax + this.activeOriginCx * CHUNK_W;
    const wy = ay + this.activeOriginCy * CHUNK_H;
    const { cx, cy } = this.worldToChunk(wx, wy);
    const chunk = this.getChunk(cx, cy);
    if (chunk) chunk.dirty = true;
  }

  // --- Active grid origin accessors ---
  getActiveOriginCx(): number {
    return this.activeOriginCx;
  }

  getActiveOriginCy(): number {
    return this.activeOriginCy;
  }

  // --- Stats ---
  getStats() {
    let loaded = 0;
    let active = 0;
    for (const chunk of this.chunks.values()) {
      loaded++;
      if (chunk.active) active++;
    }
    return {
      tick: this.currentTick,
      loadedChunks: loaded,
      activeChunks: active,
      frozenChunks: 0,
      blockheadCount: 0,
    };
  }

  /**
   * Build a per-block map-region snapshot centered on chunk column
   * `centerCx`. The region is MAP_REGION_COLS chunk columns wide ×
   * MAP_REGION_ROWS chunk rows tall (full world height), with horizontal
   * cylinder wrap. With THUMB_W=1, each cell is a single block (no
   * downsampling). Only chunks that have been generated/loaded are included;
   * missing chunks report all-zero block ids + explored=0 (fog).
   *
   * The representative block for each cell is the topmost (smallest Y)
   * non-air foreground block — but with THUMB_W=1 this is just the block
   * itself. Stations (workbench, furnace, ...) are collected separately as
   * world-coord points so the overlay can draw them as distinct markers.
   *
   * If `target` is provided (blockIds + explored arrays from the map SAB),
   * data is written directly into those arrays instead of allocating new
   * ones. The arrays must be sized REGION_BLOCK_W * REGION_BLOCK_H.
   *
   * This runs on the sim worker.
   */
  getMapRegion(
    centerCx: number,
    target?: { blockIds: Uint16Array; explored: Uint8Array },
  ): MapRegionData {
    const cols = MAP_REGION_COLS;
    const rows = MAP_REGION_ROWS;
    const halfCols = cols >> 1;
    const cx0 = ((centerCx - halfCols) % CHUNKS_X + CHUNKS_X) % CHUNKS_X;

    const totalCells = cols * rows * THUMB_CELLS;
    const blockIds = target?.blockIds ?? new Uint16Array(totalCells);
    const explored = target?.explored ?? new Uint8Array(totalCells);
    if (target) {
      blockIds.fill(0);
      explored.fill(0);
    }
    const stations: MapStation[] = [];

    for (let row = 0; row < rows; row++) {
      const cy = row; // rows span the full world height (CHUNKS_Y = MAP_REGION_ROWS)
      if (cy < 0 || cy >= CHUNKS_Y) continue;
      for (let col = 0; col < cols; col++) {
        const cx = (cx0 + col) % CHUNKS_X;
        const chunk = this.getChunk(cx, cy);
        if (!chunk || !chunk.generated) continue; // fog

        // Per-block copy (THUMB_W=1 means each cell is one block).
        // Write in image order: pixel (col*64+tx, row*64+ty) = (row*64+ty) * REGION_BLOCK_W + (col*64+tx)
        // so the SAB can be blitted directly into an ImageData of size REGION_BLOCK_W × REGION_BLOCK_H.
        const cellsPerRow = CHUNK_W / THUMB_W; // 64
        const cellsPerCol = CHUNK_H / THUMB_H; // 64
        const imgYBase = row * cellsPerCol; // top-left Y of this chunk row in image space
        const imgXBase = col * cellsPerRow;  // top-left X of this chunk col in image space
        for (let ty = 0; ty < cellsPerCol; ty++) {
          const imgRow = (imgYBase + ty) * REGION_BLOCK_W + imgXBase;
          const chunkRow = ty * CHUNK_W;
          for (let tx = 0; tx < cellsPerRow; tx++) {
            const cellIdx = chunkRow + tx;
            const ti = imgRow + tx;
            blockIds[ti] = chunk.foreground[cellIdx];
            explored[ti] = chunk.explored[cellIdx];
          }
        }

        // Collect stations in this chunk.
        for (let ly = 0; ly < CHUNK_H; ly++) {
          for (let lx = 0; lx < CHUNK_W; lx++) {
            const cellIdx = ly * CHUNK_W + lx;
            const id = chunk.foreground[cellIdx];
            if (id === 0) continue;
            const def = getBlockDef(id);
            if (def?.isStation && def.stationType) {
              stations.push({
                wx: cx * CHUNK_W + lx,
                wy: cy * CHUNK_H + ly,
                station: def.stationType,
              });
            }
          }
        }
      }
    }

    return { cx0, cols, rows, blockIds, explored, stations };
  }
}
