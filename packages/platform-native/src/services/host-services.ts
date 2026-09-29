// ============================================================================
// host-services.ts — HostServices seam
//
// The native host's blocking services (save I/O, the SQLite import cache)
// live behind one async interface so they can run either in-process
// ("inline") or in a dedicated services worker ("worker") — the latter keeps
// multi-MB save serialization and synchronous node:sqlite calls off the
// frame thread, and gives the future user-plugin sandbox a capability-
// filtered facade to wrap (see scopeServicesForPlugin).
//
// The bridge (native-bridge.ts) is the only consumer; its HostAPI
// surface is unchanged — services mode is a host-level config decision.
// ============================================================================

import type { LoadResult, SaveResult, SaveState, SaveWarning } from "@downdraft/engine";
import { createImportCacheStore, type ImportCacheStore } from "@downdraft/engine/app/shared/import-cache-store";
import type {
    ImportCacheEntry,
    LoadOptions,
    SaveGenerationInfo,
    SaveOptions,
    SaveSlotInfo,
} from "@downdraft/engine/app/shared/types";
import { FileSaveStore } from "@downdraft/engine/libraries/persistence";
import { createLogger } from "@downdraft/engine/util/logger";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNativeUserDataDir } from "../bridge/user-data-dir";

const log = createLogger("info");

// ── API surface (worker-exposed; must stay structured-cloneable) ────────────

export interface HostServicesApi {
  /** Construct/open the underlying stores. Called once before first use. */
  init(opts: { saveDir: string; cacheDbPath: string; engineVersion: string }): Promise<void>;

  saveGame(slot: string, stateJson: string, saveOpts?: SaveOptions): Promise<boolean>;
  loadGame(slot: string, loadOpts?: LoadOptions): Promise<string | null>;
  /** Typed save/load — the native path. No JSON boundary: the caller hands
   *  over a real SaveState and gets the FileSaveStore's real SaveResult
   *  (bytes, gen) / LoadResult (meta, gen, blobs) back. Structured-cloneable
   *  across the services worker. */
  saveState(slot: string, state: SaveState, saveOpts?: SaveOptions): Promise<SaveResult>;
  loadState(slot: string, loadOpts?: LoadOptions): Promise<LoadResult>;
  deleteSave(slot: string): Promise<boolean>;
  listSaves(): Promise<SaveSlotInfo[]>;
  listGenerations(slot: string): Promise<SaveGenerationInfo[]>;
  deleteGeneration(slot: string, gen: number): Promise<boolean>;
  setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  getThumbnail(slot: string): Promise<ArrayBuffer | null>;
  setProperties(slot: string, props: Record<string, unknown>): Promise<void>;
  getProperties(slot: string): Promise<Record<string, unknown>>;

  importCacheGet(modelPath: string): Promise<ImportCacheEntry | null>;
  importCacheSet(modelPath: string, entry: ImportCacheEntry): Promise<void>;
  importCacheInvalidate(modelPath: string): Promise<void>;

  dispose(): Promise<void>;
}

// ── Inline implementation (shared by "inline" mode and the worker body) ─────

