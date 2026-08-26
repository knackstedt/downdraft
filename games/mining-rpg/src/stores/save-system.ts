// ============================================================================
// Mining RPG save system — thin adapter over the engine's createGridSaveSystem.
//
// The engine handles OPFS storage, compression, hashing, and generation
// history; this module only maps the game's save shape (player + inventory +
// dirty chunks) to SaveState components + blobs.
//
// Only **dirty** chunks are persisted (unmodified chunks regenerate from
// seed). Autosave runs every 3 seconds (skipped in deterministic mode).
// ============================================================================

import { createDefaultSaveStore } from "@downdraft/app/renderer";
import { createGridSaveSystem, type SaveState } from "@downdraft/core";
import { AutosaveManager } from "@downdraft/library-persistence/browser";
import { WORLD_SEED } from "../shared/constants";
import type { BuildMaterials, CraftedItems, InventoryEntry, MiningPlayerState, PlayerStats, PlayerUpgrades, SavedGlowstick } from "../shared/types";
import { createCraftedItems, createPlayerStats } from "../shared/types";
import type { SavedChunk } from "../simulation/chunk-world";

const ENGINE_VERSION = "0.1.0";
const AUTOSAVE_INTERVAL_MS = 3000;

export interface SaveData {
  version: number;
  seed: number;
  player: MiningPlayerState;
  upgrades: PlayerUpgrades;
  inventory: InventoryEntry[];
  currency: number;
  buildMaterials: BuildMaterials;
  chunks: SavedChunk[];
  // Glowsticks (thrown light sources, 1 hour real-time lifetime). Optional
  // for backward compat with saves made before glowsticks were persisted.
  glowsticks?: SavedGlowstick[];
  // Camera zoom level at save time (optional for backward compat with saves
  // made before zoom was persisted). Restored by the renderer on load.
  zoom?: number;
  // Cumulative player statistics (optional for backward compat with saves
  // made before stats tracking was added). Restored to the game store on load.
  stats?: PlayerStats;
  // Unlocked achievement IDs (optional for backward compat). Stored as a
  // string array in the save (Set is not JSON-serializable).
  unlockedAchievements?: string[];
  // Crafted items (bars) — virtual inventory items not in the grid.
  // Optional for backward compat with saves made before crafting was added.
  craftedItems?: CraftedItems;
  savedAt: number;
}

interface MiningMeta {
  data: SaveData;
}

function buildState(meta: MiningMeta): SaveState {
  const data = meta.data;
  return {
    components: {
      meta: { v: 1, data: { version: data.version, seed: data.seed, savedAt: data.savedAt, zoom: data.zoom } },
      player: {
        v: 1,
        data: {
          player: data.player,
          upgrades: data.upgrades,
          inventory: data.inventory,
          currency: data.currency,
          buildMaterials: data.buildMaterials,
          stats: data.stats,
          unlockedAchievements: data.unlockedAchievements,
          craftedItems: data.craftedItems,
        },
      },
      chunks: { v: 1, data: { count: data.chunks.length, coords: data.chunks.map((c) => ({ cx: c.cx, cy: c.cy })) } },
      glowsticks: { v: 1, data: { list: data.glowsticks ?? [] } },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: data.chunks.length,
      playerCount: 1,
    },
  };
}

function buildBlobs(meta: MiningMeta): Record<string, ArrayBuffer> {
  const blobs: Record<string, ArrayBuffer> = {};
  const chunks = meta.data.chunks;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    blobs[`chunk${i}_grid`] = c.grid.buffer.slice(c.grid.byteOffset, c.grid.byteOffset + c.grid.byteLength) as ArrayBuffer;
    blobs[`chunk${i}_fields`] = c.fields.buffer.slice(c.fields.byteOffset, c.fields.byteOffset + c.fields.byteLength) as ArrayBuffer;
    blobs[`chunk${i}_bgGrid`] = c.bgGrid.buffer.slice(c.bgGrid.byteOffset, c.bgGrid.byteOffset + c.bgGrid.byteLength) as ArrayBuffer;
    blobs[`chunk${i}_explored`] = c.explored.buffer.slice(c.explored.byteOffset, c.explored.byteOffset + c.explored.byteLength) as ArrayBuffer;
    blobs[`chunk${i}_wakeTick`] = c.wakeTick.buffer.slice(c.wakeTick.byteOffset, c.wakeTick.byteOffset + c.wakeTick.byteLength) as ArrayBuffer;
  }
  return blobs;
}

