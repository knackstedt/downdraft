// ============================================================================
// @downdraft/engine/libraries/persistence — versioned, compressed save system
// ============================================================================
//
// FileSaveStore writes under a node:fs directory (used by the native host's
// HostServices). DirectorySaveStore writes under a FileSystemDirectoryHandle —
// OPFS in browsers, a node-fs-backed handle everywhere else — and is the
// worker-owned store option for sim workers that want to persist without a
// host round-trip.

export { FileSaveStore } from "./file-save-store";
export type { FileSaveStoreOptions } from "./file-save-store";

export { createNodeFsDirectoryHandle, NodeFsDirectoryHandle } from "./node-fs-directory-handle";

export { AutosaveManager } from "./autosave-manager";
export type { AutosaveManagerOptions } from "./autosave-manager";

export { DirectorySaveStore } from "./directory-save-store";
export type { DirectorySaveStoreOptions } from "./directory-save-store";

export { BinaryRecordStore, createBinaryRecordStore } from "./binary-record-store";
export type { BinaryRecordStoreOptions, IBinaryRecordStore } from "./binary-record-store";

// Re-export core types for convenience
export {
    decodeHeader, encodeHeader, engineVersionString, HEADER_SIZE, MigrationRegistryImpl,
    packEngineVersion, readHeaderFromFile, SAVE_FORMAT_VERSION, SAVE_MAGIC, unpackEngineVersion, XXH128_SIZE
} from "@downdraft/engine/index";

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
} from "@downdraft/engine/index";

// Declarative library descriptor
export { PersistenceLib, PersistenceTok } from "./library";
export type { PersistenceLibConfig } from "./library";

