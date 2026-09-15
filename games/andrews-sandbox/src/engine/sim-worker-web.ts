// ============================================================================
// Simulation Web Worker — runs the authoritative sim inside a Web Worker.
// SharedArrayBuffers are shared directly with the renderer — zero-copy state.
// Uses the RPC layer (expose/exposeEvents) for typed async communication.
// ============================================================================

import type { CharacterControllerHandle } from "@downdraft/core";
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
import { DEFAULT_PLAYER_MODEL } from "@sandbox/shared/constants/player";
import { EntityType, FunMode, PhysgunMode, PoseState, PropFlags, type SandboxSimMessage, type SimCommand } from "@sandbox/shared/types";

(globalThis as any).__ddThreadTag = "R1";

// ── Player pose configuration ──
// Each pose defines the character capsule dimensions (height/radius), the
// camera eye height above the feet, and a movement-speed multiplier. The sim
// recreates the Rapier character controller whenever the pose changes so the
// collision shape matches the stance.
interface PoseCfg {
  height: number;     // total capsule height (feet → head)
  radius: number;     // capsule radius
  eyeHeight: number;  // camera eye height above feet (renderer reads this)
  speedMul: number;   // movement-speed multiplier (renderer applies this)
}
const POSE_CONFIG: Record<PoseState, PoseCfg> = {
  [PoseState.Standing]:  { height: 1.8, radius: 0.4, eyeHeight: 1.62, speedMul: 1.0 },
  [PoseState.Crouching]: { height: 1.2, radius: 0.4, eyeHeight: 1.0,  speedMul: 0.6 },
  [PoseState.Prone]:     { height: 0.6, radius: 0.3, eyeHeight: 0.4,  speedMul: 0.25 },
};
function poseCfg(pose: PoseState): PoseCfg { return POSE_CONFIG[pose]; }
function capsuleHalfHeight(pose: PoseState): number {
  const c = poseCfg(pose);
  return Math.max(0, (c.height - 2 * c.radius) / 2);
}
function capsuleYOffset(pose: PoseState): number { return poseCfg(pose).height / 2; }

// ── Player constants (standing defaults) ──
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const PLAYER_CAPSULE_HALF_HEIGHT = (PLAYER_HEIGHT - 2 * PLAYER_RADIUS) / 2;
const PLAYER_CAPSULE_Y_OFFSET = PLAYER_HEIGHT / 2;

// ── Sim state ──
let simWriter: SimBufferWriter | null = null;
let inputReader: InputBufferReader | null = null;
let physicsApi: UniversalPhysicsAPI | null = null;
let physicsBackend: RapierPhysicsBackend | null = null;
let simLoop: SimWorkerLoop | null = null;
let opfsStore: OpfsSaveStore | null = null;

// ── Player state ──
let playerController: CharacterControllerHandle | null = null;
let playerPos: [number, number, number] = [0, PLAYER_HEIGHT, 0];
let playerGrounded = false;
let pendingPlayerMove: [number, number, number] | null = null;
// Most negative vertical velocity seen across accumulated movePlayer commands
// this tick — used for fall damage instead of pendingPlayerMove[1]/dt, which
// would overestimate speed when multiple deltas accumulate into one tick.
let pendingPlayerFallVy: number | null = null;
let currentPose: PoseState = PoseState.Standing;

// ── Player health state ──
// The sim is authoritative for player health. Damage is applied here (fall
// damage on hard landings, prop-collision damage on impact), health
// regenerates after a damage-free delay, and the state is mirrored to the
// renderer via the player_moved / player_damaged / player_died /
// player_respawned events so the HUD can render a health bar + damage flash.
const PLAYER_MAX_HEALTH = 100;
let playerHealth = PLAYER_MAX_HEALTH;
let playerDead = false;
// The player's chosen model id (persisted in the save state). The sim is
// authoritative; the renderer loads the model on player_model_changed.
let playerModelId: string = DEFAULT_PLAYER_MODEL;
// Peak downward speed (m/s) accumulated while airborne. Reset on landing so a
// single fall produces one damage burst. Used for fall-damage computation.
let playerFallSpeed = 0;
// Previous-frame grounded flag — used to detect the airborne→grounded landing
// transition that triggers fall damage.
let playerPrevGrounded = true;
// Sim time (seconds, accumulated dt) — used for the regen delay window and
// per-prop damage cooldowns.
let simTime = 0;
// Sim time of the last damage event — regen is suppressed until
// (simTime - lastDamageTime) >= HEALTH_REGEN_DELAY.
let lastDamageTime = -Infinity;
// Per-prop damage cooldowns (entityId → remaining seconds). Prevents a single
// fast-moving prop from dealing damage every tick while in contact.
const propDamageCooldowns = new Map<number, number>();

// ── Damage tuning ──
// Thresholds sit above small hops/step-downs so trivial drops are harmless,
// but the curve ramps steeply once past it so real falls hurt a lot. With
// gravity = 20 m/s², fall speed ≈ √(40·height): 10 m → 20 m/s, 20 m → 28 m/s.
//   10 m fall → ~42 dmg, 20 m fall → ~98 dmg, 30 m+ fall → overkill.
// Damage is uncapped — overkill (damage > maxHealth) is tracked for future
// systems (gibbing, armor penetration, etc.) and max health may be boosted.
const FALL_DAMAGE_MIN_SPEED = 14.0;   // m/s downward; below = no damage
const FALL_DAMAGE_GAIN = 7.0;         // damage = (fallSpeed - min) * gain
const PROP_DAMAGE_MIN_SPEED = 10.0;   // m/s toward player; below = no damage
const PROP_DAMAGE_MIN_MASS = 5.0;    // kg; below this mass a prop can't hurt
const PROP_DAMAGE_GAIN = 3.5;        // damage = massFactor * (impactSpeed - min) * gain
const PROP_DAMAGE_COOLDOWN = 0.5;    // seconds, per-prop
const HEALTH_REGEN_DELAY = 5.0;      // seconds without damage before regen
const HEALTH_REGEN_RATE = 5.0;      // HP / sec

// ── Reused out-tuples for Raw scalar physics reads (zero-alloc hot path) ──
const _posOut: [number, number, number] = [0, 0, 0];
const _rotOut: [number, number, number, number] = [0, 0, 0, 1];
const _velOut: [number, number, number] = [0, 0, 0];

