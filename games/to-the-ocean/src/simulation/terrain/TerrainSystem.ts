// ============================================================================
// TerrainSystem — manages per-island voxel fields and terrain deformation
// Runs in the sim worker. Handles deformation from all damage sources.
// ============================================================================

import {
    createChunkedVoxelField, ensureChunkGenerated,
    generatePortVoxelField,
    generateVoxelField,
    getLODVoxelSize, isChunkEmpty,
    type ChunkedFieldContext,
} from "../../shared/terrain";
import { TERRAIN_CONFIG } from "../../shared/TerrainConfig";
import { ChunkedVoxelField, TerrainDeformation, VoxelField, getChunkedVoxel, setChunkedVoxel } from "../../shared/TerrainTypes";
import { EntityType, TerrainDeformationBroadcast } from "../../shared/types";
import { SimEntity } from "../Simulation";

interface TerrainEntry {
  field: VoxelField | null;     // null until physics field is lazily generated (islands); non-null for ports
  chunkedField: ChunkedVoxelField | null;  // chunked field for islands (null for ports)
  chunkedCtx: ChunkedFieldContext | null;  // generation context for chunked field
  entityId: number;
  chunkX: number;
  chunkZ: number;
  radius: number;
  dirty: boolean;           // needs mesh rebuild
  deformCount: number;      // deformations since last rebuild
  worldX: number;           // world position (updated each tick)
  worldY: number;
  worldZ: number;
  isPort: boolean;          // true for port terrain, false for island
  // Bounding box of all deformations since last drain (in voxel indices)
  dirtyMinX: number; dirtyMaxX: number;
  dirtyMinZ: number; dirtyMaxZ: number;
  hasDirtyRegion: boolean;
  // Dirty chunk keys for chunked field (which chunks need mesh rebuild)
  dirtyChunkKeys: Set<number> | null;
  // LOD tracking (Phase 3)
  currentLODVoxelSize: number;  // 0 = base voxelSize
  // Pending chunk generation queue (Phase 4) — chunks to generate proactively
  pendingChunkGen: number[] | null;  // array of chunkIdx
  // Throttle: tick counter for queue rebuilding
  queueRebuildTick: number;
  // LOD hysteresis: tick when LOD was last changed (prevent rapid flapping)
  lastLODChangeTick: number;
  // Lazy physics field generation params (islands only, null once generated)
  pendingPhysField: { chunkX: number; chunkZ: number; radius: number; biome: number; islandSize: number; physVs: number } | null;
}

export class TerrainSystem {
  private terrains = new Map<number, TerrainEntry>();  // keyed by entity ID
  private pendingDeformations: TerrainDeformation[] = [];
  private pendingBroadcasts: TerrainDeformationBroadcast[] = [];
  private pendingLODChanges: { entityId: number; chunkX: number; chunkZ: number; newVoxelSize: number }[] = [];
  private pendingPhysFieldGen: number[] = [];  // entity IDs awaiting physics field generation
  private tickCount = 0;

  // Register an island's terrain when it spawns
  registerIsland(entity: SimEntity): void {
    if (entity.type !== EntityType.Island) return;
    const r = entity.scale;
    if (r <= 0) return;

    const biome = entity.data[1] ?? 0;
    const islandSize = entity.data[2] ?? 0;

    // Create chunked voxel field for on-demand chunk generation (cheap — allocates empty structures)
    const { field: chunkedField, ctx: chunkedCtx } = createChunkedVoxelField(
      entity.chunkX, entity.chunkZ, r, biome, islandSize,
    );

    // Physics field generation is deferred — queued here and processed across ticks
    // via processPendingPhysicsFieldGen() with a time budget to avoid sim stalls.
    const physVs = chunkedField.voxelSize * TERRAIN_CONFIG.physVoxelSizeMultiplier;

    this.terrains.set(entity.id, {
      field: null,  // will be generated lazily
      chunkedField,
      chunkedCtx,
      entityId: entity.id,
      chunkX: entity.chunkX,
      chunkZ: entity.chunkZ,
      radius: r,
      dirty: false,
      deformCount: 0,
      worldX: entity.position.x,
      worldY: entity.position.y,
      worldZ: entity.position.z,
      isPort: false,
      dirtyMinX: 0, dirtyMaxX: 0, dirtyMinZ: 0, dirtyMaxZ: 0, hasDirtyRegion: false,
      dirtyChunkKeys: null,
      currentLODVoxelSize: 0,
      pendingChunkGen: null,
      queueRebuildTick: 0,
      lastLODChangeTick: 0,
      pendingPhysField: { chunkX: entity.chunkX, chunkZ: entity.chunkZ, radius: r, biome, islandSize, physVs },
    });
    this.pendingPhysFieldGen.push(entity.id);
  }

