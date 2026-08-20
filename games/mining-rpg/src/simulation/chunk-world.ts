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
    MAT_FLAGS,
    MAT_GRAVITY_DIR,
    MAT_SOLID,
    Material,
    MATERIALS,
    packCell,
    SandStepPool,
    SandWorld
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
    INTEGRITY_CHECK_INTERVAL,
    INTEGRITY_MAX_DEMOLISH_PER_CHECK,
    INVENTORY_SIZE_UPGRADE_INCREMENT,
    isCollectible,
    LIGHT_GRID_STRIDE,
    LIGHT_SCAN_INTERVAL,
    LIGHT_STRUCT_FLOATS,
    LOOSE_STONE_HARDNESS,
    MAX_CHUNKS_X,
    MAX_MINE_RANGE,
    MAX_WORLD_LIGHTS,
    NEAR_PLAYER_RADIUS_CHUNKS,
    ORE_HARDNESS,
    OXYGEN_MAX_TICKS,
    PLAYER_H,
    PLAYER_W,
    RADIUS_UPGRADE_INCREMENT,
    RATE_UPGRADE_REDUCTION,
    REVEAL_RADIUS,
    STONE_HARDNESS,
    TORCH_DOUSE_INTERVAL,
    TORCH_LIGHT_COLOR,
    TORCH_LIGHT_INTENSITY,
    TORCH_LIGHT_RADIUS,
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

/**
 * Light properties for emitting materials (lava, fire, plasma, etc.).
 * Returns null for non-emitting materials. The worker uses this to build
 * the dynamic light list each scan.
 */
function materialLight(mat: number): { color: [number, number, number]; intensity: number; radius: number } | null {
  switch (mat) {
    case Material.Lava: return { color: [1.0, 0.4, 0.05], intensity: 1.0, radius: 15 };
    case Material.Fire: return { color: [1.0, 0.5, 0.1], intensity: 0.8, radius: 12 };
    case Material.BurningOil: return { color: [0.9, 0.4, 0.1], intensity: 0.7, radius: 12 };
    case Material.Plasma: return { color: [0.6, 0.8, 1.0], intensity: 1.0, radius: 15 };
    case Material.FuseFire: return { color: [1.0, 0.7, 0.2], intensity: 0.8, radius: 12 };
    case Material.Fireflies: return { color: [0.8, 1.0, 0.4], intensity: 0.3, radius: 8 };
    default: return null;
  }
}

export class ChunkWorld {
  // All loaded chunks, keyed by "cx,cy"
  private chunks = new Map<string, Chunk>();
  // The contiguous active grid simulation
  activeGrid: SandWorld;
  // Multi-threaded sand step pool (null = single-threaded fallback)
  private sandStepPool: SandStepPool | null = null;
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
  buildMaterials: BuildMaterials = { scaffolding: 0, ladder: 0, rope: 0, torch: 0 };
  // Background grid: build materials layer at the same resolution as the
  // active grid. Stores placed scaffolding/ladder/rope cells. The player
  // physics checks this grid for solid (scaffolding) and climbable
  // (ladder/rope) cells, but falling sand in the foreground grid passes
  // through — build materials don't participate in the sand simulation.
  // Synced to/from chunks during active grid rebuilds, and written to the
  // SAB each tick for the renderer's background pass.
  backgroundGrid: Uint32Array;
  // Fog-of-war: 1 byte per cell in the active grid (0 = unexplored,
  // 1 = explored). Synced to/from chunks during active grid rebuilds and
  // written to the SAB each tick for the renderer's fog pass.
  exploredGrid: Uint8Array;
  // Light list: packed light structs (posX, posY, r, g, b, intensity, radius,
  // pad) for emitting cells (lava, fire, torches). Scanned every
  // LIGHT_SCAN_INTERVAL ticks and written to the SAB for the renderer's
  // light accumulation pass.
  lightList: Float32Array;
  lightCount = 0;
  // --- Torch index ---
  // Set of active-grid cell indices (y * ACTIVE_GRID_W + x) where the
  // background grid contains a Torch. Maintained incrementally: rebuilt
  // during rebuildActiveGrid(), updated on place/douse/mine/explode. Used by
  // douseTorches() and scanEmittingLights() to avoid full-grid scans of the
  // 410k-cell background grid every tick (the primary cause of the physics
  // loop performance regression).
  private torchCells: Set<number> = new Set();
  // --- Structural integrity (auto-demolish disconnected cells) ---
  // Pre-allocated BFS scratch buffers (reused across checks — no per-check
  // allocation). visited is 1 byte/cell (0 = unvisited, 1 = reachable from
  // the active-grid border). queue holds cell indices for the BFS frontier.
  private integrityVisited: Uint8Array;
  private integrityQueue: Int32Array;
  // Last tick a structural-integrity check ran. The next check is gated by
  // INTEGRITY_CHECK_INTERVAL AND terrainDirtyForIntegrity/needsIntegrityCheck.
  private lastIntegrityTick = 0;
  // Set when mining/explosions modify terrain — the next cadence tick re-runs
  // the check. Without this, the check would run every interval even when the
  // world is static (wasted work).
  private terrainDirtyForIntegrity = false;
  // Set after an active-grid rebuild — the border changed, so the connectivity
  // graph must be re-evaluated on the next cadence tick regardless of whether
  // terrain was modified.
  private needsIntegrityCheck = false;
  // Max cells demolished per check (safety cap). Defaults to the constant but
  // exposed so tests can lower it. See INTEGRITY_MAX_DEMOLISH_PER_CHECK.
  integrityMaxDemolish = INTEGRITY_MAX_DEMOLISH_PER_CHECK;
  // World config
  readonly seed: number;