// Entity tracking
interface PropRecord {
  contentId: string;
  body: PhysicsBody;
  /** Current collider id on the body (so we can remove/swap it for a hull). */
  colliderId: number;
  type: EntityType;
  slotIdx: number;
  shape: "box" | "sphere";
  halfExtents: [number, number, number];
  radius: number;
  mass: number;
  restitution: number;
  friction: number;
  gravityScale: number;
  /**
   * Convex hull vertices in body-local space (already scaled by spawn scale),
   * once the renderer has derived them from the loaded mesh. When present,
   * body recreation (fun mode / physics update) re-applies a convex collider
   * instead of the placeholder box/sphere.
   */
  hull?: Float32Array;
  /** Remaining lifetime in seconds; 0 = permanent. */
  lifetime?: number;
  /** Stub: durability/HP (not yet consumed by damage systems). */
  strength?: number;
  /** Stub: texture-override id (not yet applied by the renderer). */
  texture?: string;
  /** Stub: shader-override id (not yet applied by the renderer). */
  shader?: string;
  /** Per-prop jelly deformation on impact (independent of the global Squishy fun mode). */
  squishy?: boolean;
}
const propRecords = new Map<number, PropRecord>(); // entityId → record
// Active physgun grabs: entityId → { mode, targetPos }. The tick loop drives
// Solid-mode grabs toward targetPos via velocity so collisions are respected;
// Ghost-mode grabs are teleported directly in the updateGrab handler.
interface GrabState {
  mode: PhysgunMode;
  targetPos: [number, number, number];
}
const grabbedProps = new Map<number, GrabState>();
let nextSlotIdx = 0;
let currentFunMode = FunMode.Normal;
/** Recycled slot indices from removed props (reused before allocating new slots). */
const freeSlots: number[] = [];

// ── Squish visual deformation ──
// In Squishy fun mode, the sim detects bounce impacts from physics contacts
// and writes a per-prop squish (compression amount + local axis) into the SAB.
// The renderer applies it as a non-uniform scale. The state lives here (not in
// the SAB) so it can animate smoothly even for sleeping bodies; the SAB is just
// the display copy the renderer reads each frame.
//
// The deformation is driven by a spring-mass-damper: an impact gives the spring
// a velocity impulse, and the spring naturally animates compression → recovery
// → slight overshoot (jelly wobble) → settle. This replaces the old instant-set
// + exponential-decay, which looked binary (snap to squished, then fade out).
interface SquishState {
  amount: number;    // current compression along `axis` (0 = rest, + = compressed, - = stretched)
  velocity: number;  // spring velocity (rate of change of amount)
  axis: number;      // 0=x, 1=y, 2=z (prop local frame)
  dir: number;       // impact-side sign along `axis` (-1 or +1); -dir is the far side (stays fixed)
}
const squishStates = new Map<number, SquishState>(); // entityId → state
// Count of props spawned with the per-prop `squishy` flag. Contact extraction
// is enabled while the global Squishy fun mode is active OR any prop is squishy.
let squishyPropCount = 0;
// Pre-step linear velocity snapshot — captured before stepNearRealm so the
// post-step contact pass can compute the pre-bounce impact speed.
const prevVelocities = new Map<number, [number, number, number]>();
// Tuning. The spring is underdamped (ρ ≈ 0.3) so it overshoots slightly on
// recovery, giving a jelly wobble. Semi-implicit Euler integration is stable
// for these constants at dt=1/60 (stability bound: dt < 2/ω ≈ 0.052s).
const SQUISH_MIN_IMPACT = 1.5;     // m/s along the contact normal to trigger
const SQUISH_IMPULSE_GAIN = 1.2;   // spring velocity impulse per m/s above threshold
const SQUISH_MAX = 0.4;            // cap compression along one axis
const SQUISH_K = 200;             // spring stiffness (pulls amount back to 0)
const SQUISH_C = 8;               // damping (underdamped — slight overshoot wobble)

// Squish is active when the global Squishy fun mode is on OR any spawned prop
// carries the per-prop `squishy` flag. Gates contact extraction (expensive) and
// the per-tick velocity snapshot used to compute impact speeds.
function squishActive(): boolean {
  return currentFunMode === FunMode.Squishy || squishyPropCount > 0;
}
// A prop deforms on impact if it was spawned squishy OR the global Squishy fun
// mode is forcing all props to be jelly.
function propIsSquishy(record: PropRecord): boolean {
  return record.squishy === true || currentFunMode === FunMode.Squishy;
}
// Toggle Rapier contact manifold extraction on/off to match `squishActive()`.
// Leaving it on when nothing needs contacts wastes ~43% of step time.
function updateExtractContacts(): void {
  if (physicsBackend) physicsBackend.extractContacts = squishActive();
}

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
      near: { tickFrequency: 1, solverIterations: 4, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
      mid: { tickFrequency: 1, solverIterations: 4, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
      far: { tickFrequency: 1, solverIterations: 2, promoteThreshold: Infinity, demoteThreshold: Infinity, demoteDwellTime: 1 },
    },
    nanSweepInterval: 0,
    nanSweepVelocityThreshold: 0,
    ccdTunnelingRatio: 0,
    snapshotInterval: 0,
    predictionMode: "server-authoritative",
    workerCount: 0,
    devMode: false,
    duplicateStatics: false,
    // The sandbox never reads contacts/intersections — skip the expensive
    // WASM↔JS callback traversal in step() (~43% of step time).
    extractContacts: false,
    // Transforms are read via the Raw scalar API in syncTransforms() —
    // skip the redundant high-level readback in step().
    readBackTransformsOnStep: false,
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

  // Create the player character controller (capsule shape, parentless collider)
  playerController = physicsApi.createCharacterController({
    offset: [0, 0.01, 0],
    radius: PLAYER_RADIUS,
    halfHeight: PLAYER_CAPSULE_HALF_HEIGHT,
    slide: true,
    autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.5 },
    maxSlope: Math.PI / 3,
    minSlopeSlide: Math.PI / 4,
    snapToGround: 0.1,
    applyImpulsesToDynamicBodies: true,
    parentless: {
      position: [playerPos[0], playerPos[1] + PLAYER_CAPSULE_Y_OFFSET, playerPos[2]],
    },
  }, { index: 0xFFFE, generation: 0 });
}

// ── Apply a pose change ──
// Recreates the Rapier character controller with the new pose's capsule
// dimensions. The player's feet stay at the same y (playerPos.y unchanged);
// only the capsule height/center changes. Emits `pose_changed` so the
// renderer can reposition the camera eye.
function applyPose(pose: PoseState): void {
  if (pose === currentPose || !physicsApi) return;
  currentPose = pose;
  const cfg = poseCfg(pose);

  // Destroy the old controller and create a new one with the pose's capsule.
  if (playerController) {
    physicsApi.destroyCharacterController(playerController);
  }
  playerController = physicsApi.createCharacterController({
    offset: [0, 0.01, 0],
    radius: cfg.radius,
    halfHeight: capsuleHalfHeight(pose),
    slide: true,
    autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.5 },
    maxSlope: Math.PI / 3,
    minSlopeSlide: Math.PI / 4,
    snapToGround: 0.1,
    applyImpulsesToDynamicBodies: true,
    parentless: {
      position: [playerPos[0], playerPos[1] + capsuleYOffset(pose), playerPos[2]],
    },
  }, { index: 0xFFFE, generation: 0 });

  events.emit("pose_changed", { pose, eyeHeight: cfg.eyeHeight });
}

