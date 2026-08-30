// ============================================================================
// Shared Module Interfaces — common contracts used by multiple game plugins.
//
// These interfaces are extracted from the individual plugin type files to
// eliminate duplicate definitions of the same concept across plugins.
// Plugins import from this file and extend the base interfaces where they
// need additional plugin-specific fields or methods.
// ============================================================================

/**
 * Biome provider — returns the biome ID at a world coordinate.
 *
 * Duplicated across:
 *   - wildlife plugin (WildlifeDeps.getBiomeAt)
 *   - fishing plugin (FishingBiomeProvider.getBiomeAt)
 *   - survival plugin (SurvivalBiomeProvider.getBiomeAt)
 *
 * All three plugins use the same signature: `(x, z) => biomeId`.
 * The survival plugin extends this with temperature/cold/hot queries.
 */
export interface BiomeProvider {
  getBiomeAt(x: number, z: number): number;
}

/**
 * Water provider — grid-based water surface height query.
 *
 * Used by the fishing plugin for water proximity checks.
 * The underlying implementation is WaterBufferWriter (from @downdraft/library-water),
 * which stores water heights on a grid.
 *
 * Note: the buoyancy plugin uses a different, world-coordinate-based
 * `sampleWaterAt(x, z)` method (BuoyancyDeps.sampleWaterAt) that internally
 * converts world coords to grid coords before delegating to the same
 * WaterBufferWriter.  These two interfaces are NOT the same shape and are
 * kept separate.
 */
export interface WaterProvider {
  getPatchSize(): number;
  getOrigin(): { x: number; z: number };
  sampleHeight(gx: number, gz: number): number;
}

/**
 * Spawn options for entity creation.
 *
 * Used by the wildlife plugin (WildlifeDeps.spawnEntity).
 * General-purpose enough to be shared across any plugin that spawns entities.
 */
export interface SpawnOpts {
  position: { x: number; y: number; z: number };
  scale?: number;
  flags?: number;
  health?: number;
  maxHealth?: number;
  data?: Float32Array;
}

/**
 * Entity provider — entity spawn/remove lifecycle.
 *
 * Used by the wildlife plugin (WildlifeDeps).
 * Other plugins that need to spawn or remove entities can adopt this interface.
 */
export interface EntityProvider {
  spawnEntity(type: number, opts: SpawnOpts): number;
  removeEntity(id: number): void;
}

/**
 * Minimal player state shared across plugins.
 *
 * Fishing and survival plugins both define player interfaces that include
 * these three fields with the same shape.  Module-specific player interfaces
 * extend this base with additional fields (e.g. inventory, health, hunger).
 *
 * Note: the wildlife and collision plugins use a flat `x/y/z` layout instead
 * of a nested `position` object, so they do NOT extend this interface.
 */
export interface PlayerState {
  active: boolean;
  position: { x: number; y: number; z: number };
  flags: number;
}
