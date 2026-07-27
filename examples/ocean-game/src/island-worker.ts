// ─── Island generation worker — runs terrain generation in parallel ──
// Receives island params, generates voxel field + water field + LOD meshes, transfers results back.

import { extractMeshFromField, extractWaterMeshFromField, generateVoxelField, generateWaterVoxelField } from "./terrain.ts";

const lodConfigs = [
  { step: 1, distance: 0 },
  { step: 3, distance: 150 },
  { step: 6, distance: 350 },
];

const waterLodConfigs = [
  { step: 1, distance: 0 },
  { step: 3, distance: 150 },
  { step: 6, distance: 350 },
];

self.onmessage = (e: MessageEvent) => {
  const { index, chunkX, chunkZ, radius, biome } = e.data;

  const voxelField = generateVoxelField(chunkX, chunkZ, radius, biome);
  const waterVoxelField = generateWaterVoxelField(voxelField, chunkX, chunkZ, radius);

  const lodMeshes = lodConfigs.map(({ step, distance }) => {
    const mesh = extractMeshFromField(voxelField, biome, 500000, step);
    return { ...mesh, lodLevel: step, lodDistance: distance };
  });

  const waterLodMeshes = waterLodConfigs.map(({ step, distance }) => {
    const mesh = extractWaterMeshFromField(waterVoxelField, 200000, step);
    return { ...mesh, lodLevel: step, lodDistance: distance };
  });

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