// ── Player health: apply damage, regen, respawn ──
// `applyDamage` is the single entry point for both fall and prop-collision
// damage. It clamps health, records the damage time (suppressing regen), emits
// player_damaged, and transitions to the dead state + emits player_died when
// health hits 0. No-op while already dead (prevents post-death stacking).
function applyDamage(amount: number, cause: "fall" | "prop"): void {
  if (playerDead || amount <= 0) return;
  // Track overkill (damage beyond what was needed to reach 0) before
  // clamping. Uncapped damage means a massive hit can produce large overkill,
  // available to future systems (gibbing, armor penetration, etc.).
  const overkill = Math.max(0, amount - playerHealth);
  playerHealth = Math.max(0, playerHealth - amount);
  lastDamageTime = simTime;
  events.emit("player_damaged", { health: playerHealth, maxHealth: PLAYER_MAX_HEALTH, amount, cause });
  if (playerHealth <= 0) {
    playerDead = true;
    events.emit("player_died", { cause, overkill });
  }
}

// ── Prop→player collision damage ──
// Runs every tick after the physics step. The player is a parentless
// character collider, so its collisions do NOT appear in getContacts()
// (Rapier character controllers do their own sweep tests). We instead do a
// manual proximity + velocity check: for each non-sleeping prop within
// (playerRadius + propRadius + margin), if the prop is moving toward the
// player above PROP_DAMAGE_MIN_SPEED, apply mass-scaled damage with a
// per-prop cooldown so a single contact doesn't deal damage every tick.
function checkPropCollisionDamage(dt: number): void {
  if (playerDead || !physicsApi) return;
  const px = playerPos[0], py = playerPos[1], pz = playerPos[2];
  // Player collision radius — use the standing capsule radius as the
  // horizontal extent. The capsule is taller than wide, but props hitting the
  // sides are the common case; vertical hits (landing on the player) are also
  // caught because the prop center is within the vertical span.
  const playerR = PLAYER_RADIUS;
  for (const [entityId, record] of propRecords) {
    // Cooldown tick — decrement first so a prop that's been in contact can
    // deal damage again after the window elapses.
    const cd = propDamageCooldowns.get(entityId);
    if (cd !== undefined) {
      if (cd <= dt) propDamageCooldowns.delete(entityId);
      else propDamageCooldowns.set(entityId, cd - dt);
    }
    // Skip sleeping bodies — they can't be moving toward the player.
    if (physicsApi.isSleepingRaw(record.body)) continue;
    physicsApi.getTranslationRaw(record.body, _posOut);
    physicsApi.getLinearVelocityRaw(record.body, _velOut);
    const dx = px - _posOut[0], dy = py - _posOut[1], dz = pz - _posOut[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-4) continue;
    const propR = record.shape === "sphere" ? record.radius : Math.max(record.halfExtents[0], record.halfExtents[1], record.halfExtents[2]);
    if (dist > playerR + propR + 0.15) continue;
    // Velocity of the prop toward the player (positive = approaching).
    const dirX = dx / dist, dirY = dy / dist, dirZ = dz / dist;
    const vToPlayer = _velOut[0] * dirX + _velOut[1] * dirY + _velOut[2] * dirZ;
    if (vToPlayer <= PROP_DAMAGE_MIN_SPEED) continue;
    if (propDamageCooldowns.has(entityId)) continue;
    // Mass gate: light props (bags, small items) can't hurt the player at all.
    // The mass factor is quadratic past the threshold so heavy props are
    // disproportionately dangerous — a 20 kg prop hits ~16× harder than a 5 kg
    // one at the same speed, not 4×. This makes weight the dominant factor.
    if (record.mass < PROP_DAMAGE_MIN_MASS) continue;
    const impactSpeed = vToPlayer - PROP_DAMAGE_MIN_SPEED;
    const massFactor = ((record.mass - PROP_DAMAGE_MIN_MASS) / PROP_DAMAGE_MIN_MASS + 1) ** 2;
    const damage = massFactor * impactSpeed * PROP_DAMAGE_GAIN;
    if (damage > 0) {
      applyDamage(damage, "prop");
      propDamageCooldowns.set(entityId, PROP_DAMAGE_COOLDOWN);
    }
  }
}

// ── Create a physics body for a prop ──
/** Computes the axis-aligned bbox volume of a flat point cloud (stride 3). */
function hullBBoxVolume(vertices: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Math.max(maxX - minX, 0) * Math.max(maxY - minY, 0) * Math.max(maxZ - minZ, 0);
}

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
  entityIndex?: number,
  // Optional convex hull vertices (body-local, already scaled). When present,
  // the collider is a convex hull instead of the placeholder box/sphere.
  hull?: Float32Array,
): { body: PhysicsBody; colliderId: number; shape: number } {
  if (!physicsApi) throw new Error("Physics not initialized");
  const entity: Entity = { index: entityIndex ?? nextSlotIdx, generation: 0 };
  const bodyDesc: BodyDesc = {
    type: "dynamic",
    position,
    rotation,
    mass,
    gravityScale,
    ccdEnabled,
    // Damping helps bodies settle and stop micro-oscillating, which lets
    // Rapier's sleep system put them to sleep after a few frames of inactivity.
    linearDamping: 0.5,
    angularDamping: 0.5,
  };
  const body = physicsApi.createBody(entity, bodyDesc);
  let colliderDesc: ColliderDesc;
  let actualShape: number; // 0=box, 1=sphere, 2=hull
  if (hull && hull.length >= 9 && physicsApi.testConvexHull(hull)) {
    // Convex hull from the mesh-derived point cloud. Density is derived from
    // the hull's bbox volume so the body's mass stays close to the configured
    // value (Rapier computes mass = density × hull volume).
    const vol = hullBBoxVolume(hull);
    colliderDesc = {
      shape: { type: "convex", vertices: hull },
      restitution,
      friction,
      density: mass > 0 && vol > 0 ? mass / vol : 1.0,
    };
    actualShape = 2;
  } else {
    colliderDesc = {
      shape: shape === "box"
        ? { type: "box", halfExtents }
        : { type: "sphere", radius },
      restitution,
      friction,
      density: mass > 0 ? mass / (shape === "box"
        ? (8 * halfExtents[0] * halfExtents[1] * halfExtents[2])
        : (4 / 3 * Math.PI * radius ** 3)) : 1.0,
    };
    actualShape = shape === "sphere" ? 1 : 0;
  }
  const colliderId = physicsApi.addCollider(body, colliderDesc);
  return { body, colliderId, shape: actualShape };
}

