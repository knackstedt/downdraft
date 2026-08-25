// ============================================================================
// @downdraft/library-persistence — versioned, compressed save system
// ============================================================================
//
// This barrel re-exports everything including FileSaveStore (Node-only).
// For browser/renderer code that cannot import node:fs/node:path, import from
// @downdraft/library-persistence/browser instead.

export { FileSaveStore } from "./file-save-store";
export type { FileSaveStoreOptions } from "./file-save-store";

export { AutosaveManager } from "./autosave-manager";
export type { AutosaveManagerOptions } from "./autosave-manager";

export { OpfsSaveStore } from "./opfs-save-store";
export type { OpfsSaveStoreOptions } from "./opfs-save-store";

export { IndexedDBSaveStore } from "./indexeddb-save-store";
export type { IndexedDBSaveStoreOptions } from "./indexeddb-save-store";

export { SaveWorkerProxy } from "./save-worker-proxy";
export type { SaveWorkerProxyOptions } from "./save-worker-proxy";

export type { SaveWorkerApi } from "./save-worker";

// Re-export core types for convenience
export {
    decodeHeader, encodeHeader, engineVersionString, HEADER_SIZE, MigrationRegistryImpl,
    packEngineVersion, readHeaderFromFile, SAVE_FORMAT_VERSION, SAVE_MAGIC, unpackEngineVersion, XXH128_SIZE
} from "@downdraft/core/index";

export type {
    ComponentMigration,
    ComponentSection,
    IMigrationRegistry,
    IRendererStateProvider,
    ISaveStore,
    LoadOptions,
    LoadResult,
    SaveGenerationInfo,
    SaveHeader,
    SaveMeta,
    SaveOptions,
    SaveResult,
    SaveSlotInfo,
    SaveState,
    SaveStateBuilder,
    SaveWarning,
    SaveWarningKind
} from "@downdraft/core/index";

