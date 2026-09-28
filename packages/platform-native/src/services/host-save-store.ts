// ============================================================================
// HostSaveStore — ISaveStore implementation backed by HostServices.
//
// The native save path: a SaveState travels to FileSaveStore (inline or
// through the services worker's structured-clone boundary) with NO JSON
// serialization layer in between, and the real SaveResult/LoadResult
// (bytes, gen, meta) comes back. Replaces the Electron-era IpcSaveStore,
// which forced a JSON-string contract and fabricated metadata to fit the
// IPC wire format.
// ============================================================================

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
import type { HostServicesApi } from "./host-services";

export class HostSaveStore implements ISaveStore {
  private warnCallbacks = new Set<(w: SaveWarning) => void>();

  /**
   * @param api  The HostServices API handle (inline impl or worker proxy).
   * @param subscribeWarnings  Host warning feed (services.onWarning) —
   *   forwarded to onWarning subscribers so corruption/backup warnings
   *   reach the game, not just the log.
   */
  constructor(
    private api: HostServicesApi,
    subscribeWarnings: (cb: (w: SaveWarning) => void) => void,
  ) {
    subscribeWarnings((w) => this.warnCallbacks.forEach((cb) => cb(w)));
  }

  save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    return this.api.saveState(slot, state, opts);
  }

  load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    return this.api.loadState(slot, opts);
  }

  listSaves(): Promise<SaveSlotInfo[]> {
    return this.api.listSaves() as Promise<SaveSlotInfo[]>;
  }

  listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    return this.api.listGenerations(slot) as Promise<SaveGenerationInfo[]>;
  }

  deleteSave(slot: string): Promise<boolean> {
    return this.api.deleteSave(slot);
  }

  deleteGeneration(slot: string, gen: number): Promise<boolean> {
    return this.api.deleteGeneration(slot, gen);
  }

  setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    return this.api.setThumbnail(slot, data);
  }

  getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    return this.api.getThumbnail(slot);
  }

  setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    return this.api.setProperties(slot, props);
  }

  getProperties(slot: string): Promise<Record<string, unknown>> {
    return this.api.getProperties(slot);
  }

  onWarning(cb: (w: SaveWarning) => void): () => void {
    this.warnCallbacks.add(cb);
    return () => { this.warnCallbacks.delete(cb); };
  }
}
