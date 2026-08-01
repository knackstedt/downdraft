// ============================================================================
// RapierPhysicsSystem — WASM Rapier Physics integration for collision & dynamics
// Runs inside the sim worker thread. Uses Rapier's handle-based API (no manual
// memory management). Self-recovers if the physics engine panics.
// ============================================================================

import RAPIER from "@dimforge/rapier3d-compat";
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
import { generateTerrainTrimeshSubRegion } from "../../shared/TerrainGenerator";
import type { VoxelField } from "../../shared/TerrainTypes";
import { EntityFlags, EntityType, EntityTypeNames } from "../../shared/types";
import { BoatCellSystem } from "../boat/BoatCellSystem";
import { BoatDesignSystem } from "../boat/BoatDesignSystem";
import { SimEntity, SimPlayer } from "../Simulation";
import type { TerrainSystem } from "../terrain/TerrainSystem";

// --- Collision groups ---
// InteractionGroups = (filter << 16) | memberships
// Two colliders interact iff (a.memberships & b.filter) && (b.memberships & a.filter)
//
// Island has two colliders:
//   - ISLAND_PLAYER: heightfield (solid from below) — players only, can't fall through terrain
//   - ISLAND_SHIP: culled trimesh (skips underwater triangles) — ships only, prevents underwater shelf pushes
const GROUP_PLAYER = 0x0001;
const GROUP_SHIP = 0x0002;
const GROUP_ISLAND_PLAYER = 0x0004;
const GROUP_ISLAND_SHIP = 0x0008;

// Player: collides with everything except other players
// (includes island trimesh as fallback when heightfield fails)
const PLAYER_COLLISION_GROUPS = ((0xFFFF & ~GROUP_PLAYER) << 16) | GROUP_PLAYER;
// Ship: collides with everything except the player-only island heightfield
const SHIP_COLLISION_GROUPS = ((0xFFFF & ~GROUP_ISLAND_PLAYER) << 16) | GROUP_SHIP;
// Island heightfield: only players can hit it
const ISLAND_PLAYER_GROUPS = (GROUP_PLAYER << 16) | GROUP_ISLAND_PLAYER;
// Island culled trimesh: only ships can hit it (used when heightfield succeeds)
const ISLAND_SHIP_GROUPS = (GROUP_SHIP << 16) | GROUP_ISLAND_SHIP;
// Island trimesh fallback: both players and ships can hit it (used when heightfield fails)
const ISLAND_BOTH_GROUPS = ((GROUP_PLAYER | GROUP_SHIP) << 16) | GROUP_ISLAND_SHIP;

interface EntityBody {
  handle: number; // RigidBody handle
  entityIdx: number;
  isStatic: boolean;
  isShip: boolean; // dynamic ship body — read back position after step
  entityType: number;
  entityId: number;
  // For islands: chunk grid of trimesh colliders for efficient partial updates
  chunkColliders?: Map<string, number>; // chunkKey "cx,cz" -> collider handle
  chunkSize?: number; // voxels per chunk (XZ grid)
  chunkCountX?: number; // number of chunks in X
  chunkCountZ?: number; // number of chunks in Z
  // Islands whose physics voxel field wasn't ready at body creation time.
  // Trimesh colliders are built later once the field is generated.
  needsTerrainCollider?: boolean;
}

export interface CollisionLogEntry {
  label: string;
  count: number;
  lastCollisionTime: number; // Date.now() ms
}

interface PlayerCharacter {
  controller: RAPIER.KinematicCharacterController;
  collider: RAPIER.Collider; // parentless capsule collider
  playerIdx: number;
}

// Desired movement for a player this tick — computed by PlayerManager before Rapier runs.
export interface PlayerMoveRequest {
  playerIdx: number;
  desiredDeltaX: number;
  desiredDeltaY: number;
  desiredDeltaZ: number;
  skipCollision: boolean; // true for noclip / freecam / climbing
}

export class RapierPhysicsSystem {
  private world: RAPIER.World | null = null;
  private eventQueue: RAPIER.EventQueue | null = null;

  private entityBodies = new Map<number, EntityBody>();
  private bodyHandleToEntityBody = new Map<number, EntityBody>();
  private pendingShipRebuilds = new Map<number, { entity: SimEntity; entityIdx: number }>();
  private playerCharacters = new Map<number, PlayerCharacter>();
  private collisionLog: CollisionLogEntry[] = [];

  // Voxel fields for ALL islands — used for manual terrain Y collision in tickPlayers.
  // Updated with deformed fields when terrain changes.
  private islandFields = new Map<number, VoxelField>();

  private boatCellSystem: BoatCellSystem;
  private boatDesignSystem: BoatDesignSystem | null = null;
  private terrainSystem: TerrainSystem | null = null;
  private initialized = false;
  private failed = false; // set when physics panics — triggers reinit on next tick
  private tickCount = 0;

