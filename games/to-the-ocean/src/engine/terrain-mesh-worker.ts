// ============================================================================
// TerrainMeshWorker — Web Worker for CPU-heavy terrain mesh generation
// Holds ChunkedVoxelField + ChunkedFieldContext per island, returns mesh data
// via Transferable TypedArrays (zero-copy).
// ============================================================================

import { ChunkedVoxelField } from "@downdraft/plugin-marching-cubes";
import { generateDecorationMesh, generateDecorations } from "@shared/island-decorations";
import { extractMesh, extractMeshSubRegion } from "@shared/marching-cubes";
import {
    createChunkedVoxelField,
    generatePortVoxelField,
    getChunkMeshSubRegion,
    materializeChunkForMesh,
    type ChunkedFieldContext,
} from "@shared/terrain";
import { BiomeType, IslandSize, PortSize, PortTheme } from "@shared/types";
import { PerlinNoise } from "@shared/world/perlin-noise";
import { generatePortMesh } from "./port-mesh-generator";
import {
    type CreateIslandFieldRequest,
    type CreateIslandFieldResult,
    type GenerateChunkMeshRequest,
    type GenerateChunkMeshResult,
    type GenerateDecorationMeshRequest,
    type GenerateDecorationMeshResult,
    type GeneratePortStructureMeshRequest,
    type GeneratePortStructureMeshResult,
    type GeneratePortTerrainMeshRequest,
    type GeneratePortTerrainMeshResult,
    type JobMessage,
    type JobResultMessage,
    type PendingChunkInfo
} from "./terrain-mesh-types";

// --- Per-island field storage (stays in the worker) ---

interface IslandFieldEntry {
  field: ChunkedVoxelField;
  ctx: ChunkedFieldContext;
  cliffNoiseFn: (x: number, y: number, z: number) => number;
}

const islandFields = new Map<string, IslandFieldEntry>();

// --- Task functions ---

function taskCreateIslandField(req: CreateIslandFieldRequest): { result: CreateIslandFieldResult; transfer: Transferable[] } {
  const { key, chunkX, chunkZ, radius, biome, islandSize } = req;

  const { field, ctx } = createChunkedVoxelField(chunkX, chunkZ, radius, biome, islandSize);
  const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
  const cliffNoiseFn = (x: number, y: number, z: number) => cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);

  islandFields.set(key, { field, ctx, cliffNoiseFn });

  // Build pending chunk list sorted by distance from island center
  const pendingChunks: PendingChunkInfo[] = [];
  let totalChunks = 0;

  for (let cx = 0; cx < field.chunkDimX; cx++) {
    for (let cy = 0; cy < field.chunkDimY; cy++) {
      for (let cz = 0; cz < field.chunkDimZ; cz++) {
        const chunkIdx = cx * field.chunkDimY * field.chunkDimZ + cy * field.chunkDimZ + cz;
        if (field.chunkOffsets[chunkIdx] < 0) continue;
        const gx0 = cx * field.chunkSize;
        const gz0 = cz * field.chunkSize;
        const chunkCenterX = chunkX + (gx0 + field.chunkSize / 2) * field.voxelSize + field.originX;
        const chunkCenterZ = chunkZ + (gz0 + field.chunkSize / 2) * field.voxelSize + field.originZ;
        const dx = chunkCenterX - chunkX;
        const dz = chunkCenterZ - chunkZ;
        const distSq = dx * dx + dz * dz;
        const chunkKey = `${cx},${cy},${cz}`;
        pendingChunks.push({ cx, cy, cz, chunkKey, distSq });
        totalChunks++;
      }
    }
  }

  pendingChunks.sort((a, b) => a.distSq - b.distSq);

  const result: CreateIslandFieldResult = {
    pendingChunks,
    totalChunks,
    isEmpty: totalChunks === 0,
    fieldMeta: {
      dimX: field.dimX,
      dimY: field.dimY,
      dimZ: field.dimZ,
      voxelSize: field.voxelSize,
      originX: field.originX,
      originY: field.originY,
      originZ: field.originZ,
      radius: field.radius,
      chunkSize: field.chunkSize,
      chunkDimX: field.chunkDimX,
      chunkDimY: field.chunkDimY,
      chunkDimZ: field.chunkDimZ,
    },
  };

  return { result, transfer: [] };
}

