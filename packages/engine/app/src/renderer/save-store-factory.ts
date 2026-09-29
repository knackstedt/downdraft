// ============================================================================
// Save Store Factory — creates the appropriate ISaveStore based on
// environment capabilities and game configuration.
// ============================================================================
//
// Mode selection:
//   "inline"  — OpfsSaveStore runs inside the sim worker (caller is responsible
//               for creating it there). The factory returns null here; the
//               sim worker creates the store directly.
//   "worker"  — Spawns a dedicated save Web Worker with OpfsSaveStore inside.
//               Returns a SaveWorkerProxy. (Browser builds only — the native
//               host has no OPFS.)
//   "host"    — The host's own save store (`downdraft.saveStore`). On native
//               this is HostSaveStore over HostServices → FileSaveStore: real
//               SaveState in, real SaveResult/LoadResult out, no JSON
//               boundary. The default when a host bridge is installed.
//   "auto"    — Picks "host" when the host exposes a typed save store, else
//               "worker" if OPFS is available. (The legacy worker-timeout →
//               IPC-fallback dance is gone: on native there is no OPFS and
//               no process boundary, so the flip can never produce a
//               divergent save location.)
//
// The factory is called from the renderer after the sim worker is initialized.

import type { ISaveStore, LoadOptions, LoadResult, SaveGenerationInfo, SaveOptions, SaveResult, SaveSlotInfo, SaveState, SaveWarning } from "@downdraft/engine";
import { OpfsSaveStore, SaveWorkerProxy, type OpfsSaveStoreOptions } from "@downdraft/engine/libraries/persistence/browser";

export type SaveStoreMode = "inline" | "worker" | "host" | "auto";

/**
 * The subset of the host bridge needed for save operations. `saveStore` is
 * the typed native path; the `saveGameState`/`loadGameState` JSON-string
 * methods only remain for the dormant Electron bridge.
 */
export interface SaveBridge {
  saveStore?: ISaveStore;
  saveGameState(slotName: string, stateJson: string, opts?: SaveOptions): Promise<boolean>;
  loadGameState(slotName: string, opts?: unknown): Promise<string | null>;
  listSaveSlots(): Promise<SaveSlotInfo[]>;
  deleteGameState(slotName: string): Promise<boolean>;
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
  /** Options for the OpfsSaveStore (used in inline and worker modes). */
  opfsOptions: OpfsSaveStoreOptions;
  /** The host bridge. Required for "host" mode; preferred in "auto". */
  bridge?: SaveBridge | null;
  /** Worker URL for dedicated worker mode. Defaults to the library's save-worker.ts. */
  workerUrl?: URL;
}

/** Result of createSaveStore: the store (null in "inline" mode) + the mode that
 *  was actually resolved. Callers should use `mode` to label their save mode
 *  rather than guessing from the store type. */
export interface CreateSaveStoreResult {
  store: ISaveStore | null;
  mode: SaveStoreMode;
}

/**
 * Check if OPFS is available in the current environment.
 */
export function isOpfsAvailable(): boolean {
  const nav = globalThis as unknown as { navigator?: { storage?: { getDirectory?: unknown } } };
  return typeof nav.navigator?.storage?.getDirectory === "function";
}

/**
 * Create the appropriate ISaveStore based on the mode and environment.
 *
 * - "inline": Returns null. The caller should create an OpfsSaveStore inside
 *   the sim worker directly (the worker has the serialized state and can
 *   write to OPFS without crossing worker boundaries).
 * - "worker": Spawns a dedicated save worker with OpfsSaveStore. Returns
 *   a SaveWorkerProxy. The caller must call init() on it.
 * - "host": Returns the host's save store (native HostSaveStore →
 *   FileSaveStore on disk). Stable across sessions; not origin-scoped.
 * - "auto": Picks "host" when the bridge exposes a typed save store, else
 *   "worker" when OPFS is available.
 *
 * Returns `{ store, mode }` where `mode` is the backend that was actually
 * selected (which may differ from the requested mode in "auto" fallback).
 */