  // Player capsule dimensions derived from PLAYER_HEIGHT and PLAYER_RADIUS constants.
  // Capsule half-height is for the cylindrical section only; total height = 2*(halfHeight + radius)
  // = 2*((H-2R)/2 + R) = H. Center is at player.y + PLAYER_HEIGHT/2.
  private static readonly PLAYER_CAPSULE_HALF_HEIGHT = (PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2;
  private static readonly PLAYER_CAPSULE_RADIUS = PLAYER_RADIUS;
  private static readonly PLAYER_CONTROLLER_OFFSET = 0.01; // skin gap
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
    await RAPIER.init();
    this.recreateWorld();
    this.initialized = true;
    this.failed = false;
  }

  private recreateWorld(): void {
    // Clean up old world if it exists
    if (this.world) {
      try {
        this.world.free();
      } catch {
        // World may be corrupted (WASM trap) — discard it anyway
      }
      this.world = null;
    }
    this.entityBodies.clear();
    this.bodyHandleToEntityBody.clear();
    this.pendingShipRebuilds.clear();
    this.pendingIslandRebuilds.clear();
    this.playerCharacters.clear();
    this.collisionLog = [];

    const gravity = { x: 0, y: -9.8, z: 0 };
    this.world = new RAPIER.World(gravity);
    this.world.integrationParameters.dt = SIM_TICK_DT;
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  isInitialized(): boolean {
    return this.initialized && !this.failed;
  }

  getStats(): { initialized: boolean; failed: boolean; bodyCount: number; tickCount: number } {
    return {
      initialized: this.initialized,
      failed: this.failed,
      bodyCount: this.entityBodies.size,
      tickCount: this.tickCount,
    };
  }

  // --- Self-recovery ---

  private isWasmTrap(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("unreachable") || msg.includes("RuntimeError") || msg.includes("abort");
  }

  private panicRecover(err: unknown): void {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error(`[RAPIER] Physics panic at tick ${this.tickCount}: ${msg}`);
    this.failed = true;
    // Attempt reinit on next tick — caller should check isInitialized()
    try {
      this.recreateWorld();
      this.failed = false;
      console.error(`[RAPIER] Physics world recreated successfully after panic`);
    } catch (recoveryErr) {
      console.error(`[RAPIER] Failed to recover physics world: ${recoveryErr}`);
      // Stay failed — sim will run without physics until next manual init
    }
  }

  // --- Entity body management ---

  createEntityBody(entity: SimEntity, entityIdx: number): void {
    if (!this.world || this.failed) return;
    if (entity.flags & EntityFlags.NoCollision) return;
    if (this.entityBodies.has(entityIdx)) return;
    if (entity.type === EntityType.Player) return;
    if (!Number.isFinite(entity.position.x) || !Number.isFinite(entity.position.y) || !Number.isFinite(entity.position.z)) return;

    try {
      const isShip = entity.type === EntityType.Ship || entity.type === EntityType.SmallCraft || entity.type === EntityType.PirateShip;
      // Ships are dynamic (so Rapier resolves their collisions) but with gravity scale 0
      // (BuoyancySystem handles gravity) and locked rotations (BoatSystem handles heading/pitch/roll).
      const isStatic = !isShip && (entity.flags & EntityFlags.Static) !== 0;

      let colliderDescs: RAPIER.ColliderDesc[] = [];

      if (isShip) {
        colliderDescs = this.buildAllBoatColliders(entity.id);
      } else if (entity.type === EntityType.Island) {
        // Island: chunked trimesh colliders for both player and ship collision.
        // Splitting into chunks allows updating only the chunks overlapping a deformation,
        // avoiding the 150-250ms cost of regenerating the full trimesh.
        const r = entity.scale;
        if (!Number.isFinite(r) || r <= 0) return;

        // Use the coarse field from TerrainSystem (shared, no duplicate generation)
        // If the field isn't ready yet (lazy generation), create the body without
        // colliders — they'll be built in syncEntities once the field arrives.
        const field: VoxelField | null = this.terrainSystem
          ? this.terrainSystem.getVoxelField(entity.id)
          : null;
        if (!field) {
          // No colliders yet — body will be flagged needsTerrainCollider
        } else {
          this.islandFields.set(entityIdx, field);

          // Chunk the XZ grid. Each chunk is CHUNK_SIZE voxels wide.
          // Y is always full (islands are short vertically).
          const CHUNK_SIZE = 32;
          const chunkCountX = Math.ceil(field.dimX / CHUNK_SIZE);
          const chunkCountZ = Math.ceil(field.dimZ / CHUNK_SIZE);

        for (let cx = 0; cx < chunkCountX; cx++) {
          for (let cz = 0; cz < chunkCountZ; cz++) {
            const x0 = cx * CHUNK_SIZE;
            const z0 = cz * CHUNK_SIZE;
            const x1 = Math.min(x0 + CHUNK_SIZE, field.dimX);
            const z1 = Math.min(z0 + CHUNK_SIZE, field.dimZ);

            const chunkMesh = generateTerrainTrimeshSubRegion(
              field, entity.chunkX, entity.chunkZ,
              x0, 0, z0, x1, field.dimY, z1, false,
            );
            if (chunkMesh.positions.length < 9 || chunkMesh.indices.length < 3) continue;

            const pos = new Float32Array(chunkMesh.positions.length);
            let valid = true;
            for (let vi = 0; vi < chunkMesh.positions.length; vi += 3) {
              pos[vi]     = chunkMesh.positions[vi]     * r;
              pos[vi + 1] = chunkMesh.positions[vi + 1] * r;
              pos[vi + 2] = chunkMesh.positions[vi + 2] * r;
              if (!Number.isFinite(pos[vi]) || !Number.isFinite(pos[vi + 1]) || !Number.isFinite(pos[vi + 2])) {
                valid = false; break;
              }
            }
            if (!valid) continue;

            const cd = RAPIER.ColliderDesc.trimesh(pos, chunkMesh.indices);
            cd.setCollisionGroups(ISLAND_BOTH_GROUPS);
            colliderDescs.push(cd);
            // Track which chunk this collider desc belongs to (stored after creation)
            (cd as any)._chunkKey = `${cx},${cz}`;
          }
        }
        }
      } else if (entity.type === EntityType.Port) {
        // Port: cuboid colliders for dock, pier, and all structure collision boxes
        // (buildings, cranes, lighthouse, breakwater). This is the complete set of
        // port collision surfaces — Rapier handles ship-vs-port natively.
        const portSize = entity.data[PORT_DATA.SIZE] ?? 0;
        const cd = getPortColliderDims(portSize, entity.scale);
        if (cd) {
          const dockCol = RAPIER.ColliderDesc.cuboid(cd.dock.halfW, cd.dock.halfH, cd.dock.halfD);
          dockCol.setTranslation(0, cd.dock.centerY, 0);
          dockCol.setRestitution(SHIP_COLLISION_RESTITUTION);
          dockCol.setFriction(SHIP_COLLISION_FRICTION);
          const pierCol = RAPIER.ColliderDesc.cuboid(cd.pier.halfW, cd.pier.halfH, cd.pier.halfL);
          pierCol.setTranslation(0, cd.pier.centerY, cd.pier.centerZ);
          pierCol.setRestitution(SHIP_COLLISION_RESTITUTION);
          pierCol.setFriction(SHIP_COLLISION_FRICTION);
          colliderDescs = [dockCol, pierCol];

          // Add structure collision boxes (buildings, cranes, lighthouse, breakwater)
          const structBoxes = getPortCollisionBoxes(portSize, entity.scale);
          for (let bi = 0; bi < structBoxes.length; bi++) {
            const box = structBoxes[bi];
            const col = RAPIER.ColliderDesc.cuboid(box.halfW, box.halfH, box.halfD);
            col.setTranslation(box.cx, box.cy, box.cz);
            col.setRestitution(SHIP_COLLISION_RESTITUTION);
            col.setFriction(SHIP_COLLISION_FRICTION);
            colliderDescs.push(col);
          }
        }
      } else if (entity.flags & EntityFlags.Static) {
        const halfExtent = entity.scale;
        colliderDescs = [RAPIER.ColliderDesc.cuboid(halfExtent, halfExtent, halfExtent)];
      } else {
        const radius = entity.scale;
        colliderDescs = [RAPIER.ColliderDesc.ball(radius)];
      }

      // Islands with no field yet: create body with no colliders, flag for later
      const needsTerrainCollider = entity.type === EntityType.Island && colliderDescs.length === 0;
      if (colliderDescs.length === 0 && !needsTerrainCollider) return;

      const bodyDesc = isShip
        ? RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(entity.position.x, entity.position.y, entity.position.z)
            .setGravityScale(0)      // BuoyancySystem handles gravity
            .setLinearDamping(0)     // BoatSystem handles drag
            .setAngularDamping(0)    // BoatSystem handles angular drag
            .lockRotations()         // BoatSystem handles heading/pitch/roll
        : isStatic
          ? RAPIER.RigidBodyDesc.fixed().setTranslation(entity.position.x, entity.position.y, entity.position.z)
          : RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(entity.position.x, entity.position.y, entity.position.z);

      const rot = entity.rotation;
      if (Number.isFinite(rot.x) && Number.isFinite(rot.y) && Number.isFinite(rot.z) && Number.isFinite(rot.w)) {
        bodyDesc.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
      }

      // Set restitution/friction/collision-groups on collider descriptions BEFORE
      // creating colliders — modifying ColliderDesc after createCollider has no effect.
      if (isShip) {
        for (let ci = 0; ci < colliderDescs.length; ci++) {
          colliderDescs[ci].setRestitution(SHIP_COLLISION_RESTITUTION);
          colliderDescs[ci].setFriction(SHIP_COLLISION_FRICTION);
          colliderDescs[ci].setCollisionGroups(SHIP_COLLISION_GROUPS);
        }
      }

      const body = this.world.createRigidBody(bodyDesc);
      let createdCount = 0;
      const chunkColliders = new Map<string, number>();
      let chunkSize: number | undefined;
      let chunkCountX: number | undefined;
      let chunkCountZ: number | undefined;

      if (entity.type === EntityType.Island) {
        const field = this.islandFields.get(entityIdx);
        if (field) {
          chunkSize = 32;
          chunkCountX = Math.ceil(field.dimX / chunkSize);
          chunkCountZ = Math.ceil(field.dimZ / chunkSize);
        }
      }

      for (let ci = 0; ci < colliderDescs.length; ci++) {
        try {
          const cd = colliderDescs[ci];
          const col = this.world.createCollider(cd, body);
          if (entity.type === EntityType.Island) {
            const chunkKey = (cd as any)._chunkKey as string | undefined;
            if (chunkKey) {
              chunkColliders.set(chunkKey, col.handle);
            }
          }
          createdCount++;
        } catch (colErr) {
          console.error(`[RAPIER] createCollider ${ci}/${colliderDescs.length} failed for entity ${entityIdx} (type=${entity.type}): ${(colErr as Error).message}`);
        }
      }
      if (createdCount === 0 && !needsTerrainCollider) {
        try { this.world.removeRigidBody(body); } catch {}
        return;
      }

      const eb: EntityBody = {
        handle: body.handle, entityIdx, isStatic, isShip,
        entityType: entity.type, entityId: entity.id,
        chunkColliders: chunkColliders.size > 0 ? chunkColliders : undefined,
        chunkSize, chunkCountX, chunkCountZ,
        needsTerrainCollider: needsTerrainCollider || undefined,
      };
      this.entityBodies.set(entityIdx, eb);
      this.bodyHandleToEntityBody.set(body.handle, eb);
    } catch (err) {
      console.error(`[RAPIER] createEntityBody failed for entity ${entityIdx}: ${(err as Error).message}`);
      if (this.isWasmTrap(err)) {
        this.failed = true;
      }
    }
  }

  removeEntityBody(entityIdx: number): void {
    if (!this.world) return;
    this.islandFields.delete(entityIdx);
    const body = this.entityBodies.get(entityIdx);
    if (!body) return;
    try {
      const rb = this.world.getRigidBody(body.handle);
      if (rb) this.world.removeRigidBody(rb);
    } catch {}
    const eb = this.entityBodies.get(entityIdx);
    if (eb) this.bodyHandleToEntityBody.delete(eb.handle);
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
  }

  rebuildShipShape(entity: SimEntity, entityIdx: number): void {
    if (!this.initialized || this.failed) return;
    if (entity.type !== EntityType.Ship && entity.type !== EntityType.SmallCraft) return;
    // Defer to next tick
    this.pendingShipRebuilds.set(entityIdx, { entity, entityIdx });
  }

  // Deferred island chunk rebuilds — processed in processPendingRebuilds
  private pendingIslandRebuilds = new Map<number, {
    entity: SimEntity; entityIdx: number; field: VoxelField;
    dirtyMinX: number; dirtyMaxX: number; dirtyMinZ: number; dirtyMaxZ: number;
  }>();

  // Update an island's chunked trimesh colliders with the deformed terrain.
  // Only chunks overlapping the dirty voxel region are regenerated.
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

  private doRebuildIslandChunks(
    entity: SimEntity, entityIdx: number, field: VoxelField,
    dirtyMinX: number, dirtyMaxX: number, dirtyMinZ: number, dirtyMaxZ: number,
  ): void {
    if (!this.world || this.failed) return;
    const r = entity.scale;
    if (!Number.isFinite(r) || r <= 0) return;

    const body = this.entityBodies.get(entityIdx);
    if (!body || !body.chunkColliders || !body.chunkSize) return;

    const rb = this.world.getRigidBody(body.handle);
    if (!rb) return;

    const CHUNK_SIZE = body.chunkSize;
    const chunkCountX = body.chunkCountX!;
    const chunkCountZ = body.chunkCountZ!;

    // Determine which chunks overlap the dirty region
    const minChunkX = Math.floor(dirtyMinX / CHUNK_SIZE);
    const maxChunkX = Math.floor(dirtyMaxX / CHUNK_SIZE);
    const minChunkZ = Math.floor(dirtyMinZ / CHUNK_SIZE);
    const maxChunkZ = Math.floor(dirtyMaxZ / CHUNK_SIZE);

    for (let cx = Math.max(0, minChunkX); cx <= Math.min(chunkCountX - 1, maxChunkX); cx++) {
      for (let cz = Math.max(0, minChunkZ); cz <= Math.min(chunkCountZ - 1, maxChunkZ); cz++) {
        const chunkKey = `${cx},${cz}`;
        const x0 = cx * CHUNK_SIZE;
        const z0 = cz * CHUNK_SIZE;
        const x1 = Math.min(x0 + CHUNK_SIZE, field.dimX);
        const z1 = Math.min(z0 + CHUNK_SIZE, field.dimZ);

        // Remove old chunk collider
        const oldHandle = body.chunkColliders.get(chunkKey);
        if (oldHandle !== undefined) {
          try {
            const oldCol = this.world.getCollider(oldHandle);
            if (oldCol) this.world.removeCollider(oldCol, false);
          } catch {}
          body.chunkColliders.delete(chunkKey);
        }

        // Generate new chunk trimesh
        const chunkMesh = generateTerrainTrimeshSubRegion(
          field, entity.chunkX, entity.chunkZ,
          x0, 0, z0, x1, field.dimY, z1, false,
        );
        if (chunkMesh.positions.length < 9 || chunkMesh.indices.length < 3) continue;

        const pos = new Float32Array(chunkMesh.positions.length);
        let valid = true;
        for (let vi = 0; vi < chunkMesh.positions.length; vi += 3) {
          pos[vi]     = chunkMesh.positions[vi]     * r;
          pos[vi + 1] = chunkMesh.positions[vi + 1] * r;
          pos[vi + 2] = chunkMesh.positions[vi + 2] * r;
          if (!Number.isFinite(pos[vi]) || !Number.isFinite(pos[vi + 1]) || !Number.isFinite(pos[vi + 2])) {
            valid = false; break;
          }
        }
        if (!valid) continue;

        const cd = RAPIER.ColliderDesc.trimesh(pos, chunkMesh.indices);
        cd.setCollisionGroups(ISLAND_BOTH_GROUPS);
        const newCol = this.world.createCollider(cd, rb);
        body.chunkColliders.set(chunkKey, newCol.handle);
      }
    }
  }

  private processPendingRebuilds(): void {
    if (!this.world) return;
    if (this.pendingShipRebuilds.size === 0 && this.pendingIslandRebuilds.size === 0) return;

    // Process ship rebuilds
    if (this.pendingShipRebuilds.size > 0) {
      const pending = Array.from(this.pendingShipRebuilds.values());
      this.pendingShipRebuilds.clear();
      for (let pi = 0; pi < pending.length; pi++) {
        const { entity, entityIdx } = pending[pi];
        try {
          this.doRebuildShipShape(entity, entityIdx);
        } catch (err) {
          console.error(`[RAPIER] doRebuildShipShape failed for entity ${entity.id}: ${(err as Error).message}`);
          if (this.isWasmTrap(err)) this.failed = true;
        }
      }
    }

    // Process island chunk rebuilds (only affected chunks are regenerated)
    if (this.pendingIslandRebuilds.size > 0) {
      const pending = Array.from(this.pendingIslandRebuilds.values());
      this.pendingIslandRebuilds.clear();
      for (let pi = 0; pi < pending.length; pi++) {
        const { entity, entityIdx, field, dirtyMinX, dirtyMaxX, dirtyMinZ, dirtyMaxZ } = pending[pi];
        try {
          this.doRebuildIslandChunks(entity, entityIdx, field, dirtyMinX, dirtyMaxX, dirtyMinZ, dirtyMaxZ);
        } catch (err) {
          console.error(`[RAPIER] doRebuildIslandChunks failed for entity ${entity.id}: ${(err as Error).message}`);
          if (this.isWasmTrap(err)) this.failed = true;
        }
      }
    }
  }

  private doRebuildShipShape(entity: SimEntity, entityIdx: number): void {
    if (!this.world) return;
    const body = this.entityBodies.get(entityIdx);
    if (!body) {
      this.createEntityBody(entity, entityIdx);
      return;
    }

    // Remove old body and create a new one with updated collider
    try {
      const rb = this.world.getRigidBody(body.handle);
      if (rb) this.world.removeRigidBody(rb);
    } catch {}
    this.entityBodies.delete(entityIdx);

    // Recreate with new shape
    const colliderDescs = this.buildAllBoatColliders(entity.id);
    if (colliderDescs.length === 0) return;

    // Ships are dynamic with gravity scale 0 — Rapier resolves collisions,
    // BuoyancySystem handles gravity, BoatSystem handles rotation.
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(entity.position.x, entity.position.y, entity.position.z)
      .setGravityScale(0)
      .setLinearDamping(0)
      .setAngularDamping(0)
      .lockRotations();

    const rot = entity.rotation;
    if (Number.isFinite(rot.x) && Number.isFinite(rot.y) && Number.isFinite(rot.z) && Number.isFinite(rot.w)) {
      bodyDesc.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    }

    // Set restitution/friction/collision-groups on all colliders
    for (let ci = 0; ci < colliderDescs.length; ci++) {
      colliderDescs[ci].setRestitution(SHIP_COLLISION_RESTITUTION);
      colliderDescs[ci].setFriction(SHIP_COLLISION_FRICTION);
      colliderDescs[ci].setCollisionGroups(SHIP_COLLISION_GROUPS);
    }

    const newBody = this.world.createRigidBody(bodyDesc);
    for (let ci = 0; ci < colliderDescs.length; ci++) {
      this.world.createCollider(colliderDescs[ci], newBody);
    }
    const newEb: EntityBody = { handle: newBody.handle, entityIdx, isStatic: false, isShip: true, entityType: entity.type, entityId: entity.id };
    this.entityBodies.set(entityIdx, newEb);
    this.bodyHandleToEntityBody.set(newBody.handle, newEb);
  }

  // Build a simplified single-box collider for the ship in Rapier.
  // The detailed per-cell collision (walls, floors, walkable surfaces) is handled
  // by BoatCellSystem.resolveCellCollision when the player is onboard — that runs
  // in ship-local space and is completely separate from Rapier.
  //
  // This simplified box handles:
  //   - Ship-vs-ship collision (two boxes intersect → Rapier pushes them apart)
  //   - Ship-vs-port collision (box vs port cuboids)
  //   - Player-vs-ship collision when NOT onboard (character controller vs box)
  //
  // Using a single box instead of per-cell cuboids is cheaper, more stable when
  // the ship rotates/rolls, and prevents the character controller from tunnelling
  // through gaps between per-cell colliders during fast ship motion.
  private buildAllBoatColliders(entityId: number): RAPIER.ColliderDesc[] {
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

    return [RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ).setTranslation(cx, cy, cz)];
  }