  constructor(numSandWorkers: number = 0) {
    this.seed = WORLD_SEED;
    if (numSandWorkers > 0) {
      // Multi-threaded: create a SandStepPool with SAB-backed grid.
      this.sandStepPool = new SandStepPool({
        W: ACTIVE_GRID_W,
        H: ACTIVE_GRID_H,
        numWorkers: numSandWorkers,
        preserveFlagsMask: FLAG_DETACHED,
        disturbedFlags: FLAG_DETACHED,
      });
      this.activeGrid = this.sandStepPool.getBoundaryWorld();
      // The skip mask is SAB-backed — get a reference to it.
      this.skipMask = this.sandStepPool.getSkipMask();
    } else {
      // Single-threaded: regular SandWorld with ArrayBuffer grid.
      this.activeGrid = new SandWorld(ACTIVE_GRID_W, ACTIVE_GRID_H);
      this.skipMask = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
      this.activeGrid.skipMask = this.skipMask;
    }
    this.cellDamage = new Float32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.backgroundGrid = new Uint32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.exploredGrid = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.lightList = new Float32Array(MAX_WORLD_LIGHTS * LIGHT_STRUCT_FLOATS);
    this.integrityVisited = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.integrityQueue = new Int32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    // In single-threaded mode, set the skip mask + flags on the activeGrid.
    // In multi-threaded mode, these are already set via the SandStepPool.
    if (!this.sandStepPool) {
      this.activeGrid.skipMask = this.skipMask;
      // Preserve FLAG_DETACHED (bit 4 of the flags byte) across the physics
      // engine's per-frame FLAG_UPDATED clear. Without this, the detached bit
      // is stripped every step() and the renderer never sees it.
      this.activeGrid.preserveFlagsMask = FLAG_DETACHED;
      // disturbAdjacent() sets FLAG_DETACHED on Stone→LooseStone conversions
      // so expireWakeTicks can detect disturbed cells in frozen chunks (outer
      // ring) even after applyAging clears FLAG_UPDATED. Without this, disturbed
      // cells in frozen chunks stay frozen and never fall — a regression where
      // disconnected cells don't break correctly when the outer ring freezes.
      this.activeGrid.disturbedFlags = FLAG_DETACHED;
    }
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

  /** Initialize the multi-threaded sand step pool (if enabled). */
  async initSandStepPool(): Promise<void> {
    if (this.sandStepPool) {
      await this.sandStepPool.init();
    }
  }

  /** Shut down the sand step pool (if active). */
  shutdownSandStepPool(): void {
    if (this.sandStepPool) {
      this.sandStepPool.shutdown();
      this.sandStepPool = null;
    }
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
    const explored = this.exploredGrid;

    // Copy out the old active grid + background grid back to chunk storage
    // using the PREVIOUS origin — the grid data is still laid out for the old origin.
    // Force sync all chunks since the origin is changing and we need to persist
    // the full old grid before overwriting it.
    this.syncActiveGridToChunks(this.prevOriginCx, this.prevOriginCy, true);

    // Clear the active grid + background grid + explored grid
    grid.fill(0);
    bgGrid.fill(0);
    explored.fill(0);
    fields.fill(DEFAULT_TEMP);
    this.cellDamage.fill(0);
    this.torchCells.clear();
    for (let i = 0; i < ACTIVE_GRID_W * ACTIVE_GRID_H * 4; i += 4) {
      fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }

    // Copy each chunk in the active window into the active grid + background grid + explored grid
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
        // Copy background grid + build torch index
        const chunkBg = chunk.bgGrid;
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = y * CHUNK_W;
          const dstRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          bgGrid.set(
            chunkBg.subarray(srcRow, srcRow + CHUNK_W),
            dstRow,
          );
          // Scan the chunk's bg row for torches and add to the index.
          // This replaces the per-tick full-grid torch scan in douseTorches()
          // and scanEmittingLights() with an O(torch_count) index lookup.
          for (let x = 0; x < CHUNK_W; x++) {
            if ((chunkBg[srcRow + x] & 0xff) === Material.Torch) {
              this.torchCells.add(dstRow + x);
            }
          }
        }
        // Copy explored grid
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = y * CHUNK_W;
          const dstRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          explored.set(
            chunk.explored.subarray(srcRow, srcRow + CHUNK_W),
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
    // The active-grid border changed → the connectivity graph must be
    // re-evaluated on the next cadence tick regardless of terrain edits.
    this.needsIntegrityCheck = true;
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
   *
   * Only syncs chunks with chunk.dirty = true — most chunks don't change
   * every tick (frozen terrain, undisturbed caves). The dirty flag is set
   * by markCellUnfrozen, clearWakeTick, mining, explosions, torch placement,
   * expireWakeTicks, etc. This reduces the per-tick copy from ~5.1MB
   * (all 25 chunks) to ~1MB (only dirty chunks, typically 3-5).
   *
   * When forceAll=true (used by rebuildActiveGrid), syncs all chunks
   * regardless of dirty state — the grid origin changed so all chunks
   * need to be written back.
   */
  private syncActiveGridToChunks(originCx?: number, originCy?: number, forceAll = false): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const bgGrid = this.backgroundGrid;
    const explored = this.exploredGrid;
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

        // Skip chunks that haven't been modified this tick. The dirty flag
        // is set by any operation that modifies the chunk's grid/fields/
        // bgGrid/explored/wakeTick. Frozen chunks with no activity stay
        // clean and are skipped — a massive save when most of the active
        // grid is settled terrain.
        if (!forceAll && !chunk.dirty) continue;

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
        // Copy explored grid back
        for (let y = 0; y < CHUNK_H; y++) {
          const srcRow = (offsetY + y) * ACTIVE_GRID_W + offsetX;
          const dstRow = y * CHUNK_W;
          chunk.explored.set(
            explored.subarray(srcRow, srcRow + CHUNK_W),
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
        // Clear dirty flag — the chunk is now in sync with the active grid.
        chunk.dirty = false;
      }
    }
  }

  // --- Freeze optimization ---

  /**
   * Combined freeze-state update — replaces the separate buildSkipMask() and
   * expireWakeTicks() passes. Runs AFTER the sand step to:
   *
   * 1. Expire wakeTicks (re-freeze settled cells, extend for moving particles,
   *    re-activate frozen cells that particles moved into).
   * 2. Build the skip mask for the NEXT tick's sand step.
   *
   * Combining these into one pass eliminates a full 400k-cell scan per tick
   * (both functions iterated all 25 chunks' wakeTick arrays separately).
   * Near-player chunks skip the wakeTick scan entirely (always active).
   *
   * The skip mask from the PREVIOUS tick's updateFreezeState is used by the
   * current tick's sand step. On rebuild (chunk boundary crossing), the skip
   * mask is rebuilt from scratch via buildSkipMaskOnly().
   */
  private updateFreezeState(): void {
    const skip = this.skipMask;
    const grid = this.activeGrid.grid;
    const playerChunk = this.worldToChunk(this.player.x, this.player.y);
    const W = ACTIVE_GRID_W;

    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = this.activeOriginCx + dcx;
        const cy = this.activeOriginCy + dcy;
        if (cx < 0 || cx >= MAX_CHUNKS_X) {
          this.fillSkipRegion(skip, dcx, dcy, 1);
          continue;
        }

        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) {
          this.fillSkipRegion(skip, dcx, dcy, 1);
          continue;
        }

        const distX = Math.abs(cx - playerChunk.cx);
        const distY = Math.abs(cy - playerChunk.cy);
        const nearPlayer = distX <= NEAR_PLAYER_RADIUS_CHUNKS && distY <= NEAR_PLAYER_RADIUS_CHUNKS;

        if (nearPlayer) {
          // Near-player: always active, no skip mask. Extend all unfrozen
          // wakeTicks so cells stay collectible. Also re-activate frozen
          // cells that particles moved into this tick (FLAG_UPDATED/DETACHED).
          this.fillSkipRegion(skip, dcx, dcy, 0);
          chunk.active = true;
          const wakeTick = chunk.wakeTick;
          const offsetX = dcx * CHUNK_W;
          const offsetY = dcy * CHUNK_H;
          for (let ly = 0; ly < CHUNK_H; ly++) {
            for (let lx = 0; lx < CHUNK_W; lx++) {
              const localIdx = ly * CHUNK_W + lx;
              const wt = wakeTick[localIdx];
              if (wt === 0) {
                // Frozen — check if a particle moved here this tick
                const ax = offsetX + lx;
                const ay = offsetY + ly;
                const packed = grid[ay * W + ax];
                if (packed !== 0) {
                  const flags = (packed >> 16) & 0xff;
                  if ((flags & (FLAG_DETACHED | FLAG_UPDATED)) !== 0) {
                    wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
                    chunk.dirty = true;
                  }
                }
              } else {
                // Unfrozen — extend so it stays collectible
                wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
                chunk.dirty = true;
              }
            }
          }
          continue;
        }

        // Non-near-player: scan wakeTicks, expire/re-activate, build skip mask
        const wakeTick = chunk.wakeTick;
        const offsetX = dcx * CHUNK_W;
        const offsetY = dcy * CHUNK_H;
        let hasUnfrozen = false;

        for (let ly = 0; ly < CHUNK_H; ly++) {
          for (let lx = 0; lx < CHUNK_W; lx++) {
            const localIdx = ly * CHUNK_W + lx;
            const wt = wakeTick[localIdx];
            if (wt === 0) {
              // Frozen — check if a particle moved here this tick
              const ax = offsetX + lx;
              const ay = offsetY + ly;
              const packed = grid[ay * W + ax];
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

            if (wt > this.currentTick) {
              // Still unfrozen — extend if moved, keep if stationary
              const ax = offsetX + lx;
              const ay = offsetY + ly;
              const packed = grid[ay * W + ax];
              const flags = (packed >> 16) & 0xff;
              if (flags & FLAG_UPDATED) {
                wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
                chunk.dirty = true;
                hasUnfrozen = true;
              } else {
                hasUnfrozen = true;
              }
            } else {
              // Expired — re-freeze
              wakeTick[localIdx] = 0;
              chunk.dirty = true;
            }
          }
        }

        chunk.active = hasUnfrozen;
        if (!hasUnfrozen) {
          this.fillSkipRegion(skip, dcx, dcy, 1);
        } else {
          this.fillSkipRegion(skip, dcx, dcy, 0);
        }
      }
    }
  }

  /**
   * Build the skip mask only (no wakeTick updates). Used after a rebuild
   * when the grid content changed and we need the skip mask before the sand
   * step, but don't want to expire wakeTicks yet (the sand step hasn't run).
   */
  private buildSkipMaskOnly(): void {
    const skip = this.skipMask;
    skip.fill(0);
    const playerChunk = this.worldToChunk(this.player.x, this.player.y);

    for (let dcy = 0; dcy < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcy++) {
      for (let dcx = 0; dcx < 2 * ACTIVE_RADIUS_CHUNKS + 1; dcx++) {
        const cx = this.activeOriginCx + dcx;
        const cy = this.activeOriginCy + dcy;
        if (cx < 0 || cx >= MAX_CHUNKS_X) {
          this.fillSkipRegion(skip, dcx, dcy, 1);
          continue;
        }

        const key = chunkKey(cx, cy);
        const chunk = this.chunks.get(key);
        if (!chunk) {
          this.fillSkipRegion(skip, dcx, dcy, 1);
          continue;
        }

        const distX = Math.abs(cx - playerChunk.cx);
        const distY = Math.abs(cy - playerChunk.cy);
        const nearPlayer = distX <= NEAR_PLAYER_RADIUS_CHUNKS && distY <= NEAR_PLAYER_RADIUS_CHUNKS;

        let hasUnfrozen = false;
        if (!nearPlayer) {
          for (let i = 0; i < chunk.wakeTick.length; i++) {
            if (chunk.wakeTick[i] > this.currentTick) {
              hasUnfrozen = true;
              break;
            }
          }
        }

        chunk.active = nearPlayer || hasUnfrozen;
        if (!chunk.active) {
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

    // Player center in active grid coords. player.x is the horizontal CENTER
    // of the AABB (see mining-player.ts: x0 = floor(px - PLAYER_W/2)), and
    // player.y is the TOP of the AABB (y0 = floor(py)). So the X center is
    // paxF directly, and the Y center is payF + PLAYER_H/2. Adding PLAYER_W/2
    // to X here would double-shift the ray origin right by 1.5 cells, biasing
    // mining hits to the right (visible when aiming straight down).
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const px = paxF;
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
        // Build materials are hit if solid, climbable, or a known build type
        // (torch is neither solid nor climbable but should be mineable)
        if (bgDef?.solid || bgDef?.climbable || buildMaterialTypeFromId(bgMat) !== null) {
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
            if (bgMat === Material.Torch) this.torchCells.delete(idx);
            this.markChunkDirty(x, y);
            // Removing a build cell can disconnect foreground terrain it was
            // supporting (rare, but possible) — flag for an integrity re-check.
            this.terrainDirtyForIntegrity = true;
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
          this.terrainDirtyForIntegrity = true;

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
   * Place a torch via raycast from the player center toward the target world
   * coords. Walks in 1-cell steps from the player toward the target, placing
   * the torch at the first valid cell (empty foreground, empty background,
   * within range, not inside the player body). Returns true on success.
   */
  placeTorchRaycast(targetX: number, targetY: number): boolean {
    if (this.buildMaterials.torch <= 0) return false;

    const fgGrid = this.activeGrid.grid;
    const bgGrid = this.backgroundGrid;
    // player.x is the horizontal CENTER of the AABB (see mining-player.ts),
    // player.y is the TOP.
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const pcx = paxF;
    const pcy = payF + PLAYER_H / 2;
    const bodyX0 = Math.floor(paxF - PLAYER_W / 2);
    const bodyX1 = Math.floor(paxF + PLAYER_W / 2);
    const bodyY0 = Math.floor(payF);
    const bodyY1 = Math.floor(payF + PLAYER_H - 1);
    const maxR2 = MAX_MINE_RANGE * MAX_MINE_RANGE;

    // Direction from player center to target
    const { x: taxF, y: tayF } = this.worldToActive(targetX, targetY);
    let dx = taxF - pcx;
    let dy = tayF - pcy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return false;
    dx /= dist;
    dy /= dist;

    // Walk from player center toward the target in 1-cell steps
    const maxSteps = Math.min(Math.ceil(dist), MAX_MINE_RANGE + 2);
    for (let step = 1; step <= maxSteps; step++) {
      const x = Math.floor(pcx + dx * step);
      const y = Math.floor(pcy + dy * step);
      if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) break;
      const rdx = x - pcx;
      const rdy = y - pcy;
      if (rdx * rdx + rdy * rdy > maxR2) break;
      // Skip cells inside the player body
      if (x >= bodyX0 && x <= bodyX1 && y >= bodyY0 && y <= bodyY1) continue;
      const idx = y * ACTIVE_GRID_W + x;
      const fgPacked = fgGrid[idx];
      // Must be empty foreground (or non-solid)
      if (fgPacked !== 0 && MATERIALS[fgPacked & 0xff]?.solid) continue;
      // Must be empty background
      if (bgGrid[idx] !== 0) continue;
      // Place the torch in the background grid
      bgGrid[idx] = packCell(Material.Torch, 0, 0);
      this.torchCells.add(idx);
      this.buildMaterials.torch--;
      // Mark the chunk dirty for saving
      const cx = this.activeOriginCx + Math.floor(x / CHUNK_W);
      const cy = this.activeOriginCy + Math.floor(y / CHUNK_H);
      const chunk = this.chunks.get(chunkKey(cx, cy));
      if (chunk) {
        const lx = x - Math.floor(x / CHUNK_W) * CHUNK_W;
        const ly = y - Math.floor(y / CHUNK_H) * CHUNK_H;
        chunk.bgGrid[ly * CHUNK_W + lx] = bgGrid[idx];
        chunk.dirty = true;
      }
      // Force a light scan on the next tick so the torch light appears immediately
      this.currentTick = 0;
      return true;
    }
    return false;
  }

  /**
   * Douse torches in the background grid that are touched by any liquid
   * (water, oil, etc.) in the foreground grid. Iterates only the torch index
   * (O(torch_count) instead of a full O(ACTIVE_GRID_CELLS) scan) and removes
   * the torch from both the active background grid and chunk storage.
   *
   * Throttled to every TORCH_DOUSE_INTERVAL ticks by the caller (step()).
   */
  douseTorches(): void {
    if (this.torchCells.size === 0) return;
    const fgGrid = this.activeGrid.grid;
    const bgGrid = this.backgroundGrid;
    const toRemove: number[] = [];
    for (const idx of this.torchCells) {
      // Verify the cell is still a torch (safety — index should be in sync)
      const bgPacked = bgGrid[idx];
      if ((bgPacked & 0xff) !== Material.Torch) {
        toRemove.push(idx);
        continue;
      }
      // Check the foreground cell at the same position
      const fgPacked = fgGrid[idx];
      if (fgPacked === 0) continue;
      const fgMat = fgPacked & 0xff;
      const def = MATERIALS[fgMat];
      if (def?.liquid) {
        // Douse: remove the torch
        const x = idx % ACTIVE_GRID_W;
        const y = (idx / ACTIVE_GRID_W) | 0;
        bgGrid[idx] = 0;
        toRemove.push(idx);
        // Sync to chunk storage
        const cx = this.activeOriginCx + Math.floor(x / CHUNK_W);
        const cy = this.activeOriginCy + Math.floor(y / CHUNK_H);
        const chunk = this.chunks.get(chunkKey(cx, cy));
        if (chunk) {
          const lx = x - Math.floor(x / CHUNK_W) * CHUNK_W;
          const ly = y - Math.floor(y / CHUNK_H) * CHUNK_H;
          chunk.bgGrid[ly * CHUNK_W + lx] = 0;
          chunk.dirty = true;
        }
      }
    }
    for (const idx of toRemove) this.torchCells.delete(idx);
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

    // Player center + body AABB in active coords. player.x is the horizontal
    // CENTER of the AABB (see mining-player.ts), player.y is the TOP.
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const pcx = paxF;
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
    } else if (type === "torch") {
      // Torch: single cell at the cursor position
      cells.push([ax, ay]);
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
      if (mat === Material.Torch) this.torchCells.add(idx);
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

  // --- Structural integrity (auto-demolish disconnected cells) ---

  /**
   * Force a structural-integrity check now (test hook). Resets the cadence
   * timer and dirty flags so the check actually runs, then runs it. Safe to
   * call from tests after setting up terrain directly in the active grid.
   */
  forceIntegrityCheckForTest(): void {
    this.terrainDirtyForIntegrity = true;
    this.needsIntegrityCheck = true;
    this.lastIntegrityTick = 0;
    this.runStructuralIntegrityCheck();
  }

  /**
   * Run a structural-integrity check if needed.
   *
   * A 4-connected flood-fill starts from every solid cell on the outer border
   * of the active grid (the border represents the rest of the world outside
   * the window). Any solid cell NOT reached by the flood is "disconnected from
   * the main world" — e.g. a block of stone fully surrounded by an empty
   * cavity (a floating island). Disconnected solid cells are demolished by
   * converting them to loose falling debris (same per-cell logic as explode()).
   *
   * Gating:
   *   - Always runs when needsIntegrityCheck is set (active-grid rebuild →
   *     border changed → re-evaluate).
   *   - Otherwise runs at most every INTEGRITY_CHECK_INTERVAL ticks, and only
   *     when terrainDirtyForIntegrity is set (mining/explosions modified
   *     terrain since the last check). A static world never re-runs the check.
   *
   * Walls are solid so they participate in the connectivity graph (they can
   * connect regions) but are never demolished. Liquids/gases are not solid so
   * they're excluded from both the flood and the demolish loop — a frozen
   * liquid on a collapsing island may briefly float until disturbed; this is
   * a known, self-correcting limitation.
   */
  private runStructuralIntegrityCheck(): void {
    if (this.needsIntegrityCheck) {
      // Border changed — always re-check.
    } else if (!this.terrainDirtyForIntegrity) {
      return; // world unchanged since last check
    } else if (this.currentTick - this.lastIntegrityTick < INTEGRITY_CHECK_INTERVAL) {
      return; // cadence not elapsed
    }

    this.lastIntegrityTick = this.currentTick;
    this.terrainDirtyForIntegrity = false;
    this.needsIntegrityCheck = false;

    const W = ACTIVE_GRID_W;
    const H = ACTIVE_GRID_H;
    const grid = this.activeGrid.grid;
    const visited = this.integrityVisited;
    const queue = this.integrityQueue;
    const flags = MAT_FLAGS;
    const solid = MAT_SOLID;
    visited.fill(0);

    // Queue entries pack x into the high bits so the BFS can do bounds checks
    // without idx % W / idx / W divisions. Layout: bits 0-18 = idx (max
    // 409599 < 2^19), bits 20-31 = x (max 639 < 2^12). Add a gap bit (19) for
    // safety so the signed Int32Array never goes negative.
    const X_SHIFT = 20;
    const IDX_MASK = 0xFFFFF; // 20 bits

    // --- Seed: enqueue every solid cell on the four outer borders ---
    // Inlined (no closure) so V8 keeps head/tail in registers.
    let head = 0;
    let tail = 0;
    // Top + bottom rows
    for (let x = 0; x < W; x++) {
      // y = 0
      {
        const idx = x;
        if (visited[idx] === 0) {
          const packed = grid[idx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[idx] = 1;
            queue[tail++] = (x << X_SHIFT) | idx;
          }
        }
      }
      // y = H - 1
      {
        const idx = (H - 1) * W + x;
        if (visited[idx] === 0) {
          const packed = grid[idx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[idx] = 1;
            queue[tail++] = (x << X_SHIFT) | idx;
          }
        }
      }
    }
    // Left + right columns (skip corners already done)
    for (let y = 1; y < H - 1; y++) {
      // x = 0
      {
        const idx = y * W;
        if (visited[idx] === 0) {
          const packed = grid[idx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[idx] = 1;
            queue[tail++] = (0 << X_SHIFT) | idx;
          }
        }
      }
      // x = W - 1
      {
        const idx = y * W + (W - 1);
        if (visited[idx] === 0) {
          const packed = grid[idx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[idx] = 1;
            queue[tail++] = ((W - 1) << X_SHIFT) | idx;
          }
        }
      }
    }

    // --- BFS (4-connected) over solid cells ---
    // Bounds checks use idx range comparisons (no division):
    //   Up:   idx >= W           (y > 0)
    //   Down: idx < downLimit    (y < H - 1)
    //   Left: x > 0
    //   Right: x < W - 1
    const downLimit = (H - 1) * W;
    const xMax = W - 1;
    while (head < tail) {
      const entry = queue[head++];
      const idx = entry & IDX_MASK;
      const x = entry >>> X_SHIFT;
      // Up
      if (idx >= W) {
        const nidx = idx - W;
        if (visited[nidx] === 0) {
          const packed = grid[nidx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[nidx] = 1;
            queue[tail++] = (x << X_SHIFT) | nidx;
          }
        }
      }
      // Down
      if (idx < downLimit) {
        const nidx = idx + W;
        if (visited[nidx] === 0) {
          const packed = grid[nidx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[nidx] = 1;
            queue[tail++] = (x << X_SHIFT) | nidx;
          }
        }
      }
      // Left
      if (x > 0) {
        const nidx = idx - 1;
        if (visited[nidx] === 0) {
          const packed = grid[nidx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[nidx] = 1;
            queue[tail++] = ((x - 1) << X_SHIFT) | nidx;
          }
        }
      }
      // Right
      if (x < xMax) {
        const nidx = idx + 1;
        if (visited[nidx] === 0) {
          const packed = grid[nidx];
          if (packed !== 0 && (flags[packed & 0xff] & solid) !== 0) {
            visited[nidx] = 1;
            queue[tail++] = ((x + 1) << X_SHIFT) | nidx;
          }
        }
      }
    }

    // --- Demolish unreached solid cells ---
    // Time-budget guard: if the check has run longer than 2ms, defer remaining
    // demolitions to the next check. Checked every 64 cells to amortize the
    // performance.now() call. Prevents frame spikes from pathological collapses.
    let demolished = 0;
    const checkStart = performance.now();
    for (let y = 0; y < H; y++) {
      const rowStart = y * W;
      for (let x = 0; x < W; x++) {
        const idx = rowStart + x;
        if (visited[idx] !== 0) continue;
        const packed = grid[idx];
        if (packed === 0) continue;
        const mat = packed & 0xff;
        if (mat === Material.Wall) continue; // walls are immune
        if ((flags[mat] & solid) === 0) continue; // liquids/gases left alone
        this.demolishCell(idx, x, y, packed, mat);
        demolished++;
        if (demolished >= this.integrityMaxDemolish) return;
        if ((demolished & 63) === 0 && performance.now() - checkStart > 2.0) return;
      }
    }
  }

  /**
   * Demolish a single disconnected solid cell — mirrors explode()'s per-cell
   * foreground terrain damage (see explode() lines ~1523-1566). Converts the
   * cell to loose falling debris so it falls and becomes collectible, rather
   * than being deleted (preserves player loot).
   *
   *   - Collectibles (ores, coal, dirt, grass, gravel, loose stone) →
   *     re-enable gravity + FLAG_DETACHED + markCellUnfrozen (falls, collectible).
   *   - Stone/Grass → Gravel (60%) / LooseStone (40%) with FLAG_DETACHED,
   *     gravity re-enabled, markCellUnfrozen. (Grass is also collectible so
   *     the first branch catches it in practice; kept for parity with explode.)
   *   - Other solids (Wood, Concrete, …) → cleared to empty, fields reset,
   *     cellDamage + wakeTick cleared.
   */
  private demolishCell(idx: number, ax: number, ay: number, packed: number, mat: number): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const shade = (packed >> 16) & 0xff;
    const fi = idx * 4;

    if (isCollectible(mat)) {
      // Ore/coal/dirt/grass/gravel/loose stone: re-enable gravity so it falls,
      // mark detached + unfrozen (collectible).
      if (fields[fi + FIELD.GRAVITY] === 0) {
        fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      }
      grid[idx] = packed | (FLAG_DETACHED << 16);
      this.markCellUnfrozen(ax, ay);
    } else if (mat === Material.Stone || mat === Material.Grass) {
      // Stone/Grass → 60% Gravel + 40% LooseStone (loose, collectible, falls).
      const newMat = Math.random() < 0.6 ? Material.Gravel : Material.LooseStone;
      const lt = newMat === Material.LooseStone ? LOOSE_STONE_SETTLE_TICKS : 0;
      grid[idx] = packCell(newMat, lt, shade | FLAG_DETACHED);
      if (fields[fi + FIELD.GRAVITY] === 0) {
        fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      }
      this.markCellUnfrozen(ax, ay);
    } else {
      // Other solids (Wood, Concrete, …): clear to create a hole. Reset all
      // fields so stale values don't corrupt particles that later flow in.
      grid[idx] = 0;
      fields[fi + FIELD.GRAVITY] = 0;
      fields[fi + FIELD.TEMP] = DEFAULT_TEMP;
      this.cellDamage[idx] = 0;
      this.clearWakeTick(ax, ay);
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
   * 2. Build skip mask (only on rebuild; otherwise reused from last tick's
   *    updateFreezeState)
   * 3. Handle mining (raycast from player toward mouse, before sim so mined
   *    particles can fall this tick)
   * 4. Run SandWorld.step on the active grid
   * 5. Update freeze state (combined expireWakeTicks + buildSkipMask for next
   *    tick — eliminates one full-grid scan per tick)
   * 6. Structural integrity check (slow cadence) — demolish solid cells
   *    disconnected from the active-grid border (floating islands). Runs at
   *    most every INTEGRITY_CHECK_INTERVAL ticks, only when terrain is dirty.
   * 7. Sync active grid back to chunk storage (only dirty chunks)
   * 7b. Douse torches touched by liquids (throttled to TORCH_DOUSE_INTERVAL,
   *     uses torch index — runs after sync to keep the hot path cache-warm)
   * 8. Update player physics
   * 9. Collect loose ore/stone near player (respects max inventory size)
   */
  async step(input: {
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
  }, currentInventory: InventoryEntry[] = []): Promise<InventoryEntry[]> {
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
      // After rebuild, build skip mask from scratch (the grid content changed).
      // updateFreezeState will run after the sand step to update it for next tick.
      this.buildSkipMaskOnly();
      // Re-scan lights immediately after rebuild — the active grid origin
      // shifted, so the old light list has stale world coords that don't
      // match the new origin. Without this, lights are wrong for up to
      // LIGHT_SCAN_INTERVAL ticks after every chunk border crossing.
      this.scanEmittingLights();
    }

    // 2. Skip mask is already set from last tick's updateFreezeState (or from
    //    buildSkipMaskOnly above if we just rebuilt). No need to rebuild every tick.

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
    if (this.sandStepPool) {
      // Multi-threaded: dispatch to sand-step workers + boundary cleanup.
      // The pool shares the SAB-backed grid with workers. The async step
      // resolves when all workers finish + boundary cleanup is done.
      await this.sandStepPool.step(this.activeGrid.frame);
      // Increment the frame counter (normally done by SandWorld.step()).
      this.activeGrid.frame++;
    } else {
      this.activeGrid.step();
    }

    // 5. Update freeze state (combined expireWakeTicks + buildSkipMask).
    //    Expires wakeTicks for settled cells, extends for moving particles,
    //    re-activates frozen cells that particles moved into, and builds the
    //    skip mask for the next tick's sand step — all in one pass.
    this.updateFreezeState();

    // 6. Structural integrity check (slow cadence) — demolish solid cells
    //    disconnected from the active-grid border (floating islands). Runs
    //    before the sync so demolished cells are persisted to chunks this
    //    tick; the new loose particles fall on subsequent ticks (they were
    //    markCellUnfrozen'd so their chunks stay active).
    this.runStructuralIntegrityCheck();

    // 7. Sync back to chunks (only dirty chunks — most are clean)
    this.syncActiveGridToChunks();

    // 7b. Douse torches touched by liquids (throttled). Runs AFTER the sync
    //     and after the sand step + updateFreezeState so the hot path
    //     (step → updateFreezeState → next step) keeps the grid warm in cache.
    //     The torch index makes this O(torch_count) instead of O(N).
    if (this.currentTick % TORCH_DOUSE_INTERVAL === 0) {
      this.douseTorches();
    }

    // 8. Update player (in active grid local coords)
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    updateMiningPlayer(this.player, input, this.activeGrid.grid, this.backgroundGrid, ACTIVE_GRID_W, ACTIVE_GRID_H, pax, pay);
    this.player.x = this.player.x + this.activeOriginCx * CHUNK_W;
    this.player.y = this.player.y + this.activeOriginCy * CHUNK_H;

    // 9. Collect loose ore/stone near player (respects max inventory size)
    const collected = this.collect(currentInventory);

    // 9. Fog-of-war: mark cells around the player as explored
    this.markExploredAroundPlayer();

    // 10. Colored lighting: scan for emitting cells (throttled)
    if (this.currentTick % LIGHT_SCAN_INTERVAL === 0) {
      this.scanEmittingLights();
    }

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

  // --- Fog-of-war ---

  /**
   * Mark cells within REVEAL_RADIUS of the player as explored in the active
   * explored grid. Uses a filled-circle stamp. Called every tick from step().
   * Also marks the player's chunk dirty so the explored changes are persisted
   * to chunk storage on the next sync.
   */
  markExploredAroundPlayer(): void {
    const { x: axF, y: ayF } = this.worldToActive(this.player.x, this.player.y);
    const cx = Math.floor(axF);
    const cy = Math.floor(ayF);
    const r = REVEAL_RADIUS;
    const r2 = r * r;
    const explored = this.exploredGrid;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= ACTIVE_GRID_H) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx;
        if (x < 0 || x >= ACTIVE_GRID_W) continue;
        // Use 255 so r8unorm normalizes to 1.0 (explored = fully transparent)
        explored[y * ACTIVE_GRID_W + x] = 255;
      }
    }
    // Mark the player's chunk dirty so explored changes are persisted.
    // Without this, dirty-chunk-sync would skip the player's chunk when
    // nothing else changed (no mining, no particle movement), and the
    // explored grid wouldn't be saved until a chunk boundary crossing.
    const pcx = this.activeOriginCx + Math.floor(cx / CHUNK_W);
    const pcy = this.activeOriginCy + Math.floor(cy / CHUNK_H);
    if (pcx >= 0 && pcx < MAX_CHUNKS_X) {
      const chunk = this.chunks.get(chunkKey(pcx, pcy));
      if (chunk) chunk.dirty = true;
    }
  }

  /** Get the active explored grid (for SAB upload by the worker). */
  getExploredGrid(): Uint8Array {
    return this.exploredGrid;
  }

  // --- Colored lighting ---

  /**
   * Scan the active grid for emitting materials (lava, fire, torches, etc.)
   * on a sparse grid (every LIGHT_GRID_STRIDE cells). Torch lights are read
   * from the torch index (O(torch_count)) instead of a full background grid
   * scan. Cluster hits and pack into the light list, prioritizing lights
   * nearest to the player. Called every LIGHT_SCAN_INTERVAL ticks from step().
   */
  scanEmittingLights(): void {
    const grid = this.activeGrid.grid;
    const { x: paxF, y: payF } = this.worldToActive(this.player.x, this.player.y);
    const px = Math.floor(paxF);
    const py = Math.floor(payF);
    const stride = LIGHT_GRID_STRIDE;
    const lights = this.lightList;
    let count = 0;

    // Sparse scan: sample every stride cells in both dimensions for foreground
    // emitting materials (lava, fire). Torch check uses a finer stride since
    // torches are placed individually and can be at any position.
    for (let y = 0; y < ACTIVE_GRID_H && count < MAX_WORLD_LIGHTS; y += stride) {
      for (let x = 0; x < ACTIVE_GRID_W && count < MAX_WORLD_LIGHTS; x += stride) {
        const idx = y * ACTIVE_GRID_W + x;
        // Check foreground grid for emitting materials
        const packed = grid[idx];
        if (packed !== 0) {
          const mat = packed & 0xff;
          const light = materialLight(mat);
          if (light) {
            const off = count * LIGHT_STRUCT_FLOATS;
            // World coords = active grid local + origin
            lights[off] = x + this.activeOriginCx * CHUNK_W;
            lights[off + 1] = y + this.activeOriginCy * CHUNK_H;
            lights[off + 2] = light.color[0];
            lights[off + 3] = light.color[1];
            lights[off + 4] = light.color[2];
            lights[off + 5] = light.intensity;
            lights[off + 6] = light.radius;
            lights[off + 7] = 0;
            count++;
          }
        }
      }
    }

    // Torch lights from the torch index (O(torch_count) instead of a full
    // O(ACTIVE_GRID_CELLS) background grid scan). Torches are placed
    // individually at any position, so the sparse stride above would miss
    // most of them — the index tracks exact positions.
    for (const idx of this.torchCells) {
      if (count >= MAX_WORLD_LIGHTS) break;
      const x = idx % ACTIVE_GRID_W;
      const y = (idx / ACTIVE_GRID_W) | 0;
      const off = count * LIGHT_STRUCT_FLOATS;
      lights[off] = x + this.activeOriginCx * CHUNK_W;
      lights[off + 1] = y + this.activeOriginCy * CHUNK_H;
      lights[off + 2] = TORCH_LIGHT_COLOR[0];
      lights[off + 3] = TORCH_LIGHT_COLOR[1];
      lights[off + 4] = TORCH_LIGHT_COLOR[2];
      lights[off + 5] = TORCH_LIGHT_INTENSITY;
      lights[off + 6] = TORCH_LIGHT_RADIUS;
      lights[off + 7] = 0;
      count++;
    }

    // Sort by distance to player (nearest first) — simple selection sort
    // on the first `count` lights, keeping only the nearest MAX_WORLD_LIGHTS.
    // Since count <= MAX_WORLD_LIGHTS already, we just sort in-place.
    for (let i = 0; i < count - 1; i++) {
      let minIdx = i;
      let minDist = Infinity;
      for (let j = i; j < count; j++) {
        const lx = lights[j * LIGHT_STRUCT_FLOATS];
        const ly = lights[j * LIGHT_STRUCT_FLOATS + 1];
        const ddx = lx - px;
        const ddy = ly - py;
        const d = ddx * ddx + ddy * ddy;
        if (d < minDist) { minDist = d; minIdx = j; }
      }
      if (minIdx !== i) {
        // Swap 8 floats
        const ia = i * LIGHT_STRUCT_FLOATS;
        const ib = minIdx * LIGHT_STRUCT_FLOATS;
        for (let k = 0; k < LIGHT_STRUCT_FLOATS; k++) {
          const tmp = lights[ia + k];
          lights[ia + k] = lights[ib + k];
          lights[ib + k] = tmp;
        }
      }
    }

    this.lightCount = count;
  }

  /** Get the packed light list (for SAB upload by the worker). */
  getLightList(): Float32Array {
    return this.lightList;
  }
  getLightCount(): number {
    return this.lightCount;
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
      // Save chunks that are dirty (terrain modified) OR have any explored
      // cells (fog-of-war progress). The explored check ensures the player's
      // exploration is persisted even in chunks with no terrain changes.
      if (chunk.dirty || chunkHasExplored(chunk.explored)) {
        result.push({
          cx: chunk.cx,
          cy: chunk.cy,
          grid: chunk.grid.slice(),
          fields: chunk.fields.slice(),
          bgGrid: chunk.bgGrid.slice(),
          explored: chunk.explored.slice(),
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
      explored: saved.explored?.slice() ?? new Uint8Array(CHUNK_W * CHUNK_H),
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
    this.terrainDirtyForIntegrity = true;
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const bgGrid = this.backgroundGrid;
    const explored = this.exploredGrid;
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
    // Also mark cells as explored (explosions reveal terrain).
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= ACTIVE_GRID_W || gy < 0 || gy >= ACTIVE_GRID_H) continue;
        const idx = gy * ACTIVE_GRID_W + gx;

        // --- Reveal fog-of-war in blast radius ---
        explored[idx] = 255;

        // --- Clear background build materials in blast radius ---
        if (bgGrid[idx] !== 0) {
          if ((bgGrid[idx] & 0xff) === Material.Torch) this.torchCells.delete(idx);
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

    // Damage the player if within blast radius. player.x is the horizontal
    // CENTER of the AABB (see mining-player.ts), player.y is the TOP.
    const { x: pax, y: pay } = this.worldToActive(this.player.x, this.player.y);
    const pcx = pax;
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
  explored: Uint8Array;
  wakeTick: Uint32Array;
}

/** Check if a chunk's explored array has any explored cells (for save filtering). */
function chunkHasExplored(explored: Uint8Array): boolean {
  for (let i = 0; i < explored.length; i++) {
    if (explored[i] !== 0) return true;
  }
  return false;
}