export function createInlineServices(emitWarning: (w: SaveWarning) => void): HostServicesApi {
  let saveStore: FileSaveStore | null = null;
  let importCache: ImportCacheStore | null = null;
  let engineVersion = "";

  const store = (): FileSaveStore => {
    if (!saveStore) throw new Error("HostServices not initialized — init() first");
    return saveStore;
  };
  const cache = (): ImportCacheStore => {
    if (!importCache) throw new Error("HostServices not initialized — init() first");
    return importCache;
  };

  return {
    async init(opts) {
      engineVersion = opts.engineVersion;
      // The cache db lives beside saves/ in userData — ensure both parents
      // exist before node:sqlite tries to open the file.
      mkdirSync(opts.saveDir, { recursive: true });
      mkdirSync(dirname(opts.cacheDbPath), { recursive: true });
      saveStore = new FileSaveStore({
        saveDir: opts.saveDir,
        engineVersion,
        skipMigrations: true,
      });
      saveStore.onWarning(emitWarning);
      importCache = createImportCacheStore(opts.cacheDbPath);
    },

    async saveGame(slot, stateJson, saveOpts) {
      try {
        const components = JSON.parse(stateJson);
        const result = await store().save(slot, {
          components,
          meta: { engineVersion, timestamp: Date.now() / 1000, entityCount: 0, playerCount: 0 },
        }, saveOpts);
        if (!result.success) log.error("services", `Save to slot '${slot}' failed`);
        return result.success;
      } catch (err) {
        log.error("services", `Save failed: ${err}`);
        return false;
      }
    },
    async loadGame(slot, loadOpts) {
      try {
        const result = await store().load(slot, loadOpts);
        return result.state ? JSON.stringify(result.state.components) : null;
      } catch (err) {
        log.error("services", `Load failed: ${err}`);
        return null;
      }
    },
    async saveState(slot, state, saveOpts) {
      try {
        const meta = {
          engineVersion: state.meta?.engineVersion || engineVersion,
          timestamp: state.meta?.timestamp || Date.now() / 1000,
          entityCount: state.meta?.entityCount ?? 0,
          playerCount: state.meta?.playerCount ?? 0,
        };
        const result = await store().save(slot, { ...state, meta }, saveOpts);
        if (!result.success) log.error("services", `Save to slot '${slot}' failed`);
        return result;
      } catch (err) {
        log.error("services", `Save failed: ${err}`);
        return { success: false, bytes: 0 };
      }
    },
    async loadState(slot, loadOpts) {
      try {
        return await store().load(slot, loadOpts);
      } catch (err) {
        log.error("services", `Load failed: ${err}`);
        return { state: null };
      }
    },
    deleteSave: (slot) => store().deleteSave(slot),
    listSaves: () => store().listSaves() as Promise<SaveSlotInfo[]>,
    listGenerations: (slot) => store().listGenerations(slot) as Promise<SaveGenerationInfo[]>,
    deleteGeneration: (slot, gen) => store().deleteGeneration(slot, gen),
    setThumbnail: (slot, data) => store().setThumbnail(slot, data),
    getThumbnail: (slot) => store().getThumbnail(slot),
    setProperties: (slot, props) => store().setProperties(slot, props),
    getProperties: (slot) => store().getProperties(slot),

    importCacheGet: (modelPath) => Promise.resolve(cache().get(modelPath)),
    importCacheSet: (modelPath, entry) => Promise.resolve(cache().set(modelPath, entry)),
    importCacheInvalidate: (modelPath) => Promise.resolve(cache().invalidate(modelPath)),

    async dispose() {
      importCache?.close();
      importCache = null;
      saveStore = null;
    },
  };
}

// ── Host-side handle ─────────────────────────────────────────────────────────

export interface HostServices {
  api: HostServicesApi;
  /** Save/load warnings from the store (worker events or direct callback). */
  onWarning(cb: (w: SaveWarning) => void): void;
  /** Tear down — terminates the worker when mode is "worker". */
  dispose(): Promise<void>;
}

export interface HostServicesOptions {
  appId: string;
  engineVersion: string;
  /** "worker" (default) isolates save/SQLite I/O on a services thread;
   *  "inline" runs the same impl in-process (debug/tests). */
  mode?: "inline" | "worker";
}

export async function createHostServices(opts: HostServicesOptions): Promise<HostServices> {
  const userData = resolveNativeUserDataDir(opts.appId);
  const initOpts = {
    saveDir: join(userData, "saves"),
    cacheDbPath: join(userData, "downdraft-import-cache.db"),
    engineVersion: opts.engineVersion,
  };
  const mode = opts.mode
    ?? (process.env.DOWNDRAFT_SERVICES === "inline" ? "inline" : "worker");

  if (mode === "worker") {
    try {
      return await createWorkerServices(initOpts);
    } catch (e) {
      log.warn("services", `services worker failed to start (${(e as Error).message}) — falling back to inline`);
    }
  }

  const warnSink = new Set<(w: SaveWarning) => void>();
  const api = createInlineServices((w) => warnSink.forEach((cb) => cb(w)));
  await api.init(initOpts);
  return {
    api,
    onWarning: (cb) => warnSink.add(cb),
    dispose: () => api.dispose(),
  };
}