  // --- Player character controller management ---

  createCharacter(player: SimPlayer, playerIdx: number): void {
    if (!this.world || this.failed) return;
    if (this.playerCharacters.has(playerIdx)) return;

    try {
      const controller = this.world.createCharacterController(RapierPhysicsSystem.PLAYER_CONTROLLER_OFFSET);
      controller.setUp({ x: 0, y: 1, z: 0 });
      controller.setApplyImpulsesToDynamicBodies(false); // player doesn't push ships
      controller.enableAutostep(0.5, 0.2, true); // step up to 0.5m, min width 0.2m, include dynamic bodies
      controller.setMaxSlopeClimbAngle(Math.PI / 3); // 60° max climb
      controller.setMinSlopeSlideAngle(Math.PI / 4); // 45° before sliding
      controller.setSlideEnabled(true);

      // Create a parentless capsule collider at the player's position.
      // The character controller moves this collider directly — no rigid body needed.
      const desc = RAPIER.ColliderDesc.capsule(
        RapierPhysicsSystem.PLAYER_CAPSULE_HALF_HEIGHT,
        RapierPhysicsSystem.PLAYER_CAPSULE_RADIUS,
      ).setTranslation(player.position.x, player.position.y + RapierPhysicsSystem.PLAYER_CAPSULE_Y_OFFSET, player.position.z);
      desc.setCollisionGroups(PLAYER_COLLISION_GROUPS);

      const collider = this.world.createCollider(desc);
      this.playerCharacters.set(playerIdx, { controller, collider, playerIdx });
    } catch (err) {
      console.error(`[RAPIER] createCharacter failed for player ${playerIdx}: ${(err as Error).message}`);
    }
  }

