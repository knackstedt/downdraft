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
//               Returns a SaveWorkerProxy.
//   "auto"    — Picks "worker" if OPFS is available, else falls back to
//               IpcSaveStore (Electron IPC → main process FileSaveStore).
//
// The factory is called from the renderer after the sim worker is initialized.

import type { ISaveStore } from "@downdraft/core";
import { OpfsSaveStore, SaveWorkerProxy, type OpfsSaveStoreOptions } from "@downdraft/library-persistence/browser";
import { IpcSaveStore, type SaveBridge } from "./ipc-save-store";

export type SaveStoreMode = "inline" | "worker" | "auto";

export interface CreateSaveStoreOptions {
  /** Mode selection. Default: "auto". */
  mode?: SaveStoreMode;
  /** Options for the OpfsSaveStore (used in inline and worker modes). */
  opfsOptions: OpfsSaveStoreOptions;
  /** The downdraft bridge for IPC fallback. Required for "auto" mode. */
  bridge?: SaveBridge | null;
  /** Worker URL for dedicated worker mode. Defaults to the library's save-worker.ts. */
  workerUrl?: URL;
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
 * - "auto": Picks "worker" if OPFS is available, else IpcSaveStore.
 */
export async function createSaveStore(opts: CreateSaveStoreOptions): Promise<ISaveStore | null> {
  const mode = opts.mode ?? "auto";

  switch (mode) {
    case "inline":
      // The caller creates the OpfsSaveStore inside the sim worker.
      // Return null to signal that the sim worker handles saves directly.
      return null;

    case "worker": {
      if (!isOpfsAvailable()) {
        throw new Error("OPFS is not available — cannot use 'worker' mode. Use 'auto' or 'inline' mode.");
      }
      const proxy = new SaveWorkerProxy({
        storeOptions: opts.opfsOptions,
        workerUrl: opts.workerUrl,
      });
      await proxy.init();
      return proxy;
    }

    case "auto": {
      if (isOpfsAvailable()) {
        // Try dedicated worker mode first, with a 5s timeout.
        // The worker spawn can hang in some environments (e.g. when Vite's
        // worker URL resolution fails in dev mode). Fall back to IPC on timeout.
        try {
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
          return proxy;
        } catch (err) {
          // Worker spawn failed or timed out — fall through to IPC
          console.warn("[createSaveStore] Worker mode failed, falling back to IPC:", err);
        }
      }
      // IPC fallback
      if (!opts.bridge) {
        throw new Error("No bridge provided for IPC fallback in 'auto' mode");
      }
      return new IpcSaveStore(opts.bridge);
    }

    default:
      throw new Error(`Unknown save store mode: ${mode}`);
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