export async function createSaveStore(opts: CreateSaveStoreOptions): Promise<CreateSaveStoreResult> {
  const mode = opts.mode ?? "auto";

  switch (mode) {
    case "inline":
      // The caller creates the OpfsSaveStore inside the sim worker.
      // Return null to signal that the sim worker handles saves directly.
      return { store: null, mode: "inline" };

    case "worker": {
      if (!isOpfsAvailable()) {
        throw new Error("OPFS is not available — cannot use 'worker' mode. Use 'auto' or 'inline' mode.");
      }
      const proxy = new SaveWorkerProxy({
        storeOptions: opts.opfsOptions,
        workerUrl: opts.workerUrl,
      });
      await proxy.init();
      return { store: proxy, mode: "worker" };
    }

    case "host": {
      if (!opts.bridge?.saveStore) {
        throw new Error("No host save store on the bridge — 'host' mode requires a native host (downdraft.saveStore)");
      }
      return { store: opts.bridge.saveStore, mode: "host" };
    }

    case "auto": {
      // Native-first: when the host exposes a typed save store, use it.
      // There is no OPFS and no process boundary on native, so the old
      // 5s worker-timeout → IPC-fallback flip is unnecessary.
      if (opts.bridge?.saveStore) {
        return { store: opts.bridge.saveStore, mode: "host" };
      }
      if (isOpfsAvailable()) {
        // Try dedicated worker mode, with a 5s init timeout — the worker
        // spawn can hang in some environments (e.g. when Vite's worker URL
        // resolution fails in dev mode).
        const proxy = new SaveWorkerProxy({
          storeOptions: opts.opfsOptions,
          workerUrl: opts.workerUrl,
        });
        await Promise.race([
          proxy.init(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SaveWorkerProxy init timeout (5s)")), 5000),
          ),
        ]);
        return { store: proxy, mode: "worker" };
      }
      // Last resort: the bridge's JSON save methods. On native this only
      // happens in headless/test hosts with no appId (the stub bridge) —
      // saves no-op but callers get a well-formed store. In a browser with
      // a real bridge this preserves the pre-migration fallback behavior.
      if (opts.bridge) {
        return { store: new BridgeJsonSaveStore(opts.bridge), mode: "host" };
      }
      throw new Error("No save backend available in 'auto' mode — no host save store, no OPFS, no bridge");
    }

    default:
      throw new Error(`Unknown save store mode: ${mode}`);
  }
}

/**
 * ISaveStore over the bridge's JSON-string save methods — the last-resort
 * "auto" backend for headless hosts (stub bridge) and dormant-Electron
 * browsers without a typed store or OPFS. The wire format is the components
 * map (what host `saveGame`/`loadGame` handlers parse/return); SaveResult
 * metadata is unavailable across the JSON boundary.
 */
export class BridgeJsonSaveStore implements ISaveStore {
  private warningCallbacks = new Set<(w: SaveWarning) => void>();

  constructor(private bridge: SaveBridge) {}

  async save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult> {
    try {
      const success = await this.bridge.saveGameState(slot, JSON.stringify(state.components), opts);
      return { success, bytes: 0 };
    } catch {
      return { success: false, bytes: 0 };
    }
  }

  async load(slot: string, opts?: LoadOptions): Promise<LoadResult> {
    try {
      const result = await this.bridge.loadGameState(slot, opts);
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
    return this.bridge.deleteGameState(slot);
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

/**
 * Create an OpfsSaveStore directly (for inline mode where the store runs
 * inside the sim worker). This is a convenience wrapper that calls init().
 */
export async function createInlineSaveStore(opts: OpfsSaveStoreOptions): Promise<OpfsSaveStore> {
  const store = new OpfsSaveStore(opts);
  await store.init();
  return store;
}
