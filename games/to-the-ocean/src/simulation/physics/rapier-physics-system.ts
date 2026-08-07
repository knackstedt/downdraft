// ============================================================================
// RapierPhysicsSystem — Physics integration via @downdraft/plugin-physics-rapier
//
// Migrated from direct Rapier WASM calls to the UniversalPhysicsAPI. The game
// keeps its bespoke orchestration (chunked island trimeshes, time-budgeted
// incremental builds, ship-Y authority split, panic recovery) but all Rapier
// state access goes through the validated, PhysicsBody-keyed API.
// ============================================================================

import type { CharacterControllerHandle, PhysicsBody, PhysicsTimingData } from "@downdraft/core";
import type { VoxelField } from "@downdraft/plugin-marching-cubes";
import { RapierPhysicsBackend, UniversalPhysicsAPI } from "@downdraft/plugin-physics-rapier";
import {
    getPortColliderDims,
    getPortCollisionBoxes,
    PLAYER_HEIGHT,
    PLAYER_RADIUS,
    PORT_DATA,
    SHIP_COLLISION_FRICTION,
    SHIP_COLLISION_RESTITUTION,
    SIM_TICK_DT,
} from "../../shared/constants";
import { PLR_FLAG } from "../../shared/sim-buffer";
import { generateTerrainTrimeshSubRegion } from "../../shared/terrain";
import { EntityFlags, EntityType, EntityTypeNames } from "../../shared/types";
import { BoatCellSystem } from "../boat/boat-cell-system";
import { BoatDesignSystem } from "../boat/boat-design-system";
import { SimEntity, SimPlayer } from "../simulation";
import type { TerrainSystem } from "../terrain/terrain-system";

// --- Collision groups ---
// InteractionGroups = (filter << 16) | memberships
// Two colliders interact iff (a.memberships & b.filter) && (b.memberships & a.filter)
const GROUP_PLAYER = 0x0001;
const GROUP_SHIP = 0x0002;
const GROUP_ISLAND_PLAYER = 0x0004;
const GROUP_ISLAND_SHIP = 0x0008;

const PLAYER_COLLISION_GROUPS = ((0xFFFF & ~GROUP_PLAYER) << 16) | GROUP_PLAYER;
const SHIP_COLLISION_GROUPS = ((0xFFFF & ~GROUP_ISLAND_PLAYER) << 16) | GROUP_SHIP;
const ISLAND_BOTH_GROUPS = ((GROUP_PLAYER | GROUP_SHIP) << 16) | GROUP_ISLAND_SHIP;

interface EntityBody {
  body: PhysicsBody;
  entityIdx: number;
  isStatic: boolean;
  isShip: boolean;
  entityType: number;
  entityId: number;
  // For islands: chunk grid of trimesh collider ids for partial updates
  chunkColliders?: Map<string, number>;
  chunkSize?: number;
  chunkCountX?: number;
  chunkCountZ?: number;
  needsTerrainCollider?: boolean;
  // Collider ids for ships — used to swap colliders without recreating the body
  colliderIds?: number[];
}

export interface CollisionLogEntry {
  label: string;
  count: number;
  lastCollisionTime: number;
}

interface PlayerCharacter {
  handle: CharacterControllerHandle;
  playerIdx: number;
}

interface PendingTrimeshChunk {
  entityIdx: number;
  entity: SimEntity;
  field: VoxelField;
  body: PhysicsBody;
  cx: number;
  cz: number;
  chunkSize: number;
}

export interface PlayerMoveRequest {
  playerIdx: number;
  desiredDeltaX: number;
  desiredDeltaY: number;
  desiredDeltaZ: number;
  skipCollision: boolean;
}

export class RapierPhysicsSystem {
  private api: UniversalPhysicsAPI | null = null;
  private backend: RapierPhysicsBackend | null = null;

  private entityBodies = new Map<number, EntityBody>();
  private pendingShipRebuilds = new Map<number, { entity: SimEntity; entityIdx: number }>();
  private playerCharacters = new Map<number, PlayerCharacter>();
  private collisionLog: CollisionLogEntry[] = [];

  private _timing: PhysicsTimingData = {
    step: 0, collisionDetection: 0, broadPhase: 0, narrowPhase: 0, solver: 0,
    velocityAssembly: 0, velocityResolution: 0, velocityUpdate: 0, velocityWriteback: 0,
    ccd: 0, ccdToiComputation: 0, ccdBroadPhase: 0, ccdNarrowPhase: 0, ccdSolver: 0,
    islandConstruction: 0, userChanges: 0,
  };
  private profilerEnabled = false;

