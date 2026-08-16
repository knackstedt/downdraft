// ============================================================================
// IpcSaveStore — ISaveStore implementation that delegates to the Electron
// main process via the `downdraft` preload bridge (IPC).
// ============================================================================
//
// This is the fallback when OPFS is unavailable (e.g. browser-only mode
// without COOP/COEP, or test environments). The main process uses
// FileSaveStore to write to disk.
//
// The bridge methods are defined in DowndraftBridgeAPI and wired in the
// preload script. This adapter translates ISaveStore calls to bridge calls.

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
} from "@downdraft/core";

/**
 * The subset of the DowndraftBridge needed for save operations.
 * This matches the methods exposed by the preload bridge.
 */
export interface SaveBridge {
  saveGameState(slotName: string, stateJson: string, opts?: SaveOptions): Promise<boolean>;
  loadGameState(slotName: string, opts?: LoadOptions): Promise<string | null>;
  listSaveSlots(): Promise<SaveSlotInfo[]>;
  deleteGameState(slotName: string): Promise<boolean>;
  listSaveGenerations?(slotName: string): Promise<SaveGenerationInfo[]>;
  deleteSaveGeneration?(slotName: string, gen: number): Promise<boolean>;
  setThumbnail?(slotName: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  getThumbnail?(slotName: string): Promise<ArrayBuffer | null>;
  setSaveProperties?(slotName: string, props: Record<string, unknown>): Promise<void>;
  getSaveProperties?(slotName: string): Promise<Record<string, unknown>>;
}

export class IpcSaveStore implements ISaveStore {
  private warningCallbacks: Array<(w: SaveWarning) => void> = [];

  constructor(private bridge: SaveBridge) {}

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    try {
      const stateJson = JSON.stringify(state);
      // The bridge accepts the full opts object — the main process handler
      // extracts blobs, thumbnail, and properties from it.
      const success = await this.bridge.saveGameState(slot, stateJson, opts);
      return { success, bytes: 0, gen: 1 };
    } catch {
      return { success: false, bytes: 0 };
    }
  }

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    try {
      const result = await this.bridge.loadGameState(slot, opts);
      if (!result) return { state: null };

      // The main process returns a JSON string of the components.
      // For the IPC path, blobs are loaded separately if needed.
      const components = JSON.parse(result);
      const state: SaveState = {
        components,
        meta: {
          engineVersion: "",
          timestamp: 0,
          entityCount: 0,
          playerCount: 0,
        },
      };

      // Load blobs if requested — the main process includes blob refs
      // in the component data. For now, the IPC path doesn't support
      // separate blob loading (blobs are embedded in the JSON as base64
      // by the main process handler if needed).
      return { state, gen: 1 };
    } catch {
      return { state: null };
    }
  }

  async listSaves(): Promise<SaveSlotInfo[]> {
    return this.bridge.listSaveSlots();
  }

  async listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    if (this.bridge.listSaveGenerations) {
      return this.bridge.listSaveGenerations(slot);
    }
    return [];
  }

  async deleteSave(slot: string): Promise<boolean> {
    return this.bridge.deleteGameState(slot);
  }

  async deleteGeneration(slot: string, gen: number): Promise<boolean> {
    if (this.bridge.deleteSaveGeneration) {
      return this.bridge.deleteSaveGeneration(slot, gen);
    }
    return false;
  }

  async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.bridge.setThumbnail) {
      return this.bridge.setThumbnail(slot, data);
    }
  }

  async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    if (this.bridge.getThumbnail) {
      return this.bridge.getThumbnail(slot);
    }
    return null;
  }

  async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    if (this.bridge.setSaveProperties) {
      return this.bridge.setSaveProperties(slot, props);
    }
  }

  async getProperties(slot: string): Promise<Record<string, unknown>> {
    if (this.bridge.getSaveProperties) {
      return this.bridge.getSaveProperties(slot);
    }
    return {};
  }

  onWarning(cb: (warning: SaveWarning) => void): () => void {
    this.warningCallbacks.push(cb);
    return () => {
      const idx = this.warningCallbacks.indexOf(cb);
      if (idx >= 0) this.warningCallbacks.splice(idx, 1);
    };
  }
}
