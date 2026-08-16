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
    PLAYER_H,
    PLAYER_W,
    RADIUS_UPGRADE_INCREMENT,
    RATE_UPGRADE_REDUCTION,
    STONE_HARDNESS,
    WORLD_SEED,
} from "../shared/constants";
import type { Chunk, ChunkCoord, InventoryEntry, MiningPlayerState, PlayerUpgrades } from "../shared/types";
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
  // World config
  readonly seed: number;

  constructor() {
    this.seed = WORLD_SEED;
    this.activeGrid = new SandWorld(ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.skipMask = new Uint8Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
    this.cellDamage = new Float32Array(ACTIVE_GRID_W * ACTIVE_GRID_H);
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

    // Copy out the old active grid back to chunk storage using the PREVIOUS
    // origin — the grid data is still laid out for the old origin.
    this.syncActiveGridToChunks(this.prevOriginCx, this.prevOriginCy);

    // Clear the active grid
    grid.fill(0);
    fields.fill(DEFAULT_TEMP);
    this.cellDamage.fill(0);
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

    // March the ray until we hit a solid mineable cell or reach max range
    let hitX = -1, hitY = -1;
    const maxRange = MAX_MINE_RANGE;
    for (let step = 0; step < maxRange; step++) {
      const cx = Math.floor(px + dx * step);
      const cy = Math.floor(py + dy * step);
      if (cx < 0 || cx >= ACTIVE_GRID_W || cy < 0 || cy >= ACTIVE_GRID_H) break;
      const idx = cy * ACTIVE_GRID_W + cx;
      const packed = grid[idx];
      if (packed === 0) continue; // empty — ray passes through
      const mat = packed & 0xff;
      if (mat === Material.Wall) break; // wall blocks the ray
      const def = MATERIALS[mat];
      if (!def?.solid) continue; // liquid/gas — ray passes through
      // Hit a solid mineable cell
      hitX = cx;
      hitY = cy;
      break;
    }

    if (hitX < 0) return []; // nothing hit

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
        if (!def?.solid) continue; // don't damage liquids/gases

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
                    // Static solid (stone) loosened by cascade → Gravel/LooseStone
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
              // Cell is frozen at this position. But if a detached (loose)
              // particle has fallen here via physics, its wakeTick was set at
              // its previous position and NOT transferred to this one. Detect
              // this case: if the grid cell has FLAG_DETACHED set, it's a loose
              // particle that needs its wakeTick re-activated here so it stays
              // collectible.
              const ax = offsetX + lx;
              const ay = offsetY + ly;
              const packed = grid[ay * ACTIVE_GRID_W + ax];
              if (packed !== 0 && ((packed >> 16) & FLAG_DETACHED) !== 0) {
                wakeTick[localIdx] = this.currentTick + FREEZE_TICKS;
                chunk.dirty = true;
                hasUnfrozen = true;
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
    mouseDown: boolean;
    mouseX: number;
    mouseY: number;
    digRadius: number;
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

    // 3. Handle mining (before sim so mined particles can fall this tick)
    if (input.mouseDown) {
      this.mine(input.mouseX, input.mouseY);
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
   * Liquids and gases are cleared too; walls are immune.
   */
  explode(worldX: number, worldY: number, radius: number): void {
    const grid = this.activeGrid.grid;
    const fields = this.activeGrid.fields;
    const { x: ax, y: ay } = this.worldToActive(worldX, worldY);
    const cx = Math.floor(ax);
    const cy = Math.floor(ay);
    const r = Math.floor(radius);

    // Dislodge cells in a circle (like mining, not destruction):
    // - Stone → converted to Dirt (loose, collectible, falls with gravity)
    // - Ore → re-enable gravity (loosened, collectible)
    // - Dirt/Grass/other solids → cleared to create a hole
    // - Liquids/gases → cleared
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= ACTIVE_GRID_W || gy < 0 || gy >= ACTIVE_GRID_H) continue;
        const idx = gy * ACTIVE_GRID_W + gx;
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
        } else {
          // Dirt/Grass/other: clear to create a hole
          grid[idx] = 0;
          fields[fi + FIELD.GRAVITY] = 0;
          this.cellDamage[idx] = 0;
          this.clearWakeTick(gx, gy);
        }
      }
    }

    // Loosen cells around the blast perimeter so terrain cascades
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
        if (!def?.solid) continue;
        // Re-enable gravity so the loosened cell falls
        const fi = idx * 4;
        if (fields[fi + FIELD.GRAVITY] === 0) {
          fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
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