// ── Spawn a prop ──
function spawnProp(
  contentId: string,
  position: [number, number, number],
  rotation?: [number, number, number, number],
  physics?: { mass?: number; restitution?: number; friction?: number; gravityScale?: number },
  shape?: "box" | "sphere",
  scale?: number,
  // Stub spawn settings — stored on the record + emitted in prop_spawned but
  // not yet consumed by any system. Threaded through so the asset browser can
  // expose them and future work can pick them up without touching the contract.
  stubs?: { strength?: number; texture?: string; shader?: string },
  squishy?: boolean,
  // Pre-computed hull vertices (body-local, already scaled). When provided
  // (e.g. on restore from save), the hull collider is installed immediately
  // instead of waiting for the renderer's async setPropColliderHull command.
  prebuiltHull?: Float32Array,
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

  const { body, colliderId, shape: actualShape } = createPropBody(position, rot, propShape, [halfExt, halfExt, halfExt], radius, mass, restitution, friction, gravityScale, false, slotIdx, prebuiltHull);

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
  f32[ENT_DATA.SHAPE + ENT.DATA] = actualShape;
  f32[ENT_DATA.SQUISH_AMOUNT + ENT.DATA] = 0;
  f32[ENT_DATA.SQUISH_AXIS + ENT.DATA] = 0;

  simWriter!.setEntityCount(nextSlotIdx);
  simWriter!.markEntityDirty(slotIdx);

  propRecords.set(entityId, {
    contentId, body, colliderId, type: EntityType.Prop, slotIdx,
    shape: propShape, halfExtents: [halfExt, halfExt, halfExt], radius: radius,
    mass, restitution, friction, gravityScale,
    strength: stubs?.strength, texture: stubs?.texture, shader: stubs?.shader,
    squishy: squishy === true,
    hull: prebuiltHull,
  });
  if (squishy === true) {
    squishyPropCount++;
    updateExtractContacts();
  }

  events.emit("prop_spawned", { entityId, contentId, nodeId: 0, position, quaternion: rot, scale: propScale, paintable: true, strength: stubs?.strength, texture: stubs?.texture, shader: stubs?.shader, squishy: squishy === true });
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
  grabbedProps.delete(entityId);
  squishStates.delete(entityId);
  prevVelocities.delete(entityId);
  propDamageCooldowns.delete(entityId);
  if (record.squishy === true) {
    squishyPropCount--;
    updateExtractContacts();
  }
  events.emit("prop_removed", { entityId });
}

// ── Clear all props ──
function clearProps(): void {
  for (const entityId of Array.from(propRecords.keys())) {
    const record = propRecords.get(entityId)!;
    if (physicsApi) physicsApi.destroyBody(record.body);
  }
  propRecords.clear();
  grabbedProps.clear();
  squishStates.clear();
  prevVelocities.clear();
  propDamageCooldowns.clear();
  nextSlotIdx = 0;
  freeSlots.length = 0;
  squishyPropCount = 0;
  updateExtractContacts();
  simWriter!.setEntityCount(0);
}

// ── Set fun mode (recreate bodies with new physics properties) ──
function setFunMode(mode: FunMode): void {
  currentFunMode = mode;
  // Recreating bodies below invalidates active grabs (new bodies are dynamic);
  // drop grab state so the Solid driver doesn't push a fresh body unexpectedly.
  grabbedProps.clear();
  // Squishy mode needs contact manifolds to detect bounces; the default config
  // disables extraction for perf. Toggle it on the backend at runtime. Leaving
  // it on when nothing needs contacts would waste ~43% of step time. This also
  // stays on when individual props are spawned squishy (see updateExtractContacts).
  updateExtractContacts();
  const gravityScale = mode === FunMode.Moon ? 0.16 : mode === FunMode.ZeroG ? 0 : 1.0;
  const restitution = mode === FunMode.Bouncy ? 0.95 : mode === FunMode.Squishy ? 0.7 : 0.3;
  const friction = mode === FunMode.Bouncy ? 0.1 : mode === FunMode.Squishy ? 0.3 : 0.5;

  // Recreate each body with new properties (the engine doesn't expose runtime
  // property setters for restitution/friction/gravityScale).
  for (const record of propRecords.values()) {
    physicsApi!.getTranslationRaw(record.body, _posOut);
    physicsApi!.getRotationRaw(record.body, _rotOut);
    physicsApi!.destroyBody(record.body);
    const rebuilt = createPropBody(_posOut, _rotOut, record.shape, record.halfExtents, record.radius, record.mass, restitution, friction, gravityScale, false, record.slotIdx, record.hull);
    record.body = rebuilt.body;
    record.colliderId = rebuilt.colliderId;
    record.restitution = restitution;
    record.friction = friction;
    record.gravityScale = gravityScale;

    const f32 = simWriter!.getEntityF32(record.slotIdx);
    const u32 = simWriter!.getEntityU32(record.slotIdx);
    u32[ENT.PARENT_ID] = record.body.id;
    f32[ENT_DATA.RESTITUTION + ENT.DATA] = restitution;
    f32[ENT_DATA.FRICTION + ENT.DATA] = friction;
    f32[ENT_DATA.GRAVITY_SCALE + ENT.DATA] = gravityScale;
    f32[ENT_DATA.SHAPE + ENT.DATA] = rebuilt.shape;
    simWriter!.markEntityDirty(record.slotIdx);
  }
  events.emit("fun_mode_changed", { mode });
}

/** Set the player's model id and notify the renderer so it loads the model. */
function setPlayerModel(modelId: string): void {
  playerModelId = modelId;
  events.emit("player_model_changed", { modelId });
}

