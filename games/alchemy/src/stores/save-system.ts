// ============================================================================
// Alchemy save system — thin adapter over the engine's createGridSaveSystem.
//
// The factory (from @downdraft/core) owns the ISaveStore singleton, save/load/
// list/delete/autosave/loadAutosave CRUD, and thumbnail handling. This module
// only defines the alchemy-specific save shape (meta + blobs) and the
// parseEntry callback that reconstructs a SaveEntry from a loaded SaveState.
// ============================================================================

import { createDefaultSaveStore } from "@downdraft/app/renderer";
import { createGridSaveSystem, type SaveState } from "@downdraft/core";

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

const ENGINE_VERSION = "0.1.0";

export interface AlchemyMeta {
  gridW: number;
  gridH: number;
  grid: Uint32Array;
  fields: Uint8Array;
  money: number;
  ingredientInventory: { mat: number; count: number }[];
  potions: any[];
  unlockedTiers: number[];
  discoveredRecipes: string[];
}

function buildState(meta: AlchemyMeta): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW: meta.gridW, gridH: meta.gridH } },
      progress: { v: 1, data: { money: meta.money, ingredientInventory: meta.ingredientInventory, potions: meta.potions, unlockedTiers: meta.unlockedTiers, discoveredRecipes: meta.discoveredRecipes } },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: 0,
      playerCount: 1,
    },
  };
}

function buildBlobs(meta: AlchemyMeta): Record<string, ArrayBuffer> {
  return {
    grid: meta.grid.buffer.slice(meta.grid.byteOffset, meta.grid.byteOffset + meta.grid.byteLength) as ArrayBuffer,
    fields: meta.fields.buffer.slice(meta.fields.byteOffset, meta.fields.byteOffset + meta.fields.byteLength) as ArrayBuffer,
  };
}

function parseEntry(state: SaveState, blobs: Record<string, ArrayBuffer> | null): SaveEntry | null {
  const world = state.components.world?.data as { gridW: number; gridH: number } | undefined;
  const progress = state.components.progress?.data as Omit<AlchemyMeta, "gridW" | "gridH" | "grid" | "fields"> | undefined;
  if (!world || !progress || !blobs) return null;
  const grid = new Uint32Array(blobs.grid);
  const fields = new Uint8Array(blobs.fields);
  return {
    id: "", name: "Save", timestamp: state.meta.timestamp * 1000,
    thumbnail: new Blob([], { type: "image/jpeg" }),
    gridW: world.gridW, gridH: world.gridH, grid, fields,
    money: progress.money, ingredientInventory: progress.ingredientInventory,
    potions: progress.potions, unlockedTiers: progress.unlockedTiers,
    discoveredRecipes: progress.discoveredRecipes,
  };
}

function extractListMeta(state: SaveState): Record<string, unknown> {
  const world = state.components.world?.data as { gridW: number; gridH: number } | undefined;
  return { gridW: world?.gridW ?? 0, gridH: world?.gridH ?? 0 };
}

const system = createGridSaveSystem<AlchemyMeta, SaveEntry>({
  createStore: () => createDefaultSaveStore(ENGINE_VERSION),
  autosaveSlot: "autosave",
  buildState,
  buildBlobs,
  parseEntry,
  extractListMeta,
});

export async function saveGame(
  name: string,
  thumbnail: ArrayBuffer,
  meta: AlchemyMeta,
): Promise<SaveEntry> {
  const { id, timestamp } = await system.saveGame(name, thumbnail, meta);
  return {
    id, name, timestamp,
    thumbnail: new Blob([thumbnail], { type: "image/jpeg" }),
    gridW: meta.gridW, gridH: meta.gridH,
    grid: new Uint32Array(meta.grid), fields: new Uint8Array(meta.fields),
    money: meta.money, ingredientInventory: meta.ingredientInventory,
    potions: meta.potions, unlockedTiers: meta.unlockedTiers,
    discoveredRecipes: meta.discoveredRecipes,
  };
}

export async function loadGame(id: string): Promise<SaveEntry | null> {
  const entry = await system.loadGame(id);
  if (!entry) return null;
  // Enrich with thumbnail + properties from the store
  const store = await system.getStore();
  const thumbBuf = await store.getThumbnail(id);
  const props = await store.getProperties(id);
  entry.id = id;
  entry.thumbnail = thumbBuf ? new Blob([thumbBuf], { type: "image/jpeg" }) : new Blob([], { type: "image/jpeg" });
  entry.name = (props.name as string) ?? "Save";
  entry.timestamp = (props.savedAt as number) ?? entry.timestamp;
  return entry;
}

export async function listSaves(): Promise<SaveMetadata[]> {
  const entries = await system.listSaves();
  return entries as unknown as SaveMetadata[];
}

export async function deleteSave(id: string): Promise<void> {
  await system.deleteSave(id);
}

export async function autosave(meta: AlchemyMeta): Promise<void> {
  await system.autosave(meta);
}

export async function loadAutosave(): Promise<SaveEntry | null> {
  return loadGame("autosave");
}
