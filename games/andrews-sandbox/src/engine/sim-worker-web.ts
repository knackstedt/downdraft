// ============================================================================
// Simulation Web Worker — runs the authoritative sim inside a Web Worker.
// SharedArrayBuffers are shared directly with the renderer — zero-copy state.
// Uses the RPC layer (expose/exposeEvents) for typed async communication.
// ============================================================================

import {
    ENT, InputBufferReader, SimBufferWriter, SimWorkerLoop,
    type BodyDesc, type ColliderDesc, type Entity,
    type LoadOptions,
    type PhysicsBody,
    type SaveOptions, type SaveState,
} from "@downdraft/core";
import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import { OpfsSaveStore, type OpfsSaveStoreOptions } from "@downdraft/library-persistence/browser";
import { RapierPhysicsBackend, UniversalPhysicsAPI } from "@downdraft/library-physics-rapier";
import { ENT_DATA, MAX_SIM_SPEED, MIN_SIM_SPEED, SIM_TICK_DT } from "@sandbox/shared/constants/buffer";
import { EntityType, FunMode, PropFlags, type SandboxSimMessage, type SimCommand } from "@sandbox/shared/types";

(globalThis as any).__ddThreadTag = "R1";

// ── Sim state ──
let simWriter: SimBufferWriter | null = null;
let inputReader: InputBufferReader | null = null;
let physicsApi: UniversalPhysicsAPI | null = null;
let physicsBackend: RapierPhysicsBackend | null = null;
let simLoop: SimWorkerLoop | null = null;
let opfsStore: OpfsSaveStore | null = null;

// Entity tracking
interface PropRecord {
  contentId: string;
  body: PhysicsBody;
  type: EntityType;
  slotIdx: number;
  shape: "box" | "sphere";
  halfExtents: [number, number, number];
  radius: number;
  mass: number;
  restitution: number;
  friction: number;
  gravityScale: number;
  /** Remaining lifetime in seconds; 0 = permanent. */
  lifetime?: number;
}
const propRecords = new Map<number, PropRecord>(); // entityId → record
let nextSlotIdx = 0;
let currentFunMode = FunMode.Normal;
/** Recycled slot indices from removed props (reused before allocating new slots). */
const freeSlots: number[] = [];

const events = exposeEvents();
const onEvent = (msg: SandboxSimMessage) => { events.emit(msg.kind, msg.data); };

