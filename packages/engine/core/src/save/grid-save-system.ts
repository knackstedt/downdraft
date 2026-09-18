// ============================================================================
// createGridSaveSystem — generic save-system factory for grid-based games.
//
// Eliminates the duplicated getStore() singleton + save/load/list/delete/
// autosave/loadAutosave boilerplate that was copy-pasted across grid-based games.
//
// The factory owns:
//   - Lazy ISaveStore singleton (via the game-provided createStore function)
//   - saveGame: named slot + thumbnail + properties
//   - loadGame: parse state + blobs into game-specific entry
//   - listSaves: list all slots except autosave, with thumbnails
//   - deleteSave: delete a named slot
//   - autosave: save to the autosave slot
//   - loadAutosave: load from the autosave slot
//
// Games provide:
//   - createStore: () => Promise<ISaveStore> (typically createDefaultSaveStore)
//   - autosaveSlot: string ("autosave", "world", etc.)
//   - buildState: (meta) => SaveState
//   - buildBlobs: (meta) => Record<string, ArrayBuffer>
//   - parseEntry: (state, blobs) => Entry | null
//   - extractListMeta?: (state) => Record<string, unknown> (for listSaves extra fields)
// ============================================================================

import type { ISaveStore, SaveState } from "./persist-types";

export interface SaveListEntry {
  id: string;
  name: string;
  timestamp: number;
  thumbnailUrl: string;
  [key: string]: unknown;
}

export interface GridSaveSystemOptions<Meta, Entry> {
  /** Creates the ISaveStore singleton (game provides this, typically createDefaultSaveStore). */
  createStore: () => Promise<ISaveStore>;
  /** Slot name for autosave (e.g. "autosave", "world"). */
  autosaveSlot: string;
  /** Build SaveState from game meta. */
  buildState: (meta: Meta) => SaveState;
  /** Build blobs record from game meta (typed arrays → ArrayBuffers). */
  buildBlobs: (meta: Meta) => Record<string, ArrayBuffer>;
  /** Parse a loaded SaveState + blobs into a game-specific entry. Return null if invalid. */
  parseEntry: (state: SaveState, blobs: Record<string, ArrayBuffer> | null) => Entry | null;
  /**
   * Extract list metadata from a loaded state for listSaves().
   * If not provided, listSaves() returns only id/name/timestamp/thumbnailUrl.
   */
  extractListMeta?: (state: SaveState) => Record<string, unknown>;
}

export interface GridSaveSystem<Meta, Entry> {
  /** Save to a named slot with thumbnail. Returns the generated id + timestamp. */
  saveGame(name: string, thumbnail: ArrayBuffer, meta: Meta): Promise<{ id: string; timestamp: number }>;
  /** Load from a named slot. Returns null if no save or invalid. */
  loadGame(id: string): Promise<Entry | null>;
  /** List all saves (excluding the autosave slot). */
  listSaves(): Promise<SaveListEntry[]>;
  /** Delete a save slot. */
  deleteSave(id: string): Promise<void>;
  /** Save to the autosave slot. */
  autosave(meta: Meta): Promise<void>;
  /** Load from the autosave slot. */
  loadAutosave(): Promise<Entry | null>;
  /** Get the underlying ISaveStore (for advanced use). */
  getStore(): Promise<ISaveStore>;
}

export function createGridSaveSystem<Meta, Entry>(
  opts: GridSaveSystemOptions<Meta, Entry>,
): GridSaveSystem<Meta, Entry> {
  let storePromise: Promise<ISaveStore> | null = null;

  function getStore(): Promise<ISaveStore> {
    if (!storePromise) {
      storePromise = opts.createStore();
    }
    return storePromise;
  }

  return {
    async saveGame(name: string, thumbnail: ArrayBuffer, meta: Meta): Promise<{ id: string; timestamp: number }> {
      const store = await getStore();
      const id = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const state = opts.buildState(meta);
      await store.save(id, state, {
        thumbnail: new Uint8Array(thumbnail),
        properties: { name, savedAt: Date.now() },
        blobs: opts.buildBlobs(meta),
      });
      return { id, timestamp: Date.now() };
    },

    async loadGame(id: string): Promise<Entry | null> {
      const store = await getStore();
      const result = await store.load(id);
      if (!result.state) return null;
      return opts.parseEntry(result.state, result.blobs ?? null);
    },

    async listSaves(): Promise<SaveListEntry[]> {
      const store = await getStore();
      const slots = await store.listSaves();
      return Promise.all(
        slots
          .filter((s) => s.slot !== opts.autosaveSlot)
          .map(async (s) => {
            const thumbBuf = await store.getThumbnail(s.slot);
            const thumbnailUrl = thumbBuf
              ? URL.createObjectURL(new Blob([thumbBuf], { type: "image/jpeg" }))
              : "";
            const props = await store.getProperties(s.slot);
            const base: SaveListEntry = {
              id: s.slot,
              name: (props.name as string) ?? "Save",
              timestamp: (props.savedAt as number) ?? s.timestamp * 1000,
              thumbnailUrl,
            };
            // Merge game-specific list metadata if the game provided the callback.
            if (opts.extractListMeta) {
              // Load the state to extract list metadata (e.g. gridW, gridH).
              // This is a lightweight load — the state header is small.
              const result = await store.load(s.slot, { includeBlobs: false });
              if (result.state) {
                const extra = opts.extractListMeta(result.state);
                Object.assign(base, extra);
              }
            }
            return base;
          }),
      );
    },

    async deleteSave(id: string): Promise<void> {
      const store = await getStore();
      await store.deleteSave(id);
    },

    async autosave(meta: Meta): Promise<void> {
      const store = await getStore();
      const state = opts.buildState(meta);
      await store.save(opts.autosaveSlot, state, {
        properties: { name: "Autosave", savedAt: Date.now() },
        blobs: opts.buildBlobs(meta),
      });
    },

    async loadAutosave(): Promise<Entry | null> {
      const store = await getStore();
      const result = await store.load(opts.autosaveSlot);
      if (!result.state) return null;
      return opts.parseEntry(result.state, result.blobs ?? null);
    },

    getStore,
  };
}