// ── Process sim commands from renderer ──
function processCommand(cmd: SimCommand): void {
  switch (cmd.type) {
    case "spawn":
      spawnProp(cmd.contentId, cmd.position, cmd.rotation, cmd.physics, cmd.shape, cmd.scale, { strength: cmd.strength, texture: cmd.texture, shader: cmd.shader }, cmd.squishy);
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
    case "setPose":
      applyPose(cmd.pose);
      break;
    case "setTool":
      // Tool selection is renderer-side only; no sim action needed
      break;
    case "setPlayerModel":
      setPlayerModel(cmd.modelId);
      break;
    case "fireWeapon": {
      // Spawn a projectile — entityId = slotIdx + 1 (same invariant as props)
      const slotIdx = freeSlots.length > 0 ? freeSlots.shift()! : nextSlotIdx++;
      const entityId = slotIdx + 1;
      const { body, colliderId } = createPropBody(cmd.origin, [0, 0, 0, 1], "sphere", [0.1, 0.1, 0.1], 0.1, 0.5, 0.5, 0.3, 0.5, true, slotIdx);
      physicsApi!.setLinearVelocityRaw(body, cmd.direction[0] * 50, cmd.direction[1] * 50, cmd.direction[2] * 50, true);

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
        contentId: "projectile", body, colliderId, type: EntityType.Projectile, slotIdx,
        shape: "sphere", halfExtents: [0.1, 0.1, 0.1], radius: 0.1,
        mass: 0.5, restitution: 0.5, friction: 0.3, gravityScale: 0.5,
        lifetime: 5.0, // despawn after 5 seconds
      });
      break;
    }
    case "grabProp": {
      const record = propRecords.get(cmd.entityId);
      if (record && physicsApi) {
        if (cmd.mode === PhysgunMode.Solid) {
          // Keep the body dynamic — the tick loop drives it toward the target
          // via velocity so the physics engine resolves collisions. Wake it so
          // it responds immediately and won't sleep mid-grab.
          physicsApi.wakeUp(record.body);
        } else {
          // Ghost: kinematic + teleport (original behavior — clips through everything).
          physicsApi.setBodyType(record.body, "kinematic");
        }
        grabbedProps.set(cmd.entityId, {
          mode: cmd.mode,
          targetPos: [cmd.origin[0], cmd.origin[1], cmd.origin[2]],
        });
      }
      break;
    }
    case "releaseProp": {
      const record = propRecords.get(cmd.entityId);
      const grab = grabbedProps.get(cmd.entityId);
      if (record && physicsApi) {
        if (grab?.mode === PhysgunMode.Solid) {
          // Preserve current linear velocity so the prop carries momentum from
          // the grab (e.g. a swing-throw). Just ensure it's dynamic.
          physicsApi.setBodyType(record.body, "dynamic");
          physicsApi.wakeUp(record.body);
        } else {
          // Ghost: restore dynamic and apply the supplied release velocity.
          physicsApi.setBodyType(record.body, "dynamic");
          physicsApi.setLinearVelocityRaw(record.body, cmd.velocity[0], cmd.velocity[1], cmd.velocity[2], true);
        }
      }
      grabbedProps.delete(cmd.entityId);
      break;
    }
    case "updateGrab": {
      const record = propRecords.get(cmd.entityId);
      const grab = grabbedProps.get(cmd.entityId);
      if (!record || !physicsApi || !grab) break;
      // Always update the stored target; the tick loop uses it for Solid mode.
      grab.targetPos[0] = cmd.targetPos[0];
      grab.targetPos[1] = cmd.targetPos[1];
      grab.targetPos[2] = cmd.targetPos[2];
      if (grab.mode === PhysgunMode.Ghost) {
        // Ghost: teleport directly (no collision resolution).
        physicsApi.setTranslationRaw(record.body, cmd.targetPos[0], cmd.targetPos[1], cmd.targetPos[2], false);
      }
      // Solid: handled in the tick loop (velocity-based, collision-aware).
      break;
    }
    case "rotateGrab": {
      const record = propRecords.get(cmd.entityId);
      const grab = grabbedProps.get(cmd.entityId);
      if (!record || !physicsApi || !grab) break;
      const [qx, qy, qz, qw] = cmd.quaternion;
      physicsApi.setRotationRaw(record.body, qx, qy, qz, qw, false);
      // Zero angular velocity so collisions can't fight the user's rotation
      // while the prop is being held (notably for Solid/dynamic grabs).
      physicsApi.setAngularVelocityRaw(record.body, 0, 0, 0, false);
      // Mirror into the SAB so the renderer picks up the new orientation
      // without waiting for the next syncTransforms tick.
      const f32 = simWriter!.getEntityF32(record.slotIdx);
      f32[ENT.ROT_X] = qx; f32[ENT.ROT_Y] = qy; f32[ENT.ROT_Z] = qz; f32[ENT.ROT_W] = qw;
      simWriter!.markEntityDirty(record.slotIdx);
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
      physicsApi.getTranslationRaw(record.body, _posOut);
      physicsApi.getRotationRaw(record.body, _rotOut);
      physicsApi.getLinearVelocityRaw(record.body, _velOut);
      physicsApi.destroyBody(record.body);
      const rebuilt = createPropBody(_posOut, _rotOut, record.shape, record.halfExtents, record.radius, newMass, newRestitution, newFriction, newGravityScale, false, undefined, record.hull);
      record.body = rebuilt.body;
      record.colliderId = rebuilt.colliderId;
      record.mass = newMass;
      record.restitution = newRestitution;
      record.friction = newFriction;
      record.gravityScale = newGravityScale;
      physicsApi.setLinearVelocityRaw(record.body, _velOut[0], _velOut[1], _velOut[2], true);
      // Re-apply active grab state — body recreation above resets the body type
      // to dynamic, which would break a Ghost grab (needs kinematic).
      const grab = grabbedProps.get(cmd.entityId);
      if (grab && grab.mode === PhysgunMode.Ghost) {
        physicsApi.setBodyType(record.body, "kinematic");
      }
      // Update SAB
      const f32 = simWriter!.getEntityF32(record.slotIdx);
      const u32 = simWriter!.getEntityU32(record.slotIdx);
      u32[ENT.PARENT_ID] = record.body.id;
      f32[ENT_DATA.MASS + ENT.DATA] = newMass;
      f32[ENT_DATA.RESTITUTION + ENT.DATA] = newRestitution;
      f32[ENT_DATA.FRICTION + ENT.DATA] = newFriction;
      f32[ENT_DATA.GRAVITY_SCALE + ENT.DATA] = newGravityScale;
      f32[ENT_DATA.SHAPE + ENT.DATA] = rebuilt.shape;
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
    case "movePlayer": {
      // Accumulate rather than overwrite: the renderer's moveLoop (~62Hz) can
      // send two commands between 60Hz sim ticks, and dropping one causes
      // visible stutter. Gravity is already baked into each delta (vy*dt), so
      // summing is correct — each command covered its own wall-clock slice.
      if (pendingPlayerMove) {
        pendingPlayerMove[0] += cmd.desiredDelta[0];
        pendingPlayerMove[1] += cmd.desiredDelta[1];
        pendingPlayerMove[2] += cmd.desiredDelta[2];
      } else {
        pendingPlayerMove = [...cmd.desiredDelta];
      }
      if (cmd.verticalVelocity !== undefined) {
        pendingPlayerFallVy = Math.min(pendingPlayerFallVy ?? 0, cmd.verticalVelocity);
      }
      break;
    }
    case "setPropColliderHull": {
      // The renderer derived a convex hull from the loaded mesh and is asking
      // us to swap the placeholder box/sphere collider for a convex one. We
      // test whether Rapier can actually build a convex hull from these
      // vertices (it returns null for degenerate/coplanar input and falls
      // back to a 0.5m ball — which would NOT match the mesh). If the test
      // fails, we keep the placeholder box and write shape=0 to the SAB so
      // the debug overlay shows the truth. The SAB SHAPE field is the single
      // source of truth for what collider is actually in use.
      const record = propRecords.get(cmd.entityId);
      if (!record || !physicsApi) break;
      // If the prop already has a hull (e.g. restored from save), skip the
      // async re-swap — the hull is already installed and authoritative.
      if (record.hull && record.hull.length >= 9) {
        // Verify the live collider is still a hull; if so, nothing to do.
        const liveType = physicsApi.getColliderShapeType(record.body, record.colliderId);
        if (liveType === 9) break;
        // If the live collider isn't a hull (somehow), fall through and re-swap.
      }
      const verts = cmd.vertices instanceof Float32Array
        ? cmd.vertices
        : new Float32Array(cmd.vertices);
      if (verts.length < 9) break; // need at least 3 points
      // Test if Rapier can build a convex hull from these vertices.
      if (!physicsApi.testConvexHull(verts)) {
        // Rapier can't build a convex hull from these vertices (degenerate/coplanar).
        // Keep the placeholder; ensure SAB reflects the placeholder shape.
        const f32 = simWriter!.getEntityF32(record.slotIdx);
        f32[ENT_DATA.SHAPE + ENT.DATA] = record.shape === "sphere" ? 1 : 0;
        break;
      }
      record.hull = verts;
      const oldColliderId = record.colliderId;
      physicsApi.removeCollider(record.body, oldColliderId);
      const vol = hullBBoxVolume(verts);
      const newColliderId = physicsApi.addCollider(record.body, {
        shape: { type: "convex", vertices: verts },
        restitution: record.restitution,
        friction: record.friction,
        density: record.mass > 0 && vol > 0 ? record.mass / vol : 1.0,
      });
      record.colliderId = newColliderId;
      // Verify the live Rapier collider is actually a convex polyhedron.
      // Only write shape=2 to the SAB if Rapier installed a ConvexPolyhedron
      // (type 9) and there's exactly one collider. If the swap failed or
      // Rapier fell back to a ball, revert to the placeholder shape so the
      // debug overlay shows the truth.
      const newShapeType = physicsApi.getColliderShapeType(record.body, newColliderId);
      const newCount = physicsApi.getColliderCount(record.body);
      const f32 = simWriter!.getEntityF32(record.slotIdx);
      if (newShapeType === 9 && newCount === 1) {
        f32[ENT_DATA.SHAPE + ENT.DATA] = 2;
      } else {
        f32[ENT_DATA.SHAPE + ENT.DATA] = record.shape === "sphere" ? 1 : 0;
        console.warn(`[Hull] entity ${cmd.entityId}: swap failed (shapeType=${newShapeType}, count=${newCount}) — keeping placeholder`);
      }
      physicsApi.wakeUp(record.body);
      break;
    }
    case "respawn": {
      // Reset health + dead state and teleport the player back to the spawn
      // origin. Clear fall-speed tracking and per-prop damage cooldowns so the
      // respawned player isn't immediately re-damaged by props still in
      // contact. Emit player_respawned + a player_moved so the renderer snaps
      // the camera to the spawn position.
      playerHealth = PLAYER_MAX_HEALTH;
      playerDead = false;
      playerFallSpeed = 0;
      playerPrevGrounded = true;
      lastDamageTime = simTime;
      propDamageCooldowns.clear();
      playerPos[0] = 0;
      playerPos[1] = PLAYER_HEIGHT;
      playerPos[2] = 0;
      if (playerController && physicsApi) {
        physicsApi.setCharacterColliderPosition(playerController, [
          playerPos[0],
          playerPos[1] + capsuleYOffset(currentPose),
          playerPos[2],
        ]);
      }
      events.emit("player_respawned", { health: playerHealth, maxHealth: PLAYER_MAX_HEALTH });
      onEvent({ kind: "player_moved", data: { position: [...playerPos] as [number, number, number], grounded: playerGrounded, pose: currentPose, health: playerHealth, maxHealth: PLAYER_MAX_HEALTH, dead: playerDead } });
      break;
    }
  }
}

