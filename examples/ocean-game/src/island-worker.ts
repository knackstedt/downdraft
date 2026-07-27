// ─── Island generation worker — runs terrain generation in parallel ──
// Receives island params, generates voxel field + water field + LOD meshes, transfers results back.

import { generateIslandMeshes } from "./terrain.ts";

self.onmessage = (e: MessageEvent) => {
  const { index, chunkX, chunkZ, radius, biome } = e.data;

  const { voxelField, waterVoxelField, lodMeshes, waterLodMeshes } = generateIslandMeshes(chunkX, chunkZ, radius, biome);

  const transfers: ArrayBuffer[] = [
    voxelField.data.buffer,
    waterVoxelField.data.buffer,
    waterVoxelField.heights.buffer,
    waterVoxelField.velocities.buffer,
    waterVoxelField.boundaryMask.buffer,
    waterVoxelField.shoreMask.buffer,
  ];
  for (const mesh of lodMeshes) {
    transfers.push(mesh.verts.buffer);
    transfers.push(mesh.indices.buffer);
  }
  for (const mesh of waterLodMeshes) {
    transfers.push(mesh.verts.buffer);
    transfers.push(mesh.indices.buffer);
  }

  (self as any).postMessage({ index, voxelField, lodMeshes, waterVoxelField, waterLodMeshes }, transfers);
};