// ── Initialize physics ──
async function initPhysics(): Promise<void> {
  physicsBackend = new RapierPhysicsBackend();
  await physicsBackend.init();
  physicsApi = new UniversalPhysicsAPI(physicsBackend, {
    gravity: [0, -9.8, 0],
    fixedDt: SIM_TICK_DT,
    maxCatchUpSteps: 1,
    stepBudgetMs: 16,
    maxEntities: 4096,
    realmConfigs: {
      near: { tickFrequency: 1, solverIterations: 16, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
      mid: { tickFrequency: 1, solverIterations: 8, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
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
  physicsApi.reserveMemory(64 * 1024 * 1024);

  // Create a static ground plane (large flat box) at y=0
  const groundEntity: Entity = { index: 0xFFFF, generation: 0 };
  const groundBody = physicsApi.createBody(groundEntity, {
    type: "static",
    position: [0, -0.5, 0],
    rotation: [0, 0, 0, 1],
    mass: 0,
  });
  physicsApi.addCollider(groundBody, {
    shape: { type: "box", halfExtents: [500, 0.5, 500] },
    restitution: 0.3,
    friction: 0.8,
  });
}

// ── Create a physics body for a prop ──
function createPropBody(
  position: [number, number, number],
  rotation: [number, number, number, number],
  shape: "box" | "sphere",
  halfExtents: [number, number, number],
  radius: number,
  mass: number,
  restitution: number,
  friction: number,
  gravityScale: number,
  ccdEnabled: boolean = false,
): PhysicsBody {
  if (!physicsApi) throw new Error("Physics not initialized");
  const entity: Entity = { index: nextSlotIdx, generation: 0 };
  const bodyDesc: BodyDesc = {
    type: "dynamic",
    position,
    rotation,
    mass,
    gravityScale,
    ccdEnabled,
  };
  const body = physicsApi.createBody(entity, bodyDesc);
  const colliderDesc: ColliderDesc = {
    shape: shape === "box"
      ? { type: "box", halfExtents }
      : { type: "sphere", radius },
    restitution,
    friction,
    density: mass > 0 ? mass / (shape === "box"
      ? (8 * halfExtents[0] * halfExtents[1] * halfExtents[2])
      : (4 / 3 * Math.PI * radius ** 3)) : 1.0,
  };
  physicsApi.addCollider(body, colliderDesc);
  return body;
}

// ── Spawn a prop ──
function spawnProp(
  contentId: string,
  position: [number, number, number],
  rotation?: [number, number, number, number],
  physics?: { mass?: number; restitution?: number; friction?: number; gravityScale?: number },
  shape?: "box" | "sphere",
  scale?: number,
): number {
  // entityId MUST equal slotIdx + 1 — the renderer's prop_spawned handler
  // writes nodeId to (entityId - 1) * stride + offset in the SAB, and the
  // physgun raycast uses slotIdx + 1 as the entityId for propRecords lookup.
  const slotIdx = freeSlots.length > 0 ? freeSlots.shift()! : nextSlotIdx++;
  const entityId = slotIdx + 1;
  const rot = rotation ?? [0, 0, 0, 1];
  const mass = physics?.mass ?? 1.0;
  const restitution = physics?.restitution ?? 0.3;
  const friction = physics?.friction ?? 0.5;
  const gravityScale = physics?.gravityScale ?? 1.0;
  const propShape = shape ?? "box";
  const propScale = scale ?? 1.0;
  const halfExt = 0.5 * propScale;
  const radius = 0.5 * propScale;

  const body = createPropBody(position, rot, propShape, [halfExt, halfExt, halfExt], radius, mass, restitution, friction, gravityScale);

  // Write to SAB
  const f32 = simWriter!.getEntityF32(slotIdx);
  const u32 = simWriter!.getEntityU32(slotIdx);
  u32[ENT.TYPE] = EntityType.Prop;
  u32[ENT.ID] = 0; // node id — set by renderer
  u32[ENT.PARENT_ID] = body.id;
  u32[ENT.CHUNK_X] = PropFlags.Paintable;
  u32[ENT.CHUNK_Z] = 0; // paint texture handle — set by renderer
  f32[ENT.POS_X] = position[0];
  f32[ENT.POS_Y] = position[1];
  f32[ENT.POS_Z] = position[2];
  f32[ENT.SCALE] = propScale;
  f32[ENT.ROT_X] = rot[0]; f32[ENT.ROT_Y] = rot[1]; f32[ENT.ROT_Z] = rot[2]; f32[ENT.ROT_W] = rot[3];
  f32[ENT_DATA.MASS + ENT.DATA] = mass;
  f32[ENT_DATA.RESTITUTION + ENT.DATA] = restitution;
  f32[ENT_DATA.FRICTION + ENT.DATA] = friction;
  f32[ENT_DATA.GRAVITY_SCALE + ENT.DATA] = gravityScale;
  f32[ENT_DATA.SHAPE + ENT.DATA] = propShape === "sphere" ? 1 : 0;

  simWriter!.setEntityCount(nextSlotIdx);
  simWriter!.markEntityDirty(slotIdx);

  propRecords.set(entityId, {
    contentId, body, type: EntityType.Prop, slotIdx,
    shape: propShape, halfExtents: [halfExt, halfExt, halfExt], radius: radius,
    mass, restitution, friction, gravityScale,
  });

  events.emit("prop_spawned", { entityId, contentId, nodeId: 0, position, quaternion: rot, scale: propScale, paintable: true });
  return entityId;
}

// ── Remove a prop ──
function removeProp(entityId: number): void {
  const record = propRecords.get(entityId);
  if (!record) return;
  if (physicsApi) physicsApi.destroyBody(record.body);
  // Clear the SAB slot so the renderer stops rendering it
  // Use 255 (invalid type) as the "empty" sentinel since EntityType.Prop = 0
  if (simWriter) {
    const u32 = simWriter.getEntityU32(record.slotIdx);
    u32[ENT.TYPE] = 255; // mark as empty/invalid
    u32[ENT.ID] = 0;
    u32[ENT.PARENT_ID] = 0;
    simWriter.markEntityDirty(record.slotIdx);
  }
  // Recycle the slot so it can be reused by the next spawn
  freeSlots.push(record.slotIdx);
  propRecords.delete(entityId);
  events.emit("prop_removed", { entityId });
}

// ── Clear all props ──
function clearProps(): void {
  for (const entityId of Array.from(propRecords.keys())) {
    const record = propRecords.get(entityId)!;
    if (physicsApi) physicsApi.destroyBody(record.body);
  }
  propRecords.clear();
  nextSlotIdx = 0;
  freeSlots.length = 0;
  simWriter!.setEntityCount(0);
}

// ── Set fun mode (recreate bodies with new physics properties) ──
function setFunMode(mode: FunMode): void {
  currentFunMode = mode;
  const gravityScale = mode === FunMode.Moon ? 0.16 : mode === FunMode.ZeroG ? 0 : 1.0;
  const restitution = mode === FunMode.Bouncy ? 0.95 : 0.3;
  const friction = mode === FunMode.Bouncy ? 0.1 : 0.5;

  // Recreate each body with new properties (the engine doesn't expose runtime
  // property setters for restitution/friction/gravityScale).
  for (const record of propRecords.values()) {
    const pos = physicsApi!.getPosition(record.body);
    const rot = physicsApi!.getRotation(record.body);
    physicsApi!.destroyBody(record.body);
    record.body = createPropBody(pos, rot, record.shape, record.halfExtents, record.radius, record.mass, restitution, friction, gravityScale);
    record.restitution = restitution;
    record.friction = friction;
    record.gravityScale = gravityScale;

    const f32 = simWriter!.getEntityF32(record.slotIdx);
    const u32 = simWriter!.getEntityU32(record.slotIdx);
    u32[ENT.PARENT_ID] = record.body.id;
    f32[ENT_DATA.RESTITUTION + ENT.DATA] = restitution;
    f32[ENT_DATA.FRICTION + ENT.DATA] = friction;
    f32[ENT_DATA.GRAVITY_SCALE + ENT.DATA] = gravityScale;
    simWriter!.markEntityDirty(record.slotIdx);
  }
  events.emit("fun_mode_changed", { mode });
}

// ── Process sim commands from renderer ──
function processCommand(cmd: SimCommand): void {
  switch (cmd.type) {
    case "spawn":
      spawnProp(cmd.contentId, cmd.position, cmd.rotation, cmd.physics, cmd.shape, cmd.scale);
      break;
    case "remove":
      removeProp(cmd.entityId);
      break;
    case "clear":
      clearProps();
      break;
    case "setFunMode":
      setFunMode(cmd.mode);
      break;
    case "setTool":
      // Tool selection is renderer-side only; no sim action needed
      break;
    case "fireWeapon": {
      // Spawn a projectile — entityId = slotIdx + 1 (same invariant as props)
      const slotIdx = freeSlots.length > 0 ? freeSlots.shift()! : nextSlotIdx++;
      const entityId = slotIdx + 1;
      const body = createPropBody(cmd.origin, [0, 0, 0, 1], "sphere", [0.1, 0.1, 0.1], 0.1, 0.5, 0.5, 0.3, 0.5, true);
      physicsApi!.setLinearVelocity(body, [cmd.direction[0] * 50, cmd.direction[1] * 50, cmd.direction[2] * 50]);

      const f32 = simWriter!.getEntityF32(slotIdx);
      const u32 = simWriter!.getEntityU32(slotIdx);
      u32[ENT.TYPE] = EntityType.Projectile;
      f32[ENT_DATA.SHAPE + ENT.DATA] = 1; // sphere
      u32[ENT.PARENT_ID] = body.id;
      f32[ENT.POS_X] = cmd.origin[0];
      f32[ENT.POS_Y] = cmd.origin[1];
      f32[ENT.POS_Z] = cmd.origin[2];
      f32[ENT.SCALE] = 1.0;
      simWriter!.setEntityCount(nextSlotIdx);
      simWriter!.markEntityDirty(slotIdx);
      propRecords.set(entityId, {
        contentId: "projectile", body, type: EntityType.Projectile, slotIdx,
        shape: "sphere", halfExtents: [0.1, 0.1, 0.1], radius: 0.1,
        mass: 0.5, restitution: 0.5, friction: 0.3, gravityScale: 0.5,
        lifetime: 5.0, // despawn after 5 seconds
      });
      break;
    }
    case "grabProp": {
      const record = propRecords.get(cmd.entityId);
      if (record && physicsApi) {
        physicsApi.setBodyType(record.body, "kinematic");
      }
      break;
    }
    case "releaseProp": {
      const record = propRecords.get(cmd.entityId);
      if (record && physicsApi) {
        physicsApi.setBodyType(record.body, "dynamic");
        physicsApi.setLinearVelocity(record.body, cmd.velocity);
      }
      break;
    }
    case "updateGrab": {
      const record = propRecords.get(cmd.entityId);
      if (record && physicsApi) {
        physicsApi.setPosition(record.body, cmd.targetPos);
      }
      break;
    }
    case "updatePropPhysics": {
      const record = propRecords.get(cmd.entityId);
      if (!record || !physicsApi) break;
      const newMass = cmd.mass ?? record.mass;
      const newRestitution = cmd.restitution ?? record.restitution;
      const newFriction = cmd.friction ?? record.friction;
      const newGravityScale = cmd.gravityScale ?? record.gravityScale;
      // Recreate body with new physics properties (no runtime setter API)
      const pos = physicsApi.getPosition(record.body);
      const rot = physicsApi.getRotation(record.body);
      const vel = physicsApi.getLinearVelocity(record.body);
      physicsApi.destroyBody(record.body);
      record.body = createPropBody(pos, rot, record.shape, record.halfExtents, record.radius, newMass, newRestitution, newFriction, newGravityScale);
      record.mass = newMass;
      record.restitution = newRestitution;
      record.friction = newFriction;
      record.gravityScale = newGravityScale;
      physicsApi.setLinearVelocity(record.body, vel);
      // Update SAB
      const f32 = simWriter!.getEntityF32(record.slotIdx);
      const u32 = simWriter!.getEntityU32(record.slotIdx);
      u32[ENT.PARENT_ID] = record.body.id;
      f32[ENT_DATA.MASS + ENT.DATA] = newMass;
      f32[ENT_DATA.RESTITUTION + ENT.DATA] = newRestitution;
      f32[ENT_DATA.FRICTION + ENT.DATA] = newFriction;
      f32[ENT_DATA.GRAVITY_SCALE + ENT.DATA] = newGravityScale;
      simWriter!.markEntityDirty(record.slotIdx);
      break;
    }
    case "applyImpulse": {
      const record = propRecords.get(cmd.entityId);
      if (record && physicsApi) {
        physicsApi.applyImpulse(record.body, cmd.impulse);
      }
      break;
    }
  }
}

// ── Sync physics transforms back to SAB ──
function syncTransforms(): void {
  if (!physicsApi || !simWriter) return;
  for (const record of propRecords.values()) {
    const pos = physicsApi.getPosition(record.body);
    const rot = physicsApi.getRotation(record.body);
    const f32 = simWriter.getEntityF32(record.slotIdx);
    f32[ENT.POS_X] = pos[0];
    f32[ENT.POS_Y] = pos[1];
    f32[ENT.POS_Z] = pos[2];
    f32[ENT.ROT_X] = rot[0];
    f32[ENT.ROT_Y] = rot[1];
    f32[ENT.ROT_Z] = rot[2];
    f32[ENT.ROT_W] = rot[3];
    const vel = physicsApi.getLinearVelocity(record.body);
    f32[ENT.VEL_X] = vel[0];
    f32[ENT.VEL_Y] = vel[1];
    f32[ENT.VEL_Z] = vel[2];
    simWriter.markEntityDirty(record.slotIdx);
  }
}

// ── Save/load state ──
function saveState(): string {
  const props: any[] = [];
  for (const [entityId, record] of propRecords) {
    const f32 = simWriter!.getEntityF32(record.slotIdx);
    props.push({
      entityId,
      contentId: record.contentId,
      position: [f32[ENT.POS_X], f32[ENT.POS_Y], f32[ENT.POS_Z]],
      quaternion: [f32[ENT.ROT_X], f32[ENT.ROT_Y], f32[ENT.ROT_Z], f32[ENT.ROT_W]],
      scale: f32[ENT.SCALE],
      shape: record.shape,
      mass: record.mass,
      restitution: record.restitution,
      friction: record.friction,
      gravityScale: record.gravityScale,
    });
  }
  return JSON.stringify({ props, funMode: currentFunMode, version: 1 });
}

async function restoreState(stateJson: string): Promise<void> {
  const state = JSON.parse(stateJson);
  clearProps();
  if (state.funMode !== undefined) currentFunMode = state.funMode;
  for (const prop of state.props ?? []) {
    spawnProp(
      prop.contentId, prop.position, prop.quaternion,
      { mass: prop.mass, restitution: prop.restitution, friction: prop.friction, gravityScale: prop.gravityScale },
      prop.shape,
      prop.scale,
    );
  }
  // Re-apply fun mode to restored props
  if (currentFunMode !== FunMode.Normal) {
    setFunMode(currentFunMode);
  }
}

// ── RPC API ──
expose({
  async init(simBuffer: SharedArrayBuffer, inputBuffer: SharedArrayBuffer, config: { seed: number; isDev?: boolean }): Promise<void> {
    simWriter = new SimBufferWriter(simBuffer);
    simWriter.init();
    inputReader = new InputBufferReader(inputBuffer);

    await initPhysics();

    simLoop = new SimWorkerLoop({
      fixedDt: SIM_TICK_DT,
      maxSpeed: MAX_SIM_SPEED,
      minSpeed: MIN_SIM_SPEED,
      tick: async (dt) => {
        if (physicsApi) physicsApi.stepNearRealm(dt);
        // Despawn expired entities (projectiles, etc.)
        const expired: number[] = [];
        for (const [entityId, record] of propRecords) {
          if (record.lifetime !== undefined && record.lifetime > 0) {
            record.lifetime -= dt;
            if (record.lifetime <= 0) expired.push(entityId);
          }
        }
        for (const entityId of expired) {
          removeProp(entityId);
        }
        syncTransforms();
        simWriter!.incrementTick();
      },
    });
    simLoop.start();
  },

  pause() { simLoop?.pause(); },
  resume() { simLoop?.resume(); },

  async save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean }> {
    const stateJson = saveState();
    if (opfsStore) {
      const parsed = JSON.parse(stateJson);
      const saveStateObj: SaveState = {
        components: { sandbox: { v: 1, data: parsed } },
        meta: {
          engineVersion: "0.1.0",
          timestamp: Date.now() / 1000,
          entityCount: parsed.props?.length ?? 0,
          playerCount: 1,
        },
      };
      await opfsStore.save(slotName, saveStateObj, opts);
    }
    return { slotName, stateJson, success: true };
  },

  async load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean> {
    let json = stateJson;
    if (!json && opfsStore) {
      const result = await opfsStore.load(slotName, opts);
      if (result.state?.components?.sandbox) {
        json = JSON.stringify(result.state.components.sandbox.data);
      }
    }
    if (!json) return false;
    await restoreState(json);
    return true;
  },

  async initSaveStore(opts: OpfsSaveStoreOptions): Promise<void> {
    opfsStore = new OpfsSaveStore(opts);
    await opfsStore.init();
  },

  sendCommand(cmd: SimCommand): Promise<void> {
    processCommand(cmd);
    return Promise.resolve();
  },

  async restoreFromState(stateJson: string): Promise<void> {
    await restoreState(stateJson);
  },

  shutdown(): Promise<void> {
    simLoop?.stop();
    return Promise.resolve();
  },
});
