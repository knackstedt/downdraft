// ============================================================================
// Persistence Types — interfaces for the versioned save/load system
// ============================================================================

// --- Component Section ---
// Each top-level key in a save body is a component section with its own
// schema version and data payload.

export interface ComponentSection {
  /** Schema version of this component's data */
  v: number;
  /** The component data payload */
  data: unknown;
}

// --- Save State ---
// The structured payload that gets serialized to the binary save format.
// Games populate this via ISimulation.serializeState() + IRendererStateProvider.

export interface SaveState {
  /** Per-component sections, each with its own schema version */
  components: Record<string, ComponentSection>;
  /** Metadata for the save header */
  meta: SaveMeta;
}

export interface SaveMeta {
  /** Engine/game semver that produced this save */
  engineVersion: string;
  /** Unix epoch seconds */
  timestamp: number;
  /** Number of entities in the save */
  entityCount: number;
  /** Number of players in the save */
  playerCount: number;
}

// --- Save File Info (from header/meta only, no decompression needed) ---

export interface SaveSlotInfo {
  slot: string;
  timestamp: number;
  entityCount: number;
  playerCount: number;
  engineVersion: string;
  /** File size in bytes (total across all generations for OPFS, single file for FileSaveStore) */
  fileSize: number;
  /** Current generation number (OPFS stores; 1 for FileSaveStore) */
  currentGen: number;
  /** Number of available generations (OPFS stores; 1 for FileSaveStore) */
  generationCount: number;
  /** Whether a thumbnail is stored for this slot */
  hasThumbnail: boolean;
  /** Slot-level properties (game mode, playtime, world name, etc.) */
  properties?: Record<string, unknown>;
}

// --- Generation Info ---
// Describes a single snapshot within a slot's generation history.

export interface SaveGenerationInfo {
  gen: number;
  timestamp: number;
  engineVersion: string;
  entityCount: number;
  playerCount: number;
  /** Compressed body size in bytes */
  bodySize: number;
  /** Number of binary blobs stored with this generation */
  blobCount: number;
}

// --- Save Options ---
// Passed to ISaveStore.save() to control generation retention and attach
// thumbnails, properties, and binary blobs.

export interface SaveOptions {
  /** Max generations to retain per slot. Older gens are pruned. Default: 3. */
  maxGenerations?: number;
  /** Thumbnail image data (PNG/WebP bytes). Stored as a separate file. */
  thumbnail?: ArrayBuffer | Uint8Array;
  /** Arbitrary slot-level properties (game mode, playtime, world name, etc.) */
  properties?: Record<string, unknown>;
  /** Binary blobs from the serializer (typed arrays keyed by blobRef). */
  blobs?: Record<string, ArrayBuffer>;
}

// --- Load Options ---

export interface LoadOptions {
  /** Load a specific generation instead of current. Default: current. */
  gen?: number;
  /** Whether to include binary blobs in the result. Default: true. */
  includeBlobs?: boolean;
}

// --- Save Result ---

export interface SaveResult {
  success: boolean;
  bytes: number;
  /** Generation number that was written */
  gen?: number;
  warning?: SaveWarning;
}

// --- Warnings ---

export type SaveWarningKind =
  | "corruption"
  | "migration_failed"
  | "forward_incompatible"
  | "backup_loaded"
  | "no_saves_found"
  | "abandoned_data";

export interface SaveWarning {
  kind: SaveWarningKind;
  slot: string;
  message: string;
  /** Component that failed migration, if applicable */
  component?: string;
  /** Abandoned data that could not be migrated (read-only) */
  abandonedData?: unknown;
}

// --- Load Result ---

export interface LoadResult {
  state: SaveState | null;
  /** Binary blobs keyed by blobRef (only present if includeBlobs was true) */
  blobs?: Record<string, ArrayBuffer>;
  /** Generation number that was loaded */
  gen?: number;
  warning?: SaveWarning;
}

// --- Migration System ---

export interface ComponentMigration {
  fromVersion: number;
  toVersion: number;
  migrate(data: unknown): unknown;
}

export interface IMigrationRegistry {
  register(component: string, migration: ComponentMigration): void;
  /**
   * Migrate a component's data from its saved version to the current version.
   * Returns the migrated data and final version, or null if migration is
   * impossible (missing step in the chain).
   */
  migrate(
    component: string,
    data: unknown,
    fromVersion: number,
  ): { data: unknown; version: number } | null;
  /** Get the latest registered version for a component */
  getLatestVersion(component: string): number;
  /** Register the current version for a component (used as migration target) */
  setCurrentVersion(component: string, version: number): void;
}

// --- Save Store Interface ---
// The unified interface for all save backends (OPFS, File, host bridge).
// save() and load() accept optional options for generation control, blobs,
// thumbnails, and properties. Backends that don't support a feature degrade
// gracefully (e.g. FileSaveStore returns generationCount: 1).

export interface ISaveStore {
  save(slot: string, state: SaveState, opts?: SaveOptions): Promise<SaveResult>;
  load(slot: string, opts?: LoadOptions): Promise<LoadResult>;
  listSaves(): Promise<SaveSlotInfo[]>;
  /** List all generations for a slot (newest first). */
  listGenerations(slot: string): Promise<SaveGenerationInfo[]>;
  deleteSave(slot: string): Promise<boolean>;
  /** Delete a specific generation from a slot. Returns false if not supported. */
  deleteGeneration(slot: string, gen: number): Promise<boolean>;
  /** Set the thumbnail image for a slot (PNG/WebP bytes). */
  setThumbnail(slot: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  /** Get the thumbnail image for a slot, or null if none. */
  getThumbnail(slot: string): Promise<ArrayBuffer | null>;
  /** Set slot-level properties (merged with existing). */
  setProperties(slot: string, props: Record<string, unknown>): Promise<void>;
  /** Get slot-level properties, or empty object if none. */
  getProperties(slot: string): Promise<Record<string, unknown>>;
  onWarning(cb: (warning: SaveWarning) => void): () => void;
}

// --- Renderer State Provider ---
// Games implement this to provide lightweight renderer metadata for saves.

export interface IRendererStateProvider {
  serializeRendererMeta(): Record<string, unknown>;
  restoreRendererMeta(meta: Record<string, unknown>): void;
}

// --- Save State Builder ---
// Helper for games to construct a SaveState from sim + renderer state.

export interface SaveStateBuilder {
  /** Set a component section with its schema version */
  setComponent(name: string, version: number, data: unknown): void;
  /** Set metadata */
  setMeta(meta: SaveMeta): void;
  /** Build the final SaveState */
  build(): SaveState;
}
