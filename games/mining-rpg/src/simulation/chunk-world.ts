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
    FLAG_UPDATED,
    MAT_GRAVITY_DIR,
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
    PLAYER_H,
    PLAYER_W,
    WORLD_SEED,
} from "../shared/constants";
import type { Chunk, ChunkCoord, InventoryEntry, MiningPlayerState } from "../shared/types";
import { createMiningPlayer, updateMiningPlayer } from "./mining-player";
import { generateChunk, surfaceHeightAt } from "./terrain";

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
  // The previous origin (saved before checkRebuild updates activeOriginCx/Cy,
  // used by rebuildActiveGrid to sync the outgoing grid to the correct chunks)
  private prevOriginCx = 0;
  private prevOriginCy = 0;
  // Whether the active grid needs rebuild (player crossed chunk boundary)
  private needsRebuild = true;
  // Whether the player position needs validation after the next grid rebuild.
  // Set on construction and when loading a save — if the player ends up inside
  // solid terrain (e.g. from a stale save created before a spawn fix), the
  // first rebuild lifts them to the nearest open space above.
  private needsSpawnValidation = true;
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
    // Player starts at the surface, centered horizontally.
    // Compute the actual surface height at the player's X so they spawn above
    // the ground (the surface varies by ±noiseAmplitude cells via fBm noise).
    const playerWorldX = Math.floor(MAX_CHUNKS_X * CHUNK_W / 2);
    const surfaceY = surfaceHeightAt(playerWorldX, WORLD_SEED);
    const playerWorldY = surfaceY - PLAYER_H - 2; // 2 cells of clearance above surface
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
      this.prevOriginCx = this.activeOriginCx;
      this.prevOriginCy = this.activeOriginCy;
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

    // Copy out the old active grid back to chunk storage using the PREVIOUS
    // origin — the grid data is still laid out for the old origin.
    this.syncActiveGridToChunks(this.prevOriginCx, this.prevOriginCy);

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

  /**
   * Validate the player's position after a grid rebuild.
   * If the player's bounding box overlaps any solid cell (e.g. from a stale
   * save created before a spawn fix), scan upward to find the first position
   * where the player fits entirely in open space and place them there.
   * Does nothing if the player is already in open space.
   */
  private validatePlayerSpawn(): void {
    const grid = this.activeGrid.grid;
    const { x: axF, y: ayF } = this.worldToActive(this.player.x, this.player.y);
    let ax = Math.floor(axF);
    let ay = Math.floor(ayF);

    // Check if the player's bounding box overlaps any solid cell
    const playerBoxHitsSolid = (px: number, py: number): boolean => {
      const x0 = Math.floor(px - PLAYER_W / 2);
      const x1 = Math.floor(px + PLAYER_W / 2);
      const y0 = Math.floor(py);
      const y1 = Math.floor(py + PLAYER_H - 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return true;
          const packed = grid[y * ACTIVE_GRID_W + x];
          if (packed === 0) continue;
          const def = MATERIALS[packed & 0xff];
          if (def?.solid) return true;
        }
      }
      return false;
    };

    if (!playerBoxHitsSolid(ax, ay)) return; // already in open space

    // Scan upward to find the first position where the player fits
    for (let dy = 1; dy < CHUNK_H * 2; dy++) {
      const candidateY = ay - dy;
      if (candidateY < 0) break;
      if (!playerBoxHitsSolid(ax, candidateY)) {
        // Found open space — move the player here (world coords)
        this.player.y = (this.activeOriginCy * CHUNK_H + candidateY) + 0.0;
        this.player.vy = 0;
        return;
      }
    }
  }

  /**
   * Sync the active grid back to chunk storage.
   * Uses the current activeOriginCx/Cy by default, or the provided origin
   * (used by rebuildActiveGrid to sync with the previous origin).
   */
  private syncActiveGridToChunks(originCx?: number, originCy?: number): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const ocx = originCx ?? this.activeOriginCx;
    const ocy = originCy ?? this.activeOriginCy;

    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = ocx + dcx;
        const cy = ocy + dcy;
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
   *
   * Collectible ores (tin, copper, iron, coal, etc.) are loosened in place —
   * their per-cell gravity field is enabled so they fall — but are NOT cleared
   * and NOT collected directly. They are collected later by collect() when the
   * loose particles touch the player.
   *
   * Non-collectible solids (stone, dirt) are cleared to create holes. The cell
   * directly above a cleared hole is loosened: stone (gravity=0) is converted to
   * dirt so it can cascade down; tin/copper ore (gravity field=0) has its field
   * set to DEFAULT_GRAVITY so it falls while keeping its ore identity.
   *
   * Returns an empty array — all collection is proximity-based via collect().
   */
  dig(wx: number, wy: number, radius: number): InventoryEntry[] {
    const { x: axF, y: ayF } = this.worldToActive(wx, wy);
    const ax = Math.floor(axF);
    const ay = Math.floor(ayF);
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
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

        if (isCollectible(mat)) {
          // Loosen the ore in place — don't clear, don't collect.
          // Enable the per-cell gravity field (tin/copper start at 0).
          const fi = idx * 4;
          if (fields[fi + FIELD.GRAVITY] === 0) {
            fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
          }
          this.markCellUnfrozen(x, y);
        } else {
          // Non-collectible solid: clear to create a hole
          grid[idx] = 0;
          this.clearWakeTick(x, y);

          // Loosen the cell directly above the hole so it cascades down.
          const aboveIdx = idx - ACTIVE_GRID_W;
          if (aboveIdx >= 0) {
            const above = grid[aboveIdx];
            if (above !== 0) {
              const aboveMat = above & 0xff;
              if (aboveMat !== Material.Wall) {
                const aboveDef = MATERIALS[aboveMat];
                if (aboveDef?.solid) {
                  const aboveFi = aboveIdx * 4;
                  if (fields[aboveFi + FIELD.GRAVITY] === 0 && MAT_GRAVITY_DIR[aboveMat] !== 0) {
                    // Ore with gravity disabled (tin/copper) — re-enable gravity
                    fields[aboveFi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
                  } else if (aboveDef.gravity === 0) {
                    // Static solid (stone) — convert to dirt so it can fall
                    const shade = (above >> 16) & 0xff;
                    grid[aboveIdx] = packCell(Material.Dirt, 0, shade);
                  }
                }
                this.markCellUnfrozen(x, y - 1);
              }
            }
          }
        }
      }
    }

    return [];
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

  /** Check if a cell (in active grid coords) is unfrozen (loose). */
  private isCellUnfrozen(ax: number, ay: number): boolean {
    const dcx = Math.floor(ax / CHUNK_W);
    const dcy = Math.floor(ay / CHUNK_H);
    const cx = this.activeOriginCx + dcx;
    const cy = this.activeOriginCy + dcy;
    if (cx < 0 || cx >= MAX_CHUNKS_X) return false;

    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (!chunk) return false;

    const localX = ax - dcx * CHUNK_W;
    const localY = ay - dcy * CHUNK_H;
    const localIdx = localY * CHUNK_W + localX;
    return chunk.wakeTick[localIdx] > this.currentTick;
  }

  /**
   * Expire wakeTicks for cells whose freeze timer has elapsed.
   * After the sim step, scan every chunk in the active window:
   *
   * Near-player chunks (within ACTIVE_RADIUS_CHUNKS of the player):
   *   - Keep ALL unfrozen cells alive by extending their wakeTick. This ensures
   *     dug/loosened ore stays collectible as long as the player is nearby,
   *     even if the particle has settled on the ground. Without this, cells
   *     near the player would silently become non-collectible after FREEZE_TICKS
   *     because expireWakeTicks used to skip near-player chunks entirely.
   *
   * Non-near-player chunks (outer ring of the active grid):
   *   - If a cell's wakeTick <= currentTick (expired) and the cell didn't move
   *     this tick (FLAG_UPDATED not set), set wakeTick = 0 (re-freeze).
   *   - If a cell moved this tick (FLAG_UPDATED set), extend its wakeTick so
   *     it stays unfrozen while still in motion.
   */
  private expireWakeTicks(): void {
    const grid = this.activeGrid.grid;
    const playerChunk = this.worldToChunk(this.player.x, this.player.y);

    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = this.activeOriginCx + dcx;
        const cy = this.activeOriginCy + dcy;
        if (cx < 0 || cx >= MAX_CHUNKS_X) continue;

        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) continue;

        const distX = Math.abs(cx - playerChunk.cx);
        const distY = Math.abs(cy - playerChunk.cy);
        const nearPlayer = distX <= ACTIVE_RADIUS_CHUNKS && distY <= ACTIVE_RADIUS_CHUNKS;

        const offsetX = dcx * CHUNK_W;
        const offsetY = dcy * CHUNK_H;
        const wakeTick = chunk.wakeTick;
        let hasUnfrozen = false;

        for (let ly = 0; ly < CHUNK_H; ly++) {
          for (let lx = 0; lx < CHUNK_W; lx++) {
            const localIdx = ly * CHUNK_W + lx;
            const wt = wakeTick[localIdx];
            if (wt === 0) continue;

            if (nearPlayer) {
              // Near-player: keep all unfrozen cells alive so they stay
              // collectible. Re-extend the wakeTick every tick.
              wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
              chunk.dirty = true;
              hasUnfrozen = true;
              continue;
            }

            if (wt > this.currentTick) {
              // Still unfrozen — check if the cell moved this tick
              const ax = offsetX + lx;
              const ay = offsetY + ly;
              const packed = grid[ay * ACTIVE_GRID_W + ax];
              const flags = (packed >> 16) & 0xff;
              if (flags & FLAG_UPDATED) {
                // Cell moved — extend wakeTick
                wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
                chunk.dirty = true;
                hasUnfrozen = true;
              } else {
                // Cell didn't move — still unfrozen but could settle soon
                hasUnfrozen = true;
              }
            } else {
              // wakeTick expired — re-freeze
              wakeTick[localIdx] = 0;
              chunk.dirty = true;
            }
          }
        }
      }
    }
  }

  // --- Collection ---

  /**
   * Collect loose particles (ore/debris) near the player.
   * Only collects cells that are unfrozen (loose — recently dug/disturbed).
   * Frozen cells (ores embedded in stone) are not collectible.
   * Returns an array of {mat, count} collected this tick.
   */
  collect(): InventoryEntry[] {
    const collected: Map<number, number> = new Map();
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const pax = Math.floor(paxF);
    // Center collection at the player's vertical midpoint, not the top of the
    // bounding box. The player is PLAYER_H cells tall; centering at the top
    // leaves only 1-2 cells of collection range below the feet (COLLECT_RADIUS
    // minus PLAYER_H). Centering at the midpoint gives balanced range above
    // and below, which is critical for picking up ore settled beneath the
    // player's feet while mining downward.
    const pay = Math.floor(payF) + Math.floor(PLAYER_H / 2);
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
        // Only collect loose (unfrozen) particles
        if (!this.isCellUnfrozen(x, y)) continue;
        if (isCollectible(mat)) {
          grid[idx] = 0; // remove from grid
          collected.set(mat, (collected.get(mat) ?? 0) + 1);
          // Clear the wakeTick for this cell (it's now empty)
          this.clearWakeTick(x, y);
        }
      }
    }

    return Array.from(collected.entries()).map(([mat, count]) => ({ mat, count }));
  }

  /** Clear the wakeTick for a cell (in active grid coords). */
  private clearWakeTick(ax: number, ay: number): void {
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
    chunk.wakeTick[localIdx] = 0;
    chunk.dirty = true;
  }

  // --- Main step ---

  /**
   * Advance the simulation by one tick.
   * 1. Check if active grid needs rebuild (player crossed chunk boundary)
   * 2. Build skip mask (freeze optimization)
   * 3. Handle digging (before sim so dug particles can fall this tick)
   * 4. Run SandWorld.step on the active grid
   * 5. Expire wakeTicks (re-freeze settled cells, extend for moving particles)
   * 6. Sync active grid back to chunk storage
   * 7. Update player physics
   * 8. Collect loose ore near player
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
      // Validate player position after (re)build — lifts the player out of
      // solid ground if a stale save placed them inside terrain.
      if (this.needsSpawnValidation) {
        this.validatePlayerSpawn();
        this.needsSpawnValidation = false;
      }
    }

    // 2. Build skip mask
    this.buildSkipMask();

    // 3. Handle digging (before sim so dug particles can fall this tick)
    let digCollected: InventoryEntry[] = [];
    if (input.mouseDown) {
      digCollected = this.dig(input.mouseX, input.mouseY, input.digRadius);
    }

    // 4. Run simulation
    this.activeGrid.step();

    // 5. Expire wakeTicks (re-freeze settled, extend for moving)
    this.expireWakeTicks();

    // 6. Sync back to chunks
    this.syncActiveGridToChunks();

    // 7. Update player (in active grid local coords)
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    updateMiningPlayer(this.player, input, this.activeGrid.grid, ACTIVE_GRID_W, ACTIVE_GRID_H, pax, pay);
    this.player.x = this.player.x + this.activeOriginCx * CHUNK_W;
    this.player.y = this.player.y + this.activeOriginCy * CHUNK_H;

    // 8. Collect loose ore near player
    const collected = this.collect();

    // Merge dig-collected and proximity-collected items
    const merged = new Map<number, number>();
    for (const { mat, count } of digCollected) merged.set(mat, (merged.get(mat) ?? 0) + count);
    for (const { mat, count } of collected) merged.set(mat, (merged.get(mat) ?? 0) + count);

    return Array.from(merged.entries()).map(([mat, count]) => ({ mat, count }));
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

  // --- Save / Load support ---

  /**
   * Get all dirty chunks for saving. Only dirty chunks (modified since
   * generation) need to be persisted — unmodified chunks regenerate from seed.
   * Returns an array of serializable chunk data.
   */
  getDirtyChunks(): SavedChunk[] {
    const result: SavedChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) {
        result.push({
          cx: chunk.cx,
          cy: chunk.cy,
          grid: chunk.grid.slice(),
          fields: chunk.fields.slice(),
          wakeTick: chunk.wakeTick.slice(),
        });
      }
    }
    return result;
  }

  /**
   * Restore a saved chunk into the world. Overwrites any existing chunk
   * at the same coords. Marks it as generated + dirty.
   */
  restoreChunk(saved: SavedChunk): void {
    const key = chunkKey(saved.cx, saved.cy);
    const chunk: Chunk = {
      cx: saved.cx,
      cy: saved.cy,
      grid: saved.grid.slice(),
      fields: saved.fields.slice(),
      wakeTick: saved.wakeTick.slice(),
      generated: true,
      dirty: true,
      active: false,
    };
    this.chunks.set(key, chunk);
  }

  /**
   * Set the player state (position, velocity, health, etc.) from a save.
   * Forces an active grid rebuild on the next step.
   */
  setPlayerState(state: Partial<MiningPlayerState>): void {
    if (state.x !== undefined) this.player.x = state.x;
    if (state.y !== undefined) this.player.y = state.y;
    if (state.vx !== undefined) this.player.vx = state.vx;
    if (state.vy !== undefined) this.player.vy = state.vy;
    if (state.onGround !== undefined) this.player.onGround = state.onGround;
    if (state.facing !== undefined) this.player.facing = state.facing;
    if (state.animFrame !== undefined) this.player.animFrame = state.animFrame;
    if (state.health !== undefined) this.player.health = state.health;
    // Force rebuild — the player may have moved to a different chunk
    this.needsRebuild = true;
    // Validate the loaded position — old saves may have the player inside
    // the ground (e.g. from before a spawn fix).
    this.needsSpawnValidation = true;
  }

  /** Get the frozen chunk count (chunks with no unfrozen cells, not near player). */
  getFrozenChunkCount(): number {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (!chunk.active) count++;
    }
    return count;
  }
}

/** Serializable chunk data for save/load. */
export interface SavedChunk {
  cx: number;
  cy: number;
  grid: Uint32Array;
  fields: Uint8Array;
  wakeTick: Uint32Array;
}

/** Check if a material is collectible (ore or loose debris). */
function isCollectible(mat: number): boolean {
  // Only ores and refined metals are collected by proximity.
  // Dirt/Sand/Stone are not collectible — they are cleared by dig() to
  // create holes, and the cascading loose particles fall into them.
  return (
    mat === Material.TinOre ||
    mat === Material.CopperOre ||
    mat === Material.IronOre ||
    mat === Material.BauxiteOre ||
    mat === Material.SilverOre ||
    mat === Material.GoldOre ||
    mat === Material.CobaltOre ||
    mat === Material.Coal ||
    mat === Material.Iron
  );
}
