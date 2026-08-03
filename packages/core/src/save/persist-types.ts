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

// --- Save File Info (from header only, no decompression needed) ---

export interface SaveSlotInfo {
  slot: string;
  timestamp: number;
  entityCount: number;
  playerCount: number;
  engineVersion: string;
  /** File size in bytes */
  fileSize: number;
}

// --- Save Result ---

export interface SaveResult {
  success: boolean;
  bytes: number;
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

export interface ISaveStore {
  save(slot: string, state: SaveState): Promise<SaveResult>;
  load(slot: string): Promise<LoadResult>;
  listSaves(): Promise<SaveSlotInfo[]>;
  deleteSave(slot: string): Promise<boolean>;
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