  removeCharacter(playerIdx: number): void {
    if (!this.world) return;
    const pc = this.playerCharacters.get(playerIdx);
    if (!pc) return;
    try {
      this.world.removeCollider(pc.collider, true);
      this.world.removeCharacterController(pc.controller);
    } catch {}
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

  // Resolve player movement against all colliders in the world.
  // Takes an array of movement requests (computed by PlayerManager) and returns
  // corrected positions + grounded state. The caller writes results back to SimPlayer.
  tickPlayers(
    players: SimPlayer[],
    playerCount: number,
    moveRequests: PlayerMoveRequest[],
  ): void {
    if (!this.world) return;

    for (let i = 0; i < moveRequests.length; i++) {
      const req = moveRequests[i];
      if (req.skipCollision) continue;

      const p = players[req.playerIdx];
      if (!p || !p.active) continue;

      // Ensure character controller exists
      if (!this.playerCharacters.has(req.playerIdx)) {
        this.createCharacter(p, req.playerIdx);
      }

      const pc = this.playerCharacters.get(req.playerIdx);
      if (!pc) continue;

      try {
        // Sync collider position to player's current position (offset up so capsule covers body)
        pc.collider.setTranslation({ x: p.position.x, y: p.position.y + RapierPhysicsSystem.PLAYER_CAPSULE_Y_OFFSET, z: p.position.z });

        // Compute collision-resolved movement
        pc.controller.computeColliderMovement(
          pc.collider,
          { x: req.desiredDeltaX, y: req.desiredDeltaY, z: req.desiredDeltaZ },
        );

        const corrected = pc.controller.computedMovement();
        const grounded = pc.controller.computedGrounded();

        // Apply corrected movement
        p.position.x += corrected.x;
        p.position.y += corrected.y;
        p.position.z += corrected.z;

        // Update grounded flag
        if (grounded) {
          p.flags |= PLR_FLAG.GROUNDED;
        } else {
          p.flags &= ~PLR_FLAG.GROUNDED;
        }

        // If collision stopped vertical movement, zero vertical velocity
        if (Math.abs(corrected.y) < Math.abs(req.desiredDeltaY) * 0.5 && req.desiredDeltaY < 0) {
          p.velocity.y = 0;
        }

        // Collect collision events for debug panel (player 0 only)
        if (req.playerIdx === 0) {
          try {
            const numCollisions = pc.controller.numComputedCollisions();
            for (let ei = 0; ei < numCollisions; ei++) {
              const collision = pc.controller.computedCollision(ei);
              if (!collision) continue;
              const col = collision.collider;
              if (!col) continue;
              const parentRb = col.parent();
              if (!parentRb) continue;
              const eb = this.bodyHandleToEntityBody.get(parentRb.handle);
              if (!eb) continue;
              const label = `${EntityTypeNames[eb.entityType] ?? "Unknown"} #${eb.entityId}`;
              this.recordCollision(label);
            }
          } catch {}
        }

      } catch (err) {
 // If character controller fails, apply movement without collision (fallback)
        p.position.x += req.desiredDeltaX;
        p.position.y += req.desiredDeltaY;
        p.position.z += req.desiredDeltaZ;
      }
    }
  }

  // --- Collision log (debug) ---

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
    if (this.collisionLog.length > 10) {
      this.collisionLog.length = 10;
    }
  }

