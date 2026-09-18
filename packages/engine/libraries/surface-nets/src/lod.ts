// Re-export LOD manager from the marching cubes plugin.
// The LOD manager uses generateChunk (MC-specific) for its own chunk
// generation, but the LOD selection logic (distance-based) is algorithm-agnostic.
// Games that want surface nets LOD should use the streaming manager instead,
// which delegates mesh extraction to a configurable function.
export { DEFAULT_LOD_LEVELS, TerrainLODManager } from "@downdraft/engine/libraries/marching-cubes";
export type { ChunkLODEntry, LODLevel } from "@downdraft/engine/libraries/marching-cubes";