  private islandFields = new Map<number, VoxelField>();
  private pendingTrimeshChunks: PendingTrimeshChunk[] = [];
  private static readonly TRIMESH_TIME_BUDGET_MS = 8;

  private boatCellSystem: BoatCellSystem;
  private boatDesignSystem: BoatDesignSystem | null = null;
  private terrainSystem: TerrainSystem | null = null;
  private initialized = false;
  private failed = false;
  private tickCount = 0;
  private currentDt = SIM_TICK_DT;

  private static readonly PLAYER_CAPSULE_HALF_HEIGHT = (PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2;
  private static readonly PLAYER_CAPSULE_RADIUS = PLAYER_RADIUS;
  private static readonly PLAYER_CONTROLLER_OFFSET = 0.01;
  private static readonly PLAYER_CAPSULE_Y_OFFSET = PLAYER_HEIGHT / 2;

  constructor(boatCellSystem: BoatCellSystem) {
    this.boatCellSystem = boatCellSystem;
  }

  setBoatDesignSystem(bds: BoatDesignSystem): void {
    this.boatDesignSystem = bds;
  }

  setTerrainSystem(ts: TerrainSystem): void {
    this.terrainSystem = ts;
  }

  async init(): Promise<void> {
    this.backend = new RapierPhysicsBackend();
    await this.backend.init();
    this.api = new UniversalPhysicsAPI(this.backend, {
      gravity: [0, -9.8, 0],
      fixedDt: SIM_TICK_DT,
      maxCatchUpSteps: 1,
      stepBudgetMs: 16,
      maxEntities: 4096,
      realmConfigs: {
        near: { tickFrequency: 1, solverIterations: 4, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
        mid: { tickFrequency: 1, solverIterations: 4, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
        far: { tickFrequency: 1, solverIterations: 4, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
      },
      nanSweepInterval: 0,
      nanSweepVelocityThreshold: 0,
      ccdTunnelingRatio: 0,
      snapshotInterval: 0,
      predictionMode: "server-authoritative",
      workerCount: 0,
      devMode: false,
      duplicateStatics: false,
    });
    // Pre-allocate WASM heap to avoid growth stutter during gameplay
    this.api.reserveMemory(64 * 1024 * 1024);
    this.initialized = true;
    this.failed = false;
  }

  isInitialized(): boolean {
    return this.initialized && !this.failed;
  }

  getStats(): {
    initialized: boolean; failed: boolean; bodyCount: number; tickCount: number;
    profilerEnabled: boolean; timing: PhysicsTimingData | null;
  } {
    return {
      initialized: this.initialized,
      failed: this.failed,
      bodyCount: this.entityBodies.size,
      tickCount: this.tickCount,
      profilerEnabled: this.profilerEnabled,
      timing: this.profilerEnabled ? { ...this._timing } : null,
    };
  }

  setProfilerEnabled(enabled: boolean): void {
    this.profilerEnabled = enabled;
  }

  // --- Self-recovery ---

  private isWasmTrap(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("unreachable") || msg.includes("RuntimeError") || msg.includes("abort");
  }

  private panicRecover(err: unknown): void {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error(`[PHYSICS] Panic at tick ${this.tickCount}: ${msg}`);
    // Tear down the corrupted world. Re-init is async (WASM load) so it can't
    // happen here — keep failed=true and initialized=false so isInitialized()
    // returns false and the sim loop awaits re-init before the next tick.
    try {
      this.recreateWorld();
    } catch (recoveryErr) {
      console.error(`[PHYSICS] Failed to tear down after panic: ${recoveryErr}`);
    }
    this.failed = true;
    this.initialized = false;
    console.error(`[PHYSICS] Physics torn down after panic; will re-init next tick`);
  }

  private recreateWorld(): void {
    if (this.api) {
      try { this.api.destroy(); } catch {}
      this.api = null;
    }
    this.entityBodies.clear();
    this.pendingShipRebuilds.clear();
    this.pendingTrimeshChunks.length = 0;
    this.playerCharacters.clear();
    this.islandFields.clear();
    this.collisionLog = [];

    if (this.backend) {
      try { this.backend.destroy(); } catch {}
      this.backend = null;
    }
  }

  // --- Entity body management ---

  createEntityBody(entity: SimEntity, entityIdx: number): void {
    if (!this.api || this.failed) return;
    if (entity.flags & EntityFlags.NoCollision) return;
    if (this.entityBodies.has(entityIdx)) return;
    if (entity.type === EntityType.Player) return;
    if (!Number.isFinite(entity.position.x) || !Number.isFinite(entity.position.y) || !Number.isFinite(entity.position.z)) return;

    try {
      const isShip = entity.type === EntityType.Ship || entity.type === EntityType.SmallCraft || entity.type === EntityType.PirateShip;
      const isStatic = !isShip && (entity.flags & EntityFlags.Static) !== 0;

      const bodyDesc = {
        type: isShip ? "dynamic" as const : isStatic ? "static" as const : "kinematic" as const,
        position: [entity.position.x, entity.position.y, entity.position.z] as [number, number, number],
        rotation: [entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w] as [number, number, number, number],
        gravityScale: isShip ? 0 : undefined,
        linearDamping: isShip ? 0 : undefined,
        angularDamping: isShip ? 0 : undefined,
        lockedAxes: isShip ? { rotation: [true, true, true] as [boolean, boolean, boolean] } : undefined,
      };

      const body = this.api.createBody({ index: entityIdx, generation: 0 }, bodyDesc);

      const colliderIds: number[] = [];
      let chunkColliders = new Map<string, number>();
      let chunkSize: number | undefined;
      let chunkCountX: number | undefined;
      let chunkCountZ: number | undefined;
      let needsTerrainCollider = false;

      if (isShip) {
        const descs = this.buildBoatColliderDescs(entity.id);
        for (const d of descs) {
          const id = this.api.addCollider(body, d);
          if (id >= 0) colliderIds.push(id);
        }
      } else if (entity.type === EntityType.Island) {
        const r = entity.scale;
        if (!Number.isFinite(r) || r <= 0) { this.api.destroyBody(body); return; }

        const field: VoxelField | null = this.terrainSystem
          ? this.terrainSystem.getVoxelField(entity.id)
          : null;
        if (!field) {
          needsTerrainCollider = true;
        } else {
          this.islandFields.set(entityIdx, field);
          const CHUNK_SIZE = 32;
          chunkSize = CHUNK_SIZE;
          chunkCountX = Math.ceil(field.dimX / CHUNK_SIZE);
          chunkCountZ = Math.ceil(field.dimZ / CHUNK_SIZE);
          // Build chunks immediately (initial creation); incremental queue is for lazy fields
          for (let cx = 0; cx < chunkCountX; cx++) {
            for (let cz = 0; cz < chunkCountZ; cz++) {
              const desc = this.buildIslandChunkColliderDesc(entity, field, cx, cz, CHUNK_SIZE);
              if (!desc) continue;
              const id = this.api.addCollider(body, desc);
              if (id >= 0) chunkColliders.set(`${cx},${cz}`, id);
            }
          }
        }
      } else if (entity.type === EntityType.Port) {
        const portSize = entity.data[PORT_DATA.SIZE] ?? 0;
        const cd = getPortColliderDims(portSize, entity.scale);
        if (cd) {
          colliderIds.push(this.api.addCollider(body, {
            shape: { type: "box", halfExtents: [cd.dock.halfW, cd.dock.halfH, cd.dock.halfD] },
            translation: [0, cd.dock.centerY, 0],
            restitution: SHIP_COLLISION_RESTITUTION,
            friction: SHIP_COLLISION_FRICTION,
          }));
          colliderIds.push(this.api.addCollider(body, {
            shape: { type: "box", halfExtents: [cd.pier.halfW, cd.pier.halfH, cd.pier.halfL] },
            translation: [0, cd.pier.centerY, cd.pier.centerZ],
            restitution: SHIP_COLLISION_RESTITUTION,
            friction: SHIP_COLLISION_FRICTION,
          }));
          const structBoxes = getPortCollisionBoxes(portSize, entity.scale);
          for (let bi = 0; bi < structBoxes.length; bi++) {
            const box = structBoxes[bi];
            colliderIds.push(this.api.addCollider(body, {
              shape: { type: "box", halfExtents: [box.halfW, box.halfH, box.halfD] },
              translation: [box.cx, box.cy, box.cz],
              restitution: SHIP_COLLISION_RESTITUTION,
              friction: SHIP_COLLISION_FRICTION,
            }));
          }
        }
      } else if (entity.flags & EntityFlags.Static) {
        const halfExtent = entity.scale;
        colliderIds.push(this.api.addCollider(body, {
          shape: { type: "box", halfExtents: [halfExtent, halfExtent, halfExtent] },
        }));
      } else {
        const radius = entity.scale;
        colliderIds.push(this.api.addCollider(body, {
          shape: { type: "sphere", radius },
        }));
      }

      const eb: EntityBody = {
        body, entityIdx, isStatic, isShip,
        entityType: entity.type, entityId: entity.id,
        chunkColliders: chunkColliders.size > 0 ? chunkColliders : undefined,
        chunkSize, chunkCountX, chunkCountZ,
        needsTerrainCollider: needsTerrainCollider || undefined,
        colliderIds: isShip ? colliderIds : undefined,
      };
      this.entityBodies.set(entityIdx, eb);
    } catch (err) {
      console.error(`[PHYSICS] createEntityBody failed for entity ${entityIdx}: ${(err as Error).message}`);
      if (this.isWasmTrap(err)) this.failed = true;
    }
  }

  removeEntityBody(entityIdx: number): void {
    if (!this.api) return;
    this.islandFields.delete(entityIdx);
    const body = this.entityBodies.get(entityIdx);
    if (!body) return;
    if (this.pendingTrimeshChunks.length > 0) {
      this.pendingTrimeshChunks = this.pendingTrimeshChunks.filter(c => c.entityIdx !== entityIdx);
    }
    try { this.api.destroyBody(body.body); } catch {}
    this.entityBodies.delete(entityIdx);
  }

  remapEntityBody(oldIdx: number, newIdx: number): void {
    if (oldIdx === newIdx) return;
    const body = this.entityBodies.get(oldIdx);
    if (!body) return;
    body.entityIdx = newIdx;
    this.entityBodies.set(newIdx, body);
    this.entityBodies.delete(oldIdx);
    const field = this.islandFields.get(oldIdx);
    if (field) {
      this.islandFields.set(newIdx, field);
      this.islandFields.delete(oldIdx);
    }
    for (let i = 0; i < this.pendingTrimeshChunks.length; i++) {
      if (this.pendingTrimeshChunks[i].entityIdx === oldIdx) {
        this.pendingTrimeshChunks[i].entityIdx = newIdx;
      }
    }
  }

  rebuildShipShape(entity: SimEntity, entityIdx: number): void {
    if (!this.initialized || this.failed) return;
    if (entity.type !== EntityType.Ship && entity.type !== EntityType.SmallCraft) return;
    this.pendingShipRebuilds.set(entityIdx, { entity, entityIdx });
  }

  private pendingIslandRebuilds = new Map<number, {
    entity: SimEntity; entityIdx: number; field: VoxelField;
    dirtyMinX: number; dirtyMaxX: number; dirtyMinZ: number; dirtyMaxZ: number;
  }>();

  rebuildIslandCollider(
    entity: SimEntity, entityIdx: number, field: VoxelField,
    dirtyMinX: number, dirtyMaxX: number, dirtyMinZ: number, dirtyMaxZ: number,
  ): void {
    if (!this.initialized || this.failed) return;
    if (entity.type !== EntityType.Island) return;
    this.islandFields.set(entityIdx, field);
    this.pendingIslandRebuilds.set(entityIdx, {
      entity, entityIdx, field, dirtyMinX, dirtyMaxX, dirtyMinZ, dirtyMaxZ,
    });
  }

  private buildIslandChunkMesh(
    entity: SimEntity, field: VoxelField, cx: number, cz: number, CHUNK_SIZE: number,
  ): { vertices: Float32Array; indices: Uint32Array } | null {
    const r = entity.scale;
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const x1 = Math.min(x0 + CHUNK_SIZE, field.dimX);
    const z1 = Math.min(z0 + CHUNK_SIZE, field.dimZ);

    const chunkMesh = generateTerrainTrimeshSubRegion(
      field, entity.chunkX, entity.chunkZ,
      x0, 0, z0, x1, field.dimY, z1, true,
    );
    if (chunkMesh.positions.length < 9 || chunkMesh.indices.length < 3) return null;

    const pos = new Float32Array(chunkMesh.positions.length);
    for (let vi = 0; vi < chunkMesh.positions.length; vi += 3) {
      pos[vi]     = chunkMesh.positions[vi]     * r;
      pos[vi + 1] = chunkMesh.positions[vi + 1] * r;
      pos[vi + 2] = chunkMesh.positions[vi + 2] * r;
      if (!Number.isFinite(pos[vi]) || !Number.isFinite(pos[vi + 1]) || !Number.isFinite(pos[vi + 2])) return null;
    }
    return { vertices: pos, indices: chunkMesh.indices };
  }

  private buildIslandChunkColliderDesc(
    entity: SimEntity, field: VoxelField, cx: number, cz: number, CHUNK_SIZE: number,
  ): import("@downdraft/core").ColliderDesc | null {
    const mesh = this.buildIslandChunkMesh(entity, field, cx, cz, CHUNK_SIZE);
    if (!mesh) return null;
    return {
      shape: { type: "mesh", vertices: mesh.vertices, indices: mesh.indices },
      collisionGroups: ISLAND_BOTH_GROUPS,
    };
  }

  private doRebuildIslandChunks(
    entity: SimEntity, entityIdx: number, field: VoxelField,
    dirtyMinX: number, dirtyMaxX: number, dirtyMinZ: number, dirtyMaxZ: number,
  ): void {
    if (!this.api) return;
    const body = this.entityBodies.get(entityIdx);
    if (!body || !body.chunkColliders || !body.chunkSize) return;

    const CHUNK_SIZE = body.chunkSize;
    const chunkCountX = body.chunkCountX!;
    const chunkCountZ = body.chunkCountZ!;

    const minChunkX = Math.floor(dirtyMinX / CHUNK_SIZE);
    const maxChunkX = Math.floor(dirtyMaxX / CHUNK_SIZE);
    const minChunkZ = Math.floor(dirtyMinZ / CHUNK_SIZE);
    const maxChunkZ = Math.floor(dirtyMaxZ / CHUNK_SIZE);

    for (let cx = Math.max(0, minChunkX); cx <= Math.min(chunkCountX - 1, maxChunkX); cx++) {
      for (let cz = Math.max(0, minChunkZ); cz <= Math.min(chunkCountZ - 1, maxChunkZ); cz++) {
        const chunkKey = `${cx},${cz}`;
        const oldId = body.chunkColliders.get(chunkKey);
        const mesh = this.buildIslandChunkMesh(entity, field, cx, cz, CHUNK_SIZE);
        if (!mesh) {
          // Chunk is empty — remove old collider if any
          if (oldId !== undefined) {
            try { this.api.removeCollider(body.body, oldId); } catch {}
            body.chunkColliders.delete(chunkKey);
          }
          continue;
        }
        // Try in-place shape swap first (avoids broadphase re-insertion)
        if (oldId !== undefined) {
          const swapped = this.api.swapColliderShapeRaw(
            body.body.realmId, oldId, mesh.vertices, mesh.indices,
          );
          if (swapped) continue; // Shape updated in-place, keep same collider id
          // Fallback: remove + create
          try { this.api.removeCollider(body.body, oldId); } catch {}
          body.chunkColliders.delete(chunkKey);
        }
        const newId = this.api.addCollider(body.body, {
          shape: { type: "mesh", vertices: mesh.vertices, indices: mesh.indices },
          collisionGroups: ISLAND_BOTH_GROUPS,
        });
        if (newId >= 0) body.chunkColliders.set(chunkKey, newId);
      }
    }
  }

  private processPendingRebuilds(): void {
    if (!this.api) return;
    if (this.pendingShipRebuilds.size === 0 && this.pendingIslandRebuilds.size === 0) return;

    if (this.pendingShipRebuilds.size > 0) {
      const pending = Array.from(this.pendingShipRebuilds.values());
      this.pendingShipRebuilds.clear();
      for (const { entity, entityIdx } of pending) {
        try { this.doRebuildShipShape(entity, entityIdx); }
        catch (err) {
          console.error(`[PHYSICS] doRebuildShipShape failed for entity ${entity.id}: ${(err as Error).message}`);
          if (this.isWasmTrap(err)) this.failed = true;
        }
      }
    }

    if (this.pendingIslandRebuilds.size > 0) {
      const pending = Array.from(this.pendingIslandRebuilds.values());
      this.pendingIslandRebuilds.clear();
      for (const { entity, entityIdx, field, dirtyMinX, dirtyMaxX, dirtyMinZ, dirtyMaxZ } of pending) {
        try { this.doRebuildIslandChunks(entity, entityIdx, field, dirtyMinX, dirtyMaxX, dirtyMinZ, dirtyMaxZ); }
        catch (err) {
          console.error(`[PHYSICS] doRebuildIslandChunks failed for entity ${entity.id}: ${(err as Error).message}`);
          if (this.isWasmTrap(err)) this.failed = true;
        }
      }
    }
  }

  private doRebuildShipShape(entity: SimEntity, entityIdx: number): void {
    if (!this.api) return;
    const body = this.entityBodies.get(entityIdx);
    if (!body) { this.createEntityBody(entity, entityIdx); return; }

    if (body.colliderIds) {
      for (const id of body.colliderIds) {
        try { this.api.removeCollider(body.body, id); } catch {}
      }
      body.colliderIds.length = 0;
    }

    const descs = this.buildBoatColliderDescs(entity.id);
    if (descs.length === 0) return;

    if (!body.colliderIds) body.colliderIds = [];
    for (const d of descs) {
      const id = this.api.addCollider(body.body, d);
      if (id >= 0) body.colliderIds.push(id);
    }

    this.api.setTranslationRaw(body.body, entity.position.x, entity.position.y, entity.position.z, true);
  }

  private buildBoatColliderDescs(entityId: number): import("@downdraft/core").ColliderDesc[] {
    const bounds = this.boatCellSystem.getShipBounds(entityId);
    if (!bounds) return [];
    const halfX = (bounds.maxX - bounds.minX) / 2;
    const halfZ = (bounds.maxZ - bounds.minZ) / 2;
    const halfY = (bounds.maxY - bounds.minY) / 2;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    if (halfX <= 0 || halfY <= 0 || halfZ <= 0) return [];
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return [];
    return [{
      shape: { type: "box", halfExtents: [halfX, halfY, halfZ] },
      translation: [cx, cy, cz],
      restitution: SHIP_COLLISION_RESTITUTION,
      friction: SHIP_COLLISION_FRICTION,
      collisionGroups: SHIP_COLLISION_GROUPS,
    }];
  }

  // --- Player character controller management ---

  createCharacter(player: SimPlayer, playerIdx: number): void {
    if (!this.api || this.failed) return;
    if (this.playerCharacters.has(playerIdx)) return;
    try {
      const handle = this.api.createCharacterController({
        offset: [0, RapierPhysicsSystem.PLAYER_CONTROLLER_OFFSET, 0],
        radius: RapierPhysicsSystem.PLAYER_CAPSULE_RADIUS,
        halfHeight: RapierPhysicsSystem.PLAYER_CAPSULE_HALF_HEIGHT,
        slide: true,
        autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.5 },
        maxSlope: Math.PI / 3,
        minSlopeSlide: Math.PI / 4,
        snapToGround: 0,
        applyImpulsesToDynamicBodies: false,
        collisionGroups: PLAYER_COLLISION_GROUPS,
        parentless: {
          position: [player.position.x, player.position.y + RapierPhysicsSystem.PLAYER_CAPSULE_Y_OFFSET, player.position.z],
          collisionGroups: PLAYER_COLLISION_GROUPS,
        },
      }, { index: playerIdx, generation: 0 });
      this.playerCharacters.set(playerIdx, { handle, playerIdx });
    } catch (err) {
      console.error(`[PHYSICS] createCharacter failed for player ${playerIdx}: ${(err as Error).message}`);
    }
  }

  removeCharacter(playerIdx: number): void {
    if (!this.api) return;
    const pc = this.playerCharacters.get(playerIdx);
    if (!pc) return;
    try { this.api.destroyCharacterController(pc.handle); } catch {}
    this.playerCharacters.delete(playerIdx);
  }

  remapCharacter(oldIdx: number, newIdx: number): void {
    if (oldIdx === newIdx) return;
    const pc = this.playerCharacters.get(oldIdx);
    if (!pc) return;
    pc.playerIdx = newIdx;
    this.playerCharacters.set(newIdx, pc);
    this.playerCharacters.delete(oldIdx);
  }

  tickPlayers(
    players: SimPlayer[],
    _playerCount: number,
    moveRequests: PlayerMoveRequest[],
  ): void {
    if (!this.api) return;

    for (let i = 0; i < moveRequests.length; i++) {
      const req = moveRequests[i];
      if (req.skipCollision) continue;
      const p = players[req.playerIdx];
      if (!p || !p.active) continue;

      if (!this.playerCharacters.has(req.playerIdx)) {
        this.createCharacter(p, req.playerIdx);
      }
      const pc = this.playerCharacters.get(req.playerIdx);
      if (!pc) continue;

      try {
        this.api.setCharacterColliderPosition(pc.handle, [
          p.position.x,
          p.position.y + RapierPhysicsSystem.PLAYER_CAPSULE_Y_OFFSET,
          p.position.z,
        ]);

        const result = this.api.characterMove(
          pc.handle,
          [req.desiredDeltaX, req.desiredDeltaY, req.desiredDeltaZ],
          this.currentDt,
        );

        p.position.x += result.effectiveMovement[0];
        p.position.y += result.effectiveMovement[1];
        p.position.z += result.effectiveMovement[2];

        if (result.grounded) {
          p.flags |= PLR_FLAG.GROUNDED;
        } else {
          p.flags &= ~PLR_FLAG.GROUNDED;
        }

        if (Math.abs(result.effectiveMovement[1]) < Math.abs(req.desiredDeltaY) * 0.5 && req.desiredDeltaY < 0) {
          p.velocity.y = 0;
        }

        // Debug collision log (player 0 only). The physics layer resolves hit
        // colliders back to their Entity; we map entity.index to the game's
        // EntityBody to recover entityType/entityId for the debug label.
        if (req.playerIdx === 0) {
          for (const c of result.collisions) {
            if (!c.entity) continue;
            const eb = this.entityBodies.get(c.entity.index);
            if (!eb) continue;
            const label = `${EntityTypeNames[eb.entityType] ?? "Unknown"} #${eb.entityId}`;
            this.recordCollision(label);
          }
        }
      } catch (err) {
        // Fallback: apply movement without collision
        p.position.x += req.desiredDeltaX;
        p.position.y += req.desiredDeltaY;
        p.position.z += req.desiredDeltaZ;
      }
    }
  }

  getCollisionLog(): CollisionLogEntry[] {
    return this.collisionLog;
  }

  private recordCollision(label: string): void {
    const now = Date.now();
    const existing = this.collisionLog.find((e) => e.label === label);
    if (existing) {
      existing.count++;
      existing.lastCollisionTime = now;
      this.collisionLog = [existing, ...this.collisionLog.filter((e) => e.label !== label)];
    } else {
      this.collisionLog.unshift({ label, count: 1, lastCollisionTime: now });
    }
    if (this.collisionLog.length > 10) this.collisionLog.length = 10;
  }

  setTimestep(dt: number): void {
    this.currentDt = dt;
  }

  tick(
    dt: number,
    entities: SimEntity[],
    entityCount: number,
    _players: SimPlayer[],
    _playerCount: number,
  ): void {
    if (!this.initialized || !this.api) return;

    if (this.failed) {
      // Recovery requires async re-init; caller must call init() again
      return;
    }

    this.tickCount++;
    this.currentDt = dt;

    try {
      const t0 = performance.now();
      this.processPendingRebuilds();
      const t1 = performance.now();
      this.syncEntities(entities, entityCount);
      const t2 = performance.now();
      this.api.stepNearRealm(dt);
      const t3 = performance.now();
      this.readBackShipPositions(entities, entityCount);
      const t4 = performance.now();

      if (t4 - t0 > 50) {
        console.error(`[PHYSICS] Slow tick ${this.tickCount}: rebuilds=${(t1-t0).toFixed(1)}ms sync=${(t2-t1).toFixed(1)}ms step=${(t3-t2).toFixed(1)}ms readback=${(t4-t3).toFixed(1)}ms bodies=${this.entityBodies.size}`);
      }
    } catch (err) {
      this.panicRecover(err);
    }
  }

  private syncEntities(entities: SimEntity[], entityCount: number): void {
    if (!this.api) return;

    for (let i = 0; i < entityCount; i++) {
      if (this.failed) break;
      const ent = entities[i];
      if (!ent) continue;

      if (!this.entityBodies.has(i) && !(ent.flags & EntityFlags.NoCollision)) {
        this.createEntityBody(ent, i);
      }

      const body = this.entityBodies.get(i);
      if (!body) continue;

      if (body.needsTerrainCollider) {
        const field = this.terrainSystem?.getVoxelField(ent.id);
        if (field) {
          this.queueIslandTrimeshChunks(ent, body, field);
          body.needsTerrainCollider = false;
        }
      }

      const px = ent.position.x, py = ent.position.y, pz = ent.position.z;
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;

      try {
        if (body.isShip) {
          this.api.setTranslationRaw(body.body, px, py, pz, true);
          this.api.setLinearVelocityRaw(body.body, ent.velocity.x, ent.velocity.y, ent.velocity.z, true);
          this.api.setAngularVelocityRaw(body.body, 0, 0, 0, true);
        } else {
          // Skip sleeping non-ship bodies (raw scalar check, no alloc)
          if (this.api.isSleepingRaw(body.body)) continue;
          this.api.setTranslationRaw(body.body, px, py, pz, false);
        }

        const rx = ent.rotation.x, ry = ent.rotation.y, rz = ent.rotation.z, rw = ent.rotation.w;
        if (Number.isFinite(rx) && Number.isFinite(ry) && Number.isFinite(rz) && Number.isFinite(rw)) {
          this.api.setRotationRaw(body.body, rx, ry, rz, rw, false);
        }
      } catch (err) {
        if (this.isWasmTrap(err)) this.failed = true;
      }
    }

    this.processPendingTrimeshChunks();
  }

  private queueIslandTrimeshChunks(
    entity: SimEntity, body: EntityBody, field: VoxelField,
  ): void {
    if (!this.api || this.failed) return;
    const r = entity.scale;
    if (!Number.isFinite(r) || r <= 0) return;

    this.islandFields.set(body.entityIdx, field);

    const CHUNK_SIZE = 32;
    const chunkCountX = Math.ceil(field.dimX / CHUNK_SIZE);
    const chunkCountZ = Math.ceil(field.dimZ / CHUNK_SIZE);

    body.chunkColliders = new Map<string, number>();
    body.chunkSize = CHUNK_SIZE;
    body.chunkCountX = chunkCountX;
    body.chunkCountZ = chunkCountZ;

    for (let cx = 0; cx < chunkCountX; cx++) {
      for (let cz = 0; cz < chunkCountZ; cz++) {
        this.pendingTrimeshChunks.push({
          entityIdx: body.entityIdx, entity, field, body: body.body,
          cx, cz, chunkSize: CHUNK_SIZE,
        });
      }
    }
  }

  private processPendingTrimeshChunks(): void {
    if (!this.api || this.failed || this.pendingTrimeshChunks.length === 0) return;
    const startTime = performance.now();

    while (this.pendingTrimeshChunks.length > 0) {
      if (performance.now() - startTime > RapierPhysicsSystem.TRIMESH_TIME_BUDGET_MS) break;

      const chunk = this.pendingTrimeshChunks.shift()!;
      const body = this.entityBodies.get(chunk.entityIdx);
      if (!body || !body.chunkColliders) continue;

      try {
        const desc = this.buildIslandChunkColliderDesc(chunk.entity, chunk.field, chunk.cx, chunk.cz, chunk.chunkSize);
        if (!desc) continue;
        const id = this.api.addCollider(chunk.body, desc);
        if (id >= 0) body.chunkColliders.set(`${chunk.cx},${chunk.cz}`, id);
      } catch (colErr) {
        console.error(`[PHYSICS] Deferred createCollider failed for entity ${chunk.entityIdx} chunk ${chunk.cx},${chunk.cz}: ${(colErr as Error).message}`);
      }
    }
  }

  private readBackShipPositions(entities: SimEntity[], entityCount: number): void {
    if (!this.api) return;

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      const body = this.entityBodies.get(i);
      if (!body || !body.isShip) continue;

      try {
        // Raw scalar readback — no tuple allocation per ship per tick
        const pos: [number, number, number] = [0, 0, 0];
        const vel: [number, number, number] = [0, 0, 0];
        this.api.getTranslationRaw(body.body, pos);
        this.api.getLinearVelocityRaw(body.body, vel);

        // Only write back XZ — BuoyancySystem is the authority for ship Y
        if (Number.isFinite(pos[0]) && Number.isFinite(pos[2])) {
          ent.position.x = pos[0];
          ent.position.z = pos[2];
        }
        if (Number.isFinite(vel[0]) && Number.isFinite(vel[2])) {
          ent.velocity.x = vel[0];
          ent.velocity.z = vel[2];
        }
      } catch (err) {
        if (this.isWasmTrap(err)) this.failed = true;
      }
    }
  }

  shutdown(): void {
    if (this.api) {
      try { this.api.destroy(); } catch {}
      this.api = null;
    }
    if (this.backend) {
      try { this.backend.destroy(); } catch {}
      this.backend = null;
    }
    this.entityBodies.clear();
    this.pendingShipRebuilds.clear();
    this.pendingTrimeshChunks.length = 0;
    this.playerCharacters.clear();
    this.collisionLog = [];
    this.initialized = false;
  }
}
