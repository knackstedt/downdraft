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
    LOOSE_STONE_SETTLE_TICKS,
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
    BASE_INVENTORY_SIZE,
    BASE_MINING_DAMAGE,
    BASE_MINING_RADIUS,
    BASE_MINING_RATE,
    BUILD_DIMENSIONS,
    BUILD_HARDNESS,
    buildMaterialTypeFromId,
    CHUNK_H,
    CHUNK_W,
    COLLECT_RADIUS,
    DAMAGE_UPGRADE_INCREMENT,
    DIRT_HARDNESS,
    FREEZE_TICKS,
    GRAVEL_HARDNESS,
    INVENTORY_SIZE_UPGRADE_INCREMENT,
    isCollectible,
    LOOSE_STONE_HARDNESS,
    MAX_CHUNKS_X,
    MAX_MINE_RANGE,
    ORE_HARDNESS,
    OXYGEN_MAX_TICKS,
    PLAYER_H,
    PLAYER_W,
    RADIUS_UPGRADE_INCREMENT,
    RATE_UPGRADE_REDUCTION,
    STONE_HARDNESS,
    WORLD_SEED,
    type BuildMaterialType
} from "../shared/constants";
import type { BuildMaterials, Chunk, ChunkCoord, InventoryEntry, MiningPlayerState, PlayerUpgrades } from "../shared/types";
import { createMiningPlayer, updateMiningPlayer } from "./mining-player";
import { generateChunk, surfaceHeightAt } from "./terrain";

/**
 * Flag bit stored in the packed cell's flags field (bits 16-23) to indicate
 * that a cell has been dislodged from the static terrain by mining. The
 * renderer reads this bit to tint detached cells differently from static
 * terrain.
 *
 * Bit 4 of the flags field (bit 20 of the packed uint32). Unused by the
 * physics engine (which only uses bits 0-3: shade 0-1, FLAG_UPDATED 2,
 * FLAG_SPARK 3). Registered with SandWorld.preserveFlagsMask so it survives
 * the per-frame FLAG_UPDATED clear in buildActiveListAndClearFlags(). Swaps
 * and applyAging preserve it via bit-OR / selective clear.
 */
