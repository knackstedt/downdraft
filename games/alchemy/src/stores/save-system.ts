// ============================================================================
// Alchemy save system — thin adapter over @downdraft/library-persistence
// OpfsSaveStore. The engine handles OPFS storage, compression, hashing, and
// generation history; this module only maps the game's save shape to SaveState
// components + binary blobs.
//
// OPFS is used (not IndexedDB) because the grid/field arrays are large binary
// blobs; OPFS writes them directly to disk without the structured-clone
// serialization cost that IndexedDB imposes on ArrayBuffer values.
// ============================================================================

import { createSaveStore, downdraft } from "@downdraft/app/renderer";
import type { ISaveStore, SaveState } from "@downdraft/core";

export interface SaveEntry {
  id: string;
  name: string;
  timestamp: number;
  thumbnail: Blob;
  gridW: number;
  gridH: number;
  grid: Uint32Array;
  fields: Uint8Array;
  // Meta-state
  money: number;
  ingredientInventory: { mat: number; count: number }[];
  potions: any[];
  unlockedTiers: number[];
  discoveredRecipes: string[];
}

export interface SaveMetadata {
  id: string;
  name: string;
  timestamp: number;
  thumbnailUrl: string;
  gridW: number;
  gridH: number;
}

const AUTOSAVE_SLOT = "autosave";
const ENGINE_VERSION = "0.1.0";

interface AlchemyMeta {
  money: number;
  ingredientInventory: { mat: number; count: number }[];
  potions: any[];
  unlockedTiers: number[];
  discoveredRecipes: string[];
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
      // Fall back to inline OpfsSaveStore if createSaveStore returned null
      // (e.g. "inline" mode). For "auto" mode this shouldn't happen, but
      // guard against it.
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

function buildState(gridW: number, gridH: number, meta: AlchemyMeta): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW, gridH } },
      progress: { v: 1, data: meta },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: 0,
      playerCount: 1,
    },
  };
}

export async function saveGame(
  name: string,
  thumbnail: ArrayBuffer,
  gridW: number,
  gridH: number,
  grid: Uint32Array,
  fields: Uint8Array,
  meta: AlchemyMeta,
): Promise<SaveEntry> {
  const store = await getStore();
  const id = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = buildState(gridW, gridH, meta);
  await store.save(id, state, {
    thumbnail: new Uint8Array(thumbnail),
    properties: { name, savedAt: Date.now() },
    blobs: {
      grid: grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength) as ArrayBuffer,
      fields: fields.buffer.slice(fields.byteOffset, fields.byteOffset + fields.byteLength) as ArrayBuffer,
    },
  });
  return {
    id, name, timestamp: Date.now(), thumbnail: new Blob([thumbnail], { type: "image/jpeg" }),
    gridW, gridH, grid: new Uint32Array(grid), fields: new Uint8Array(fields),
    money: meta.money, ingredientInventory: meta.ingredientInventory,
    potions: meta.potions, unlockedTiers: meta.unlockedTiers,
    discoveredRecipes: meta.discoveredRecipes,
  };
}

export async function loadGame(id: string): Promise<SaveEntry | null> {
  const store = await getStore();
  const result = await store.load(id);
  if (!result.state) return null;
  const world = result.state.components.world?.data as { gridW: number; gridH: number } | undefined;
  const progress = result.state.components.progress?.data as AlchemyMeta | undefined;
  if (!world || !progress || !result.blobs) return null;
  const grid = new Uint32Array(result.blobs.grid);
  const fields = new Uint8Array(result.blobs.fields);
  const thumbBuf = await store.getThumbnail(id);
  const thumbnail = thumbBuf ? new Blob([thumbBuf], { type: "image/jpeg" }) : new Blob([], { type: "image/jpeg" });
  const props = await store.getProperties(id);
  return {
    id, name: (props.name as string) ?? "Save",
    timestamp: (props.savedAt as number) ?? result.state.meta.timestamp * 1000,
    thumbnail, gridW: world.gridW, gridH: world.gridH, grid, fields,
    money: progress.money, ingredientInventory: progress.ingredientInventory,
    potions: progress.potions, unlockedTiers: progress.unlockedTiers,
    discoveredRecipes: progress.discoveredRecipes,
  };
}

export async function listSaves(): Promise<SaveMetadata[]> {
  const store = await getStore();
  const slots = await store.listSaves();
  const metas = await Promise.all(
    slots
      .filter((s) => s.slot !== AUTOSAVE_SLOT)
      .map(async (s) => {
        const thumbBuf = await store.getThumbnail(s.slot);
        const thumbnailUrl = thumbBuf ? URL.createObjectURL(new Blob([thumbBuf], { type: "image/jpeg" })) : "";
        // gridW/gridH are stored in the world component; load is overkill for
        // listing, so we read properties if present, else 0.
        const props = await store.getProperties(s.slot);
        return {
          id: s.slot,
          name: (props.name as string) ?? "Save",
          timestamp: (props.savedAt as number) ?? s.timestamp * 1000,
          thumbnailUrl,
          gridW: (props.gridW as number) ?? 0,
          gridH: (props.gridH as number) ?? 0,
        } satisfies SaveMetadata;
      }),
  );
  return metas;
}

export async function deleteSave(id: string): Promise<void> {
  const store = await getStore();
  await store.deleteSave(id);
}

export async function autosave(
  gridW: number,
  gridH: number,
  grid: Uint32Array,
  fields: Uint8Array,
  meta: AlchemyMeta,
): Promise<void> {
  const store = await getStore();
  const state = buildState(gridW, gridH, meta);
  await store.save(AUTOSAVE_SLOT, state, {
    properties: { name: "Autosave", savedAt: Date.now() },
    blobs: {
      grid: grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength) as ArrayBuffer,
      fields: fields.buffer.slice(fields.byteOffset, fields.byteOffset + fields.byteLength) as ArrayBuffer,
    },
  });
}

export async function loadAutosave(): Promise<SaveEntry | null> {
  return loadGame(AUTOSAVE_SLOT);
}
