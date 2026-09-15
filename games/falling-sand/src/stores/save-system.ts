// ============================================================================
// Falling-sand save system — schema mapping + createGameSaveSystem facade.
//
// The engine owns the lifecycle (store singleton, autosave interval, restore-
// on-start); this module defines only the falling-sand save shape (multi-
// layer grids + fields) and the blob mappers between typed arrays and
// ArrayBuffers.
// ============================================================================

import { createDefaultSaveStore } from "@downdraft/app/renderer";
import { createGameSaveSystem, type GameSaveSystem, type SaveListEntry, type SaveState } from "@downdraft/core";

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

export type SaveMetadata = SaveListEntry;

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

export type FallingSandSaveSystem = GameSaveSystem<FallingSandMeta, SaveEntry>;

/**
 * Create the save lifecycle for this session. Called once from onReady —
 * the snapshot/restore callbacks bind the renderer.
 */
export function createFallingSandSaveSystem(opts: {
  /** Capture current grids/fields for autosave (null skips the tick). */
  snapshot: () => FallingSandMeta | null;
  /** Apply a loaded entry to the renderer. */
  restore: (entry: SaveEntry) => Promise<void>;
  deterministic?: boolean;
}): FallingSandSaveSystem {
  const base = createGameSaveSystem<FallingSandMeta, SaveEntry>({
    createStore: () => createDefaultSaveStore(ENGINE_VERSION),
    autosaveSlot: "autosave",
    buildState,
    buildBlobs,
    parseEntry,
    extractListMeta,
    snapshot: opts.snapshot,
    restore: opts.restore,
    deterministic: opts.deterministic,
  });

  // Enrich loadGame with the slot's thumbnail + name + id (the parsed entry
  // only carries grid data).
  const enriched: FallingSandSaveSystem = {
    ...base,
    async loadGame(id: string) {
      const entry = await base.loadGame(id);
      if (!entry) return null;
      const store = await base.getStore();
      const thumbBuf = await store.getThumbnail(id);
      const props = await store.getProperties(id);
      entry.id = id;
      entry.thumbnail = thumbBuf ? new Blob([thumbBuf], { type: "image/jpeg" }) : entry.thumbnail;
      entry.name = (props.name as string) ?? "Save";
      entry.timestamp = (props.savedAt as number) ?? entry.timestamp;
      return entry;
    },
    async loadAndRestore(id: string) {
      const entry = await enriched.loadGame(id);
      if (entry) await opts.restore(entry);
      return entry;
    },
  };
  return enriched;
}
