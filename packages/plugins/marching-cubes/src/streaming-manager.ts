// ============================================================================
// TerrainStreamingManager — generic terrain LOD, chunk generation, and
// time-budgeted streaming for chunked voxel fields.
// ============================================================================
// This is the generic engine for managing multiple chunked voxel fields with:
// - Distance-based LOD with hysteresis (prevents rapid LOD flapping)
// - Time-budgeted chunk generation (avoids sim stalls)
// - Time-budgeted physics field generation
// - Dirty region tracking for mesh rebuilds
// - Deformation batching
//
// Games provide:
// - A ChunkFieldFactory to create chunked fields at a given LOD
// - A PhysicsFieldFactory to create physics voxel fields
// - A ChunkGenerator to fill chunk data on demand
// - A ChunkEmptyChecker to skip empty chunks
//

import type { ChunkedVoxelField } from "./chunked-field.ts";
import {
    getChunkedVoxel,
    isChunkEmpty,
    isChunkGenerated,
    setChunkedVoxel
} from "./chunked-field.ts";
import type { TerrainStreamingConfig } from "./streaming-config.ts";
import { getLODVoxelSize } from "./streaming-config.ts";
import type { VoxelField } from "./types.ts";
export interface TerrainEntry {
  id: number;
  chunkX: number;
  chunkZ: number;
  radius: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  isPort: boolean;
  field: VoxelField | null;
  chunkedField: ChunkedVoxelField | null;
  dirty: boolean;
  deformCount: number;
  dirtyMinX: number;
  dirtyMaxX: number;
  dirtyMinZ: number;
  dirtyMaxZ: number;
  hasDirtyRegion: boolean;
  dirtyChunkKeys: Set<number> | null;
  currentLODVoxelSize: number;
  pendingChunkGen: number[] | null;
  lastLODChangeTick: number;
  pendingPhysField: {
    chunkX: number;
    chunkZ: number;
    radius: number;
    physVs: number;
  } | null;
}

export interface ChunkFieldFactory {
  (
    chunkX: number,
    chunkZ: number,
    radius: number,
    voxelSize: number,
  ): { field: ChunkedVoxelField; ctx: unknown };
}

export interface PhysicsFieldFactory {
  (
    chunkX: number,
    chunkZ: number,
    radius: number,
    physVs: number,
  ): VoxelField;
}

export interface ChunkGenerator {
  (
    field: ChunkedVoxelField,
    ctx: unknown,
    cx: number,
    cy: number,
    cz: number,
  ): void;
}

export interface ChunkEmptyChecker {
  (
    field: ChunkedVoxelField,
    ctx: unknown,
    cx: number,
    cy: number,
    cz: number,
  ): boolean;
}

export interface Deformation {
  id: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  radius: number;
  strength: number;
}

export interface LODChange {
  id: number;
  chunkX: number;
  chunkZ: number;
  newVoxelSize: number;
}

export interface DirtyTerrain {
  id: number;
  field: VoxelField;
  dirtyMinX: number;
  dirtyMaxX: number;
  dirtyMinZ: number;
  dirtyMaxZ: number;
}

export interface EntityPosition {
  id: number;
  type: number;
  position: { x: number; y: number; z: number };
  scale: number;
  data: number[];
  chunkX: number;
  chunkZ: number;
}

export class TerrainStreamingManager {
  private terrains = new Map<number, TerrainEntry>();
  private pendingDeformations: Deformation[] = [];
  private pendingLODChanges: LODChange[] = [];
  private pendingPhysFieldGen: number[] = [];
  private tickCount = 0;
  private config: TerrainStreamingConfig;
  private chunkFieldFactory: ChunkFieldFactory;
  private physicsFieldFactory: PhysicsFieldFactory;
  private chunkGenerator: ChunkGenerator;
  private chunkEmptyChecker: ChunkEmptyChecker;
  private islandEntityType: number;
  private portEntityType: number;

  constructor(
    config: TerrainStreamingConfig,
    factories: {
      chunkFieldFactory: ChunkFieldFactory;
      physicsFieldFactory: PhysicsFieldFactory;
      chunkGenerator: ChunkGenerator;
      chunkEmptyChecker: ChunkEmptyChecker;
    },
    islandEntityType: number = 2,
    portEntityType: number = 3,
  ) {
    this.config = config;
    this.chunkFieldFactory = factories.chunkFieldFactory;
    this.physicsFieldFactory = factories.physicsFieldFactory;
    this.chunkGenerator = factories.chunkGenerator;
    this.chunkEmptyChecker = factories.chunkEmptyChecker;
    this.islandEntityType = islandEntityType;
    this.portEntityType = portEntityType;
  }