async function createWorkerServices(initOpts: { saveDir: string; cacheDbPath: string; engineVersion: string }): Promise<HostServices> {
  const { wrap } = await import("@downdraft/engine/worker/rpc");
  const worker = new Worker(new URL("./services-worker.ts", import.meta.url).href);
  // HostServicesApi lacks WorkerApi's index signature — the proxy is typed
  // by construction, so assert through unknown.
  const wp = wrap(worker, { timeoutMs: 0 }) as unknown as {
    proxy: HostServicesApi;
    onEvents: (cb: (kind: string, data: any) => void) => () => void;
    terminate: () => void;
  };

  // init() must succeed before we hand the proxy out — a dead worker
  // surfaces here, not mid-save.
  await wp.proxy.init(initOpts);

  const warnSink = new Set<(w: SaveWarning) => void>();
  wp.onEvents((kind, data) => {
    if (kind === "save-warning") warnSink.forEach((cb) => cb(data as SaveWarning));
  });

  let disposed = false;
  return {
    api: wp.proxy,
    onWarning: (cb) => warnSink.add(cb),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try { await wp.proxy.dispose(); } catch { /* worker may already be gone */ }
      wp.terminate();
    },
  };
}

// ── Plugin gating ────────────────────────────────────────────────────────────
//
// User-authored plugins will run in their own sandboxed workers and receive a
// capability-filtered HostServices facade rather than the raw API. Slot names
// are forced into a `plugin:<namespace>:` prefix so a plugin can only touch
// its own save namespace, and the import cache (host-internal) is hidden
// entirely. This is the seam the plugin loader will use; it exists now so the
// boundary is real code, not a future refactor.

export function scopeServicesForPlugin(api: HostServicesApi, namespace: string): HostServicesApi {
  if (!/^[\w-]+$/.test(namespace)) throw new Error(`Invalid plugin namespace: ${namespace}`);
  // FileSaveStore sanitizes slot names to [a-zA-Z0-9_-] — use a safe prefix.
  const prefix = `plugin-${namespace}--`;
  const ns = (slot: string) => `${prefix}${slot.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const unscoped = (method: string) => () => {
    throw new Error(`Plugin '${namespace}': ${method} is not available to plugins`);
  };
  return {
    init: unscoped("init"),
    saveGame: (slot, json, opts) => api.saveGame(ns(slot), json, opts),
    loadGame: (slot, opts) => api.loadGame(ns(slot), opts),
    saveState: (slot, state, opts) => api.saveState(ns(slot), state, opts),
    loadState: (slot, opts) => api.loadState(ns(slot), opts),
    deleteSave: (slot) => api.deleteSave(ns(slot)),
    listSaves: async () =>
      (await api.listSaves())
        .filter((s) => s.slot.startsWith(prefix))
        .map((s) => ({ ...s, slot: s.slot.slice(prefix.length) })),
    listGenerations: (slot) => api.listGenerations(ns(slot)),
    deleteGeneration: (slot, gen) => api.deleteGeneration(ns(slot), gen),
    setThumbnail: unscoped("setThumbnail"),
    getThumbnail: unscoped("getThumbnail"),
    setProperties: (slot, props) => api.setProperties(ns(slot), props),
    getProperties: (slot) => api.getProperties(ns(slot)),
    importCacheGet: unscoped("importCacheGet"),
    importCacheSet: unscoped("importCacheSet"),
    importCacheInvalidate: unscoped("importCacheInvalidate"),
    dispose: unscoped("dispose"),
  };
}
