// Re-export the streaming manager from the marching cubes plugin.
// The streaming manager manages voxel field lifecycle (chunk generation,
// LOD transitions, deformation batching) but does NOT perform mesh extraction.
// Mesh extraction happens in the game layer (the game's terrain renderer) which
// calls extractMeshFromField from whichever plugin is configured.
//
// Therefore the streaming manager is fully algorithm-agnostic and can be
// re-exported as-is.
export { TerrainStreamingManager } from "@downdraft/engine/libraries/marching-cubes";
export type {
    ChunkEmptyChecker,
    ChunkFieldFactory,
    ChunkGenerator, DirtyTerrain, PhysicsFieldFactory, TerrainDeformation, TerrainEntityPosition, TerrainEntry, TerrainLODChange
} from "@downdraft/engine/libraries/marching-cubes";

