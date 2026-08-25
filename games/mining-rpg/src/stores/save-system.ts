// ============================================================================
// Mining RPG save system — thin adapter over @downdraft/library-persistence
// OpfsSaveStore. The engine handles OPFS storage, compression, hashing, and
// generation history; this module only maps the game's save shape (player +
// inventory + dirty chunks) to SaveState components + blobs.
//
// Only **dirty** chunks are persisted (unmodified chunks regenerate from
// seed). Autosave runs every 3 seconds (skipped in deterministic mode).
//
// OPFS is used (not IndexedDB) because chunk voxel data is large binary blobs;
// OPFS lets us write them directly to disk without the structured-clone
// serialization cost that IndexedDB imposes on ArrayBuffer values, which
// matters for games with much larger worlds.
// ============================================================================

import { createSaveStore, downdraft } from "@downdraft/app/renderer";
import type { ISaveStore, SaveState } from "@downdraft/core";
import { AutosaveManager } from "@downdraft/library-persistence/browser";
import { WORLD_SEED } from "../shared/constants";
import type { BuildMaterials, CraftedItems, InventoryEntry, MiningPlayerState, PlayerStats, PlayerUpgrades, SavedGlowstick } from "../shared/types";
import { createCraftedItems, createPlayerStats } from "../shared/types";
import type { SavedChunk } from "../simulation/chunk-world";

const SAVE_SLOT = "world";
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

let storePromise: Promise<ISaveStore> | null = null;

function getStore(): Promise<ISaveStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const store = await createSaveStore({
        mode: "auto",
        opfsOptions: { engineVersion: ENGINE_VERSION },
        bridge: downdraft,
      });
      if (!store) {
        const { OpfsSaveStore } = await import("@downdraft/library-persistence/browser");
        const fallback = new OpfsSaveStore({ engineVersion: ENGINE_VERSION });
        await fallback.init();
        return fallback;
      }
      return store;
    })();
  }
  return storePromise;
}

function chunksToBlobs(chunks: SavedChunk[]): Record<string, ArrayBuffer> {
  const blobs: Record<string, ArrayBuffer> = {};
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

function blobsToChunks(blobs: Record<string, ArrayBuffer>, coords: { cx: number; cy: number }[]): SavedChunk[] {
  const chunks: SavedChunk[] = [];
  for (let i = 0; i < coords.length; i++) {
    const grid = blobs[`chunk${i}_grid`];
    const fields = blobs[`chunk${i}_fields`];
    const bgGrid = blobs[`chunk${i}_bgGrid`];
    const explored = blobs[`chunk${i}_explored`];
    const wakeTick = blobs[`chunk${i}_wakeTick`];
    if (!grid || !fields || !bgGrid || !wakeTick) continue;
    chunks.push({
      cx: coords[i].cx,
      cy: coords[i].cy,
      grid: new Uint32Array(grid),
      fields: new Uint8Array(fields),
      bgGrid: new Uint32Array(bgGrid),
      explored: explored ? new Uint8Array(explored) : new Uint8Array(128 * 128),
      wakeTick: new Uint32Array(wakeTick),
    });
  }
  return chunks;
}

function buildState(data: SaveData): SaveState {
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

/** Save the world state via the engine OpfsSaveStore. */
export async function saveWorld(data: SaveData): Promise<void> {
  const store = await getStore();
  await store.save(SAVE_SLOT, buildState(data), { blobs: chunksToBlobs(data.chunks) });
}

/** Load the world state. Returns null if no save exists. */
export async function loadWorld(): Promise<SaveData | null> {
  const store = await getStore();
  const result = await store.load(SAVE_SLOT);
  if (!result.state) return null;
  const meta = result.state.components.meta?.data as { version: number; seed: number; savedAt: number; zoom?: number } | undefined;
  const player = result.state.components.player?.data as {
    player: MiningPlayerState; upgrades?: PlayerUpgrades; inventory?: InventoryEntry[];
    currency?: number; buildMaterials?: BuildMaterials; stats?: PlayerStats;
    unlockedAchievements?: string[]; craftedItems?: CraftedItems;
  } | undefined;
  const chunksComp = result.state.components.chunks?.data as { count: number; coords: { cx: number; cy: number }[] } | undefined;
  const glowsticksComp = result.state.components.glowsticks?.data as { list: SavedGlowstick[] } | undefined;
  if (!meta || !player) return null;
  const chunks = chunksComp && result.blobs ? blobsToChunks(result.blobs, chunksComp.coords) : [];
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

/** Delete the save data (new game / reset). */
export async function deleteSave(): Promise<void> {
  const store = await getStore();
  await store.deleteSave(SAVE_SLOT);
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
// (already imported above — just re-export the binding)
export { AutosaveManager };
