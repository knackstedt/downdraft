import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "@downdraft/core";
import { CHUNK_FULL, ChunkedVoxelField, VoxelField, getChunkedVoxel, setChunkedVoxel } from "@downdraft/plugin-marching-cubes";
import { generateDecorationMesh, generateDecorations } from "@shared/island-decorations";
import { extractMesh, extractMeshSubRegion } from "@shared/marching-cubes";
import {
    createChunkedVoxelField,
    generatePortVoxelField,
    getChunkMeshSubRegion,
    materializeChunkForMesh,
    promoteChunkWithData,
    type ChunkedFieldContext,
} from "@shared/terrain";
import { TERRAIN_CONFIG } from "@shared/terrain-config";
import { BiomeType, EntityType, IslandSize, PortSize, PortTheme } from "@shared/types";
import { PerlinNoise } from "@shared/world/perlin-noise";
import { generatePortMesh } from "../port-mesh-generator";
import { BOAT_WGSL, ISLAND_WGSL } from "../shaders/entity-shaders";
import type { EntityRenderContext } from "./render-context";

interface IslandMesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  useUint32: boolean;
  lineIndices: GPUBuffer | null;
  lineIndexCount: number;
}

interface ChunkMeshEntry extends IslandMesh {
  worldCenterX: number;
  worldCenterY: number;
  worldCenterZ: number;
  boundingRadius: number;
}

interface PortTerrainMesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  useUint32: boolean;
}

interface PortStructureMesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  useUint32: boolean;
}

interface DecorationMesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
}

interface PendingDeformation {
  chunkX: number; chunkZ: number; isPort: boolean;
  worldX: number; worldY: number; worldZ: number;
  entityWorldX: number; entityWorldY: number; entityWorldZ: number;
  radius: number; strength: number;
}

export class IslandTerrainRenderer {
  private ctx: EntityRenderContext;

  // Per-island terrain meshes (keyed by "chunkX,chunkZ")
  private islandMeshes = new Map<string, IslandMesh>();
  private activeIslandKeys = new Set<string>();
  private islandEmptyKeys = new Set<string>();
  private islandVoxelFields = new Map<string, VoxelField>();

  // Per-port terrain meshes
  private portTerrainMeshes = new Map<string, PortTerrainMesh>();
  private activePortKeys = new Set<string>();
  private portEmptyKeys = new Set<string>();
  private portVoxelFields = new Map<string, VoxelField>();

  // Chunked island mesh streaming
  private islandChunkMeshes = new Map<string, Map<string, ChunkMeshEntry>>();
  private islandChunkPending = new Map<string, { x: number; y: number; z: number; chunkKey: string; distSq: number }[]>();
  private islandChunkField = new Map<string, VoxelField>();
  private islandChunkTotalChunks = new Map<string, number>();
  private islandChunkCliffNoise = new Map<string, (x: number, y: number, z: number) => number>();
  private islandChunkedFields = new Map<string, ChunkedVoxelField>();
  private islandChunkedCtxs = new Map<string, ChunkedFieldContext>();

  // Per-island decoration meshes
  private decorationMeshes = new Map<string, DecorationMesh>();
  private activeDecorationKeys = new Set<string>();
  private decorationEmptyKeys = new Set<string>();

  // Port structure meshes
  private portStructureMeshes = new Map<string, PortStructureMesh>();
  private activePortStructureKeys = new Set<string>();

  // Pending terrain deformations
  private pendingDeformations: PendingDeformation[] = [];

  // Pooled voxel collision data
  private pooledVoxelData: Float32Array | null = null;
  private pooledVoxelResult: { data: Float32Array; originX: number; originY: number; originZ: number; voxelSize: number; dimX: number; dimY: number; dimZ: number; isoLevel: number } | null = null;
  private pooledNearby: { field: ChunkedVoxelField | VoxelField; isChunked: boolean; worldOriginX: number; worldOriginY: number; worldOriginZ: number; voxelSize: number; isoLevel: number }[] = [];

  // Legacy port meshes (fallback, one per size)
  portVertices: (GPUBuffer | null)[] = [null, null, null];
  portIndices: (GPUBuffer | null)[] = [null, null, null];
  portIndexCounts: number[] = [0, 0, 0];
  portNormalizationScales: number[] = [1, 1, 1];