const FLAG_DETACHED = 0x10;

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
  // Player upgrades (mining damage, radius, rate, inventory size)
  upgrades: PlayerUpgrades;
  // Per-cell mining damage accumulator (active grid coords). When accumulated
  // damage reaches the material's hardness, the cell is dislodged (converted
  // to a loose, collectible form). Cleared on grid rebuild.
  private cellDamage: Float32Array;
  // Tick counter for mining rate limiting — counts down; when 0, the next
  // mouseDown tick can mine.
  private mineCooldown = 0;
  // Build material counts (scaffolding/ladder/rope). The worker is the single
  // source of truth — placement consumes from here, purchases add to here.
  // The renderer mirrors these for display via the "buildMaterials" event.
  buildMaterials: BuildMaterials = { scaffolding: 0, ladder: 0, rope: 0 };
  // Background grid: build materials layer at the same resolution as the
  // active grid. Stores placed scaffolding/ladder/rope cells. The player
  // physics checks this grid for solid (scaffolding) and climbable
  // (ladder/rope) cells, but falling sand in the foreground grid passes
  // through — build materials don't participate in the sand simulation.
  // Synced to/from chunks during active grid rebuilds, and written to the
  // SAB each tick for the renderer's background pass.
  backgroundGrid: Uint32Array;
  // World config
  readonly seed: number;

  constructor() {
    this.seed = WORLD_SEED;
    this.activeGrid = new SandWorld(ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.skipMask = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.cellDamage = new Float32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.backgroundGrid = new Uint32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.activeGrid.skipMask = this.skipMask;
    // Preserve FLAG_DETACHED (bit 4 of the flags byte) across the physics
    // engine's per-frame FLAG_UPDATED clear. Without this, the detached bit
    // is stripped every step() and the renderer never sees it.
    this.activeGrid.preserveFlagsMask = FLAG_DETACHED;
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
    this.upgrades = {
      damage: 0,
      radius: 0,
      rate: 0,
      inventorySize: 0,
    };
  }

  // --- Upgrade system ---

  /** Get the effective mining damage per hit. */
  getMiningDamage(): number {
    return BASE_MINING_DAMAGE + this.upgrades.damage * DAMAGE_UPGRADE_INCREMENT;
  }
  /** Get the effective mining radius (cells around the raycast hit). */
  getMiningRadius(): number {
    return BASE_MINING_RADIUS + this.upgrades.radius * RADIUS_UPGRADE_INCREMENT;
  }
  /** Get the effective mining rate (ticks between hits). */
  getMiningRate(): number {
    return Math.max(1, BASE_MINING_RATE - this.upgrades.rate * RATE_UPGRADE_REDUCTION);
  }
  /** Get the max inventory size (total item count). */
  getMaxInventory(): number {
    return BASE_INVENTORY_SIZE + this.upgrades.inventorySize * INVENTORY_SIZE_UPGRADE_INCREMENT;
  }
  /** Get the current total item count in inventory. */
  getInventoryCount(inventory: InventoryEntry[]): number {
    return inventory.reduce((sum, e) => sum + e.count, 0);
  }

  /** Set upgrade levels (from save or UI). */
  setUpgrades(upgrades: PlayerUpgrades): void {
    this.upgrades = { ...upgrades };
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
    const bgGrid = this.backgroundGrid;

    // Copy out the old active grid + background grid back to chunk storage
    // using the PREVIOUS origin — the grid data is still laid out for the old origin.
    this.syncActiveGridToChunks(this.prevOriginCx, this.prevOriginCy);

    // Clear the active grid + background grid
    grid.fill(0);
    bgGrid.fill(0);
    fields.fill(DEFAULT_TEMP);
    this.cellDamage.fill(0);
    for (let i = 0; i < ACTIVE_GRID_W * ACTIVE_GRID_H * 4; i += 4) {
      fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }

    // Copy each chunk in the active window into the active grid + background grid
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
        // Copy background grid
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = y * CHUNK_W;
          const dstRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          bgGrid.set(
            chunk.bgGrid.subarray(srcRow, srcRow + CHUNK_W),
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
    const bgGrid = this.backgroundGrid;
    const { x: axF, y: ayF } = this.worldToActive(this.player.x, this.player.y);
    let ax = Math.floor(axF);
    let ay = Math.floor(ayF);

    // Check if the player's bounding box overlaps any solid cell (foreground or background)
    const playerBoxHitsSolid = (px: number, py: number): boolean => {
      const x0 = Math.floor(px - PLAYER_W / 2);
      const x1 = Math.floor(px + PLAYER_W / 2);
      const y0 = Math.floor(py);
      const y1 = Math.floor(py + PLAYER_H - 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return true;
          const packed = grid[y * ACTIVE_GRID_W + x];
          if (packed !== 0) {
            const def = MATERIALS[packed & 0xff];
            if (def?.solid) return true;
          }
          // Check background grid (scaffolding is solid)
          const bgPacked = bgGrid[y * ACTIVE_GRID_W + x];
          if (bgPacked !== 0) {
            const bgDef = MATERIALS[bgPacked & 0xff];
            if (bgDef?.solid) return true;
          }
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
    const bgGrid = this.backgroundGrid;
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
        // Copy background grid back
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          const dstRow = y * CHUNK_W;
          chunk.bgGrid.set(
            bgGrid.subarray(srcRow, srcRow + CHUNK_W),
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
  /**
   * Mine toward the mouse position using a raycast from the player.
   *
   * 1. Cast a ray from the player's center toward the mouse world position.
   * 2. Find the first solid (mineable) cell the ray hits.
   * 3. Apply damage to cells within the mining radius around the hit point.
   * 4. When a cell's accumulated damage reaches its hardness, it is dislodged:
   *    - Stone → converted to Dirt (loose, collectible, falls with gravity)
   *    - Ore → loosened (gravity re-enabled, becomes collectible)
   *    - Dirt → cleared (already loose, just removed)
   * 5. Liquids (water, oil, lava) and gases are NOT mineable — the ray passes
   *    through them.
   * 6. Walls are indestructible.
   *
   * Rate-limited by mineCooldown (controlled by the rate upgrade).
   * Returns collected items (always empty — collection is proximity-based).
   */
  mine(mouseWX: number, mouseWY: number): InventoryEntry[] {
    // Rate limiting — only mine when cooldown has elapsed.
    // getMiningRate() returns ticks between hits (e.g. 3 = hit every 3 ticks).
    // We set cooldown to rate-1 so the next hit happens exactly `rate` ticks later.
    if (this.mineCooldown > 0) {
      this.mineCooldown--;
      return [];
    }
    // Reset cooldown for next hit
    this.mineCooldown = this.getMiningRate() - 1;

    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const bgGrid = this.backgroundGrid;
    const damage = this.getMiningDamage();
    const radius = this.getMiningRadius();

    // Player center in active grid coords
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const px = paxF + PLAYER_W / 2;
    const py = payF + PLAYER_H / 2;

    // Mouse in active grid coords
    const { x: mxF, y: myF } = this.worldToActive(mouseWX, mouseWY);
    const mx = mxF;
    const my = myF;

    // Ray direction (normalized)
    let dx = mx - px;
    let dy = my - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return [];
    dx /= dist;
    dy /= dist;

    // March the ray until we hit a solid mineable cell or reach max range.
    // Check both the foreground grid and the background (build materials) grid.
    // The foreground takes priority (it's in front), but if the foreground cell
    // is empty/liquid/gas, the ray hits the background cell behind it.
    let hitX = -1, hitY = -1;
    let hitBg = false; // true if the hit is in the background grid
    const maxRange = MAX_MINE_RANGE;
    for (let step = 0; step < maxRange; step++) {
      const cx = Math.floor(px + dx * step);
      const cy = Math.floor(py + dy * step);
      if (cx < 0 || cx >= ACTIVE_GRID_W || cy < 0 || cy >= ACTIVE_GRID_H) break;
      const idx = cy * ACTIVE_GRID_W + cx;

      // Check foreground first
      const packed = grid[idx];
      if (packed !== 0) {
        const mat = packed & 0xff;
        if (mat === Material.Wall) break; // wall blocks the ray
        const def = MATERIALS[mat];
        if (def?.solid || def?.climbable) {
          hitX = cx;
          hitY = cy;
          hitBg = false;
          break;
        }
        // Liquid/gas — ray passes through foreground, check background
      }

      // Check background (build materials)
      const bgPacked = bgGrid[idx];
      if (bgPacked !== 0) {
        const bgMat = bgPacked & 0xff;
        const bgDef = MATERIALS[bgMat];
        if (bgDef?.solid || bgDef?.climbable) {
          hitX = cx;
          hitY = cy;
          hitBg = true;
          break;
        }
      }
    }

    if (hitX < 0) return []; // nothing hit

    // --- Background hit: mine build materials (scaffolding/ladder/rope) ---
    // Build materials are in the background grid. Mining them clears the
    // background cell (they don't cascade or produce collectibles — they're
    // just removed). The damage accumulator is shared with the foreground
    // (cellDamage), keyed by active-grid index.
    if (hitBg) {
      const r2 = radius * radius;
      for (let ddy = -radius; ddy <= radius; ddy++) {
        for (let ddx = -radius; ddx <= radius; ddx++) {
          if (ddx * ddx + ddy * ddy > r2) continue;
          const x = hitX + ddx;
          const y = hitY + ddy;
          if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) continue;
          const idx = y * ACTIVE_GRID_W + x;
          const bgPacked = bgGrid[idx];
          if (bgPacked === 0) continue;
          const bgMat = bgPacked & 0xff;
          const bgDef = MATERIALS[bgMat];
          if (!bgDef) continue;

          // All build materials use BUILD_HARDNESS
          this.cellDamage[idx] += damage;
          if (this.cellDamage[idx] >= BUILD_HARDNESS) {
            this.cellDamage[idx] = 0;
            bgGrid[idx] = 0; // clear the background cell
            this.markChunkDirty(x, y);
          }
        }
      }
      return [];
    }

    // --- Foreground hit: mine terrain (existing behavior) ---
    // Apply damage to cells within radius of the hit point
    const r2 = radius * radius;
    for (let ddy = -radius; ddy <= radius; ddy++) {
      for (let ddx = -radius; ddx <= radius; ddx++) {
        if (ddx * ddx + ddy * ddy > r2) continue;
        const x = hitX + ddx;
        const y = hitY + ddy;
        if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) continue;
        const idx = y * ACTIVE_GRID_W + x;
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        if (mat === Material.Wall) continue;

        const def = MATERIALS[mat];
        if (!def?.solid && !def?.climbable) continue; // don't damage liquids/gases

        // Determine hardness based on material type
        let hardness: number;
        if (mat === Material.Stone) {
          hardness = STONE_HARDNESS;
        } else if (mat === Material.LooseStone) {
          hardness = LOOSE_STONE_HARDNESS;
        } else if (mat === Material.Gravel) {
          hardness = GRAVEL_HARDNESS;
        } else if (mat === Material.Dirt || mat === Material.Grass) {
          hardness = DIRT_HARDNESS;
        } else if (isCollectible(mat)) {
          hardness = ORE_HARDNESS;
        } else {
          hardness = STONE_HARDNESS; // default for other solids
        }

        // Accumulate damage
        this.cellDamage[idx] += damage;

        if (this.cellDamage[idx] >= hardness) {
          // Cell is dislodged!
          this.cellDamage[idx] = 0;

          if (isCollectible(mat)) {
            // Ore: re-enable gravity so it falls, mark unfrozen (collectible)
            const fi = idx * 4;
            if (fields[fi + FIELD.GRAVITY] === 0) {
              fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
            }
            // Mark as detached (loosened from static terrain)
            grid[idx] = packed | (FLAG_DETACHED << 16);
            this.markCellUnfrozen(x, y);
          } else if (mat === Material.Stone || mat === Material.Grass) {
            // Stone/Grass → 60% Gravel (fine, flows+settles) + 40% LooseStone
            // (coarse, falls then re-settles to Stone). Both are collectible.
            const shade = (packed >> 16) & 0xff;
            const newMat = Math.random() < 0.6 ? Material.Gravel : Material.LooseStone;
            // LooseStone uses the lifetime field as a settle timer; Gravel
            // has no timer (never re-settles to Stone).
            const lifetime = newMat === Material.LooseStone ? LOOSE_STONE_SETTLE_TICKS : 0;
            grid[idx] = packCell(newMat, lifetime, shade | FLAG_DETACHED);
            const fi = idx * 4;
            if (fields[fi + FIELD.GRAVITY] === 0) {
              fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
            }
            this.markCellUnfrozen(x, y);
          } else {
            // Dirt/Grass/other: clear to create a hole
            grid[idx] = 0;
            this.clearWakeTick(x, y);
          }

          // Loosen the cell directly above so it cascades down
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
                    fields[aboveFi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
                    // Mark as detached (loosened)
                    grid[aboveIdx] = above | (FLAG_DETACHED << 16);
                  } else if (aboveDef.gravity === 0) {
                    // Static solid (stone) loosened by cascade → Gravel/LooseStone.
                    const shade = (above >> 16) & 0xff;
                    const newMat = Math.random() < 0.6 ? Material.Gravel : Material.LooseStone;
                    const lt = newMat === Material.LooseStone ? LOOSE_STONE_SETTLE_TICKS : 0;
                    grid[aboveIdx] = packCell(newMat, lt, shade | FLAG_DETACHED);
                    if (fields[aboveFi + FIELD.GRAVITY] === 0) {
                      fields[aboveFi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
                    }
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

  // --- World-space background/foreground access (for rope extension) ---
  // These helpers read/write cells by WORLD coords, transparently checking
  // the active grid (for in-bounds cells) or loaded chunk storage (for cells
  // outside the active grid). They never generate new chunks — unloaded
  // chunks are treated as empty/non-solid, and writes to them are skipped.
  // This lets the rope extension scan/find the true bottom of an existing
  // rope column that spans loaded chunks beyond the active grid.

  /** Read the packed background cell at world coords. Returns 0 for cells in
   *  unloaded chunks or out of the world (no generation). */
  private bgAtWorld(wx: number, wy: number): number {
    const ax = wx - this.activeOriginCx * CHUNK_W;
    const ay = wy - this.activeOriginCy * CHUNK_H;
    if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H) {
      return this.backgroundGrid[ay * ACTIVE_GRID_W + ax];
    }
    const { cx, cy } = this.worldToChunk(wx, wy);
    if (cx < 0 || cx >= MAX_CHUNKS_X) return 0;
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return 0;
    const lx = wx - cx * CHUNK_W;
    const ly = wy - cy * CHUNK_H;
    return chunk.bgGrid[ly * CHUNK_W + lx];
  }

  /** Check if the foreground cell at world coords is solid. Returns false for
   *  cells in unloaded chunks (treated as non-solid / passable). */
  private fgSolidAtWorld(wx: number, wy: number): boolean {
    const ax = wx - this.activeOriginCx * CHUNK_W;
    const ay = wy - this.activeOriginCy * CHUNK_H;
    if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H) {
      const packed = this.activeGrid.grid[ay * ACTIVE_GRID_W + ax];
      if (packed === 0) return false;
      return !!MATERIALS[packed & 0xff]?.solid;
    }
    const { cx, cy } = this.worldToChunk(wx, wy);
    if (cx < 0 || cx >= MAX_CHUNKS_X) return false;
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return false;
    const lx = wx - cx * CHUNK_W;
    const ly = wy - cy * CHUNK_H;
    const packed = chunk.grid[ly * CHUNK_W + lx];
    if (packed === 0) return false;
    return !!MATERIALS[packed & 0xff]?.solid;
  }

  /** Set a background cell at world coords. Writes to the active grid (and
   *  marks the chunk dirty) for in-bounds cells, or to chunk storage for
   *  out-of-grid cells. No-op for unloaded chunks (caller must ensure the
   *  chunk is loaded before calling). */
  private setBgAtWorld(wx: number, wy: number, packed: number): void {
    const ax = wx - this.activeOriginCx * CHUNK_W;
    const ay = wy - this.activeOriginCy * CHUNK_H;
    if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H) {
      this.backgroundGrid[ay * ACTIVE_GRID_W + ax] = packed;
      this.markChunkDirty(ax, ay);
      return;
    }
    const { cx, cy } = this.worldToChunk(wx, wy);
    if (cx < 0 || cx >= MAX_CHUNKS_X) return;
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return;
    const lx = wx - cx * CHUNK_W;
    const ly = wy - cy * CHUNK_H;
    chunk.bgGrid[ly * CHUNK_W + lx] = packed;
    chunk.dirty = true;
  }

  /**
   * Place a build item at world coords (wx, wy). Each item places a dynamic
   * multi-cell pattern into the background grid:
   *
   *   Scaffolding: 5-wide horizontal platform centered on cursor, with auto
   *     supports that fill downward up to 7 cells, stopping at solid ground.
   *   Ladder:      5-wide × 7-tall block, top-center at cursor.
   *   Rope:        3-wide segment. If cursor is directly above existing rope,
   *     extends that rope downward from its current bottom — scanning through
   *     loaded chunks (not just the active grid) to find the true bottom, and
   *     writing the new segment to chunk storage for cells beyond the active
   *     grid. Otherwise places a new 3-wide × 5-tall segment.
   *
   * Scaffolding/ladder cells must be valid: within active-grid bounds, within
   * range, foreground not solid, background empty, not inside the player body.
   * Rope extension cells are validated against loaded chunks (foreground not
   * solid, background empty, not in body) with NO range limit — the only limit
   * is that the containing chunk must be loaded. New rope cells are range-
   * limited like scaffolding/ladder. If any cell fails, the entire placement
   * is aborted (returns false).
   *
   * On success, consumes one item from buildMaterials and returns true.
   */
  place(wx: number, wy: number, mat: number): boolean {
    const type = buildMaterialTypeFromId(mat);
    if (!type || this.buildMaterials[type] <= 0) return false;

    const fgGrid = this.activeGrid.grid;
    const bgGrid = this.backgroundGrid;
    const { x: axF, y: ayF } = this.worldToActive(wx, wy);
    const ax = Math.floor(axF);
    const ay = Math.floor(ayF);

    // Player center + body AABB in active coords
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const pcx = paxF + PLAYER_W / 2;
    const pcy = payF + PLAYER_H / 2;
    const bodyX0 = Math.floor(paxF - PLAYER_W / 2);
    const bodyX1 = Math.floor(paxF + PLAYER_W / 2);
    const bodyY0 = Math.floor(payF);
    const bodyY1 = Math.floor(payF + PLAYER_H - 1);
    const maxR2 = MAX_MINE_RANGE * MAX_MINE_RANGE;

    // Helper: check if a cell is valid for placement
    const isValid = (x: number, y: number): boolean => {
      if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return false;
      const rdx = x - pcx;
      const rdy = y - pcy;
      if (rdx * rdx + rdy * rdy > maxR2) return false;
      if (x >= bodyX0 && x <= bodyX1 && y >= bodyY0 && y <= bodyY1) return false;
      const idx = y * ACTIVE_GRID_W + x;
      const fgPacked = fgGrid[idx];
      if (fgPacked !== 0) {
        if (MATERIALS[fgPacked & 0xff]?.solid) return false;
      }
      if (bgGrid[idx] !== 0) return false;
      return true;
    };

    // --- Compute cells to place based on material type ---
    let cells: Array<[number, number]> = [];

    if (type === "scaffolding") {
      const { width, supportDepth } = BUILD_DIMENSIONS.scaffolding;
      const halfW = Math.floor(width / 2);
      // Platform: 5-wide row at cursor y
      for (let dx = -halfW; dx <= halfW; dx++) {
        cells.push([ax + dx, ay]);
      }
      // Supports: only 2 legs at the left and right edges of the platform.
      // Each leg scans downward up to supportDepth, stopping at solid ground.
      const legOffsets = [-halfW, halfW];
      for (const dx of legOffsets) {
        for (let dy = 1; dy <= supportDepth; dy++) {
          const sx = ax + dx;
          const sy = ay + dy;
          if (sx < 0 || sx >= ACTIVE_GRID_W || sy < 0 || sy >= ACTIVE_GRID_H) break;
          const sIdx = sy * ACTIVE_GRID_W + sx;
          if (fgGrid[sIdx] !== 0 && MATERIALS[fgGrid[sIdx] & 0xff]?.solid) break;
          if (bgGrid[sIdx] !== 0) break;
          cells.push([sx, sy]);
        }
      }
    } else if (type === "ladder") {
      const { width, height } = BUILD_DIMENSIONS.ladder;
      const halfW = Math.floor(width / 2);
      for (let dy = 0; dy < height; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          cells.push([ax + dx, ay + dy]);
        }
      }
    } else {
      // rope — handled entirely in WORLD coords so the extension can span
      // loaded chunks beyond the active grid. The scan for the existing
      // rope's bottom continues through loaded chunks (not just the active
      // grid), and the new segment is written to chunk storage for cells
      // outside the active grid. Only loaded chunks limit the extension.
      const { width, segmentHeight } = BUILD_DIMENSIONS.rope;
      const halfW = Math.floor(width / 2);
      const { x: wAx, y: wAy } = this.activeToWorld(ax, ay);
      let startWY = wAy;
      let isExtension = false;
      // Check if cursor is directly above existing rope → extend downward.
      // bgAtWorld checks the active grid first, then loaded chunk storage, so
      // the scan continues past the active grid boundary into loaded chunks.
      if ((this.bgAtWorld(wAx, wAy + 1) & 0xff) === mat) {
        isExtension = true;
        // Find the bottom of the existing rope column, scanning down through
        // loaded chunks. Stops at the first non-rope cell OR an unloaded
        // chunk (bgAtWorld returns 0 for unloaded chunks).
        let bottomWY = wAy + 1;
        while ((this.bgAtWorld(wAx, bottomWY + 1) & 0xff) === mat) bottomWY++;
        // Start placing below the current bottom
        startWY = bottomWY + 1;
      }
      // Build the new segment cells in world coords
      const ropeCells: Array<[number, number]> = [];
      for (let dy = 0; dy < segmentHeight; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          ropeCells.push([wAx + dx, startWY + dy]);
        }
      }
      // Validate each rope cell. Extensions are NOT range-limited (the rope
      // follows itself down to its true bottom across loaded chunks); new
      // ropes ARE range-limited (cells are at the cursor, near the player).
      // All cells must: be in a loaded chunk, foreground not solid,
      // background empty, not inside the player body.
      for (const [rwx, rwy] of ropeCells) {
        // Convert to active coords for the body + range checks
        const cax = rwx - this.activeOriginCx * CHUNK_W;
        const cay = rwy - this.activeOriginCy * CHUNK_H;
        const inGrid = cax >= 0 && cax < ACTIVE_GRID_W && cay >= 0 && cay < ACTIVE_GRID_H;
        // Body check (player is always within the active grid, so out-of-grid
        // cells can't overlap the body — skip the check for them)
        if (inGrid && cax >= bodyX0 && cax <= bodyX1 && cay >= bodyY0 && cay <= bodyY1) {
          return false;
        }
        // Foreground must not be solid (checks active grid or loaded chunk)
        if (this.fgSolidAtWorld(rwx, rwy)) return false;
        // Background must be empty (checks active grid or loaded chunk)
        if (this.bgAtWorld(rwx, rwy) !== 0) return false;
        // Range check only for new ropes (extension follows the existing rope)
        if (!isExtension) {
          const rdx = cax - pcx;
          const rdy = cay - pcy;
          if (rdx * rdx + rdy * rdy > maxR2) return false;
        }
        // For out-of-grid cells, the containing chunk MUST be loaded — we
        // can't write to an unloaded chunk (setBgAtWorld would no-op).
        if (!inGrid) {
          const { cx, cy } = this.worldToChunk(rwx, rwy);
          if (cx < 0 || cx >= MAX_CHUNKS_X) return false;
          if (!this.chunks.has(chunkKey(cx, cy))) return false;
        }
      }
      // Write all rope cells (active grid for in-bounds, chunk storage for
      // out-of-grid)
      const ropePacked = packCell(mat, 0, 0);
      for (const [rwx, rwy] of ropeCells) {
        this.setBgAtWorld(rwx, rwy, ropePacked);
      }
      this.buildMaterials[type]--;
      return true;
    }

    // --- Validate all cells (scaffolding/ladder, active coords) ---
    for (const [x, y] of cells) {
      if (!isValid(x, y)) return false;
    }

    // --- Write all cells ---
    for (const [x, y] of cells) {
      const idx = y * ACTIVE_GRID_W + x;
      bgGrid[idx] = packCell(mat, 0, 0);
      this.markChunkDirty(x, y);
    }

    this.buildMaterials[type]--;
    return true;
  }

  /** Add build materials (from a purchase at the signpost shop). */
  addBuildMaterial(type: BuildMaterialType, qty: number): void {
    this.buildMaterials[type] = Math.max(0, this.buildMaterials[type] + qty);
  }

  /** Mark the chunk containing an active-grid cell as dirty (needs saving). */
  private markChunkDirty(ax: number, ay: number): void {
    const dcx = Math.floor(ax / CHUNK_W);
    const dcy = Math.floor(ay / CHUNK_H);
    const cx = this.activeOriginCx + dcx;
    const cy = this.activeOriginCy + dcy;
    if (cx < 0 || cx >= MAX_CHUNKS_X) return;
    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (chunk) chunk.dirty = true;
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
            if (wt === 0) {
              // Cell is frozen at this position. But if a particle has
              // moved here via physics, its wakeTick was set at its
              // previous position and NOT transferred to this one. Detect
              // this case and re-activate:
              //   - FLAG_DETACHED: a loose particle (ore/loose stone) that
              //     was dislodged from static terrain and fell here.
              //   - FLAG_UPDATED: any cell (including liquids) that moved
              //     this tick. Without this, liquid flowing into a crater
              //     (e.g. from a bomb blast) wouldn't keep its chunk
              //     active — the chunk would re-freeze with air pockets
              //     trapped in the crater.
              const ax = offsetX + lx;
              const ay = offsetY + ly;
              const packed = grid[ay * ACTIVE_GRID_W + ax];
              if (packed !== 0) {
                const flags = (packed >> 16) & 0xff;
                if ((flags & (FLAG_DETACHED | FLAG_UPDATED)) !== 0) {
                  wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
                  chunk.dirty = true;
                  hasUnfrozen = true;
                }
              }
              continue;
            }

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
   * Collect loose particles (ore/loose stone) near the player.
   * Only collects cells that are unfrozen (loose — recently mined/disturbed).
   * Frozen cells (ores embedded in stone) are not collectible.
   * Respects the max inventory size — stops collecting when full.
   * Returns an array of {mat, count} collected this tick.
   */
  collect(currentInventory: InventoryEntry[] = []): InventoryEntry[] {
    const collected: Map<number, number> = new Map();
    const maxInv = this.getMaxInventory();
    let currentCount = this.getInventoryCount(currentInventory);
    if (currentCount >= maxInv) return []; // inventory full

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

    // Player body AABB in active-grid coords — debris overlapping these cells
    // should NOT be collected; it buries the player and causes crush/suffocation
    // damage. Without this, collect() vacuums up debris on the player's body
    // every tick, preventing suffocation.
    const bodyX0 = Math.floor(paxF - PLAYER_W / 2);
    const bodyX1 = Math.floor(paxF + PLAYER_W / 2);
    const bodyY0 = Math.floor(payF);
    const bodyY1 = Math.floor(payF + PLAYER_H - 1);

    for (let dy = -COLLECT_RADIUS; dy <= COLLECT_RADIUS; dy++) {
      for (let dx = -COLLECT_RADIUS; dx <= COLLECT_RADIUS; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = pax + dx;
        const y = pay + dy;
        if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) continue;
        // Skip cells overlapping the player's body — those bury the player
        if (x >= bodyX0 && x <= bodyX1 && y >= bodyY0 && y <= bodyY1) continue;
        const idx = y * ACTIVE_GRID_W + x;
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        // Only collect loose (unfrozen) particles
        if (!this.isCellUnfrozen(x, y)) continue;
        if (isCollectible(mat)) {
          // Check inventory space
          if (currentCount >= maxInv) break;
          grid[idx] = 0; // remove from grid
          collected.set(mat, (collected.get(mat) ?? 0) + 1);
          currentCount++;
          // Clear the wakeTick for this cell (it's now empty)
          this.clearWakeTick(x, y);
        }
      }
      if (currentCount >= maxInv) break;
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
   * 3. Handle mining (raycast from player toward mouse, before sim so mined
   *    particles can fall this tick)
   * 4. Run SandWorld.step on the active grid
   * 5. Expire wakeTicks (re-freeze settled cells, extend for moving particles)
   * 6. Sync active grid back to chunk storage
   * 7. Update player physics
   * 8. Collect loose ore/stone near player (respects max inventory size)
   */
  step(input: {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    jump: boolean;
    noclip: boolean;
    mouseDown: boolean;
    mouseX: number;
    mouseY: number;
    digRadius: number;
    buildMode: boolean;
    buildMat: number;
  }, currentInventory: InventoryEntry[] = []): InventoryEntry[] {
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

    // 3. Handle mining or placement (before sim so changes apply this tick).
    // In build mode, left-click places the selected material; otherwise it
    // mines toward the cursor. Placement is rate-limited by the caller (the
    // worker enforces PLACE_COOLDOWN_MS) so holding the button draws a line.
    if (input.mouseDown) {
      if (input.buildMode) {
        this.place(input.mouseX, input.mouseY, input.buildMat);
      } else {
        this.mine(input.mouseX, input.mouseY);
      }
    }

    // 4. Run simulation
    this.activeGrid.step();

    // 5. Expire wakeTicks (re-freeze settled, extend for moving)
    this.expireWakeTicks();

    // 6. Sync back to chunks
    this.syncActiveGridToChunks();

    // 7. Update player (in active grid local coords)
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    updateMiningPlayer(this.player, input, this.activeGrid.grid, this.backgroundGrid, ACTIVE_GRID_W, ACTIVE_GRID_H, pax, pay);
    this.player.x = this.player.x + this.activeOriginCx * CHUNK_W;
    this.player.y = this.player.y + this.activeOriginCy * CHUNK_H;

    // 8. Collect loose ore/stone near player (respects max inventory size)
    const collected = this.collect(currentInventory);

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
          bgGrid: chunk.bgGrid.slice(),
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
      bgGrid: saved.bgGrid?.slice() ?? new Uint32Array(CHUNK_W * CHUNK_H),
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
    // Restore oxygen if the save provides it; old saves without the field
    // default to a full breath.
    this.player.oxygen = state.oxygen ?? OXYGEN_MAX_TICKS;
    // Force rebuild — the player may have moved to a different chunk
    this.needsRebuild = true;
    // Validate the loaded position — old saves may have the player inside
    // the ground (e.g. from before a spawn fix).
    this.needsSpawnValidation = true;
  }

  /**
   * Respawn the player at the surface spawn point with full health.
   * Upgrades and inventory are preserved (the player keeps their progress).
   * Clears per-cell mining damage so half-mined cells don't carry over.
   */
  respawn(): void {
    const playerWorldX = Math.floor(MAX_CHUNKS_X * CHUNK_W / 2);
    const surfaceY = surfaceHeightAt(playerWorldX, WORLD_SEED);
    const playerWorldY = surfaceY - PLAYER_H - 2;
    this.player.x = playerWorldX;
    this.player.y = playerWorldY;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.onGround = false;
    this.player.health = 100;
    this.player.lastDamageMaterial = 0;
    this.player.oxygen = OXYGEN_MAX_TICKS;
    // Clear per-cell mining damage
    this.cellDamage.fill(0);
    // Reset mining cooldown so the player can mine immediately
    this.mineCooldown = 0;
    // Force rebuild + spawn validation
    this.needsRebuild = true;
    this.needsSpawnValidation = true;
  }

  /**
   * Explode a bomb at the given world coordinates. Damages/clears solid cells
   * in a circular radius and damages the player if they're within range.
   * Liquids and gases are NOT destroyed — they're unfrozen so they flow
   * naturally into the crater. Walls are immune.
   */
  explode(worldX: number, worldY: number, radius: number): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const bgGrid = this.backgroundGrid;
    const { x: ax, y: ay } = this.worldToActive(worldX, worldY);
    const cx = Math.floor(ax);
    const cy = Math.floor(ay);
    const r = Math.floor(radius);

    // Dislodge foreground cells in a circle (like mining, not destruction):
    // - Stone → converted to Gravel/LooseStone (loose, collectible, falls)
    // - Ore → re-enable gravity (loosened, collectible)
    // - Other solids (Dirt, Wood, etc.) → cleared to create a hole
    // - Liquids/gases → NOT cleared, just unfrozen so they flow naturally
    //   into the crater. Clearing them would destroy the liquid and leave
    //   permanent air pockets under the liquid surface (the surrounding
    //   liquid can't flow in fast enough before the chunk re-freezes).
    //   Physically, an underwater explosion creates a void in solid material
    //   and the liquid rushes in to fill it.
    // Also clear background build materials (scaffolding/ladder/rope) in the
    // blast radius — bombs destroy placed build items.
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= ACTIVE_GRID_W || gy < 0 || gy >= ACTIVE_GRID_H) continue;
        const idx = gy * ACTIVE_GRID_W + gx;

        // --- Clear background build materials in blast radius ---
        if (bgGrid[idx] !== 0) {
          bgGrid[idx] = 0;
          this.markChunkDirty(gx, gy);
        }

        // --- Foreground terrain damage ---
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        if (mat === Material.Wall) continue; // walls are immune
        const def = MATERIALS[mat];
        if (!def) continue;
        const shade = (packed >> 16) & 0xff;
        const fi = idx * 4;

        if (isCollectible(mat)) {
          // Ore: re-enable gravity so it falls, mark unfrozen (collectible)
          if (fields[fi + FIELD.GRAVITY] === 0) {
            fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
          }
          grid[idx] = packed | (FLAG_DETACHED << 16);
          this.markCellUnfrozen(gx, gy);
        } else if (mat === Material.Stone || mat === Material.Grass) {
          // Stone/Grass → 60% Gravel + 40% LooseStone (loose, collectible)
          const newMat = Math.random() < 0.6 ? Material.Gravel : Material.LooseStone;
          const lt = newMat === Material.LooseStone ? LOOSE_STONE_SETTLE_TICKS : 0;
          grid[idx] = packCell(newMat, lt, shade | FLAG_DETACHED);
          if (fields[fi + FIELD.GRAVITY] === 0) {
            fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
          }
          this.markCellUnfrozen(gx, gy);
        } else if (def.solid) {
          // Dirt/Wood/other solids: clear to create a hole.
          // Reset ALL fields (gravity, temp, wind) to defaults so stale
          // values from the destroyed cell don't corrupt particles that
          // later flow into this space (e.g. a high temp field left behind
          // by fire/smoke would turn inflowing water into steam).
          grid[idx] = 0;
          fields[fi + FIELD.GRAVITY] = 0;
          fields[fi + FIELD.TEMP] = DEFAULT_TEMP;
          fields[fi + FIELD.WIND_X] = 0;
          fields[fi + FIELD.WIND_Y] = 0;
          this.cellDamage[idx] = 0;
          this.clearWakeTick(gx, gy);
        } else {
          // Liquids/gases: don't destroy — just unfreeze so they flow
          // naturally into the crater. This prevents permanent air pockets
          // under liquids (the liquid fills the void instead of being
          // deleted) and avoids leaving stale fields that corrupt new
          // particles.
          this.markCellUnfrozen(gx, gy);
        }
      }
    }

    // Loosen cells around the blast perimeter so terrain cascades and
    // liquids/gases flow into the crater. Without unfreezing liquid cells
    // here, the crater would remain filled with air — the surrounding liquid
    // stays frozen and never flows in (its chunk becomes inactive once the
    // solid debris settles and re-freezes).
    for (let dy = -r - 1; dy <= r + 1; dy++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < radius || dist > radius + 1.5) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= ACTIVE_GRID_W || gy < 0 || gy >= ACTIVE_GRID_H) continue;
        const idx = gy * ACTIVE_GRID_W + gx;
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        if (mat === Material.Wall) continue;
        const def = MATERIALS[mat];
        if (!def) continue;
        // Re-enable gravity for solids so the loosened cell falls.
        // Liquids/gases flow via their material properties (not the GRAVITY
        // field), so we only unfreeze them — no gravity change needed.
        if (def.solid) {
          const fi = idx * 4;
          if (fields[fi + FIELD.GRAVITY] === 0) {
            fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
          }
        }
        this.markCellUnfrozen(gx, gy);
      }
    }

    // Damage the player if within blast radius
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    const pcx = pax + PLAYER_W / 2;
    const pcy = pay + PLAYER_H / 2;
    const pdx = pcx - cx;
    const pdy = pcy - cy;
    const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
    if (pdist <= radius + PLAYER_W) {
      // Damage scales inversely with distance: 50 at point-blank, 0 at edge
      const damage = Math.round(50 * (1 - pdist / (radius + PLAYER_W)));
      if (damage > 0) {
        this.player.health = Math.max(0, this.player.health - damage);
        // Bombs use the fuse-fire death cause so the quip reflects the
        // explosion (e.g. "should've cut the red wire"), not generic fire.
        this.player.lastDamageMaterial = Material.FuseFire;
      }
    }

    // Ignite flammable materials (oil, wood, coal, etc.) in and around the
    // blast. The explosion's heat ignites oil into BurningOil and other
    // flammables into Fire. Uses a slightly larger radius than the blast
    // so fire spreads to exposed fuel at the crater's edge.
    const igniteR = Math.ceil(radius) + 1;
    this.activeGrid.ignite(cx, cy, igniteR);
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
  bgGrid: Uint32Array;
  wakeTick: Uint32Array;
}