  setTimestep(dt: number): void {
    if (this.world && this.world.integrationParameters.dt !== dt) {
      this.world.integrationParameters.dt = dt;
    }
  }

  // --- Main tick ---

  tick(
    dt: number,
    entities: SimEntity[],
    entityCount: number,
    _players: SimPlayer[],
    _playerCount: number,
  ): void {
    if (!this.initialized || !this.world) return;

    // If physics failed, attempt recovery
    if (this.failed) {
      try {
        this.recreateWorld();
        this.failed = false;
        console.error(`[RAPIER] Physics world recovered at tick ${this.tickCount}`);
      } catch (err) {
        console.error(`[RAPIER] Recovery failed: ${err}`);
        return;
      }
    }

    this.tickCount++;

    try {
      const t0 = performance.now();
      this.processPendingRebuilds();
      const t1 = performance.now();
      this.syncEntities(entities, entityCount);
      const t2 = performance.now();
      this.setTimestep(dt);
      this.world.step(this.eventQueue!);
      const t3 = performance.now();
      this.readBackShipPositions(entities, entityCount);
      const t4 = performance.now();

      if (t4 - t0 > 50) {
        console.error(`[RAPIER] Slow tick ${this.tickCount}: rebuilds=${(t1-t0).toFixed(1)}ms sync=${(t2-t1).toFixed(1)}ms step=${(t3-t2).toFixed(1)}ms readback=${(t4-t3).toFixed(1)}ms bodies=${this.entityBodies.size}`);
      }
    } catch (err) {
      this.panicRecover(err);
    }
  }