  islandPipeline: GPURenderPipeline | null = null;
  boatPipeline: GPURenderPipeline | null = null;

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(pbrLitPipelineLayout: GPUPipelineLayout): void {
    const device = this.ctx.device;
    const format = this.ctx.format;

    const dev = device;
    const islandShaderModule = dev.createShaderModule({ code: ISLAND_WGSL });
    const boatShaderModule = dev.createShaderModule({ code: BOAT_WGSL });

    this.islandPipeline = dev.createRenderPipeline({
      layout: pbrLitPipelineLayout,
      vertex: {
        module: islandShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: islandShaderModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.boatPipeline = dev.createRenderPipeline({
      layout: pbrLitPipelineLayout,
      vertex: {
        module: boatShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: boatShaderModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Generate procedural port meshes (one per size, normalized to unit scale)
    const portSizes = [PortSize.Small, PortSize.Medium, PortSize.Large];
    for (let ps = 0; ps < 3; ps++) {
      const portMesh = generatePortMesh({
        size: portSizes[ps],
        theme: PortTheme.Fishing,
        services: [],
        seed: 1000 + ps * 100,
        biome: BiomeType.Ocean,
      });
      let maxExtent = 0;
      for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
        maxExtent = Math.max(maxExtent, Math.abs(portMesh.vertices[vi]), Math.abs(portMesh.vertices[vi + 1]), Math.abs(portMesh.vertices[vi + 2]));
      }
      const normScale = maxExtent > 0 ? 1 / maxExtent : 1;
      this.portNormalizationScales[ps] = normScale;
      const verts = new Float32Array(portMesh.vertices.length);
      for (let vi = 0; vi < portMesh.vertices.length; vi += 9) {
        verts[vi] = portMesh.vertices[vi] * normScale;
        verts[vi + 1] = portMesh.vertices[vi + 1] * normScale;
        verts[vi + 2] = portMesh.vertices[vi + 2] * normScale;
        for (let j = 3; j < 9; j++) verts[vi + j] = portMesh.vertices[vi + j];
      }
      this.portVertices[ps] = dev.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      dev.queue.writeBuffer(this.portVertices[ps]!, 0, verts as any);
      const indices = new Uint16Array(portMesh.indices);
      this.portIndexCounts[ps] = indices.length;
      this.portIndices[ps] = dev.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      dev.queue.writeBuffer(this.portIndices[ps]!, 0, indices as any);
    }
  }

  // --- Public API ---

  ensureIslandMesh(chunkX: number, chunkZ: number, radius: number, biome: number, islandSize: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.islandMeshes.has(key) || this.islandEmptyKeys.has(key)) {
      this.activeIslandKeys.add(key);
      return;
    }
    if (this.islandChunkMeshes.has(key)) {
      this.activeIslandKeys.add(key);
      return;
    }

    const { field: cf, ctx: cfCtx } = createChunkedVoxelField(chunkX, chunkZ, radius, biome, islandSize);
    this.islandChunkedFields.set(key, cf);
    this.islandChunkedCtxs.set(key, cfCtx);
    this.setupChunkedIslandFromChunkedField(key, cf, cfCtx, chunkX, chunkZ, radius);
    this.activeIslandKeys.add(key);
  }

  ensureDecorationMesh(chunkX: number, chunkZ: number, biome: number, islandSize: number, islandRadius: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.decorationMeshes.has(key) || this.decorationEmptyKeys.has(key)) {
      this.activeDecorationKeys.add(key);
      return;
    }

    const existingField = this.islandVoxelFields.get(key) ?? this.islandChunkField.get(key) ?? undefined;
    const placements = generateDecorations(chunkX, chunkZ, biome as BiomeType, islandSize as IslandSize, islandRadius, existingField);
    if (placements.length === 0) {
      this.decorationEmptyKeys.add(key);
      this.activeDecorationKeys.add(key);
      return;
    }

    const mesh = generateDecorationMesh(placements);
    if (mesh.verts.length === 0 || mesh.indices.length === 0) {
      this.decorationEmptyKeys.add(key);
      this.activeDecorationKeys.add(key);
      return;
    }

    const device = this.ctx.device!;
    const vertices = device.createBuffer({
      size: mesh.verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertices, 0, mesh.verts as any);

    let indexData: Uint16Array = mesh.indices;
    if (mesh.indices.length % 2 !== 0) {
      indexData = new Uint16Array(mesh.indices.length + 1);
      indexData.set(mesh.indices);
    }
    const indices = device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indices, 0, indexData as any);

    this.decorationMeshes.set(key, { vertices, indices, indexCount: mesh.indices.length });
    this.activeDecorationKeys.add(key);
  }

  ensurePortMesh(chunkX: number, chunkZ: number, radius: number, biome: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.portTerrainMeshes.has(key) || this.portEmptyKeys.has(key)) {
      this.activePortKeys.add(key);
      return;
    }

    const device = this.ctx.device!;
    const field = generatePortVoxelField(chunkX, chunkZ, radius, biome);
    this.portVoxelFields.set(key, field);

    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    const cliffNoiseFn = (x: number, y: number, z: number) => cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);

    const extracted = extractMesh(field, cliffNoiseFn);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) {
      this.portEmptyKeys.add(key);
      this.activePortKeys.add(key);
      return;
    }

    const verts = extracted.verts;
    for (let i = 0; i < verts.length; i += 9) {
      verts[i] /= radius;
      verts[i + 1] /= radius;
      verts[i + 2] /= radius;
    }

    const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) {
      indexData = new Uint16Array(indexBuf.length + 1);
      indexData.set(indexBuf);
    } else {
      indexData = indexBuf as Uint16Array | Uint32Array;
    }

