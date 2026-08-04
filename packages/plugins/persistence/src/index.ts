// ============================================================================
// @downdraft/plugin-persistence — versioned, compressed save system
// ============================================================================

export { FileSaveStore } from "./file-save-store";
export type { FileSaveStoreOptions } from "./file-save-store";

// Re-export core types for convenience
export {
  MigrationRegistryImpl,
  packEngineVersion,
  unpackEngineVersion,
  engineVersionString,
  encodeHeader,
  decodeHeader,
  readHeaderFromFile,
  SAVE_MAGIC,
  SAVE_FORMAT_VERSION,
  HEADER_SIZE,
  XXH128_SIZE,
} from "@downdraft/core/index";

export type {
  ComponentMigration,
  ComponentSection,
  IMigrationRegistry,
  IRendererStateProvider,
  ISaveStore,
  LoadResult,
  SaveHeader,
  SaveMeta,
  SaveResult,
  SaveSlotInfo,
  SaveState,
  SaveStateBuilder,
  SaveWarning,
  SaveWarningKind,
} from "@downdraft/core/index";
