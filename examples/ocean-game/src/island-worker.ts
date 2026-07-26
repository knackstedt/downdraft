// ─── Island generation worker — runs terrain generation in parallel ──
// Receives island params, generates voxel field + LOD meshes, transfers results back.

import { extractMeshFromField, generateVoxelField } from "./terrain.ts";

const lodConfigs = [
  { step: 1, distance: 0 },
  { step: 3, distance: 150 },
  { step: 6, distance: 350 },
];

self.onmessage = (e: MessageEvent) => {
  const { index, chunkX, chunkZ, radius, biome } = e.data;

  const voxelField = generateVoxelField(chunkX, chunkZ, radius, biome);
  const lodMeshes = lodConfigs.map(({ step, distance }) => {
    const mesh = extractMeshFromField(voxelField, biome, 500000, step);
    return { ...mesh, lodLevel: step, lodDistance: distance };
  });

  const transfers: ArrayBuffer[] = [voxelField.data.buffer];
  for (const mesh of lodMeshes) {
    transfers.push(mesh.verts.buffer);
    transfers.push(mesh.indices.buffer);
  }

  (self as any).postMessage({ index, voxelField, lodMeshes }, transfers);
};