// ── Drive Solid-mode physgun grabs toward their target ──
// Velocity-based P controller: set linear velocity toward the target each tick.
// The physics step then moves the body and resolves collisions, so the grabbed
// prop can't clip through walls or other objects. Setting velocity fresh each
// tick also counteracts gravity (no cumulative droop). Angular velocity is left
// untouched so collisions can spin the prop naturally.
const SOLID_GRAB_GAIN = 12.0;   // velocity = delta * gain
const SOLID_GRAB_MAX_SPEED = 40.0; // m/s cap
function driveSolidGrabs(_dt: number): void {
  if (!physicsApi) return;
  for (const [entityId, grab] of grabbedProps) {
    if (grab.mode !== PhysgunMode.Solid) continue;
    const record = propRecords.get(entityId);
    if (!record) continue;
    physicsApi.getTranslationRaw(record.body, _posOut);
    const dx = grab.targetPos[0] - _posOut[0];
    const dy = grab.targetPos[1] - _posOut[1];
    const dz = grab.targetPos[2] - _posOut[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-4) {
      // At target — kill linear velocity so it hovers in place.
      physicsApi.setLinearVelocityRaw(record.body, 0, 0, 0, true);
      continue;
    }
    let vx = dx * SOLID_GRAB_GAIN;
    let vy = dy * SOLID_GRAB_GAIN;
    let vz = dz * SOLID_GRAB_GAIN;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > SOLID_GRAB_MAX_SPEED) {
      const s = SOLID_GRAB_MAX_SPEED / speed;
      vx *= s; vy *= s; vz *= s;
    }
    physicsApi.setLinearVelocityRaw(record.body, vx, vy, vz, true);
  }
}

// ── Sync physics transforms back to SAB ──
// Hot path: runs every tick for every prop. Uses the Raw scalar API with
// reused out-tuples to avoid per-entity tuple allocation + spread copies,
// and skips sleeping bodies (no transform changes while asleep).
function syncTransforms(): void {
  if (!physicsApi || !simWriter) return;
  const api = physicsApi;
  const writer = simWriter;
  for (const record of propRecords.values()) {
    // Skip sleeping bodies — their transforms don't change.
    if (api.isSleepingRaw(record.body)) continue;

    // Raw scalar reads into reused out-tuples (zero allocation).
    api.getTranslationRaw(record.body, _posOut);
    api.getRotationRaw(record.body, _rotOut);
    api.getLinearVelocityRaw(record.body, _velOut);

    const f32 = writer.getEntityF32(record.slotIdx);
    f32[ENT.POS_X] = _posOut[0];
    f32[ENT.POS_Y] = _posOut[1];
    f32[ENT.POS_Z] = _posOut[2];
    f32[ENT.ROT_X] = _rotOut[0];
    f32[ENT.ROT_Y] = _rotOut[1];
    f32[ENT.ROT_Z] = _rotOut[2];
    f32[ENT.ROT_W] = _rotOut[3];
    f32[ENT.VEL_X] = _velOut[0];
    f32[ENT.VEL_Y] = _velOut[1];
    f32[ENT.VEL_Z] = _velOut[2];

    writer.markEntityDirty(record.slotIdx);
  }
}