  // Build chunked trimesh colliders for an island body whose physics field was
  // not ready at creation time. Called from syncEntities once the field arrives.
  private buildIslandTrimeshColliders(
    entity: SimEntity, body: EntityBody, field: VoxelField,
  ): void {
    if (!this.world || this.failed) return;
    const r = entity.scale;
    if (!Number.isFinite(r) || r <= 0) return;

    const rb = this.world.getRigidBody(body.handle);
    if (!rb) return;

    const entityIdx = body.entityIdx;
    this.islandFields.set(entityIdx, field);

    const CHUNK_SIZE = 32;
    const chunkCountX = Math.ceil(field.dimX / CHUNK_SIZE);
    const chunkCountZ = Math.ceil(field.dimZ / CHUNK_SIZE);
    const chunkColliders = new Map<string, number>();

    for (let cx = 0; cx < chunkCountX; cx++) {
      for (let cz = 0; cz < chunkCountZ; cz++) {
        const x0 = cx * CHUNK_SIZE;
        const z0 = cz * CHUNK_SIZE;
        const x1 = Math.min(x0 + CHUNK_SIZE, field.dimX);
        const z1 = Math.min(z0 + CHUNK_SIZE, field.dimZ);

        const chunkMesh = generateTerrainTrimeshSubRegion(
          field, entity.chunkX, entity.chunkZ,
          x0, 0, z0, x1, field.dimY, z1, false,
        );
        if (chunkMesh.positions.length < 9 || chunkMesh.indices.length < 3) continue;

        const pos = new Float32Array(chunkMesh.positions.length);
        let valid = true;
        for (let vi = 0; vi < chunkMesh.positions.length; vi += 3) {
          pos[vi]     = chunkMesh.positions[vi]     * r;
          pos[vi + 1] = chunkMesh.positions[vi + 1] * r;
          pos[vi + 2] = chunkMesh.positions[vi + 2] * r;
          if (!Number.isFinite(pos[vi]) || !Number.isFinite(pos[vi + 1]) || !Number.isFinite(pos[vi + 2])) {
            valid = false; break;
          }
        }
        if (!valid) continue;

        try {
          const cd = RAPIER.ColliderDesc.trimesh(pos, chunkMesh.indices);
          cd.setCollisionGroups(ISLAND_BOTH_GROUPS);
          const col = this.world.createCollider(cd, rb);
          chunkColliders.set(`${cx},${cz}`, col.handle);
        } catch (colErr) {
          console.error(`[RAPIER] Deferred createCollider failed for entity ${entityIdx} chunk ${cx},${cz}: ${(colErr as Error).message}`);
        }
      }
    }

    body.chunkColliders = chunkColliders.size > 0 ? chunkColliders : undefined;
    body.chunkSize = CHUNK_SIZE;
    body.chunkCountX = chunkCountX;
    body.chunkCountZ = chunkCountZ;
  }