    const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indices, 0, indexData as any);

    this.portTerrainMeshes.set(key, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32 });
    this.activePortKeys.add(key);
  }

  ensurePortStructureMesh(chunkX: number, chunkZ: number, radius: number, biome: number): void {
    const key = `${chunkX},${chunkZ}`;
    if (this.portStructureMeshes.has(key)) {
      this.activePortStructureKeys.add(key);
      return;
    }

    const device = this.ctx.device!;
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

    const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertices, 0, verts as any);
    const indexBuffer = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indexBuffer, 0, indices as any);

    this.portStructureMeshes.set(key, { vertices, indices: indexBuffer, indexCount: portMesh.indices.length, useUint32 });
    this.activePortStructureKeys.add(key);
  }

  handleTerrainLODChange(chunkX: number, chunkZ: number, newVoxelSize: number): void {
    const key = `${chunkX},${chunkZ}`;
    const ctx = this.ctx;

    let radius = 0, biome = 0, islandSize = 0;
    for (let i = 0; i < ctx.drawEntityCount; i++) {
      if (ctx.drawEntityTypes[i] === EntityType.Island &&
          ctx.drawEntityChunkX[i] === chunkX &&
          ctx.drawEntityChunkZ[i] === chunkZ) {
        radius = ctx.drawEntityScales[i];
        biome = ctx.drawEntityBiome[i];
        islandSize = ctx.drawEntityIslandSize[i];
        break;
      }
    }
    if (radius <= 0) return;

    const oldChunkMap = this.islandChunkMeshes.get(key);
    if (oldChunkMap) {
      for (const [, chunk] of oldChunkMap) {
        chunk.vertices.destroy();
        chunk.indices.destroy();
        if (chunk.lineIndices) chunk.lineIndices.destroy();
      }
      this.islandChunkMeshes.delete(key);
    }
    this.islandChunkPending.delete(key);
    this.islandChunkTotalChunks.delete(key);
    this.islandChunkCliffNoise.delete(key);
    this.islandChunkedFields.delete(key);
    this.islandChunkedCtxs.delete(key);

    const oldMesh = this.islandMeshes.get(key);
    if (oldMesh) {
      oldMesh.vertices.destroy();
      oldMesh.indices.destroy();
      if (oldMesh.lineIndices) oldMesh.lineIndices.destroy();
      this.islandMeshes.delete(key);
    }
    this.islandVoxelFields.delete(key);
    this.islandChunkField.delete(key);

    const lodVs = newVoxelSize > 0 ? newVoxelSize : undefined;
    const { field: cf, ctx: cfCtx } = createChunkedVoxelField(chunkX, chunkZ, radius, biome, islandSize, lodVs);
    this.islandChunkedFields.set(key, cf);
    this.islandChunkedCtxs.set(key, cfCtx);
    this.setupChunkedIslandFromChunkedField(key, cf, cfCtx, chunkX, chunkZ, radius);
  }

  applyTerrainDeformation(
    chunkX: number, chunkZ: number, isPort: boolean,
    worldX: number, worldY: number, worldZ: number,
    entityWorldX: number, entityWorldY: number, entityWorldZ: number,
    radius: number, strength: number,
  ): void {
    this.pendingDeformations.push({ chunkX, chunkZ, isPort, worldX, worldY, worldZ, entityWorldX, entityWorldY, entityWorldZ, radius, strength });
  }

  processPendingDeformations(): void {
    if (this.pendingDeformations.length === 0) return;
    const d = this.pendingDeformations.shift()!;
    this.doApplyTerrainDeformation(d.chunkX, d.chunkZ, d.isPort, d.worldX, d.worldY, d.worldZ, d.entityWorldX, d.entityWorldY, d.entityWorldZ, d.radius, d.strength);
  }

  processIslandChunkStream(playerX: number, playerZ: number): void {
    if (this.islandChunkPending.size === 0) return;
    const cfg = TERRAIN_CONFIG;
    const startTime = performance.now();
    let chunksProcessed = 0;

    // Sort islands by distance to player so closest island gets budget priority
    const islandKeys = Array.from(this.islandChunkPending.keys()).sort((a, b) => {
      const [ax, az] = a.split(",").map(Number);
      const [bx, bz] = b.split(",").map(Number);
      const aDist = (ax - playerX) * (ax - playerX) + (az - playerZ) * (az - playerZ);
      const bDist = (bx - playerX) * (bx - playerX) + (bz - playerZ) * (bz - playerZ);
      return aDist - bDist;
    });

    for (const key of islandKeys) {
      const pending = this.islandChunkPending.get(key);
      if (!pending || pending.length === 0) continue;
      if (chunksProcessed >= cfg.streamMaxChunksPerFrame) break;
      if (performance.now() - startTime > cfg.streamTimeBudgetMs) break;
      chunksProcessed += this.processOneIslandChunks(key, pending, playerX, playerZ, cfg.streamMaxChunksPerFrame - chunksProcessed, startTime, cfg.streamTimeBudgetMs, chunksProcessed);
    }
  }

  preBakeAllChunks(playerX: number, playerZ: number): void {
    if (this.islandChunkPending.size === 0) return;

    // Sort islands by distance to player
    const islandKeys = Array.from(this.islandChunkPending.keys()).sort((a, b) => {
      const [ax, az] = a.split(",").map(Number);
      const [bx, bz] = b.split(",").map(Number);
      const aDist = (ax - playerX) * (ax - playerX) + (az - playerZ) * (az - playerZ);
      const bDist = (bx - playerX) * (bx - playerX) + (bz - playerZ) * (bz - playerZ);
      return aDist - bDist;
    });

    for (const key of islandKeys) {
      const pending = this.islandChunkPending.get(key);
      if (!pending || pending.length === 0) continue;
      // Process all chunks for this island with no budget limit
      this.processOneIslandChunks(key, pending, playerX, playerZ, Infinity, 0, Infinity, 0);
    }
  }

  private processOneIslandChunks(
    key: string,
    pending: any[],
    playerX: number, playerZ: number,
    maxChunks: number,
    startTime: number,
    timeBudgetMs: number,
    chunksProcessedOffset: number,
  ): number {
    const device = this.ctx.device!;
    const cfg = TERRAIN_CONFIG;
    let chunksProcessed = 0;

    const cf = this.islandChunkedFields.get(key);
    const cfCtx = this.islandChunkedCtxs.get(key);
    const legacyField = this.islandChunkField.get(key);

    const [chunkXStr, chunkZStr] = key.split(",");
    const islandX = parseFloat(chunkXStr);
    const islandZ = parseFloat(chunkZStr);

    if (cf && cfCtx) {
      const halfChunk = cf.chunkSize / 2;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        const gx0 = p.cx * cf.chunkSize;
        const gz0 = p.cz * cf.chunkSize;
        const cx = islandX + (gx0 + halfChunk) * cf.voxelSize + cf.originX;
        const cz = islandZ + (gz0 + halfChunk) * cf.voxelSize + cf.originZ;
        const dx = cx - playerX;
        const dz = cz - playerZ;
        p.distSq = dx * dx + dz * dz;
      }
      pending.sort((a, b) => a.distSq - b.distSq);

      while (pending.length > 0 && chunksProcessed < maxChunks) {
        if (performance.now() - startTime > timeBudgetMs) break;
        const chunk = pending.shift()!;
        const chunkMeshes = this.islandChunkMeshes.get(key);
        if (!chunkMeshes) break;
        const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
        if (!cliffNoiseFn) break;

        const matField = materializeChunkForMesh(cf, cfCtx, chunk.cx, chunk.cy, chunk.cz);
        if (!matField) { chunksProcessed++; continue; }

        const sub = getChunkMeshSubRegion(cf, chunk.cx, chunk.cy, chunk.cz);
        const extracted = extractMeshSubRegion(matField, sub.x0, sub.y0, sub.z0, sub.x1, sub.y1, sub.z1, cliffNoiseFn);
        if (extracted.verts.length === 0 || extracted.indices.length === 0) { chunksProcessed++; continue; }

        const verts = extracted.verts;
        const r = cf.radius;
        for (let i = 0; i < verts.length; i += 9) { verts[i] /= r; verts[i + 1] /= r; verts[i + 2] /= r; }

        const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(vertices, 0, verts as any);

        const indexBuf = extracted.indices;
        let indexData: Uint16Array | Uint32Array;
        if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) { indexData = new Uint16Array(indexBuf.length + 1); indexData.set(indexBuf); }
        else { indexData = indexBuf as Uint16Array | Uint32Array; }

        const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(indices, 0, indexData as any);

        const halfChunkC = cf.chunkSize / 2;
        const wcx = islandX + (chunk.cx * cf.chunkSize + halfChunkC) * cf.voxelSize + cf.originX;
        const wcy = (chunk.cy * cf.chunkSize + halfChunkC) * cf.voxelSize + cf.originY;
        const wcz = islandZ + (chunk.cz * cf.chunkSize + halfChunkC) * cf.voxelSize + cf.originZ;
        const chunkRadius = halfChunkC * cf.voxelSize * 1.5;
        chunkMeshes.set(chunk.chunkKey, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32, lineIndices: null, lineIndexCount: 0, worldCenterX: wcx, worldCenterY: wcy, worldCenterZ: wcz, boundingRadius: chunkRadius });
        chunksProcessed++;
      }
    } else if (legacyField) {
      const halfDimX = legacyField.dimX / cfg.chunkSubdivisions / 2;
      const halfDimZ = legacyField.dimZ / cfg.chunkSubdivisions / 2;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        const cx = islandX + (p.x + halfDimX) * legacyField.voxelSize + legacyField.originX;
        const cz = islandZ + (p.z + halfDimZ) * legacyField.voxelSize + legacyField.originZ;
        const dx = cx - playerX; const dz = cz - playerZ;
        p.distSq = dx * dx + dz * dz;
      }
      pending.sort((a, b) => a.distSq - b.distSq);

      while (pending.length > 0 && chunksProcessed < maxChunks) {
        if (performance.now() - startTime > timeBudgetMs) break;
        const chunk = pending.shift()!;
        const chunkMeshes = this.islandChunkMeshes.get(key);
        if (!chunkMeshes) break;
        const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
        if (!cliffNoiseFn) break;

        const chunkDimX = Math.ceil(legacyField.dimX / cfg.chunkSubdivisions);
        const chunkDimY = Math.ceil(legacyField.dimY / cfg.chunkSubdivisions);
        const chunkDimZ = Math.ceil(legacyField.dimZ / cfg.chunkSubdivisions);
        const cxIdx = Math.floor(chunk.x / chunkDimX);
        const cyIdx = Math.floor(chunk.y / chunkDimY);
        const czIdx = Math.floor(chunk.z / chunkDimZ);
        const x0 = cxIdx * chunkDimX, y0 = cyIdx * chunkDimY, z0 = czIdx * chunkDimZ;
        const x1 = Math.min(legacyField.dimX, x0 + chunkDimX);
        const y1 = Math.min(legacyField.dimY, y0 + chunkDimY);
        const z1 = Math.min(legacyField.dimZ, z0 + chunkDimZ);
        const extracted = extractMeshSubRegion(legacyField, x0, y0, z0, x1, y1, z1, cliffNoiseFn);
        if (extracted.verts.length === 0 || extracted.indices.length === 0) { chunksProcessed++; continue; }

        const verts = extracted.verts;
        const r = legacyField.radius;
        for (let i = 0; i < verts.length; i += 9) { verts[i] /= r; verts[i + 1] /= r; verts[i + 2] /= r; }

        const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(vertices, 0, verts as any);

        const indexBuf = extracted.indices;
        let indexData: Uint16Array | Uint32Array;
        if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) { indexData = new Uint16Array(indexBuf.length + 1); indexData.set(indexBuf); }
        else { indexData = indexBuf as Uint16Array | Uint32Array; }

        const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(indices, 0, indexData as any);

        const halfChunkX = chunkDimX / 2;
        const halfChunkY = chunkDimY / 2;
        const halfChunkZ = chunkDimZ / 2;
        const wcx = islandX + (cxIdx * chunkDimX + halfChunkX) * legacyField.voxelSize + legacyField.originX;
        const wcy = (cyIdx * chunkDimY + halfChunkY) * legacyField.voxelSize + legacyField.originY;
        const wcz = islandZ + (czIdx * chunkDimZ + halfChunkZ) * legacyField.voxelSize + legacyField.originZ;
        const chunkRadius = Math.max(halfChunkX, halfChunkY, halfChunkZ) * legacyField.voxelSize * 1.5;
        chunkMeshes.set(chunk.chunkKey, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32, lineIndices: null, lineIndexCount: 0, worldCenterX: wcx, worldCenterY: wcy, worldCenterZ: wcz, boundingRadius: chunkRadius });
        chunksProcessed++;
      }
    }

    if (pending.length === 0) {
      this.islandChunkPending.delete(key);
      this.islandChunkTotalChunks.delete(key);
    }

    return chunksProcessed;
  }

  cleanupStaleIslandMeshes(): void {
    for (const [key, mesh] of this.islandMeshes) {
      if (!this.activeIslandKeys.has(key)) {
        mesh.vertices.destroy(); mesh.indices.destroy();
        if (mesh.lineIndices) mesh.lineIndices.destroy();
        this.islandMeshes.delete(key);
        this.islandVoxelFields.delete(key);
      }
    }
    for (const [key, chunkMap] of this.islandChunkMeshes) {
      if (!this.activeIslandKeys.has(key)) {
        if (this.islandChunkPending.has(key)) continue;
        for (const [, chunk] of chunkMap) {
          chunk.vertices.destroy(); chunk.indices.destroy();
          if (chunk.lineIndices) chunk.lineIndices.destroy();
        }
        this.islandChunkMeshes.delete(key);
        this.islandChunkPending.delete(key);
        this.islandChunkField.delete(key);
        this.islandChunkTotalChunks.delete(key);
        this.islandChunkCliffNoise.delete(key);
        this.islandChunkedFields.delete(key);
        this.islandChunkedCtxs.delete(key);
      }
    }
    for (const key of this.islandEmptyKeys) {
      if (!this.activeIslandKeys.has(key)) { this.islandEmptyKeys.delete(key); this.islandVoxelFields.delete(key); }
    }
    for (const [key, mesh] of this.portTerrainMeshes) {
      if (!this.activePortKeys.has(key)) {
        mesh.vertices.destroy(); mesh.indices.destroy();
        this.portTerrainMeshes.delete(key); this.portVoxelFields.delete(key);
      }
    }
    for (const [key, mesh] of this.portStructureMeshes) {
      if (!this.activePortStructureKeys.has(key)) {
        mesh.vertices.destroy(); mesh.indices.destroy();
        this.portStructureMeshes.delete(key);
      }
    }
    for (const key of this.portEmptyKeys) {
      if (!this.activePortKeys.has(key)) { this.portEmptyKeys.delete(key); }
    }
    this.activeIslandKeys.clear();
    this.activePortKeys.clear();
    this.activePortStructureKeys.clear();
  }

  cleanupStaleDecorations(): void {
    for (const [key, deco] of this.decorationMeshes) {
      if (!this.activeDecorationKeys.has(key)) {
        deco.vertices.destroy(); deco.indices.destroy();
        this.decorationMeshes.delete(key);
      }
    }
    for (const key of this.decorationEmptyKeys) {
      if (!this.activeDecorationKeys.has(key)) { this.decorationEmptyKeys.delete(key); }
    }
    this.activeDecorationKeys.clear();
  }

  getIslandVoxelField(chunkX: number, chunkZ: number): VoxelField | null {
    return this.islandVoxelFields.get(`${chunkX},${chunkZ}`) ?? null;
  }

  getNearbyVoxelData(
    camX: number, camY: number, camZ: number,
    collisionRadius: number, maxVoxelFloats: number,
  ): { data: Float32Array; originX: number; originY: number; originZ: number; voxelSize: number; dimX: number; dimY: number; dimZ: number; isoLevel: number } | null {
    const ctx = this.ctx;
    const nearby = this.pooledNearby;
    nearby.length = 0;

    for (let i = 0; i < ctx.drawEntityCount; i++) {
      const type = ctx.drawEntityTypes[i];
      if (type !== EntityType.Island && type !== EntityType.Port) continue;
      const ex = ctx.drawEntityPosX[i] ?? 0;
      const ey = ctx.drawEntityPosY[i] ?? 0;
      const ez = ctx.drawEntityPosZ[i] ?? 0;
      const chunkX = ctx.drawEntityChunkX[i] ?? 0;
      const chunkZ = ctx.drawEntityChunkZ[i] ?? 0;
      const key = `${chunkX},${chunkZ}`;

      let field: ChunkedVoxelField | VoxelField | null = null;
      let isChunked = false;
      if (type === EntityType.Island) {
        const cf = this.islandChunkedFields.get(key);
        if (cf) { field = cf; isChunked = true; }
        else { field = this.islandVoxelFields.get(key) ?? this.islandChunkField.get(key) ?? null; }
      } else { field = this.portVoxelFields.get(key) ?? null; }
      if (!field) continue;

      const vs = field.voxelSize;
      const fox = ex + field.originX; const foy = ey + field.originY; const foz = ez + field.originZ;
      const fieldMaxX = fox + field.dimX * vs; const fieldMaxY = foy + field.dimY * vs; const fieldMaxZ = foz + field.dimZ * vs;
      if (camX + collisionRadius < fox || camX - collisionRadius > fieldMaxX) continue;
      if (camY + collisionRadius < foy || camY - collisionRadius > fieldMaxY) continue;
      if (camZ + collisionRadius < foz || camZ - collisionRadius > fieldMaxZ) continue;

      nearby.push({ field, isChunked, worldOriginX: fox, worldOriginY: foy, worldOriginZ: foz, voxelSize: vs, isoLevel: field.isoLevel });
    }

    if (nearby.length === 0) return null;

    const voxelSize = nearby[0].voxelSize;
    const isoLevel = nearby[0].isoLevel;
    const maxDim = Math.floor(Math.cbrt(maxVoxelFloats));
    const desiredExtent = collisionRadius;
    const dim = Math.min(maxDim, Math.ceil((2 * desiredExtent) / voxelSize));
    const dimX = dim;
    const dimY = Math.min(dim, Math.ceil(desiredExtent / voxelSize) * 2);
    const dimZ = dim;
    const originX = camX - (dimX / 2) * voxelSize;
    const originY = camY - (dimY / 2) * voxelSize;
    const originZ = camZ - (dimZ / 2) * voxelSize;

    const totalVoxels = dimX * dimY * dimZ;
    if (!this.pooledVoxelData || this.pooledVoxelData.length < totalVoxels) {
      this.pooledVoxelData = new Float32Array(totalVoxels);
    }
    const data = this.pooledVoxelData;
    data.fill(-1.0, 0, totalVoxels);

    for (const entry of nearby) {
      const field = entry.field;
      const vs = entry.voxelSize;
      const eox = entry.worldOriginX; const eoy = entry.worldOriginY; const eoz = entry.worldOriginZ;
      for (let gx = 0; gx < dimX; gx++) {
        for (let gz = 0; gz < dimZ; gz++) {
          const worldX = originX + gx * voxelSize;
          const worldZ = originZ + gz * voxelSize;
          const vx = Math.floor((worldX - eox) / vs);
          const vz = Math.floor((worldZ - eoz) / vs);
          if (vx < 0 || vx >= field.dimX || vz < 0 || vz >= field.dimZ) continue;
          for (let gy = 0; gy < dimY; gy++) {
            const worldY = originY + gy * voxelSize;
            const vy = Math.floor((worldY - eoy) / vs);
            if (vy < 0 || vy >= field.dimY) continue;
            let density: number;
            if (entry.isChunked) { density = getChunkedVoxel(field as ChunkedVoxelField, vx, vy, vz); }
            else { const vf = field as VoxelField; density = vf.data[vx * vf.dimY * vf.dimZ + vy * vf.dimZ + vz]; }
            if (density > data[gx * dimY * dimZ + gy * dimZ + gz]) { data[gx * dimY * dimZ + gy * dimZ + gz] = density; }
          }
        }
      }
    }

    const result = this.pooledVoxelResult ?? (this.pooledVoxelResult = { data, originX, originY, originZ, voxelSize, dimX, dimY, dimZ, isoLevel });
    result.data = data; result.originX = originX; result.originY = originY; result.originZ = originZ;
    result.voxelSize = voxelSize; result.dimX = dimX; result.dimY = dimY; result.dimZ = dimZ; result.isoLevel = isoLevel;
    return result;
  }

  // --- Render helpers ---

  renderIsland(passEncoder: GPURenderPassEncoder, idx: number): number {
    const ctx = this.ctx;
    if (!this.islandPipeline || !ctx.bindGroup) return 0;
    let tris = 0;
    const chunkX = ctx.drawEntityChunkX[idx] ?? 0;
    const chunkZ = ctx.drawEntityChunkZ[idx] ?? 0;
    const islandKey = `${chunkX},${chunkZ}`;
    const islandMesh = this.islandMeshes.get(islandKey);
    if (islandMesh && islandMesh.indexCount > 0) {
      passEncoder.setPipeline(this.islandPipeline);
      passEncoder.setBindGroup(0, ctx.bindGroup, [idx * 256]);
      passEncoder.setVertexBuffer(0, islandMesh.vertices);
      passEncoder.setIndexBuffer(islandMesh.indices, islandMesh.useUint32 ? "uint32" : "uint16");
      passEncoder.drawIndexed(islandMesh.indexCount);
      tris += Math.floor(islandMesh.indexCount / 3);

      const deco = this.decorationMeshes.get(islandKey);
      if (deco && deco.indexCount > 0) {
        passEncoder.setVertexBuffer(0, deco.vertices);
        passEncoder.setIndexBuffer(deco.indices, "uint16");
        passEncoder.drawIndexed(deco.indexCount);
        tris += Math.floor(deco.indexCount / 3);
      }
    } else {
      const chunkMap = this.islandChunkMeshes.get(islandKey);
      if (chunkMap && chunkMap.size > 0) {
        passEncoder.setPipeline(this.islandPipeline);
        passEncoder.setBindGroup(0, ctx.bindGroup, [idx * 256]);
        const camX = ctx.cameraPosCache[0];
        const camY = ctx.cameraPosCache[1];
        const camZ = ctx.cameraPosCache[2];
        const chunkEntries = Array.from(chunkMap.values());
        for (let ci = 0; ci < chunkEntries.length; ci++) {
          const chunk = chunkEntries[ci] as ChunkMeshEntry;
          if (chunk.indexCount <= 0) continue;
          // Per-chunk distance culling: skip chunks beyond render distance
          const dx = chunk.worldCenterX - camX;
          const dy = chunk.worldCenterY - camY;
          const dz = chunk.worldCenterZ - camZ;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > (600 + chunk.boundingRadius) * (600 + chunk.boundingRadius)) continue;
          passEncoder.setVertexBuffer(0, chunk.vertices);
          passEncoder.setIndexBuffer(chunk.indices, chunk.useUint32 ? "uint32" : "uint16");
          passEncoder.drawIndexed(chunk.indexCount);
          tris += Math.floor(chunk.indexCount / 3);
        }
        const deco = this.decorationMeshes.get(islandKey);
        if (deco && deco.indexCount > 0) {
          passEncoder.setVertexBuffer(0, deco.vertices);
          passEncoder.setIndexBuffer(deco.indices, "uint16");
          passEncoder.drawIndexed(deco.indexCount);
          tris += Math.floor(deco.indexCount / 3);
        }
      }
    }
    return tris;
  }

  renderPort(passEncoder: GPURenderPassEncoder, idx: number): number {
    const ctx = this.ctx;
    if (!ctx.bindGroup) return 0;
    let tris = 0;
    const chunkX = ctx.drawEntityChunkX[idx] ?? 0;
    const chunkZ = ctx.drawEntityChunkZ[idx] ?? 0;
    const portKey = `${chunkX},${chunkZ}`;

    const portTerrain = this.portTerrainMeshes.get(portKey);
    if (portTerrain && portTerrain.indexCount > 0 && this.islandPipeline) {
      passEncoder.setPipeline(this.islandPipeline);
      passEncoder.setBindGroup(0, ctx.bindGroup, [idx * 256]);
      passEncoder.setVertexBuffer(0, portTerrain.vertices);
      passEncoder.setIndexBuffer(portTerrain.indices, portTerrain.useUint32 ? "uint32" : "uint16");
      passEncoder.drawIndexed(portTerrain.indexCount);
      tris += Math.floor(portTerrain.indexCount / 3);
    }

    const portStruct = this.portStructureMeshes.get(portKey);
    if (portStruct && portStruct.indexCount > 0 && this.boatPipeline) {
      passEncoder.setPipeline(this.boatPipeline);
      passEncoder.setBindGroup(0, ctx.bindGroup, [idx * 256]);
      passEncoder.setVertexBuffer(0, portStruct.vertices);
      passEncoder.setIndexBuffer(portStruct.indices, portStruct.useUint32 ? "uint32" : "uint16");
      passEncoder.drawIndexed(portStruct.indexCount);
      tris += Math.floor(portStruct.indexCount / 3);
      return tris;
    }

    // Fallback: legacy pre-generated per-size mesh
    if (this.boatPipeline) {
      const portSize = ctx.drawEntityPortSizes[idx] ?? PortSize.Medium;
      const ps = portSize === PortSize.Small ? 0 : portSize === PortSize.Medium ? 1 : 2;
      const pv = this.portVertices[ps];
      const pi = this.portIndices[ps];
      const pic = this.portIndexCounts[ps];
      if (pv && pi && pic > 0) {
        passEncoder.setPipeline(this.boatPipeline);
        passEncoder.setBindGroup(0, ctx.bindGroup, [idx * 256]);
        passEncoder.setVertexBuffer(0, pv);
        passEncoder.setIndexBuffer(pi, "uint16");
        passEncoder.drawIndexed(pic);
        tris += Math.floor(pic / 3);
      }
    }
    return tris;
  }

  getIslandMeshes(): Map<string, IslandMesh> {
    return this.islandMeshes;
  }

  // --- Private methods ---

  private setupChunkedIslandFromChunkedField(
    key: string, cf: ChunkedVoxelField, cfCtx: ChunkedFieldContext,
    chunkX: number, chunkZ: number, radius: number,
  ): void {
    this.islandChunkMeshes.set(key, new Map());
    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    this.islandChunkCliffNoise.set(key, (x: number, y: number, z: number) => cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0));

    const islandWorldX = chunkX;
    const islandWorldZ = chunkZ;
    const pending: { cx: number; cy: number; cz: number; chunkKey: string; distSq: number }[] = [];
    let totalChunks = 0;

    for (let cx = 0; cx < cf.chunkDimX; cx++) {
      for (let cy = 0; cy < cf.chunkDimY; cy++) {
        for (let cz = 0; cz < cf.chunkDimZ; cz++) {
          const chunkIdx = cx * cf.chunkDimY * cf.chunkDimZ + cy * cf.chunkDimZ + cz;
          if (cf.chunkOffsets[chunkIdx] < 0) continue;
          const gx0 = cx * cf.chunkSize;
          const gz0 = cz * cf.chunkSize;
          const chunkCenterX = islandWorldX + (gx0 + cf.chunkSize / 2) * cf.voxelSize + cf.originX;
          const chunkCenterZ = islandWorldZ + (gz0 + cf.chunkSize / 2) * cf.voxelSize + cf.originZ;
          const dx = chunkCenterX - islandWorldX;
          const dz = chunkCenterZ - islandWorldZ;
          const distSq = dx * dx + dz * dz;
          const chunkKey = `${cx},${cy},${cz}`;
          pending.push({ cx, cy, cz, chunkKey, distSq });
          totalChunks++;
        }
      }
    }

    if (totalChunks === 0) {
      this.islandEmptyKeys.add(key);
      this.islandChunkedFields.delete(key);
      this.islandChunkedCtxs.delete(key);
      return;
    }

    pending.sort((a, b) => a.distSq - b.distSq);
    this.islandChunkPending.set(key, pending as any);
    this.islandChunkTotalChunks.set(key, totalChunks);
  }

  private doApplyTerrainDeformation(
    chunkX: number, chunkZ: number, isPort: boolean,
    worldX: number, worldY: number, worldZ: number,
    entityWorldX: number, entityWorldY: number, entityWorldZ: number,
    radius: number, strength: number,
  ): void {
    const key = `${chunkX},${chunkZ}`;
    const cf = isPort ? null : this.islandChunkedFields.get(key);
    const cfCtx = isPort ? null : this.islandChunkedCtxs.get(key);
    const field = isPort
      ? this.portVoxelFields.get(key)
      : (this.islandVoxelFields.get(key) ?? this.islandChunkField.get(key));
    if (!field && !cf) return;

    if (cf && cfCtx) {
      const localX = worldX - entityWorldX;
      const localY = worldY - entityWorldY;
      const localZ = worldZ - entityWorldZ;
      const cvs = cf.voxelSize;
      const cDefRadiusVoxels = Math.ceil(radius / cvs);
      const defRadiusSq = radius * radius;
      const ccx = Math.floor((localX - cf.originX) / cvs);
      const ccy = Math.floor((localY - cf.originY) / cvs);
      const ccz = Math.floor((localZ - cf.originZ) / cvs);

      const dirtyChunkKeys = new Set<string>();
      for (let vx = ccx - cDefRadiusVoxels; vx <= ccx + cDefRadiusVoxels; vx++) {
        if (vx < 0 || vx >= cf.dimX) continue;
        for (let vy = ccy - cDefRadiusVoxels; vy <= ccy + cDefRadiusVoxels; vy++) {
          if (vy < 0 || vy >= cf.dimY) continue;
          for (let vz = ccz - cDefRadiusVoxels; vz <= ccz + cDefRadiusVoxels; vz++) {
            if (vz < 0 || vz >= cf.dimZ) continue;
            const wx = vx * cvs + cf.originX;
            const wy = vy * cvs + cf.originY;
            const wz = vz * cvs + cf.originZ;
            const ddx = wx - localX; const ddy = wy - localY; const ddz = wz - localZ;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (distSq > defRadiusSq) continue;
            const falloff = 1 - Math.sqrt(distSq) / radius;
            const change = strength * falloff * falloff;
            const chCx = vx >>> cf.chunkBits;
            const chCy = vy >>> cf.chunkBits;
            const chCz = vz >>> cf.chunkBits;
            const chunkIdx = chCx * cf.chunkDimY * cf.chunkDimZ + chCy * cf.chunkDimZ + chCz;
            dirtyChunkKeys.add(`${chCx},${chCy},${chCz}`);
            // Promote FullSolid/FullEmpty chunks to Full before deforming
            if (cf.chunkClass[chunkIdx] !== CHUNK_FULL) {
              promoteChunkWithData(cf, cfCtx!, chunkIdx);
            }
            const oldVal = getChunkedVoxel(cf, vx, vy, vz);
            setChunkedVoxel(cf, vx, vy, vz, oldVal + change);
          }
        }
      }
      this.rebuildChunkedIslandChunks(key, cf, cfCtx, dirtyChunkKeys);
      return;
    }

    if (!field) return;
    const localX = worldX - entityWorldX;
    const localY = worldY - entityWorldY;
    const localZ = worldZ - entityWorldZ;
    const vs = field.voxelSize;
    const defRadiusVoxels = Math.ceil(radius / vs);
    const defRadiusSq = radius * radius;
    const cx = Math.floor((localX - field.originX) / vs);
    const cy = Math.floor((localY - field.originY) / vs);
    const cz = Math.floor((localZ - field.originZ) / vs);

    for (let vx = cx - defRadiusVoxels; vx <= cx + defRadiusVoxels; vx++) {
      if (vx < 0 || vx >= field.dimX) continue;
      for (let vy = cy - defRadiusVoxels; vy <= cy + defRadiusVoxels; vy++) {
        if (vy < 0 || vy >= field.dimY) continue;
        for (let vz = cz - defRadiusVoxels; vz <= cz + defRadiusVoxels; vz++) {
          if (vz < 0 || vz >= field.dimZ) continue;
          const wx = vx * vs + field.originX;
          const wy = vy * vs + field.originY;
          const wz = vz * vs + field.originZ;
          const ddx = wx - localX; const ddy = wy - localY; const ddz = wz - localZ;
          const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
          if (distSq > defRadiusSq) continue;
          const falloff = 1 - Math.sqrt(distSq) / radius;
          const change = strength * falloff * falloff;
          const idx = vx * field.dimY * field.dimZ + vy * field.dimZ + vz;
          field.data[idx] += change;
        }
      }
    }

    if (isPort) { this.rebuildPortMesh(key, field); }
    else if (this.islandChunkMeshes.has(key)) { this.rebuildChunkedIsland(key, field, chunkX, chunkZ, localX, localY, localZ, radius); }
    else { this.rebuildIslandMesh(key, field, chunkX, chunkZ); }
  }

  private rebuildIslandMesh(key: string, field: VoxelField, chunkX: number, chunkZ: number): void {
    const device = this.ctx.device!;
    const old = this.islandMeshes.get(key);
    if (old) { old.vertices.destroy(); old.indices.destroy(); if (old.lineIndices) old.lineIndices.destroy(); this.islandMeshes.delete(key); }

    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    const cliffNoiseFn = (x: number, y: number, z: number) => cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);

    const extracted = extractMesh(field, cliffNoiseFn);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) { this.islandEmptyKeys.add(key); this.activeIslandKeys.add(key); return; }
    this.islandEmptyKeys.delete(key);

    const r = field.radius;
    const verts = extracted.verts;
    for (let i = 0; i < verts.length; i += 9) { verts[i] /= r; verts[i + 1] /= r; verts[i + 2] /= r; }

    const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) { indexData = new Uint16Array(indexBuf.length + 1); indexData.set(indexBuf); }
    else { indexData = indexBuf as Uint16Array | Uint32Array; }

    const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indices, 0, indexData as any);

    this.islandMeshes.set(key, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32, lineIndices: null, lineIndexCount: 0 });
    this.activeIslandKeys.add(key);
  }

  private rebuildPortMesh(key: string, field: VoxelField): void {
    const device = this.ctx.device!;
    const old = this.portTerrainMeshes.get(key);
    if (old) { old.vertices.destroy(); old.indices.destroy(); this.portTerrainMeshes.delete(key); }

    const chunkX = parseInt(key.split(",")[0]);
    const chunkZ = parseInt(key.split(",")[1]);
    const cliffNoise = new PerlinNoise(chunkX * 92837111 + chunkZ * 72635341 ^ 0x56781234);
    const cliffNoiseFn = (x: number, y: number, z: number) => cliffNoise.fbm(x * 5.0, z * 5.0, 3, 0.5, 2.0);

    const extracted = extractMesh(field, cliffNoiseFn);
    if (extracted.verts.length === 0 || extracted.indices.length === 0) { this.portEmptyKeys.add(key); this.activePortKeys.add(key); return; }
    this.portEmptyKeys.delete(key);

    const r = field.radius;
    const verts = extracted.verts;
    for (let i = 0; i < verts.length; i += 9) { verts[i] /= r; verts[i + 1] /= r; verts[i + 2] /= r; }

    const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertices, 0, verts as any);

    const indexBuf = extracted.indices;
    let indexData: Uint16Array | Uint32Array;
    if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) { indexData = new Uint16Array(indexBuf.length + 1); indexData.set(indexBuf); }
    else { indexData = indexBuf as Uint16Array | Uint32Array; }

    const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indices, 0, indexData as any);

    this.portTerrainMeshes.set(key, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32 });
    this.activePortKeys.add(key);
  }

  private rebuildChunkedIsland(
    key: string, field: VoxelField, chunkX: number, chunkZ: number,
    localX: number, localY: number, localZ: number, defRadius: number,
  ): void {
    const device = this.ctx.device!;
    const cfg = TERRAIN_CONFIG;
    const sub = cfg.chunkSubdivisions;
    const chunkDimX = Math.ceil(field.dimX / sub);
    const chunkDimY = Math.ceil(field.dimY / sub);
    const chunkDimZ = Math.ceil(field.dimZ / sub);

    const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
    if (!cliffNoiseFn) return;
    const chunkMap = this.islandChunkMeshes.get(key);
    if (!chunkMap) return;

    const r = field.radius;
    const vs = field.voxelSize;
    const defGx = (localX - field.originX) / vs;
    const defGy = (localY - field.originY) / vs;
    const defGz = (localZ - field.originZ) / vs;
    const defRadiusVoxels = defRadius / vs;

    const minCx = Math.max(0, Math.floor((defGx - defRadiusVoxels) / chunkDimX));
    const maxCx = Math.min(sub - 1, Math.floor((defGx + defRadiusVoxels) / chunkDimX));
    const minCy = Math.max(0, Math.floor((defGy - defRadiusVoxels) / chunkDimY));
    const maxCy = Math.min(sub - 1, Math.floor((defGy + defRadiusVoxels) / chunkDimY));
    const minCz = Math.max(0, Math.floor((defGz - defRadiusVoxels) / chunkDimZ));
    const maxCz = Math.min(sub - 1, Math.floor((defGz + defRadiusVoxels) / chunkDimZ));

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const chunkKey = `${cx},${cy},${cz}`;
          const x0 = cx * chunkDimX; const y0 = cy * chunkDimY; const z0 = cz * chunkDimZ;
          const x1 = Math.min(field.dimX, x0 + chunkDimX);
          const y1 = Math.min(field.dimY, y0 + chunkDimY);
          const z1 = Math.min(field.dimZ, z0 + chunkDimZ);

          const extracted = extractMeshSubRegion(field, x0, y0, z0, x1, y1, z1, cliffNoiseFn);
          const old = chunkMap.get(chunkKey);
          if (old) { old.vertices.destroy(); old.indices.destroy(); if (old.lineIndices) old.lineIndices.destroy(); chunkMap.delete(chunkKey); }
          if (extracted.verts.length === 0 || extracted.indices.length === 0) continue;

          const verts = extracted.verts;
          for (let i = 0; i < verts.length; i += 9) { verts[i] /= r; verts[i + 1] /= r; verts[i + 2] /= r; }

          const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          device.queue.writeBuffer(vertices, 0, verts as any);

          const indexBuf = extracted.indices;
          let indexData: Uint16Array | Uint32Array;
          if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) { indexData = new Uint16Array(indexBuf.length + 1); indexData.set(indexBuf); }
          else { indexData = indexBuf as Uint16Array | Uint32Array; }

          const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
          device.queue.writeBuffer(indices, 0, indexData as any);

          // Compute world-space center + bounding radius for culling
          const halfChunkX = chunkDimX / 2;
          const halfChunkY = chunkDimY / 2;
          const halfChunkZ = chunkDimZ / 2;
          const wcx = chunkX + (cx * chunkDimX + halfChunkX) * field.voxelSize + field.originX;
          const wcy = (cy * chunkDimY + halfChunkY) * field.voxelSize + field.originY;
          const wcz = chunkZ + (cz * chunkDimZ + halfChunkZ) * field.voxelSize + field.originZ;
          const chunkRadius = Math.max(halfChunkX, halfChunkY, halfChunkZ) * field.voxelSize * 1.5;
          chunkMap.set(chunkKey, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32, lineIndices: null, lineIndexCount: 0, worldCenterX: wcx, worldCenterY: wcy, worldCenterZ: wcz, boundingRadius: chunkRadius });
        }
      }
    }
  }

  private rebuildChunkedIslandChunks(
    key: string, cf: ChunkedVoxelField, cfCtx: ChunkedFieldContext,
    dirtyChunkKeys: Set<string>,
  ): void {
    const device = this.ctx.device!;
    const cliffNoiseFn = this.islandChunkCliffNoise.get(key);
    if (!cliffNoiseFn) return;
    const chunkMap = this.islandChunkMeshes.get(key);
    if (!chunkMap) return;
    const r = cf.radius;
    const [islandXStr, islandZStr] = key.split(",");
    const islandX = parseFloat(islandXStr);
    const islandZ = parseFloat(islandZStr);

    for (const chunkKey of dirtyChunkKeys) {
      const [cx, cy, cz] = chunkKey.split(",").map(Number);
      const matField = materializeChunkForMesh(cf, cfCtx, cx, cy, cz);
      if (!matField) continue;
      const sub = getChunkMeshSubRegion(cf, cx, cy, cz);
      const extracted = extractMeshSubRegion(matField, sub.x0, sub.y0, sub.z0, sub.x1, sub.y1, sub.z1, cliffNoiseFn);

      const old = chunkMap.get(chunkKey);
      if (old) { old.vertices.destroy(); old.indices.destroy(); if (old.lineIndices) old.lineIndices.destroy(); chunkMap.delete(chunkKey); }
      if (extracted.verts.length === 0 || extracted.indices.length === 0) continue;

      const verts = extracted.verts;
      for (let i = 0; i < verts.length; i += 9) { verts[i] /= r; verts[i + 1] /= r; verts[i + 2] /= r; }

      const vertices = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vertices, 0, verts as any);

      const indexBuf = extracted.indices;
      let indexData: Uint16Array | Uint32Array;
      if (!extracted.useUint32 && indexBuf instanceof Uint16Array && indexBuf.length % 2 !== 0) { indexData = new Uint16Array(indexBuf.length + 1); indexData.set(indexBuf); }
      else { indexData = indexBuf as Uint16Array | Uint32Array; }

      const indices = device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(indices, 0, indexData as any);

      // Compute world-space center + bounding radius for culling
      const halfChunk = cf.chunkSize / 2;
      const wcx = islandX + (cx * cf.chunkSize + halfChunk) * cf.voxelSize + cf.originX;
      const wcy = (cy * cf.chunkSize + halfChunk) * cf.voxelSize + cf.originY;
      const wcz = islandZ + (cz * cf.chunkSize + halfChunk) * cf.voxelSize + cf.originZ;
      const chunkRadius = halfChunk * cf.voxelSize * 1.5;
      chunkMap.set(chunkKey, { vertices, indices, indexCount: indexBuf.length, useUint32: extracted.useUint32, lineIndices: null, lineIndexCount: 0, worldCenterX: wcx, worldCenterY: wcy, worldCenterZ: wcz, boundingRadius: chunkRadius });
    }
  }
}
