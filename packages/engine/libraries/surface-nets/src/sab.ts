// Re-export SAB channel from the marching cubes plugin.
// The SAB channel is a shared array buffer for terrain heightmap data —
// it has no dependency on the mesh extraction algorithm.
export { TerrainChannel, TerrainSABChannel } from "@downdraft/engine/libraries/marching-cubes";