function taskGenerateChunkMesh(req: GenerateChunkMeshRequest): { result: GenerateChunkMeshResult; transfer: Transferable[] } {
  const { key, cx, cy, cz } = req;
  const entry = islandFields.get(key);
  if (!entry) {
    return {
      result: { verts: new Float32Array(0), indices: new Uint16Array(0), useUint32: false, worldCenterX: 0, worldCenterY: 0, worldCenterZ: 0, boundingRadius: 0, hasMesh: false },
      transfer: [],
    };
  }

  const { field, ctx, cliffNoiseFn } = entry;

  const matField = materializeChunkForMesh(field, ctx, cx, cy, cz);
  if (!matField) {
    return {
      result: { verts: new Float32Array(0), indices: new Uint16Array(0), useUint32: false, worldCenterX: 0, worldCenterY: 0, worldCenterZ: 0, boundingRadius: 0, hasMesh: false },
      transfer: [],
    };
  }

  const sub = getChunkMeshSubRegion(field, cx, cy, cz);
  const extracted = extractMeshSubRegion(matField, sub.x0, sub.y0, sub.z0, sub.x1, sub.y1, sub.z1, cliffNoiseFn);
  if (extracted.verts.length === 0 || extracted.indices.length === 0) {
    return {
      result: { verts: new Float32Array(0), indices: new Uint16Array(0), useUint32: false, worldCenterX: 0, worldCenterY: 0, worldCenterZ: 0, boundingRadius: 0, hasMesh: false },
      transfer: [],
    };
  }

  const verts = extracted.verts;
  const r = field.radius;
  for (let i = 0; i < verts.length; i += 9) {
    verts[i] /= r;
    verts[i + 1] /= r;
    verts[i + 2] /= r;
  }

  const indexBuf = extracted.indices;
  let indexData: Uint16Array | Uint32Array;
  if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
    indexData = new Uint16Array(indexBuf.length + 1);
    indexData.set(indexBuf);
  } else {
    indexData = indexBuf as Uint16Array | Uint32Array;
  }

  const halfChunk = field.chunkSize / 2;
  const islandX = parseFloat(key.split(",")[0]);
  const islandZ = parseFloat(key.split(",")[1]);
  const wcx = islandX + (cx * field.chunkSize + halfChunk) * field.voxelSize + field.originX;
  const wcy = (cy * field.chunkSize + halfChunk) * field.voxelSize + field.originY;
  const wcz = islandZ + (cz * field.chunkSize + halfChunk) * field.voxelSize + field.originZ;
  const chunkRadius = halfChunk * field.voxelSize * 1.5;

  const result: GenerateChunkMeshResult = {
    verts,
    indices: indexData,
    useUint32: extracted.useUint32,
    worldCenterX: wcx,
    worldCenterY: wcy,
    worldCenterZ: wcz,
    boundingRadius: chunkRadius,
    hasMesh: true,
  };

  return {
    result,
    transfer: [verts.buffer, indexData.buffer],
  };
}

function taskGenerateDecorationMesh(req: GenerateDecorationMeshRequest): { result: GenerateDecorationMeshResult; transfer: Transferable[] } {
  const { chunkX, chunkZ, biome, islandSize, islandRadius } = req;

  const placements = generateDecorations(chunkX, chunkZ, biome as BiomeType, islandSize as IslandSize, islandRadius);
  if (placements.length === 0) {
    return {
      result: { verts: new Float32Array(0), indices: new Uint16Array(0), hasMesh: false },
      transfer: [],
    };
  }

  const mesh = generateDecorationMesh(placements);
  if (mesh.verts.length === 0 || mesh.indices.length === 0) {
    return {
      result: { verts: new Float32Array(0), indices: new Uint16Array(0), hasMesh: false },
      transfer: [],
    };
  }

  let indexData: Uint16Array = mesh.indices;
  if (mesh.indices.length % 2 !== 0) {
    indexData = new Uint16Array(mesh.indices.length + 1);
    indexData.set(mesh.indices);
  }

  const result: GenerateDecorationMeshResult = {
    verts: mesh.verts,
    indices: indexData,
    hasMesh: true,
  };

  return {
    result,
    transfer: [mesh.verts.buffer, indexData.buffer],
  };
}