  registerIsland(
    id: number,
    chunkX: number,
    chunkZ: number,
    radius: number,
    worldX: number, worldY: number, worldZ: number,
    biome: number = 0,
    islandSize: number = 0,
  ): void {
    if (radius <= 0) return;

    const { field: chunkedField, ctx: chunkedCtx } = this.chunkFieldFactory(
      chunkX, chunkZ, radius, this.config.baseVoxelSize,
    );

    const physVs = chunkedField.voxelSize * 1.0;

    this.terrains.set(id, {
      id,
      chunkX,
      chunkZ,
      radius,
      worldX, worldY, worldZ,
      isPort: false,
      field: null,
      chunkedField,
      dirty: false,
      deformCount: 0,
      dirtyMinX: 0, dirtyMaxX: 0, dirtyMinZ: 0, dirtyMaxZ: 0,
      hasDirtyRegion: false,
      dirtyChunkKeys: null,
      currentLODVoxelSize: 0,
      pendingChunkGen: null,
      lastLODChangeTick: 0,
      pendingPhysField: { chunkX, chunkZ, radius, physVs },
    });

    this.pendingPhysFieldGen.push(id);
    void biome; void islandSize; void chunkedCtx;
  }

  registerPort(
    id: number,
    chunkX: number,
    chunkZ: number,
    radius: number,
    worldX: number, worldY: number, worldZ: number,
    portField: VoxelField,
  ): void {
    if (radius <= 0) return;

    this.terrains.set(id, {
      id,
      chunkX,
      chunkZ,
      radius,
      worldX, worldY, worldZ,
      isPort: true,
      field: portField,
      chunkedField: null,
      dirty: false,
      deformCount: 0,
      dirtyMinX: 0, dirtyMaxX: 0, dirtyMinZ: 0, dirtyMaxZ: 0,
      hasDirtyRegion: false,
      dirtyChunkKeys: null,
      currentLODVoxelSize: 0,
      pendingChunkGen: null,
      lastLODChangeTick: 0,
      pendingPhysField: null,
    });
  }

  unregister(id: number): void {
    this.terrains.delete(id);
  }

  hasTerrain(id: number): boolean {
    return this.terrains.has(id);
  }

  getTerrain(id: number): TerrainEntry | null {
    return this.terrains.get(id) ?? null;
  }

  getVoxelField(id: number): VoxelField | null {
    return this.terrains.get(id)?.field ?? null;
  }

  getChunkedField(id: number): ChunkedVoxelField | null {
    return this.terrains.get(id)?.chunkedField ?? null;
  }

  isPort(id: number): boolean {
    return this.terrains.get(id)?.isPort ?? false;
  }

  hasPhysicsField(id: number): boolean {
    const t = this.terrains.get(id);
    return t ? t.field !== null : false;
  }

  processPendingPhysicsFieldGen(): void {
    if (this.pendingPhysFieldGen.length === 0) return;
    const cfg = this.config;
    const startTime = performance.now();
    let generated = 0;

    while (this.pendingPhysFieldGen.length > 0 && generated < cfg.physFieldGenMaxPerTick) {
      if (performance.now() - startTime > cfg.physFieldGenTimeBudgetMs) break;

      const id = this.pendingPhysFieldGen.shift()!;
      const terrain = this.terrains.get(id);
      if (!terrain || !terrain.pendingPhysField) continue;

      const { chunkX, chunkZ, radius, physVs } = terrain.pendingPhysField;
      terrain.field = this.physicsFieldFactory(chunkX, chunkZ, radius, physVs);
      terrain.pendingPhysField = null;
      generated++;
    }
  }