  // Process pending physics field generation with a time budget.
  // Called each tick — generates at most physFieldGenMaxPerTick islands.
  processPendingPhysicsFieldGen(): void {
    if (this.pendingPhysFieldGen.length === 0) return;
    const cfg = TERRAIN_CONFIG;
    const startTime = performance.now();
    let generated = 0;

    while (this.pendingPhysFieldGen.length > 0 && generated < cfg.physFieldGenMaxPerTick) {
      if (performance.now() - startTime > cfg.physFieldGenTimeBudgetMs) break;

      const entityId = this.pendingPhysFieldGen.shift()!;
      const terrain = this.terrains.get(entityId);
      if (!terrain || !terrain.pendingPhysField) continue;

      const { chunkX, chunkZ, radius, biome, islandSize, physVs } = terrain.pendingPhysField;
      terrain.field = generateVoxelField(chunkX, chunkZ, radius, biome, islandSize, physVs);
      terrain.pendingPhysField = null;
      generated++;
    }
  }

  // Check if an island's physics field has been generated yet
  hasPhysicsField(entityId: number): boolean {
    const terrain = this.terrains.get(entityId);
    return terrain ? terrain.field !== null : false;
  }

  // Register a port's terrain when it spawns
  registerPort(entity: SimEntity): void {
    if (entity.type !== EntityType.Port) return;
    const r = entity.scale;
    if (r <= 0) return;

    const biome = entity.data[5] ?? 0; // PORT_DATA.BIOME
    const field = generatePortVoxelField(entity.chunkX, entity.chunkZ, r, biome);

    this.terrains.set(entity.id, {
      field,
      chunkedField: null,
      chunkedCtx: null,
      entityId: entity.id,
      chunkX: entity.chunkX,
      chunkZ: entity.chunkZ,
      radius: r,
      dirty: false,
      deformCount: 0,
      worldX: entity.position.x,
      worldY: entity.position.y,
      worldZ: entity.position.z,
      isPort: true,
      dirtyMinX: 0, dirtyMaxX: 0, dirtyMinZ: 0, dirtyMaxZ: 0, hasDirtyRegion: false,
      dirtyChunkKeys: null,
      currentLODVoxelSize: 0,
      pendingChunkGen: null,
      queueRebuildTick: 0,
      lastLODChangeTick: 0,
      pendingPhysField: null,
    });
  }

  // Unregister when island despawns
  unregisterIsland(entityId: number): void {
    this.terrains.delete(entityId);
  }

  // Get the voxel field for an entity (island or port)
  getVoxelField(entityId: number): VoxelField | null {
    const terrain = this.terrains.get(entityId);
    return terrain ? terrain.field : null;
  }

  // Get the chunked voxel field for an island (null for ports)
  getChunkedField(entityId: number): ChunkedVoxelField | null {
    const terrain = this.terrains.get(entityId);
    return terrain ? terrain.chunkedField : null;
  }

  // Get the chunked field context for an island (null for ports)
  getChunkedCtx(entityId: number): ChunkedFieldContext | null {
    const terrain = this.terrains.get(entityId);
    return terrain ? terrain.chunkedCtx : null;
  }

  // Check if an entity has registered terrain
  hasTerrain(entityId: number): boolean {
    return this.terrains.has(entityId);
  }