function parseEntry(state: SaveState, blobs: Record<string, ArrayBuffer> | null): SaveData | null {
  const meta = state.components.meta?.data as { version: number; seed: number; savedAt: number; zoom?: number } | undefined;
  const player = state.components.player?.data as {
    player: MiningPlayerState; upgrades?: PlayerUpgrades; inventory?: InventoryEntry[];
    currency?: number; buildMaterials?: BuildMaterials; stats?: PlayerStats;
    unlockedAchievements?: string[]; craftedItems?: CraftedItems;
  } | undefined;
  const chunksComp = state.components.chunks?.data as { count: number; coords: { cx: number; cy: number }[] } | undefined;
  const glowsticksComp = state.components.glowsticks?.data as { list: SavedGlowstick[] } | undefined;
  if (!meta || !player) return null;
  const chunks: SavedChunk[] = [];
  if (chunksComp && blobs) {
    for (let i = 0; i < chunksComp.coords.length; i++) {
      const grid = blobs[`chunk${i}_grid`];
      const fields = blobs[`chunk${i}_fields`];
      const bgGrid = blobs[`chunk${i}_bgGrid`];
      const explored = blobs[`chunk${i}_explored`];
      const wakeTick = blobs[`chunk${i}_wakeTick`];
      if (!grid || !fields || !bgGrid || !wakeTick) continue;
      chunks.push({
        cx: chunksComp.coords[i].cx,
        cy: chunksComp.coords[i].cy,
        grid: new Uint32Array(grid),
        fields: new Uint8Array(fields),
        bgGrid: new Uint32Array(bgGrid),
        explored: explored ? new Uint8Array(explored) : new Uint8Array(128 * 128),
        wakeTick: new Uint32Array(wakeTick),
      });
    }
  }
  return {
    version: meta.version,
    seed: meta.seed ?? WORLD_SEED,
    player: player.player,
    upgrades: player.upgrades ?? { damage: 0, radius: 0, rate: 0, inventorySize: 0 },
    inventory: player.inventory ?? [],
    currency: player.currency ?? 0,
    buildMaterials: player.buildMaterials ?? { scaffolding: 0, ladder: 0, rope: 0, torch: 0 },
    chunks,
    glowsticks: glowsticksComp?.list ?? [],
    zoom: meta.zoom,
    stats: player.stats ?? createPlayerStats(),
    unlockedAchievements: player.unlockedAchievements ?? [],
    craftedItems: player.craftedItems ?? createCraftedItems(),
    savedAt: meta.savedAt ?? 0,
  };
}

const system = createGridSaveSystem<MiningMeta, SaveData>({
  createStore: () => createDefaultSaveStore(ENGINE_VERSION),
  autosaveSlot: "world",
  buildState,
  buildBlobs,
  parseEntry,
});

/** Save the world state via the engine save store. */
export async function saveWorld(data: SaveData): Promise<void> {
  await system.autosave({ data });
}

/** Load the world state. Returns null if no save exists. */
export async function loadWorld(): Promise<SaveData | null> {
  return system.loadAutosave();
}

/** Delete the save data (new game / reset). */
export async function deleteSave(): Promise<void> {
  await system.deleteSave("world");
}

/**
 * AutosaveManager — re-exported from @downdraft/library-persistence.
 *
 * The engine AutosaveManager is generic (works with any save function).
 * This factory wraps it with the mining-rpg-specific saveWorld() call.
 */
export function createAutosaveManager(
  getSaveData: () => Promise<SaveData> | SaveData,
  deterministic: boolean = false,
): AutosaveManager {
  return new AutosaveManager({
    save: async () => {
      const data = await getSaveData();
      await saveWorld(data);
    },
    intervalMs: AUTOSAVE_INTERVAL_MS,
    deterministic,
  });
}

// Re-export the engine AutosaveManager for backward compatibility
export { AutosaveManager };
