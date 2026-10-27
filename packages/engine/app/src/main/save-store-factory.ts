// ============================================================================
// Save Store Factory — creates the appropriate ISaveStore based on
// environment capabilities and app configuration.
// ============================================================================
//
// Mode selection:
//   "host"    — The host's own save store (`downdraft.saveStore`). On native
//               this is HostSaveStore over HostServices → FileSaveStore: real
//               SaveState in, real SaveResult/LoadResult out, no JSON
//               boundary. The default when a host bridge is installed.
//   "worker"  — The sim worker owns persistence itself (e.g. a
//               DirectorySaveStore created inside the worker). The factory
//               returns a null store; save()/load() RPCs persist directly.
//   "auto"    — Picks "host" when the host exposes a typed save store, else
//               a JSON bridge wrapper when only the generic saveAppState /
//               loadAppState methods exist (headless/test hosts).
//
// A sim worker that wants worker-owned persistence constructs a
// DirectorySaveStore itself (see @downdraft/engine/libraries/persistence)
// and exposes save()/load() RPCs — the factory is only for the main-thread
// side.
//
// The factory is called from the main thread after the sim worker is
// initialized.

import type { ISaveStore, LoadOptions, LoadResult, SaveGenerationInfo, SaveOptions, SaveResult, SaveSlotInfo, SaveState, SaveWarning } from "@downdraft/engine";

export type SaveStoreMode = "host" | "worker" | "auto";

/**
 * The subset of the host bridge needed for save operations. `saveStore` is
 * the typed native path; the `saveAppState`/`loadAppState` JSON-string
 * methods are the last-resort generic fallback.
 */
export interface SaveBridge {
  saveStore?: ISaveStore;
  saveAppState(slotName: string, stateJson: string, opts?: SaveOptions): Promise<boolean>;
  loadAppState(slotName: string, opts?: unknown): Promise<string | null>;
  listSaveSlots(): Promise<SaveSlotInfo[]>;
  deleteAppState(slotName: string): Promise<boolean>;
  listSaveGenerations?(slotName: string): Promise<SaveGenerationInfo[]>;
  deleteSaveGeneration?(slotName: string, gen: number): Promise<boolean>;
  setThumbnail?(slotName: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  getThumbnail?(slotName: string): Promise<ArrayBuffer | null>;
  setSaveProperties?(slotName: string, props: Record<string, unknown>): Promise<void>;
  getSaveProperties?(slotName: string): Promise<Record<string, unknown>>;
}

export interface CreateSaveStoreOptions {
  /** Mode selection. Default: "auto". */
  mode?: SaveStoreMode;
  /** The host bridge. Required; "auto" still needs it for the JSON fallback. */
  bridge?: SaveBridge | null;
}

/** Result of createSaveStore: the store + the mode that was actually
 *  resolved. Callers should use `mode` to label their save mode rather than
 *  guessing from the store type. */
export interface CreateSaveStoreResult {
  store: ISaveStore | null;
  mode: "host" | "worker";
}

/**
 * Create the appropriate ISaveStore based on the mode and environment.
 *
 * - "host": Returns the host's save store (native HostSaveStore →
 *   FileSaveStore on disk). Stable across sessions; not origin-scoped.
 * - "worker": Returns null — the sim worker owns its store (DirectorySaveStore).
 * - "auto": Picks "host" when the bridge exposes a typed save store, else
 *   wraps the bridge's JSON save methods (headless/test hosts, stub bridge).
 */
export async function createSaveStore(opts: CreateSaveStoreOptions): Promise<CreateSaveStoreResult> {
  const mode = opts.mode ?? "auto";

  switch (mode) {
    case "host": {
      if (!opts.bridge?.saveStore) {
        throw new Error("No host save store on the bridge — 'host' mode requires a native host (downdraft.saveStore)");
      }
      return { store: opts.bridge.saveStore, mode: "host" };
    }

    case "worker":
      // Worker-owned persistence — the sim worker creates its own
      // DirectorySaveStore and save()/load() RPCs persist directly.
      return { store: null, mode: "worker" };

    case "auto": {
      if (opts.bridge?.saveStore) {
        return { store: opts.bridge.saveStore, mode: "host" };
      }
      // Last resort: the bridge's JSON save methods. On native this only
      // happens in headless/test hosts with no appId (the stub bridge) —
      // saves no-op but callers get a well-formed store.
      if (opts.bridge) {
        return { store: new BridgeJsonSaveStore(opts.bridge), mode: "host" };
      }
      throw new Error("No save backend available in 'auto' mode — no host save store, no bridge");
    }

    default:
      throw new Error(`Unknown save store mode: ${mode}`);
  }
}

/**
 * ISaveStore over the bridge's JSON-string save methods — the last-resort
 * "auto" backend for headless hosts (stub bridge). The wire format is the
 * components map (what host `saveApp`/`loadApp` handlers parse/return);
 * SaveResult metadata is unavailable across the JSON boundary.
 */
export class BridgeJsonSaveStore implements ISaveStore {
  private warningCallbacks = new Set<(w: SaveWarning) => void>();

  constructor(private bridge: SaveBridge) {}

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    try {
      const success = await this.bridge.saveAppState(slot, JSON.stringify(state.components), opts);
      return { success, bytes: 0 };
    } catch {
      return { success: false, bytes: 0 };
    }
  }

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    try {
      const result = await this.bridge.loadAppState(slot, opts);
      if (!result) return { state: null };
      const components = JSON.parse(result);
      return {
        state: {
          components,
          meta: { engineVersion: "", timestamp: 0, entityCount: 0, playerCount: 0 },
        },
      };
    } catch {
      return { state: null };
    }
  }

  listSaves(): Promise<SaveSlotInfo[]> {
    return this.bridge.listSaveSlots();
  }

  async listGenerations(slot: string): Promise<SaveGenerationInfo[]> {
    return this.bridge.listSaveGenerations?.(slot) ?? [];
  }

  deleteSave(slot: string): Promise<boolean> {
    return this.bridge.deleteAppState(slot);
  }

  async deleteGeneration(slot: string, gen: number): Promise<boolean> {
    return this.bridge.deleteSaveGeneration?.(slot, gen) ?? false;
  }

  async setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    await this.bridge.setThumbnail?.(slot, data);
  }

  async getThumbnail(slot: string): Promise<ArrayBuffer | null> {
    return (await this.bridge.getThumbnail?.(slot)) ?? null;
  }

  async setProperties(slot: string, props: Record<string, unknown>): Promise<void> {
    await this.bridge.setSaveProperties?.(slot, props);
  }

  async getProperties(slot: string): Promise<Record<string, unknown>> {
    return (await this.bridge.getSaveProperties?.(slot)) ?? {};
  }

  onWarning(cb: (w: SaveWarning) => void): () => void {
    this.warningCallbacks.add(cb);
    return () => { this.warningCallbacks.delete(cb); };
  }
}
