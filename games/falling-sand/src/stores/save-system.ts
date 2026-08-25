// ============================================================================
// Falling-sand save system — thin adapter over @downdraft/library-persistence
// OpfsSaveStore. The engine handles OPFS storage, compression, hashing, and
// generation history; this module only maps the game's save shape (multi-layer
// grids + fields) to SaveState components + binary blobs.
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

const AUTOSAVE_SLOT = "autosave";
const ENGINE_VERSION = "0.1.0";

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

function buildState(gridW: number, gridH: number, numLayers: number): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW, gridH, numLayers } },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: 0,
      playerCount: 1,
    },
  };
}

function gridsToBlobs(grids: Uint32Array[], fields: Uint8Array[]): Record<string, ArrayBuffer> {
  const blobs: Record<string, ArrayBuffer> = {};
  for (let i = 0; i < grids.length; i++) {
    const g = grids[i];
    blobs[`grid${i}`] = g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength) as ArrayBuffer;
  }
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    blobs[`fields${i}`] = f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer;
  }
  return blobs;
}

function blobsToGrids(blobs: Record<string, ArrayBuffer>, numLayers: number): { grids: Uint32Array[]; fields: Uint8Array[] } {
  const grids: Uint32Array[] = [];
  const fields: Uint8Array[] = [];
  for (let i = 0; i < numLayers; i++) {
    grids.push(new Uint32Array(blobs[`grid${i}`]));
    fields.push(new Uint8Array(blobs[`fields${i}`]));
  }
  return { grids, fields };
}

export async function saveGame(
  name: string,
  thumbnail: ArrayBuffer,
  gridW: number,
  gridH: number,
  grids: Uint32Array[],
  fields: Uint8Array[],
): Promise<SaveEntry> {
  const store = await getStore();
  const id = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = buildState(gridW, gridH, grids.length);
  await store.save(id, state, {
    thumbnail: new Uint8Array(thumbnail),
    properties: { name, savedAt: Date.now() },
    blobs: gridsToBlobs(grids, fields),
  });
  return {
    id, name, timestamp: Date.now(), thumbnail: new Blob([thumbnail], { type: "image/jpeg" }),
    gridW, gridH, numLayers: grids.length,
    grids: grids.map((g) => new Uint32Array(g)), fields: fields.map((f) => new Uint8Array(f)),
  };
}

export async function loadGame(id: string): Promise<SaveEntry | null> {
  const store = await getStore();
  const result = await store.load(id);
  if (!result.state) return null;
  const world = result.state.components.world?.data as { gridW: number; gridH: number; numLayers: number } | undefined;
  if (!world || !result.blobs) return null;
  const { grids, fields } = blobsToGrids(result.blobs, world.numLayers);
  const thumbBuf = await store.getThumbnail(id);
  const thumbnail = thumbBuf ? new Blob([thumbBuf], { type: "image/jpeg" }) : new Blob([], { type: "image/jpeg" });
  const props = await store.getProperties(id);
  return {
    id, name: (props.name as string) ?? "Save",
    timestamp: (props.savedAt as number) ?? result.state.meta.timestamp * 1000,
    thumbnail, gridW: world.gridW, gridH: world.gridH, numLayers: world.numLayers,
    grids, fields,
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
  grids: Uint32Array[],
  fields: Uint8Array[],
): Promise<void> {
  const store = await getStore();
  const state = buildState(gridW, gridH, grids.length);
  await store.save(AUTOSAVE_SLOT, state, {
    properties: { name: "Autosave", savedAt: Date.now() },
    blobs: gridsToBlobs(grids, fields),
  });
}

export async function loadAutosave(): Promise<SaveEntry | null> {
  return loadGame(AUTOSAVE_SLOT);
}
