// ============================================================================
// Falling-sand save system — thin adapter over the engine's createGridSaveSystem.
//
// The factory owns the ISaveStore singleton + CRUD. This module defines the
// falling-sand save shape (multi-layer grids + fields) and the blob
// mappers that convert between typed arrays and ArrayBuffers.
// ============================================================================

import { createDefaultSaveStore } from "@downdraft/app/renderer";
import { createGridSaveSystem, type SaveState } from "@downdraft/core";

export interface SaveEntry {
  id: string;
  name: string;
  timestamp: number;
  thumbnail: Blob;       // JPEG screenshot
  gridW: number;
  gridH: number;
  numLayers: number;
  grids: Uint32Array[];  // one per layer
  fields: Uint8Array[];  // one per layer
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

export interface FallingSandMeta {
  gridW: number;
  gridH: number;
  grids: Uint32Array[];
  fields: Uint8Array[];
}

function buildState(meta: FallingSandMeta): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW: meta.gridW, gridH: meta.gridH, numLayers: meta.grids.length } },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: 0,
      playerCount: 1,
    },
  };
}

function buildBlobs(meta: FallingSandMeta): Record<string, ArrayBuffer> {
  const blobs: Record<string, ArrayBuffer> = {};
  for (let i = 0; i < meta.grids.length; i++) {
    const g = meta.grids[i];
    blobs[`grid${i}`] = g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength) as ArrayBuffer;
  }
  for (let i = 0; i < meta.fields.length; i++) {
    const f = meta.fields[i];
    blobs[`fields${i}`] = f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer;
  }
  return blobs;
}

function parseEntry(state: SaveState, blobs: Record<string, ArrayBuffer> | null): SaveEntry | null {
  const world = state.components.world?.data as { gridW: number; gridH: number; numLayers: number } | undefined;
  if (!world || !blobs) return null;
  const grids: Uint32Array[] = [];
  const fields: Uint8Array[] = [];
  for (let i = 0; i < world.numLayers; i++) {
    grids.push(new Uint32Array(blobs[`grid${i}`]));
    fields.push(new Uint8Array(blobs[`fields${i}`]));
  }
  return {
    id: "", name: "Save", timestamp: state.meta.timestamp * 1000,
    thumbnail: new Blob([], { type: "image/jpeg" }),
    gridW: world.gridW, gridH: world.gridH, numLayers: world.numLayers,
    grids, fields,
  };
}

function extractListMeta(state: SaveState): Record<string, unknown> {
  const world = state.components.world?.data as { gridW: number; gridH: number } | undefined;
  return { gridW: world?.gridW ?? 0, gridH: world?.gridH ?? 0 };
}

const system = createGridSaveSystem<FallingSandMeta, SaveEntry>({
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
  meta: FallingSandMeta,
): Promise<SaveEntry> {
  const { id, timestamp } = await system.saveGame(name, thumbnail, meta);
  return {
    id, name, timestamp,
    thumbnail: new Blob([thumbnail], { type: "image/jpeg" }),
    gridW: meta.gridW, gridH: meta.gridH, numLayers: meta.grids.length,
    grids: meta.grids.map((g) => new Uint32Array(g)),
    fields: meta.fields.map((f) => new Uint8Array(f)),
  };
}

export async function loadGame(id: string): Promise<SaveEntry | null> {
  const entry = await system.loadGame(id);
  if (!entry) return null;
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
  return system.listSaves() as unknown as Promise<SaveMetadata[]>;
}

export async function deleteSave(id: string): Promise<void> {
  await system.deleteSave(id);
}

export async function autosave(meta: FallingSandMeta): Promise<void> {
  await system.autosave(meta);
}

export async function loadAutosave(): Promise<SaveEntry | null> {
  return loadGame("autosave");
}