  updatePositions(entities: EntityPosition[], entityCount: number): void {
    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== this.islandEntityType && ent.type !== this.portEntityType) continue;
      const terrain = this.terrains.get(ent.id);
      if (terrain) {
        terrain.worldX = ent.position.x;
        terrain.worldY = ent.position.y;
        terrain.worldZ = ent.position.z;
      }
    }
  }

  deform(deformation: Deformation): void {
    this.pendingDeformations.push(deformation);
  }

  deformAt(
    id: number,
    worldX: number, worldY: number, worldZ: number,
    radius: number,
    strength: number,
  ): void {
    this.pendingDeformations.push({ id, worldX, worldY, worldZ, radius, strength });
  }

  processDeformations(): void {
    if (this.pendingDeformations.length === 0) return;

    for (let i = 0; i < this.pendingDeformations.length; i++) {
      const def = this.pendingDeformations[i];
      const terrain = this.terrains.get(def.id);
      if (!terrain) continue;

      const field = terrain.field;
      if (!field) {
        const cf = terrain.chunkedField;
        if (cf) {
          this.applyDeformationToChunked(cf, terrain, def);
        }
        terrain.dirty = true;
        terrain.deformCount++;
        continue;
      }

      const vs = field.voxelSize;
      const localX = def.worldX - terrain.worldX;
      const localY = def.worldY - terrain.worldY;
      const localZ = def.worldZ - terrain.worldZ;
      const defRadiusVoxels = Math.ceil(def.radius / vs);
      const defRadiusSq = def.radius * def.radius;
      const cx = Math.floor((localX - field.originX) / vs);
      const cy = Math.floor((localY - field.originY) / vs);
      const cz = Math.floor((localZ - field.originZ) / vs);

      const minVX = Math.max(0, cx - defRadiusVoxels - 1);
      const maxVX = Math.min(field.dimX - 1, cx + defRadiusVoxels + 1);
      const minVZ = Math.max(0, cz - defRadiusVoxels - 1);
      const maxVZ = Math.min(field.dimZ - 1, cz + defRadiusVoxels + 1);
      if (terrain.hasDirtyRegion) {
        terrain.dirtyMinX = Math.min(terrain.dirtyMinX, minVX);
        terrain.dirtyMaxX = Math.max(terrain.dirtyMaxX, maxVX);
        terrain.dirtyMinZ = Math.min(terrain.dirtyMinZ, minVZ);
        terrain.dirtyMaxZ = Math.max(terrain.dirtyMaxZ, maxVZ);
      } else {
        terrain.dirtyMinX = minVX;
        terrain.dirtyMaxX = maxVX;
        terrain.dirtyMinZ = minVZ;
        terrain.dirtyMaxZ = maxVZ;
        terrain.hasDirtyRegion = true;
      }

      for (let vx = cx - defRadiusVoxels; vx <= cx + defRadiusVoxels; vx++) {
        if (vx < 0 || vx >= field.dimX) continue;
        for (let vy = cy - defRadiusVoxels; vy <= cy + defRadiusVoxels; vy++) {
          if (vy < 0 || vy >= field.dimY) continue;
          for (let vz = cz - defRadiusVoxels; vz <= cz + defRadiusVoxels; vz++) {
            if (vz < 0 || vz >= field.dimZ) continue;
            const wx = vx * vs + field.originX;
            const wy = vy * vs + field.originY;
            const wz = vz * vs + field.originZ;
            const ddx = wx - localX;
            const ddy = wy - localY;
            const ddz = wz - localZ;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (distSq > defRadiusSq) continue;
            const falloff = 1 - Math.sqrt(distSq) / def.radius;
            const change = def.strength * falloff * falloff;
            const idx = vx * field.dimY * field.dimZ + vy * field.dimZ + vz;
            field.data[idx] += change;
          }
        }
      }

      const cf = terrain.chunkedField;
      if (cf) {
        this.applyDeformationToChunked(cf, terrain, def);
      }

      terrain.dirty = true;
      terrain.deformCount++;
    }

    this.pendingDeformations.length = 0;
  }

  private applyDeformationToChunked(
    cf: ChunkedVoxelField,
    terrain: TerrainEntry,
    def: Deformation,
  ): void {
    const cvs = cf.voxelSize;
    const localX = def.worldX - terrain.worldX;
    const localY = def.worldY - terrain.worldY;
    const localZ = def.worldZ - terrain.worldZ;
    const cDefRadiusVoxels = Math.ceil(def.radius / cvs);
    const ccx = Math.floor((localX - cf.originX) / cvs);
    const ccy = Math.floor((localY - cf.originY) / cvs);
    const ccz = Math.floor((localZ - cf.originZ) / cvs);
    const defRadiusSq = def.radius * def.radius;

    if (!terrain.dirtyChunkKeys) terrain.dirtyChunkKeys = new Set();

    for (let vx = ccx - cDefRadiusVoxels; vx <= ccx + cDefRadiusVoxels; vx++) {
      if (vx < 0 || vx >= cf.dimX) continue;
      for (let vy = ccy - cDefRadiusVoxels; vy <= ccy + cDefRadiusVoxels; vy++) {
        if (vy < 0 || vy >= cf.dimY) continue;
        for (let vz = ccz - cDefRadiusVoxels; vz <= ccz + cDefRadiusVoxels; vz++) {
          if (vz < 0 || vz >= cf.dimZ) continue;
          const wx = vx * cvs + cf.originX;
          const wy = vy * cvs + cf.originY;
          const wz = vz * cvs + cf.originZ;
          const ddx = wx - localX;
          const ddy = wy - localY;
          const ddz = wz - localZ;
          const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
          if (distSq > defRadiusSq) continue;
          const falloff = 1 - Math.sqrt(distSq) / def.radius;
          const change = def.strength * falloff * falloff;

          const chCx = vx >>> cf.chunkBits;
          const chCy = vy >>> cf.chunkBits;
          const chCz = vz >>> cf.chunkBits;
          const chunkKey = chCx * cf.chunkDimY * cf.chunkDimZ + chCy * cf.chunkDimZ + chCz;
          terrain.dirtyChunkKeys.add(chunkKey);

          setChunkedVoxel(cf, vx, vy, vz, getChunkedVoxel(cf, vx, vy, vz) + change);
        }
      }
    }
  }

  drainDirtyTerrains(): DirtyTerrain[] {
    const out: DirtyTerrain[] = [];
    this.terrains.forEach((terrain) => {
      if (terrain.dirty && terrain.field) {
        out.push({
          id: terrain.id,
          field: terrain.field,
          dirtyMinX: terrain.dirtyMinX,
          dirtyMaxX: terrain.dirtyMaxX,
          dirtyMinZ: terrain.dirtyMinZ,
          dirtyMaxZ: terrain.dirtyMaxZ,
        });
        terrain.dirty = false;
        terrain.hasDirtyRegion = false;
      }
    });
    return out;
  }

  drainDirtyChunkKeys(id: number): number[] | null {
    const terrain = this.terrains.get(id);
    if (!terrain || !terrain.dirtyChunkKeys || terrain.dirtyChunkKeys.size === 0) return null;
    const out = Array.from(terrain.dirtyChunkKeys);
    terrain.dirtyChunkKeys.clear();
    return out;
  }

  getDirtyIslands(): number[] {
    const dirty: number[] = [];
    for (const [id, terrain] of this.terrains) {
      if (terrain.dirty) dirty.push(id);
    }
    return dirty;
  }

  markClean(id: number): void {
    const terrain = this.terrains.get(id);
    if (terrain) {
      terrain.dirty = false;
      terrain.deformCount = 0;
    }
  }

  hasDirtyIslands(): boolean {
    for (const [, terrain] of this.terrains) {
      if (terrain.dirty) return true;
    }
    return false;
  }

  updateLOD(
    entities: EntityPosition[],
    entityCount: number,
    playerX: number,
    playerZ: number,
  ): void {
    this.tickCount++;
    const cfg = this.config;

    const candidates: { ent: EntityPosition; terrain: TerrainEntry; effectiveLODVs: number; dist: number }[] = [];

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== this.islandEntityType) continue;
      const terrain = this.terrains.get(ent.id);
      if (!terrain || terrain.isPort) continue;

      if (this.tickCount - terrain.lastLODChangeTick < cfg.lodHysteresisTicks) continue;

      const dx = terrain.worldX - playerX;
      const dz = terrain.worldZ - playerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      const targetLODVs = getLODVoxelSize(dist, cfg.lodLevels);
      const effectiveLODVs = targetLODVs === 0 ? cfg.baseVoxelSize : targetLODVs;

      if (effectiveLODVs === terrain.currentLODVoxelSize) continue;

      candidates.push({ ent, terrain, effectiveLODVs, dist });
    }

    if (candidates.length === 0) return;

    candidates.sort((a, b) => a.dist - b.dist);

    const cand = candidates[0];
    const { ent, terrain, effectiveLODVs } = cand;
    const r = terrain.radius;

    const { field: newChunkedField } = this.chunkFieldFactory(
      terrain.chunkX, terrain.chunkZ, r, effectiveLODVs,
    );

    terrain.chunkedField = newChunkedField;
    terrain.currentLODVoxelSize = effectiveLODVs;
    terrain.pendingChunkGen = null;
    terrain.lastLODChangeTick = this.tickCount;

    this.pendingLODChanges.push({
      id: ent.id,
      chunkX: terrain.chunkX,
      chunkZ: terrain.chunkZ,
      newVoxelSize: effectiveLODVs,
    });
  }

  drainLODChanges(): LODChange[] {
    const out = this.pendingLODChanges;
    this.pendingLODChanges = [];
    return out;
  }

  queueNearbyChunksForGeneration(
    entities: EntityPosition[],
    entityCount: number,
    playerX: number,
    playerZ: number,
  ): void {
    if (this.tickCount % 30 !== 0) return;
    const cfg = this.config;

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== this.islandEntityType) continue;
      const terrain = this.terrains.get(ent.id);
      if (!terrain || !terrain.chunkedField || terrain.isPort) continue;

      const cf = terrain.chunkedField;
      const dx = terrain.worldX - playerX;
      const dz = terrain.worldZ - playerZ;
      const distSq = dx * dx + dz * dz;

      if (distSq > cfg.lodCheckRange * cfg.lodCheckRange) continue;
      if (terrain.pendingChunkGen && terrain.pendingChunkGen.length > 0) continue;

      const chunks: { idx: number; distSq: number }[] = [];
      let scanned = 0;
      for (let cx = 0; cx < cf.chunkDimX && scanned < cfg.maxChunksToScan; cx++) {
        for (let cy = 0; cy < cf.chunkDimY && scanned < cfg.maxChunksToScan; cy++) {
          for (let cz = 0; cz < cf.chunkDimZ && scanned < cfg.maxChunksToScan; cz++) {
            const chunkIdx = cx * cf.chunkDimY * cf.chunkDimZ + cy * cf.chunkDimZ + cz;
            if (isChunkEmpty(cf, chunkIdx)) continue;
            if (isChunkGenerated(cf, chunkIdx)) continue;

            const gx0 = cx * cf.chunkSize;
            const gz0 = cz * cf.chunkSize;
            const chunkWX = terrain.worldX + (gx0 + cf.chunkSize / 2) * cf.voxelSize + cf.originX;
            const chunkWZ = terrain.worldZ + (gz0 + cf.chunkSize / 2) * cf.voxelSize + cf.originZ;
            const cdx = chunkWX - playerX;
            const cdz = chunkWZ - playerZ;
            const chunkDistSq = cdx * cdx + cdz * cdz;

            if (chunkDistSq > cfg.generationRange * cfg.generationRange) continue;

            scanned++;

            if (this.chunkEmptyChecker(cf, null, cx, cy, cz)) continue;

            chunks.push({ idx: chunkIdx, distSq: chunkDistSq });
          }
        }
      }

      chunks.sort((a, b) => a.distSq - b.distSq);
      terrain.pendingChunkGen = chunks.map((c) => c.idx);
    }
  }

  processPendingChunkGen(): void {
    const cfg = this.config;
    const startTime = performance.now();
    let generated = 0;

    for (const [, terrain] of this.terrains) {
      if (!terrain.pendingChunkGen || terrain.pendingChunkGen.length === 0) continue;
      if (!terrain.chunkedField) continue;

      const cf = terrain.chunkedField;

      while (terrain.pendingChunkGen.length > 0 && generated < cfg.chunkGenMaxPerTick) {
        if (performance.now() - startTime > cfg.chunkGenTimeBudgetMs) break;

        const chunkIdx = terrain.pendingChunkGen.shift()!;
        if (isChunkEmpty(cf, chunkIdx)) continue;
        if (isChunkGenerated(cf, chunkIdx)) continue;

        const cx = Math.floor(chunkIdx / (cf.chunkDimY * cf.chunkDimZ));
        const rem = chunkIdx % (cf.chunkDimY * cf.chunkDimZ);
        const cy = Math.floor(rem / cf.chunkDimZ);
        const cz = rem % cf.chunkDimZ;

        this.chunkGenerator(cf, null, cx, cy, cz);
        generated++;
      }

      if (terrain.pendingChunkGen.length === 0) {
        terrain.pendingChunkGen = null;
      }
    }
  }

  getCurrentLODVoxelSize(id: number): number {
    const terrain = this.terrains.get(id);
    return terrain ? terrain.currentLODVoxelSize : 0;
  }

  getLoadedCount(): number {
    return this.terrains.size;
  }

  clear(): void {
    this.terrains.clear();
    this.pendingDeformations.length = 0;
    this.pendingLODChanges.length = 0;
    this.pendingPhysFieldGen.length = 0;
  }
}

export { allocateChunk, markChunkGenerated } from "./chunked-field.ts";
