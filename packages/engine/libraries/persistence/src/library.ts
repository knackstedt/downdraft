// ============================================================================
// PersistenceLib — declarative engine library descriptor for @downdraft/engine/libraries/persistence
//
// Games declare `libraries: [PersistenceLib]` (or with config override) in
// their GameModule. The host creates an OpfsSaveStore (sim-side), initializes
// it, and exposes it via a typed token.
//
// Games that need full control can still import OpfsSaveStore, FileSaveStore,
// or SaveWorkerProxy directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import type { ISaveStore } from "@downdraft/engine/save/persist-types";
import { createLogger } from "@downdraft/engine/util/logger";
import { OpfsSaveStore } from "./opfs-save-store";

const log = createLogger("info");

// ── Config ──

export interface PersistenceLibConfig {
  /** Engine/game version string for save headers (e.g. "0.1.0"). Required. */
  engineVersion: string;
  /** Subdirectory name under OPFS root for saves. Default: "saves". */
  savesDirName?: string;
  /** Default max generations per slot. Default: 3. */
  maxGenerations?: number;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side save store. Inject in sim systems that need save/load. */
export const PersistenceTok = resourceToken<ISaveStore>("persistence:save-store");

// ── Descriptor ──

export const PersistenceLib: EngineLibrary<PersistenceLibConfig> = {
  name: "persistence",
  version: "1.0.0",

  provides: [PersistenceTok],

  sim: {
    create(config, ctx) {
      const store = new OpfsSaveStore({
        engineVersion: config.engineVersion,
        savesDirName: config.savesDirName,
        maxGenerations: config.maxGenerations,
      });
      // init() is async (resolves the OPFS root directory). The host calls
      // create() synchronously, so we kick off init() and let the game await
      // it in onReady if needed. The store is safe to provide immediately;
      // save/load calls will throw until init() resolves.
      store.init().catch((err) => {
        log.error("persistence-lib", `OpfsSaveStore init failed: ${err}`);
      });
      ctx.provide(PersistenceTok, store);
      return store;
    },
    dispose(_store) {
      // OpfsSaveStore holds OPFS directory handles — no explicit destroy/cleanup
      // method. The handles are GC'd when the store is dropped.
    },
  },

  // No tick — save/load is event-driven (autosave interval, manual saves).

  // No renderer setup — persistence is sim-side only.

  defaultConfig: {
    engineVersion: "0.0.0",
    maxGenerations: 3,
  },
};