  private syncEntities(entities: SimEntity[], entityCount: number): void {
    if (!this.world) return;

    for (let i = 0; i < entityCount; i++) {
      if (this.failed) break;
      const ent = entities[i];
      if (!ent) continue;

      if (!this.entityBodies.has(i) && !(ent.flags & EntityFlags.NoCollision)) {
        this.createEntityBody(ent, i);
      }

      const body = this.entityBodies.get(i);
      if (!body) continue;

      // Build deferred terrain colliders for islands whose physics field is now ready
      if (body.needsTerrainCollider) {
        const field = this.terrainSystem?.getVoxelField(ent.id);
        if (field) {
          this.buildIslandTrimeshColliders(ent, body, field);
          body.needsTerrainCollider = false;
        }
      }

      const px = ent.position.x, py = ent.position.y, pz = ent.position.z;
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;

      try {
        const rb = this.world.getRigidBody(body.handle);
        if (!rb) continue;

        if (body.isShip) {
          // Ships are dynamic: sync position AND velocity so Rapier can resolve
          // collisions with the correct momentum. BuoyancySystem already integrated
          // position += velocity * dt, so we sync the post-integration position.
          rb.setTranslation({ x: px, y: py, z: pz }, true);
          rb.setLinvel({ x: ent.velocity.x, y: ent.velocity.y, z: ent.velocity.z }, true);
          // Reset angular velocity — BoatSystem handles rotation
          rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
        } else {
          // Non-ship entities: sync position only (kinematic or static)
          rb.setTranslation({ x: px, y: py, z: pz }, true);
        }

        const rx = ent.rotation.x, ry = ent.rotation.y, rz = ent.rotation.z, rw = ent.rotation.w;
        if (Number.isFinite(rx) && Number.isFinite(ry) && Number.isFinite(rz) && Number.isFinite(rw)) {
          rb.setRotation({ x: rx, y: ry, z: rz, w: rw }, true);
        }
      } catch (err) {
        if (this.isWasmTrap(err)) {
          this.failed = true;
        }
        // Body might have been removed — skip silently
      }
    }
  }