function taskGeneratePortTerrainMesh(req: GeneratePortTerrainMeshRequest): { result: GeneratePortTerrainMeshResult; transfer: Transferable[] } {
  const { chunkX, chunkZ, radius, biome } = req;

  const field = generatePortVoxelField(chunkX, chunkZ, radius, biome);
  const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
  const cliffNoiseFn = (x: number, y: number, z: number) => cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);

  const extracted = extractMesh(field, cliffNoiseFn);
  if (extracted.verts.length === 0 || extracted.indices.length === 0) {
    return {
      result: { verts: new Float32Array(0), indices: new Uint16Array(0), useUint32: false, hasMesh: false },
      transfer: [],
    };
  }

  const verts = extracted.verts;
  for (let i = 0; i < verts.length; i += 9) {
    verts[i] /= radius;
    verts[i + 1] /= radius;
    verts[i + 2] /= radius;
  }

  const indexBuf = extracted.indices;
  let indexData: Uint16Array | Uint32Array;
  if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
    indexData = new Uint16Array(indexBuf.length + 1);
    indexData.set(indexBuf);
  } else {
    indexData = indexBuf as Uint16Array | Uint32Array;
  }

  const result: GeneratePortTerrainMeshResult = {
    verts,
    indices: indexData,
    useUint32: extracted.useUint32,
    hasMesh: true,
  };

  return {
    result,
    transfer: [verts.buffer, indexData.buffer],
  };
}

function taskGeneratePortStructureMesh(req: GeneratePortStructureMeshRequest): { result: GeneratePortStructureMeshResult; transfer: Transferable[] } {
  const { chunkX, chunkZ, radius, biome } = req;

  const portSize = radius <= 18 ? PortSize.Small : radius <= 32 ? PortSize.Medium : PortSize.Large;
  const seed = chunkX * 83492791 + chunkZ * 26515163;
  const portMesh = generatePortMesh({ size: portSize, theme: PortTheme.Fishing, services: [], seed, biome: biome as BiomeType });

  let maxExtent = 0;
  for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
    maxExtent = Math.max(maxExtent, Math.abs(portMesh.vertices[vi]), Math.abs(portMesh.vertices[vi + 1]), Math.abs(portMesh.vertices[vi + 2]));
  }
  const normScale = maxExtent > 0 ? 1 / maxExtent : 1;

  const verts = new Float32Array(portMesh.vertices.length);
  for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
    verts[vi] = portMesh.vertices[vi] * normScale;
    verts[vi + 1] = portMesh.vertices[vi + 1] * normScale;
    verts[vi + 2] = portMesh.vertices[vi + 2] * normScale;
    for (let j = 3; j < 9; j++) verts[vi + j] = portMesh.vertices[vi + j];
  }

  const vertCount = portMesh.vertices.length / 9;
  const useUint32 = vertCount > 65535;
  const indices = useUint32 ? new Uint32Array(portMesh.indices) : new Uint16Array(portMesh.indices);

  const result: GeneratePortStructureMeshResult = {
    verts,
    indices,
    useUint32,
    hasMesh: true,
  };

  return {
    result,
    transfer: [verts.buffer, indices.buffer],
  };
}

// --- Message handler ---

const taskMap: Record<string, (args: any) => { result: any; transfer: Transferable[] }> = {
  createIslandField: taskCreateIslandField,
  generateChunkMesh: taskGenerateChunkMesh,
  generateDecorationMesh: taskGenerateDecorationMesh,
  generatePortTerrainMesh: taskGeneratePortTerrainMesh,
  generatePortStructureMesh: taskGeneratePortStructureMesh,
};

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as JobMessage;
  if (!msg || msg.__job !== true) return;

  const fn = taskMap[msg.fn];
  if (!fn) {
    const errResult: JobResultMessage = { __jobResult: true, id: msg.id, error: `Unknown function: ${msg.fn}` };
    (self as any).postMessage(errResult);
    return;
  }

  try {
    const { result, transfer } = fn(msg.args[0]);
    const resultMsg: JobResultMessage = { __jobResult: true, id: msg.id, result };
    (self as any).postMessage(resultMsg, transfer);
  } catch (err) {
    const errResult: JobResultMessage = { __jobResult: true, id: msg.id, error: String(err) };
    (self as any).postMessage(errResult);
  }
};