// ── Squish: detect bounce impacts from contacts and drive per-prop deformation ──
// Runs every tick. The spring integration always runs (so a prop never freezes
// deformed when switching out of Squishy / removing its squishy flag); the
// contact-detection portion only runs while squish is active (global Squishy
// fun mode OR any spawned squishy prop), where extractContacts is enabled.
function updateSquish(dt: number): void {
  // Integrate the spring for existing squish states (always — smooth recovery
  // even after leaving Squishy mode). Settled states zero their SAB slots so
  // the renderer stops deforming the prop.
  if (squishStates.size > 0) {
    for (const [entityId, state] of squishStates) {
      // Semi-implicit Euler — stable for stiff springs at dt=1/60.
      state.velocity += (-SQUISH_K * state.amount - SQUISH_C * state.velocity) * dt;
      state.amount += state.velocity * dt;
      // Clamp the compression cap. Let negative values (stretch/wobble) pass —
      // the renderer handles them and they give the jelly overshoot feel.
      if (state.amount > SQUISH_MAX) {
        state.amount = SQUISH_MAX;
        if (state.velocity > 0) state.velocity = 0;
      }
      // Settled — remove and zero the SAB so the prop returns to rest.
      if (Math.abs(state.amount) < 0.005 && Math.abs(state.velocity) < 0.05) {
        squishStates.delete(entityId);
        const record = propRecords.get(entityId);
        if (record && simWriter) {
          const f32 = simWriter.getEntityF32(record.slotIdx);
          f32[ENT_DATA.SQUISH_AMOUNT + ENT.DATA] = 0;
          f32[ENT_DATA.SQUISH_AXIS + ENT.DATA] = 0;
          simWriter.markEntityDirty(record.slotIdx);
        }
        continue;
      }
      // Write the animated value to the SAB each tick. The axis slot stores a
      // signed code (dir * (axis+1)) so the renderer knows which face was hit.
      const record = propRecords.get(entityId);
      if (record && simWriter) {
        const f32 = simWriter.getEntityF32(record.slotIdx);
        f32[ENT_DATA.SQUISH_AMOUNT + ENT.DATA] = state.amount;
        f32[ENT_DATA.SQUISH_AXIS + ENT.DATA] = state.dir * (state.axis + 1);
        simWriter.markEntityDirty(record.slotIdx);
      }
    }
  }

  if (!squishActive() || !physicsApi || !simWriter) return;

  // Read the fresh contact manifolds produced by this step.
  const contacts = physicsApi.getContacts();
  if (contacts.length > 0) {
    for (const manifold of contacts) {
      const nx = manifold.normal[0], ny = manifold.normal[1], nz = manifold.normal[2];
      // normal points A→B. Each side may be a prop; handle both so prop↔ground
      // and prop↔prop collisions both squish the dynamic participants.
      applySquishImpact(manifold.entityA.index + 1, nx, ny, nz, +1);
      applySquishImpact(manifold.entityB.index + 1, nx, ny, nz, -1);
    }
  }
}

/** Compute impact speed along the normal and give the spring a velocity impulse. */
function applySquishImpact(
  entityId: number,
  nx: number, ny: number, nz: number,
  normalSign: number, // +1 if this entity is A (normal points away), -1 if B
): void {
  const record = propRecords.get(entityId);
  if (!record || !physicsApi || !simWriter) return;
  // Only deform props that are squishy (per-prop flag) or when the global
  // Squishy fun mode is forcing all props to be jelly.
  if (!propIsSquishy(record)) return;
  const prevVel = prevVelocities.get(entityId);
  if (!prevVel) return;
  // Pre-step velocity along the normal, signed so positive = moving into the
  // other body (the impact that caused this contact).
  const vDotN = prevVel[0] * nx + prevVel[1] * ny + prevVel[2] * nz;
  const impactSpeed = normalSign * vDotN;
  if (impactSpeed < SQUISH_MIN_IMPACT) return;

  // Velocity impulse — the spring will compress over several frames (animated
  // onset), peak, then spring back with a slight overshoot wobble.
  const impulse = (impactSpeed - SQUISH_MIN_IMPACT) * SQUISH_IMPULSE_GAIN;

  // Transform the world-space contact normal into the prop's local frame
  // (n_local = q^-1 · n_world) and pick the dominant local axis to compress.
  physicsApi.getRotationRaw(record.body, _rotOut);
  const qx = _rotOut[0], qy = _rotOut[1], qz = _rotOut[2], qw = _rotOut[3];
  // Conjugate (inverse for a unit quaternion).
  const ux = -qx, uy = -qy, uz = -qz, us = qw;
  const uu = ux * ux + uy * uy + uz * uz;
  const dot = ux * nx + uy * ny + uz * nz;
  const cx = uy * nz - uz * ny;
  const cy = uz * nx - ux * nz;
  const cz = ux * ny - uy * nx;
  const lnx = 2 * dot * ux + (us * us - uu) * nx + 2 * us * cx;
  const lny = 2 * dot * uy + (us * us - uu) * ny + 2 * us * cy;
  const lnz = 2 * dot * uz + (us * us - uu) * nz + 2 * us * cz;
  const ax = Math.abs(lnx), ay = Math.abs(lny), az = Math.abs(lnz);
  const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  // Impact-side sign along the axis, in the prop's local frame. The contact
  // normal points A→B: for entity A it points toward A's impact face, for
  // entity B it points into B from its impact face (opposite). normalSign
  // flips the sense so `dir` is consistently the side that was hit.
  const lnDom = axis === 0 ? lnx : axis === 1 ? lny : lnz;
  const dir = normalSign * (lnDom >= 0 ? 1 : -1);

  // Add the impulse to the existing state (accumulate rapid impacts). If the
  // axis or impact side changed (hit from a different direction), reset.
  const existing = squishStates.get(entityId);
  if (existing && existing.axis === axis && existing.dir === dir) {
    existing.velocity += impulse;
  } else {
    squishStates.set(entityId, { amount: existing?.amount ?? 0, velocity: impulse, axis, dir });
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
      squishy: record.squishy === true,
      // Save the hull vertices so restore can install the hull collider
      // immediately instead of waiting for the async setPropColliderHull
      // round-trip through the renderer.
      hull: record.hull ? Array.from(record.hull) : undefined,
    });
  }
  return JSON.stringify({ props, funMode: currentFunMode, pose: currentPose, playerPos: [...playerPos], health: playerHealth, dead: playerDead, playerModel: playerModelId, version: 2 });
}