  // After world.step(), read back corrected positions and velocities for ships.
  // Rapier resolved collisions (e.g. pushed ship out of port) — we need to write
  // the corrected position back to the entity so the rest of the simulation
  // (rendering, player tracking, etc.) uses the correct position.
  private readBackShipPositions(entities: SimEntity[], entityCount: number): void {
    if (!this.world) return;

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;

      const body = this.entityBodies.get(i);
      if (!body || !body.isShip) continue;

      try {
        const rb = this.world.getRigidBody(body.handle);
        if (!rb) continue;

        const pos = rb.translation();
        const vel = rb.linvel();

        // Only write back XZ — BuoyancySystem is the authority for ship Y.
        // Writing back Y from Rapier causes friction on sloped terrain to push
        // ships underwater.
        if (Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
          ent.position.x = pos.x;
          ent.position.z = pos.z;
        }
        if (Number.isFinite(vel.x) && Number.isFinite(vel.z)) {
          ent.velocity.x = vel.x;
          ent.velocity.z = vel.z;
        }
      } catch (err) {
        if (this.isWasmTrap(err)) {
          this.failed = true;
        }
        // Body might have been removed — skip silently
      }
    }
  }

  shutdown(): void {
    if (this.world) {
      this.world.free();
      this.world = null;
    }
    this.entityBodies.clear();
    this.bodyHandleToEntityBody.clear();
    this.pendingShipRebuilds.clear();
    this.playerCharacters.clear();
    this.collisionLog = [];
    this.initialized = false;
  }
}
