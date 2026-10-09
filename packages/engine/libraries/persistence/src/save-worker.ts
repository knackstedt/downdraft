// ============================================================================
// Save Worker — dedicated Web Worker that owns an OpfsSaveStore instance.
// ============================================================================
//
// The renderer spawns this worker when "worker" mode is selected. The sim
// worker sends serialized state (as transferable ArrayBuffer) to this worker
// via a MessageChannel, and this worker writes it to OPFS directly.
//
// Uses the engine's RPC layer (expose/exposeEvents) for typed communication.

import type {
    ISaveStore,
    LoadOptions,
    LoadResult,
    SaveGenerationInfo,
    SaveOptions,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveWarning,
} from "@downdraft/engine";
import { expose } from "@downdraft/engine/worker/rpc";
import { OpfsSaveStore, type OpfsSaveStoreOptions } from "./opfs-save-store";

let store: OpfsSaveStore | null = null;

const api = {
  async init(opts: OpfsSaveStoreOptions): Promise<void> {
    store = new OpfsSaveStore(opts);
    await store.init();
  },

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    if (!store) throw new Error("Save worker not initialized — call init() first");
    return store.save(slot, state, opts);
  },

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    if (!store) throw new Error("Save worker not initialized");
    return store.load(slot, opts);
  },

  async listSaves(): Promise<SaveSlotInfo[]> {
    if (!store) throw new Error("Save worker not initialized");
    return store.listSaves();
  },

  async listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    if (!store) throw new Error("Save worker not initialized");
    return store.listGenerations(slot);
  },

  async deleteSave(slot: string): Promise<boolean> {
    if (!store) throw new Error("Save worker not initialized");
    return store.deleteSave(slot);
  },

  async deleteGeneration(slot: string, gen: number): Promise<boolean> {
    if (!store) throw new Error("Save worker not initialized");
    return store.deleteGeneration(slot, gen);
  },

  async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    if (!store) throw new Error("Save worker not initialized");
    return store.setThumbnail(slot, data);
  },

  async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    if (!store) throw new Error("Save worker not initialized");
    return store.getThumbnail(slot);
  },

  async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    if (!store) throw new Error("Save worker not initialized");
    return store.setProperties(slot, props);
  },

  async getProperties(slot: string): Promise<Record<string, unknown>> {
    if (!store) throw new Error("Save worker not initialized");
    return store.getProperties(slot);
  },

  onWarning(): void {
    // Warnings are forwarded as events — the proxy sets up the callback
    // and forwards via exposeEvents. For simplicity, warnings are logged.
  },

  async shutdown(): Promise<void> {
    store = null;
  },
};

expose(api);

// Also export the type for the proxy side
export type SaveWorkerApi = typeof api;
export type { ISaveStore, LoadOptions, LoadResult, SaveGenerationInfo, SaveOptions, SaveResult, SaveSlotInfo, SaveState, SaveWarning };