  // Get all dirty terrain entries and clear their dirty flag (for physics rebuild)
  drainDirtyTerrains(): { entityId: number; field: VoxelField; dirtyMinX: number; dirtyMaxX: number; dirtyMinZ: number; dirtyMaxZ: number }[] {
    const out: { entityId: number; field: VoxelField; dirtyMinX: number; dirtyMaxX: number; dirtyMinZ: number; dirtyMaxZ: number }[] = [];
    this.terrains.forEach((terrain) => {
      if (terrain.dirty && terrain.field) {
        out.push({
          entityId: terrain.entityId,
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

  // Drain dirty chunk keys for an island (for renderer chunk mesh rebuild)
  // Returns array of chunk key indices, or null if no chunked field / no dirty chunks.
  drainDirtyChunkKeys(entityId: number): number[] | null {
    const terrain = this.terrains.get(entityId);
    if (!terrain || !terrain.dirtyChunkKeys || terrain.dirtyChunkKeys.size === 0) return null;
    const out = Array.from(terrain.dirtyChunkKeys);
    terrain.dirtyChunkKeys.clear();
    return out;
  }

  // Check if terrain belongs to a port
  isPortTerrain(entityId: number): boolean {
    const terrain = this.terrains.get(entityId);
    return terrain ? terrain.isPort : false;
  }

  // Queue a deformation — will be applied in processDeformations()
  deform(deformation: TerrainDeformation): void {
    this.pendingDeformations.push(deformation);
  }

  // Convenience method: deform by world-space position
  deformAt(
    entityId: number,
    worldX: number, worldY: number, worldZ: number,
    radius: number,
    strength: number,
  ): void {
    this.pendingDeformations.push({
      islandEntityId: entityId,
      worldX, worldY, worldZ,
      radius,
      strength,
    });
  }

  // Process all pending deformations — called once per tick
  processDeformations(): void {
    if (this.pendingDeformations.length === 0) return;

    for (let i = 0; i < this.pendingDeformations.length; i++) {
      const def = this.pendingDeformations[i];
      const terrain = this.terrains.get(def.islandEntityId);
      if (!terrain) continue;

      const field = terrain.field;
      if (!field) {
        // Physics field not yet generated — skip physics field deformation.
        // Chunked field deformation below still applies.
        // Queue broadcast so renderer can apply the deformation to its own field.
        this.pendingBroadcasts.push({
          chunkX: terrain.chunkX,
          chunkZ: terrain.chunkZ,
          isPort: terrain.isPort,
          worldX: def.worldX,
          worldY: def.worldY,
          worldZ: def.worldZ,
          entityWorldX: terrain.worldX,
          entityWorldY: terrain.worldY,
          entityWorldZ: terrain.worldZ,
          radius: def.radius,
          strength: def.strength,
        });

        // Still apply to chunked field if present
        const cf = terrain.chunkedField;
        const cfCtx = terrain.chunkedCtx;
        if (cf && cfCtx) {
          const cvs = cf.voxelSize;
          const cDefRadiusVoxels = Math.ceil(def.radius / cvs);
          const ccx = Math.floor((def.worldX - terrain.worldX - cf.originX) / cvs);
          const ccy = Math.floor((def.worldY - terrain.worldY - cf.originY) / cvs);
          const ccz = Math.floor((def.worldZ - terrain.worldZ - cf.originZ) / cvs);
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
                const ddx = wx - (def.worldX - terrain.worldX);
                const ddy = wy - (def.worldY - terrain.worldY);
                const ddz = wz - (def.worldZ - terrain.worldZ);
                const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
                if (distSq > defRadiusSq) continue;

                const falloff = 1 - Math.sqrt(distSq) / def.radius;
                const change = def.strength * falloff * falloff;

                const chCx = vx >>> cf.chunkBits;
                const chCy = vy >>> cf.chunkBits;
                const chCz = vz >>> cf.chunkBits;
                ensureChunkGenerated(cf, cfCtx, chCx, chCy, chCz);

                const chunkKey = chCx * cf.chunkDimY * cf.chunkDimZ + chCy * cf.chunkDimZ + chCz;
                terrain.dirtyChunkKeys.add(chunkKey);

                setChunkedVoxel(cf, vx, vy, vz, getChunkedVoxel(cf, vx, vy, vz) + change);
              }
            }
          }
        }

        terrain.dirty = true;
        terrain.deformCount++;
        continue;
      }

      const vs = field.voxelSize;

      // Convert world-space deformation center to island-local coordinates
      const localX = def.worldX - terrain.worldX;
      const localY = def.worldY - terrain.worldY;
      const localZ = def.worldZ - terrain.worldZ;

      // Deformation radius in voxels
      const defRadiusVoxels = Math.ceil(def.radius / vs);
      const defRadiusSq = def.radius * def.radius;

      // Center voxel
      const cx = Math.floor((localX - field.originX) / vs);
      const cy = Math.floor((localY - field.originY) / vs);
      const cz = Math.floor((localZ - field.originZ) / vs);

      // Track dirty region (expanded by 1 for marching cubes boundary)
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

      // Iterate over the sphere of voxels
      for (let vx = cx - defRadiusVoxels; vx <= cx + defRadiusVoxels; vx++) {
        if (vx < 0 || vx >= field.dimX) continue;
        for (let vy = cy - defRadiusVoxels; vy <= cy + defRadiusVoxels; vy++) {
          if (vy < 0 || vy >= field.dimY) continue;
          for (let vz = cz - defRadiusVoxels; vz <= cz + defRadiusVoxels; vz++) {
            if (vz < 0 || vz >= field.dimZ) continue;

            // World-space position of this voxel
            const wx = vx * vs + field.originX;
            const wy = vy * vs + field.originY;
            const wz = vz * vs + field.originZ;

            // Distance from deformation center
            const ddx = wx - localX;
            const ddy = wy - localY;
            const ddz = wz - localZ;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;

            if (distSq > defRadiusSq) continue;

            // Falloff: 1 at center, 0 at edge (smooth)
            const falloff = 1 - Math.sqrt(distSq) / def.radius;
            const change = def.strength * falloff * falloff;

            const idx = vx * field.dimY * field.dimZ + vy * field.dimZ + vz;
            field.data[idx] += change;
          }
        }
      }

      // Also apply deformation to the chunked field (if present) for render-resolution updates
      const cf = terrain.chunkedField;
      const cfCtx = terrain.chunkedCtx;
      if (cf && cfCtx) {
        const cvs = cf.voxelSize;
        const cDefRadiusVoxels = Math.ceil(def.radius / cvs);
        const ccx = Math.floor((localX - cf.originX) / cvs);
        const ccy = Math.floor((localY - cf.originY) / cvs);
        const ccz = Math.floor((localZ - cf.originZ) / cvs);

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

              // Ensure the chunk containing this voxel is generated before modifying
              const chCx = vx >>> cf.chunkBits;
              const chCy = vy >>> cf.chunkBits;
              const chCz = vz >>> cf.chunkBits;
              ensureChunkGenerated(cf, cfCtx, chCx, chCy, chCz);

              // Track dirty chunk
              const chunkKey = chCx * cf.chunkDimY * cf.chunkDimZ + chCy * cf.chunkDimZ + chCz;
              terrain.dirtyChunkKeys.add(chunkKey);

              setChunkedVoxel(cf, vx, vy, vz, getChunkedVoxel(cf, vx, vy, vz) + change);
            }
          }
        }
      }

      terrain.dirty = true;
      terrain.deformCount++;

      // Queue broadcast so the renderer can apply the same deformation
      this.pendingBroadcasts.push({
        chunkX: terrain.chunkX,
        chunkZ: terrain.chunkZ,
        isPort: terrain.isPort,
        worldX: def.worldX,
        worldY: def.worldY,
        worldZ: def.worldZ,
        entityWorldX: terrain.worldX,
        entityWorldY: terrain.worldY,
        entityWorldZ: terrain.worldZ,
        radius: def.radius,
        strength: def.strength,
      });
    }

    this.pendingDeformations.length = 0;
  }

