// ============================================================================
// ChunkWorld — the chunked falling-sand world for the mining RPG.
//
// The world is divided into chunks (CHUNK_W x CHUNK_H cells each). Only chunks
// near the player are loaded and simulated. The simulation runs on a single
// contiguous "active grid" (a SandWorld instance) that covers a window of
// (2*R+1) x (2*R+1) chunks centered on the player's current chunk.
//
// The active grid is rebuilt only when the player crosses into a new chunk
// (not every frame). Between rebuilds, SandWorld.step runs on the stable
// contiguous grid. After each step, the active grid is synced back to chunk
// storage.
//
// Freeze optimization: each cell has a wakeTick timestamp. Cells with
// wakeTick=0 are frozen. Chunks with no unfrozen cells (and not near the
// player) are skipped entirely via SandWorld.skipMask.
// ============================================================================

import {
    DEFAULT_GRAVITY,
    DEFAULT_TEMP,
    FIELD,
    Material,
    MATERIALS,
    packCell,
    SandWorld,
} from "@downdraft/library-sand";
import {
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
    ACTIVE_RADIUS_CHUNKS,
    CHUNK_H,
    CHUNK_W,
    COLLECT_RADIUS,
    FREEZE_TICKS,
    MAX_CHUNKS_X,
    WORLD_SEED,
} from "../shared/constants";
import type { Chunk, ChunkCoord, InventoryEntry, MiningPlayerState } from "../shared/types";
import { createMiningPlayer, updateMiningPlayer } from "./mining-player";
import { generateChunk } from "./terrain";

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export class ChunkWorld {
  // All loaded chunks, keyed by "cx,cy"
  private chunks = new Map<string, Chunk>();
  // The contiguous active grid simulation
  activeGrid: SandWorld;
  // Per-cell skip mask for the active grid (frozen cells)
  private skipMask: Uint8Array;
  // The chunk coords of the active grid's top-left corner
  private activeOriginCx = 0;
  private activeOriginCy = 0;
  // Whether the active grid needs rebuild (player crossed chunk boundary)
  private needsRebuild = true;
  // Current tick counter
  currentTick = 0;
  // Player state (world cell coords)
  player: MiningPlayerState;
  // World config
  readonly seed: number;

  constructor() {
    this.seed = WORLD_SEED;
    this.activeGrid = new SandWorld(ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.skipMask = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.activeGrid.skipMask = this.skipMask;
    // Don't initialize the stone floor — the chunk system provides terrain
    this.activeGrid.grid.fill(0);
    this.activeGrid.fields.fill(DEFAULT_TEMP);
    for (let i = 0; i < ACTIVE_GRID_W * ACTIVE_GRID_H * 4; i += 4) {
      this.activeGrid.fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.activeGrid.fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }
    // Player starts at the surface, centered horizontally
    const playerWorldX = Math.floor(MAX_CHUNKS_X * CHUNK_W / 2);
    const playerWorldY = Math.floor(CHUNK_H * 0.3) - 10; // just above surface
    this.player = createMiningPlayer(playerWorldX, playerWorldY);
  }

  // --- Chunk management ---

  /** Get the chunk containing a world cell coordinate. */
  worldToChunk(wx: number, wy: number): ChunkCoord {
    return {
      cx: Math.floor(wx / CHUNK_W),
      cy: Math.floor(wy / CHUNK_H),
    };
  }

  /** Convert world cell coords to active grid local coords. */
  worldToActive(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx - this.activeOriginCx * CHUNK_W,
      y: wy - this.activeOriginCy * CHUNK_H,
    };
  }

  /** Convert active grid local coords to world cell coords. */
  activeToWorld(ax: number, ay: number): { x: number; y: number } {
    return {
      x: ax + this.activeOriginCx * CHUNK_W,
      y: ay + this.activeOriginCy * CHUNK_H,
    };
  }

  /** Ensure a chunk is loaded (generate if needed). Returns the chunk. */
  private ensureChunk(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = generateChunk(cx, cy, this.seed);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Get the chunk for a world cell coordinate (loads if needed). */
  getChunkAt(wx: number, wy: number): Chunk {
    const { cx, cy } = this.worldToChunk(wx, wy);
    return this.ensureChunk(cx, cy);
  }

  // --- Active grid management ---

  /** Check if the active grid needs rebuild based on player position. */
  private checkRebuild(): void {
    const { cx, cy } = this.worldToChunk(this.player.x, this.player.y);
    const newOriginCx = cx - ACTIVE_RADIUS_CHUNKS;
    const newOriginCy = cy - ACTIVE_RADIUS_CHUNKS;
    if (newOriginCx !== this.activeOriginCx || newOriginCy !== this.activeOriginCy) {
      this.activeOriginCx = newOriginCx;
      this.activeOriginCy = newOriginCy;
      this.needsRebuild = true;
    }
  }

  /**
   * Rebuild the active grid from chunk storage.
   * Copies all chunks in the active window into the contiguous active grid,
   * generates/loads any missing chunks, and copies out leaving chunks.
   */
  private rebuildActiveGrid(): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;

    // Copy out the old active grid back to chunk storage (sync dirty data)
    this.syncActiveGridToChunks();

    // Clear the active grid
    grid.fill(0);
    fields.fill(DEFAULT_TEMP);
    for (let i = 0; i < ACTIVE_GRID_W * ACTIVE_GRID_H * 4; i += 4) {
      fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }

    // Copy each chunk in the active window into the active grid
    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = this.activeOriginCx + dcx;
        const cy = this.activeOriginCy + dcy;
        if (cx < 0 || cx >= MAX_CHUNKS_X) continue; // out of horizontal bounds

        const chunk = this.ensureChunk(cx, cy);
        const offsetX = dcx * CHUNK_W;
        const offsetY = dcy * CHUNK_H;

        // Copy grid
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = y * CHUNK_W;
          const dstRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          grid.set(
            chunk.grid.subarray(srcRow, srcRow + CHUNK_W),
            dstRow,
          );
        }
        // Copy fields
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = y * CHUNK_W * 4;
          const dstRow = (offsetY + y) * ACTIVE_GRID_W * 4 + offsetX * 4;
          fields.set(
            chunk.fields.subarray(srcRow, srcRow + CHUNK_W * 4),
            dstRow,
          );
        }
      }
    }

    this.needsRebuild = false;
  }

  /** Sync the active grid back to chunk storage (copy dirty regions). */
  private syncActiveGridToChunks(): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;

    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = this.activeOriginCx + dcx;
        const cy = this.activeOriginCy + dcy;
        if (cx < 0 || cx >= MAX_CHUNKS_X) continue;

        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) continue;

        const offsetX = dcx * CHUNK_W;
        const offsetY = dcy * CHUNK_H;

        // Copy grid back
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          const dstRow = y * CHUNK_W;
          chunk.grid.set(
            grid.subarray(srcRow, srcRow + CHUNK_W),
            dstRow,
          );
        }
        // Copy fields back
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = (offsetY + y) * ACTIVE_GRID_W * 4 + offsetX * 4;
          const dstRow = y * CHUNK_W * 4;
          chunk.fields.set(
            fields.subarray(srcRow, srcRow + CHUNK_W * 4),
            dstRow,
          );
        }
      }
    }
  }

  // --- Freeze optimization ---

  /**
   * Build the skip mask for the active grid.
   * A chunk is active if:
   *   - it's within ACTIVE_RADIUS_CHUNKS of the player's chunk, OR
   *   - it has any cell with wakeTick > currentTick
   * A chunk adjacent to an active chunk is also active (1-chunk buffer)
   * so particles can't enter a frozen chunk without it being active.
   */
  private buildSkipMask(): void {
    const skip = this.skipMask;
    skip.fill(0);

    const playerChunk = this.worldToChunk(this.player.x, this.player.y);

    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = this.activeOriginCx + dcx;
        const cy = this.activeOriginCy + dcy;
        if (cx < 0 || cx >= MAX_CHUNKS_X) {
          // Out of bounds — mark entire chunk region as skip (frozen wall)
          this.fillSkipRegion(skip, dcx, dcy, 1);
          continue;
        }

        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) {
          this.fillSkipRegion(skip, dcx, dcy, 1);
          continue;
        }

        // Check if chunk should be active
        const distX = Math.abs(cx - playerChunk.cx);
        const distY = Math.abs(cy - playerChunk.cy);
        const nearPlayer = distX <= ACTIVE_RADIUS_CHUNKS + 1 && distY <= ACTIVE_RADIUS_CHUNKS + 1;

        let hasUnfrozen = false;
        if (!nearPlayer) {
          // Check if any cell is unfrozen
          for (let i = 0; i < chunk.wakeTick.length; i++) {
            if (chunk.wakeTick[i] > this.currentTick) {
              hasUnfrozen = true;
              break;
            }
          }
        }

        const isActive = nearPlayer || hasUnfrozen;
        chunk.active = isActive;

        if (!isActive) {
          // Freeze the entire chunk region in the skip mask
          this.fillSkipRegion(skip, dcx, dcy, 1);
        }
      }
    }
  }

  private fillSkipRegion(skip: Uint8Array, dcx: number, dcy: number, value: number): void {
    const offsetX = dcx * CHUNK_W;
    const offsetY = dcy * CHUNK_H;
    for (let y = 0; y < CHUNK_H; y++) {
      const rowStart = (offsetY + y) * ACTIVE_GRID_W + offsetX;
      for (let x = 0; x < CHUNK_W; x++) {
        skip[rowStart + x] = value;
      }
    }
  }

  // --- Digging ---

  /**
   * Dig a circular region at world coords (wx, wy) with the given radius.
   * Destroyed cells become loose falling-sand particles (same material).
   * Sets wakeTick = currentTick + FREEZE_TICKS for dug cells.
   */
  dig(wx: number, wy: number, radius: number): void {
    const { x: ax, y: ay } = this.worldToActive(wx, wy);
    const grid = this.activeGrid.grid;
    const r2 = radius * radius;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = ax + dx;
        const y = ay + dy;
        if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) continue;
        const idx = y * ACTIVE_GRID_W + x;
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        // Don't dig through walls or bedrock-like materials
        if (mat === Material.Wall) continue;
        // The cell stays as its material but now has gravity (loose particle)
        // Set wakeTick so it unfreezes for FREEZE_TICKS
        const def = MATERIALS[mat];
        if (def?.solid && def.gravity === 0) {
          // Static solid (stone) — make it fall by giving it gravity
          // We keep the material but the sim will now move it since it's unfrozen
          // Actually, stone has gravityDir=0 so it won't fall. We need to convert
          // it to a "loose" version. For Phase 1, convert stone→dirt (which falls),
          // and ores stay as their material (they have gravity=1).
          grid[idx] = packCell(Material.Dirt, 0, packed >> 16 & 0xff);
        }
        // Mark the cell's chunk as unfrozen
        this.markCellUnfrozen(x, y);
      }
    }
  }

  /** Mark a cell (in active grid coords) as unfrozen in its chunk's wakeTick. */
  private markCellUnfrozen(ax: number, ay: number): void {
    const dcx = Math.floor(ax / CHUNK_W);
    const dcy = Math.floor(ay / CHUNK_H);
    const cx = this.activeOriginCx + dcx;
    const cy = this.activeOriginCy + dcy;
    if (cx < 0 || cx >= MAX_CHUNKS_X) return;

    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    const localX = ax - dcx * CHUNK_W;
    const localY = ay - dcy * CHUNK_H;
    const localIdx = localY * CHUNK_W + localX;
    chunk.wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
    chunk.dirty = true;
  }

  // --- Collection ---

  /**
   * Collect loose particles (ore/debris) near the player.
   * Returns an array of {mat, count} collected this tick.
   */
  collect(): InventoryEntry[] {
    const collected: Map<number, number> = new Map();
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    const grid = this.activeGrid.grid;
    const r2 = COLLECT_RADIUS * COLLECT_RADIUS;

    for (let dy = -COLLECT_RADIUS; dy <= COLLECT_RADIUS; dy++) {
      for (let dx = -COLLECT_RADIUS; dx <= COLLECT_RADIUS; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = pax + dx;
        const y = pay + dy;
        if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) continue;
        const idx = y * ACTIVE_GRID_W + x;
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        // Collect ores and loose debris (dirt that's falling)
        if (isCollectible(mat)) {
          grid[idx] = 0; // remove from grid
          collected.set(mat, (collected.get(mat) ?? 0) + 1);
          this.markCellUnfrozen(x, y); // update chunk storage
        }
      }
    }

    return Array.from(collected.entries()).map(([mat, count]) => ({ mat, count }));
  }

  // --- Main step ---

  /**
   * Advance the simulation by one tick.
   * 1. Check if active grid needs rebuild (player crossed chunk boundary)
   * 2. Build skip mask (freeze optimization)
   * 3. Run SandWorld.step on the active grid
   * 4. Sync active grid back to chunk storage
   * 5. Update player physics
   * 6. Collect loose ore near player
   */
  step(input: {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    jump: boolean;
    mouseDown: boolean;
    mouseX: number;
    mouseY: number;
    digRadius: number;
  }): InventoryEntry[] {
    this.currentTick++;

    // 1. Rebuild if needed
    this.checkRebuild();
    if (this.needsRebuild) {
      this.rebuildActiveGrid();
    }

    // 2. Build skip mask
    this.buildSkipMask();

    // Handle digging
    if (input.mouseDown) {
      this.dig(input.mouseX, input.mouseY, input.digRadius);
    }

    // 3. Run simulation
    this.activeGrid.step();

    // 4. Sync back to chunks
    this.syncActiveGridToChunks();

    // 5. Update player (in active grid local coords)
    // updateMiningPlayer writes the new local position into player.x/y,
    // so we convert world→local before the call, then local→world after.
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    updateMiningPlayer(this.player, input, this.activeGrid.grid, ACTIVE_GRID_W, ACTIVE_GRID_H, pax, pay);
    // player.x/y now hold the updated LOCAL coords — convert back to world
    this.player.x = this.player.x + this.activeOriginCx * CHUNK_W;
    this.player.y = this.player.y + this.activeOriginCy * CHUNK_H;

    // 6. Collect loose ore
    const collected = this.collect();

    return collected;
  }

  // --- Stats ---

  /** Active grid origin in world cell coords (top-left corner of the active grid). */
  getActiveOriginX(): number {
    return this.activeOriginCx * CHUNK_W;
  }
  getActiveOriginY(): number {
    return this.activeOriginCy * CHUNK_H;
  }

  getLoadedChunkCount(): number {
    return this.chunks.size;
  }

  getActiveChunkCount(): number {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.active) count++;
    }
    return count;
  }

  getPlayerDepth(): number {
    return Math.floor(this.player.y / CHUNK_H);
  }
}

/** Check if a material is collectible (ore or loose debris). */
function isCollectible(mat: number): boolean {
  return (
    mat === Material.TinOre ||
    mat === Material.CopperOre ||
    mat === Material.IronOre ||
    mat === Material.BauxiteOre ||
    mat === Material.SilverOre ||
    mat === Material.GoldOre ||
    mat === Material.CobaltOre ||
    mat === Material.Iron
  );
}