async function restoreState(stateJson: string): Promise<void> {
  const state = JSON.parse(stateJson);
  if (!state || typeof state !== "object") return;
  clearProps();
  if (state.funMode !== undefined) currentFunMode = state.funMode;
  if (state.pose !== undefined) applyPose(state.pose);
  // Restore player health + dead state. Old saves without these fields default
  // to full health / not dead. Reset fall-damage tracking + cooldowns so a
  // loaded dead player isn't immediately re-damaged on respawn.
  playerHealth = typeof state.health === "number" ? state.health : PLAYER_MAX_HEALTH;
  playerDead = state.dead === true;
  playerFallSpeed = 0;
  playerPrevGrounded = true;
  lastDamageTime = simTime;
  propDamageCooldowns.clear();
  // Restore player position + sync the Rapier character controller so the
  // next characterMove tick continues from the saved spot instead of the
  // spawn origin. Emit player_moved so the renderer repositions the camera.
  if (state.playerPos !== undefined) {
    playerPos[0] = state.playerPos[0];
    playerPos[1] = state.playerPos[1];
    playerPos[2] = state.playerPos[2];
    if (playerController && physicsApi) {
      physicsApi.setCharacterColliderPosition(playerController, [
        playerPos[0],
        playerPos[1] + capsuleYOffset(currentPose),
        playerPos[2],
      ]);
    }
    onEvent({ kind: "player_moved", data: { position: [...playerPos] as [number, number, number], grounded: playerGrounded, pose: currentPose, health: playerHealth, maxHealth: PLAYER_MAX_HEALTH, dead: playerDead } });
  }
  // Restore the player's chosen model id and notify the renderer so it loads
  // the correct avatar. Old saves (version 1) without this field keep the default.
  if (typeof state.playerModel === "string" && state.playerModel) {
    playerModelId = state.playerModel;
    events.emit("player_model_changed", { modelId: playerModelId });
  }
  for (const prop of state.props ?? []) {
    spawnProp(
      prop.contentId, prop.position, prop.quaternion,
      { mass: prop.mass, restitution: prop.restitution, friction: prop.friction, gravityScale: prop.gravityScale },
      prop.shape,
      prop.scale,
      undefined,
      prop.squishy === true,
      // Restore the saved hull so the convex collider is installed
      // immediately — no async round-trip through the renderer.
      prop.hull ? new Float32Array(prop.hull) : undefined,
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
        // Accumulate sim time for health-regen delay + per-prop damage cooldowns.
        simTime += dt;
        // Drive Solid-mode physgun grabs toward their target via velocity so
        // the physics step resolves collisions (the prop can't clip through
        // walls). Runs before stepNearRealm so the velocity is applied this tick.
        if (physicsApi && grabbedProps.size > 0) driveSolidGrabs(dt);
        // Snapshot pre-step velocities so the post-step contact pass can compute
        // the pre-bounce impact speed (after step(), velocities are resolved).
        if (physicsApi && squishActive()) {
          for (const [eid, rec] of propRecords) {
            physicsApi.getLinearVelocityRaw(rec.body, _velOut);
            prevVelocities.set(eid, [_velOut[0], _velOut[1], _velOut[2]]);
          }
        }
        if (physicsApi) physicsApi.stepNearRealm(dt);
        // Squish: decay existing deformation (always) and detect new bounces
        // from the fresh contacts (Squishy mode only).
        updateSquish(dt);
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

        // Process player movement via Rapier character controller
        if (playerController && physicsApi && pendingPlayerMove) {
          physicsApi.setCharacterColliderPosition(playerController, [
            playerPos[0],
            playerPos[1] + capsuleYOffset(currentPose),
            playerPos[2],
          ]);
          const result = physicsApi.characterMove(playerController, pendingPlayerMove, dt);
          playerPos[0] += result.effectiveMovement[0];
          playerPos[1] += result.effectiveMovement[1];
          playerPos[2] += result.effectiveMovement[2];
          playerGrounded = result.grounded;

          // ── Fall damage ──
          // Track peak downward speed while airborne using the intended
          // vertical move this tick (pendingPlayerMove[1] / dt). On the
          // airborne→grounded landing transition, if the peak exceeded the
          // threshold, apply damage scaled by the overshoot. Reset on landing
          // so a single fall deals one burst.
          if (!playerGrounded) {
            const fallVy = pendingPlayerFallVy ?? pendingPlayerMove[1] / dt;
            if (fallVy < 0 && fallVy < -playerFallSpeed) playerFallSpeed = -fallVy;
          } else if (!playerPrevGrounded) {
            // Just landed.
            if (playerFallSpeed > FALL_DAMAGE_MIN_SPEED) {
              applyDamage((playerFallSpeed - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_GAIN, "fall");
            }
            playerFallSpeed = 0;
          }
          playerPrevGrounded = playerGrounded;

          pendingPlayerMove = null;
          pendingPlayerFallVy = null;
          onEvent({ kind: "player_moved", data: { position: [...playerPos] as [number, number, number], grounded: playerGrounded, pose: currentPose, health: playerHealth, maxHealth: PLAYER_MAX_HEALTH, dead: playerDead } });
        }

        // ── Prop→player collision damage ──
        // Manual proximity + velocity check (the player's parentless character
        // collider doesn't appear in getContacts()). Skips sleeping bodies.
        checkPropCollisionDamage(dt);

        // ── Health regen ──
        // Slowly regenerate after a damage-free delay. No-op while dead or
        // already at max.
        if (!playerDead && playerHealth < PLAYER_MAX_HEALTH && (simTime - lastDamageTime) >= HEALTH_REGEN_DELAY) {
          playerHealth = Math.min(PLAYER_MAX_HEALTH, playerHealth + HEALTH_REGEN_RATE * dt);
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
    const rawJson = saveState();
    const parsed = JSON.parse(rawJson);
    // Always wrap in SaveState.components.sandbox.{ v, data } format so that
    // both OPFS and IPC (FileSaveStore) backends store the state in the
    // expected component format. FileSaveStore.load() expects each component
    // to have { v, data } structure — sending the raw game state as components
    // corrupts it (each field becomes { v: undefined, data: undefined }).
    const saveStateObj: SaveState = {
      components: { sandbox: { v: 1, data: parsed } },
      meta: {
        engineVersion: "0.1.0",
        timestamp: Date.now() / 1000,
        entityCount: parsed.props?.length ?? 0,
        playerCount: 1,
      },
    };
    const stateJson = JSON.stringify(saveStateObj.components);
    if (opfsStore) {
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
    // Handle wrapped stateJson (SaveState.components format) by extracting
    // the sandbox component data.
    try {
      const parsed = JSON.parse(json);
      if (parsed?.sandbox?.data) {
        json = JSON.stringify(parsed.sandbox.data);
      }
    } catch { /* not JSON, use as-is */ }
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