  // Drain pending broadcasts (called by sim worker after processDeformations)
  drainBroadcasts(): TerrainDeformationBroadcast[] {
    const out = this.pendingBroadcasts;
    this.pendingBroadcasts = [];
    return out;
  }

  // Check which islands need mesh rebuild
  getDirtyIslands(): number[] {
    const dirty: number[] = [];
    for (const [entityId, terrain] of this.terrains) {
      if (terrain.dirty) dirty.push(entityId);
    }
    return dirty;
  }

  // Mark an island as rebuilt
  markClean(entityId: number): void {
    const terrain = this.terrains.get(entityId);
    if (terrain) {
      terrain.dirty = false;
      terrain.deformCount = 0;
    }
  }

  // Check if any islands need processing
  hasDirtyIslands(): boolean {
    for (const [, terrain] of this.terrains) {
      if (terrain.dirty) return true;
    }
    return false;
  }

  // Get terrain info for an entity
  getTerrain(entityId: number): TerrainEntry | null {
    return this.terrains.get(entityId) ?? null;
  }

  // Update entity world positions (for world-space deformation conversion)
  // Called each tick before processing deformations
  updateIslandPositions(entities: SimEntity[], entityCount: number): void {
    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Island && ent.type !== EntityType.Port) continue;
      const terrain = this.terrains.get(ent.id);
      if (terrain) {
        terrain.worldX = ent.position.x;
        terrain.worldY = ent.position.y;
        terrain.worldZ = ent.position.z;
      }
    }
  }

  // Phase 3: Check and update LOD for all islands based on player distance.
  // Queues LOD changes internally; caller drains them via drainLODChanges().
  // Limits to 1 LOD transition per tick to avoid sim stalls when moving fast.
  // Skips physics field regeneration for distant islands (no collision needed).
  updateLOD(
    entities: SimEntity[], entityCount: number,
    playerX: number, playerZ: number,
  ): void {
    this.tickCount++;
    const lodHysteresisTicks = 60;  // 1 second at 60fps — prevent rapid LOD flapping

    // Collect all candidates that need LOD change, sorted by distance
    const candidates: { ent: SimEntity; terrain: TerrainEntry; effectiveLODVs: number; dist: number }[] = [];

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Island) continue;
      const terrain = this.terrains.get(ent.id);
      if (!terrain || terrain.isPort) continue;

      // Hysteresis: skip LOD check if we recently changed LOD for this island
      if (this.tickCount - terrain.lastLODChangeTick < lodHysteresisTicks) continue;

      const dx = terrain.worldX - playerX;
      const dz = terrain.worldZ - playerZ;
      const distSq = dx * dx + dz * dz;
      const dist = Math.sqrt(distSq);

      const targetLODVs = getLODVoxelSize(dist);
      const effectiveLODVs = targetLODVs === 0 ? TERRAIN_CONFIG.voxelSize : targetLODVs;

      if (effectiveLODVs === terrain.currentLODVoxelSize) continue;

      candidates.push({ ent, terrain, effectiveLODVs, dist });
    }

    if (candidates.length === 0) return;

    // Sort by distance — closest first (most important to update)
    candidates.sort((a, b) => a.dist - b.dist);

    // Process only 1 LOD transition per tick to avoid sim stalls
    const cand = candidates[0];
    const { ent, terrain, effectiveLODVs } = cand;

    const biome = ent.data[1] ?? 0;
    const islandSize = ent.data[2] ?? 0;
    const r = terrain.radius;

    // Regenerate chunked field (cheap — just allocates empty structures)
    const { field: newChunkedField, ctx: newChunkedCtx } = createChunkedVoxelField(
      terrain.chunkX, terrain.chunkZ, r, biome, islandSize, effectiveLODVs,
    );

    terrain.chunkedField = newChunkedField;
    terrain.chunkedCtx = newChunkedCtx;
    terrain.currentLODVoxelSize = effectiveLODVs;
    terrain.pendingChunkGen = null;
    terrain.lastLODChangeTick = this.tickCount;

    // NOTE: Physics field is NOT regenerated on LOD change.
    // The coarse physics field uses a fixed resolution (set at registerIsland time)
    // and doesn't need to match render LOD. Regenerating it synchronously here
    // causes 500-800ms stalls for large islands. Physics colliders are rebuilt
    // only when the player is close enough and the island actually deforms.

    this.pendingLODChanges.push({
      entityId: ent.id,
      chunkX: terrain.chunkX,
      chunkZ: terrain.chunkZ,
      newVoxelSize: effectiveLODVs,
    });
  }

  // Drain pending LOD changes (called by sim worker after updateLOD)
  drainLODChanges(): { entityId: number; chunkX: number; chunkZ: number; newVoxelSize: number }[] {
    const out = this.pendingLODChanges;
    this.pendingLODChanges = [];
    return out;
  }

  // Phase 4: Queue non-empty chunks near the player for proactive generation.
  // Throttled to every 30 ticks (~0.5s) to avoid scanning all chunks every tick.
  // Also caps the number of isChunkEmpty checks per queue build.
  queueNearbyChunksForGeneration(
    entities: SimEntity[], entityCount: number,
    playerX: number, playerZ: number,
  ): void {
    // Throttle: only rebuild queues every 30 ticks
    if (this.tickCount % 30 !== 0) return;

    const maxChunksToScan = 256;  // cap isChunkEmpty checks per island per rebuild

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Island) continue;
      const terrain = this.terrains.get(ent.id);
      if (!terrain || !terrain.chunkedField || !terrain.chunkedCtx || terrain.isPort) continue;

      const cf = terrain.chunkedField;
      const ctx = terrain.chunkedCtx;
      const dx = terrain.worldX - playerX;
      const dz = terrain.worldZ - playerZ;
      const distSq = dx * dx + dz * dz;

      // Only pre-generate for islands within LOD range
      if (distSq > 250 * 250) continue;

      // If we already have a pending queue, don't rebuild it
      if (terrain.pendingChunkGen && terrain.pendingChunkGen.length > 0) continue;

      // Build a list of non-empty chunks sorted by distance to player
      const chunks: { idx: number; distSq: number }[] = [];
      let scanned = 0;
      for (let cx = 0; cx < cf.chunkDimX && scanned < maxChunksToScan; cx++) {
        for (let cy = 0; cy < cf.chunkDimY && scanned < maxChunksToScan; cy++) {
          for (let cz = 0; cz < cf.chunkDimZ && scanned < maxChunksToScan; cz++) {
            const chunkIdx = cx * cf.chunkDimY * cf.chunkDimZ + cy * cf.chunkDimZ + cz;
            if (cf.chunkOffsets[chunkIdx] < 0) continue;  // already marked empty

            // Skip already-generated chunks
            if (cf.chunkGenerated[chunkIdx]) continue;

            // Approximate chunk center in world space (cheap — do before isChunkEmpty)
            const gx0 = cx * cf.chunkSize;
            const gz0 = cz * cf.chunkSize;
            const chunkWX = terrain.worldX + (gx0 + cf.chunkSize / 2) * cf.voxelSize + cf.originX;
            const chunkWZ = terrain.worldZ + (gz0 + cf.chunkSize / 2) * cf.voxelSize + cf.originZ;
            const cdx = chunkWX - playerX;
            const cdz = chunkWZ - playerZ;
            const chunkDistSq = cdx * cdx + cdz * cdz;

            // Skip chunks far from the player (beyond generation range)
            if (chunkDistSq > 200 * 200) continue;

            scanned++;

            // Fast empty check — skip chunks that are all air or all solid
            if (isChunkEmpty(cf, ctx, cx, cy, cz)) continue;

            chunks.push({ idx: chunkIdx, distSq: chunkDistSq });
          }
        }
      }

      chunks.sort((a, b) => a.distSq - b.distSq);
      terrain.pendingChunkGen = chunks.map(c => c.idx);
    }
  }

  // Phase 4: Process pending chunk generation with a time budget.
  // Called each tick to generate a few chunks proactively.
  processPendingChunkGen(): void {
    const cfg = TERRAIN_CONFIG;
    const startTime = performance.now();
    let generated = 0;

    for (const [, terrain] of this.terrains) {
      if (!terrain.pendingChunkGen || terrain.pendingChunkGen.length === 0) continue;
      if (!terrain.chunkedField || !terrain.chunkedCtx) continue;

      const cf = terrain.chunkedField;
      const ctx = terrain.chunkedCtx;

      while (terrain.pendingChunkGen.length > 0 && generated < cfg.chunkGenMaxPerTick) {
        if (performance.now() - startTime > cfg.chunkGenTimeBudgetMs) break;

        const chunkIdx = terrain.pendingChunkGen.shift()!;
        if (cf.chunkOffsets[chunkIdx] < 0) continue;  // empty chunk
        if (cf.chunkGenerated[chunkIdx]) continue;     // already done

        const cx = Math.floor(chunkIdx / (cf.chunkDimY * cf.chunkDimZ));
        const rem = chunkIdx % (cf.chunkDimY * cf.chunkDimZ);
        const cy = Math.floor(rem / cf.chunkDimZ);
        const cz = rem % cf.chunkDimZ;

        ensureChunkGenerated(cf, ctx, cx, cy, cz);
        generated++;
      }

      if (terrain.pendingChunkGen.length === 0) {
        terrain.pendingChunkGen = null;
      }
    }
  }

  // Get the current LOD voxel size for an island (0 = base)
  getCurrentLODVoxelSize(entityId: number): number {
    const terrain = this.terrains.get(entityId);
    return terrain ? terrain.currentLODVoxelSize : 0;
  }
}
