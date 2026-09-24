import type {
    BodyDesc,
    BodyType,
    CharacterControllerDesc,
    CharacterControllerHandle,
    CharacterMoveResult,
    ColliderDesc,
    ColliderShape,
    ContactManifold,
    Entity,
    IntersectionPair,
    IslandInfo,
    JointDesc,
    PhysicsBackend,
    PhysicsBody,
    PhysicsRealmConfig,
    RaycastResult,
    ShapeCastResult,
} from "@downdraft/engine";
import { loadPhysicsLib, type PhysicsLib } from "./rapier-backend";

interface RealmState {
  id: number;
  config: PhysicsRealmConfig;
  bodies: Map<number, BodyState>;
  nextBodyId: number;
  contacts: ContactManifold[];
  intersections: IntersectionPair[];
  nextControllerId: number;
  nextJointId: number;
  /** Scratch buffers for the batched awake-body readback path in step(). */
  readbackIds: Uint32Array;
  readbackStates: Float32Array;
}

interface BodyState {
  body: PhysicsBody;
  desc: BodyDesc;
  colliders: Map<number, ColliderDesc>;
  nextColliderId: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  sleeping: boolean;
}

export class RapierPhysicsBackend implements PhysicsBackend {
  readonly name: string = "rapier";
  readonly version: string = "0.2.0";

  private lib: PhysicsLib | null = null;
  private readonly libFactory?: () => Promise<PhysicsLib>;
  private realms: Map<number, RealmState> = new Map();
  private realmIds: number[] = [];
  private nextRealmId = 1;
  private destroyed = false;

  /**
   * Step options — set by UniversalPhysicsAPI from PhysicsModuleConfig.
   * Games that don't read contacts/intersections set extractContacts=false
   * to skip the expensive WASM↔JS callback traversal in step().
   * Games that read transforms via the Raw API set readBackTransformsOnStep=false
   * to skip redundant high-level transform readback.
   */
  extractContacts = true;
  readBackTransformsOnStep = true;

  /**
   * @param libFactory — override the PhysicsLib source. Defaults to the WASM
   * Rapier bundle; the native runtime passes `loadFfiPhysicsLib` from
   * `./ffi-lib` to drive the Rust cdylib instead.
   */
  constructor(libFactory?: () => Promise<PhysicsLib>) {
    this.libFactory = libFactory;
  }

  async init(): Promise<void> {
    if (this.lib) return;
    this.lib = await (this.libFactory ? this.libFactory() : loadPhysicsLib());
  }

  private ensureLib(): PhysicsLib {
    if (!this.lib) {
      throw new Error("RapierPhysicsBackend not initialized. Call init() first.");
    }
    return this.lib;
  }

  createRealm(config: PhysicsRealmConfig): number {
    const id = config.id ?? this.nextRealmId++;
    const realm: RealmState = {
      id,
      config,
      bodies: new Map(),
      nextBodyId: 1,
      contacts: [],
      intersections: [],
      nextControllerId: 1,
      nextJointId: 1,
      readbackIds: new Uint32Array(0),
      readbackStates: new Float32Array(0),
 };
    this.realms.set(id, realm);
    this.realmIds.push(id);

    if (this.lib) {
      this.lib.createRealm(id, config.gravity);
    }
    return id;
  }

  destroyRealm(realmId: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    if (this.lib) {
      this.lib.destroyRealm(realmId);
    }
    realm.bodies.clear();
    this.realms.delete(realmId);
    this.realmIds = this.realmIds.filter((id) => id !== realmId);
  }

  getRealmIds(): number[] {
    return [...this.realmIds];
  }

  createBody(realmId: number, desc: BodyDesc, entity: Entity): PhysicsBody {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);

    const bodyId = realm.nextBodyId++;
    const body: PhysicsBody = { id: bodyId, realmId, entity };

    const state: BodyState = {
      body,
      desc,
      colliders: new Map(),
      nextColliderId: 1,
      position: [...desc.position] as [number, number, number],
      rotation: [...desc.rotation] as [number, number, number, number],
      linearVelocity: [...(desc.linearVelocity ?? [0, 0, 0])] as [number, number, number],
      angularVelocity: [...(desc.angularVelocity ?? [0, 0, 0])] as [number, number, number],
      sleeping: desc.sleeping ?? false,
    };

    realm.bodies.set(bodyId, state);

    if (this.lib) {
      this.lib.createBody(realmId, bodyId, desc, entity);
    }

    return body;
  }

  destroyBody(body: PhysicsBody): void {
    const realm = this.realms.get(body.realmId);
    if (!realm) return;
    if (this.lib) {
      this.lib.destroyBody(body.realmId, body.id);
    }
    realm.bodies.delete(body.id);
  }

  setBodyType(body: PhysicsBody, type: BodyType): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.desc.type = type;
    if (this.lib) {
      this.lib.setBodyType(body.realmId, body.id, type);
    }
  }

  addCollider(body: PhysicsBody, desc: ColliderDesc): number {
    const state = this.getBodyState(body);
    if (!state) return -1;
    const id = state.nextColliderId++;
    state.colliders.set(id, desc);
    if (this.lib) {
      this.lib.addCollider(body.realmId, body.id, id, desc);
    }
    return id;
  }

  removeCollider(body: PhysicsBody, colliderId: number): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.colliders.delete(colliderId);
    if (this.lib) {
      this.lib.removeCollider(body.realmId, body.id, colliderId);
    }
  }

  testConvexHull(vertices: Float32Array): boolean {
    if (!this.lib?.testConvexHull) return false;
    return this.lib.testConvexHull(vertices);
  }

  getColliderShapeType(body: PhysicsBody, colliderId: number): number {
    if (!this.lib?.getColliderShapeType) return -1;
    return this.lib.getColliderShapeType(body.realmId, colliderId);
  }

  getColliderCount(body: PhysicsBody): number {
    if (!this.lib?.getColliderCount) return -1;
    return this.lib.getColliderCount(body.realmId, body.id);
  }

  setColliderPosition(realmId: number, colliderId: number, pos: [number, number, number]): void {
    if (this.lib && this.lib.setColliderPosition) {
      this.lib.setColliderPosition(realmId, colliderId, pos);
    }
  }

  getColliderPosition(realmId: number, colliderId: number): [number, number, number] {
    if (this.lib && this.lib.getColliderPosition) {
      return this.lib.getColliderPosition(realmId, colliderId);
    }
    return [0, 0, 0];
  }

  applyForce(body: PhysicsBody, force: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state || state.desc.type !== "dynamic") return;
    if (this.lib) {
      this.lib.applyForce(body.realmId, body.id, force);
    }
  }

  applyImpulse(body: PhysicsBody, impulse: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state || state.desc.type !== "dynamic") return;
    state.linearVelocity[0] += impulse[0] / (state.desc.mass ?? 1);
    state.linearVelocity[1] += impulse[1] / (state.desc.mass ?? 1);
    state.linearVelocity[2] += impulse[2] / (state.desc.mass ?? 1);
    if (this.lib) {
      this.lib.applyImpulse(body.realmId, body.id, impulse);
    }
  }

  applyTorque(body: PhysicsBody, torque: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state || state.desc.type !== "dynamic") return;
    if (this.lib) {
      this.lib.applyTorque(body.realmId, body.id, torque);
    }
  }

  applyTorqueImpulse(body: PhysicsBody, impulse: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state || state.desc.type !== "dynamic") return;
    state.angularVelocity[0] += impulse[0];
    state.angularVelocity[1] += impulse[1];
    state.angularVelocity[2] += impulse[2];
    if (this.lib) {
      this.lib.applyTorqueImpulse(body.realmId, body.id, impulse);
    }
  }

  applyImpulseAtPoint(
    body: PhysicsBody,
    impulse: [number, number, number],
    point: [number, number, number],
  ): void {
    const state = this.getBodyState(body);
    if (!state || state.desc.type !== "dynamic") return;
    state.linearVelocity[0] += impulse[0] / (state.desc.mass ?? 1);
    state.linearVelocity[1] += impulse[1] / (state.desc.mass ?? 1);
    state.linearVelocity[2] += impulse[2] / (state.desc.mass ?? 1);
    if (this.lib) {
      this.lib.applyImpulseAtPoint(body.realmId, body.id, impulse, point);
    }
  }

  setLinearVelocity(body: PhysicsBody, vel: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.linearVelocity = [...vel] as [number, number, number];
    if (this.lib) {
      this.lib.setLinearVelocity(body.realmId, body.id, vel);
    }
  }

  getLinearVelocity(body: PhysicsBody): [number, number, number] {
    const state = this.getBodyState(body);
    return state ? [...state.linearVelocity] as [number, number, number] : [0, 0, 0];
  }

  setAngularVelocity(body: PhysicsBody, vel: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.angularVelocity = [...vel] as [number, number, number];
    if (this.lib) {
      this.lib.setAngularVelocity(body.realmId, body.id, vel);
    }
  }

  getAngularVelocity(body: PhysicsBody): [number, number, number] {
    const state = this.getBodyState(body);
    return state ? [...state.angularVelocity] as [number, number, number] : [0, 0, 0];
  }

  setPosition(body: PhysicsBody, pos: [number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.position = [...pos] as [number, number, number];
    if (this.lib) {
      this.lib.setPosition(body.realmId, body.id, pos);
    }
  }

  getPosition(body: PhysicsBody): [number, number, number] {
    const state = this.getBodyState(body);
    return state ? [...state.position] as [number, number, number] : [0, 0, 0];
  }

  setRotation(body: PhysicsBody, rot: [number, number, number, number]): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.rotation = [...rot] as [number, number, number, number];
    if (this.lib) {
      this.lib.setRotation(body.realmId, body.id, rot);
    }
  }

  getRotation(body: PhysicsBody): [number, number, number, number] {
    const state = this.getBodyState(body);
    return state ? [...state.rotation] as [number, number, number, number] : [0, 0, 0, 1];
  }

  wakeUp(body: PhysicsBody): void {
    const state = this.getBodyState(body);
    if (!state) return;
    state.sleeping = false;
    if (this.lib) {
      this.lib.wakeUp(body.realmId, body.id);
    }
  }

  isSleeping(body: PhysicsBody): boolean {
    const state = this.getBodyState(body);
    return state ? state.sleeping : false;
  }

  // --- Raw fast paths ---

  setTranslationRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean): void {
    const state = this.getBodyState(body);
    if (state) {
      state.position[0] = x; state.position[1] = y; state.position[2] = z;
    }
    if (this.lib && this.lib.setTranslationRaw) {
      this.lib.setTranslationRaw(body.realmId, body.id, x, y, z, wakeUp);
    } else if (this.lib) {
      this.lib.setPosition(body.realmId, body.id, [x, y, z]);
    }
  }

  setRotationRaw(body: PhysicsBody, x: number, y: number, z: number, w: number, wakeUp: boolean): void {
    const state = this.getBodyState(body);
    if (state) {
      state.rotation[0] = x; state.rotation[1] = y; state.rotation[2] = z; state.rotation[3] = w;
    }
    if (this.lib && this.lib.setRotationRaw) {
      this.lib.setRotationRaw(body.realmId, body.id, x, y, z, w, wakeUp);
    } else if (this.lib) {
      this.lib.setRotation(body.realmId, body.id, [x, y, z, w]);
    }
  }

  getTranslationRaw(body: PhysicsBody, out: [number, number, number]): void {
    if (this.lib && this.lib.getTranslationRaw) {
      this.lib.getTranslationRaw(body.realmId, body.id, out);
    } else {
      const state = this.getBodyState(body);
      if (state) { out[0] = state.position[0]; out[1] = state.position[1]; out[2] = state.position[2]; }
      else { out[0] = 0; out[1] = 0; out[2] = 0; }
    }
  }

  getRotationRaw(body: PhysicsBody, out: [number, number, number, number]): void {
    if (this.lib && this.lib.getRotationRaw) {
      this.lib.getRotationRaw(body.realmId, body.id, out);
    } else {
      const state = this.getBodyState(body);
      if (state) { out[0] = state.rotation[0]; out[1] = state.rotation[1]; out[2] = state.rotation[2]; out[3] = state.rotation[3]; }
      else { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; }
    }
  }

  getLinearVelocityRaw(body: PhysicsBody, out: [number, number, number]): void {
    if (this.lib && this.lib.getLinearVelocityRaw) {
      this.lib.getLinearVelocityRaw(body.realmId, body.id, out);
    } else {
      const state = this.getBodyState(body);
      if (state) { out[0] = state.linearVelocity[0]; out[1] = state.linearVelocity[1]; out[2] = state.linearVelocity[2]; }
      else { out[0] = 0; out[1] = 0; out[2] = 0; }
    }
  }

  setLinearVelocityRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean): void {
    const state = this.getBodyState(body);
    if (state) {
      state.linearVelocity[0] = x; state.linearVelocity[1] = y; state.linearVelocity[2] = z;
    }
    if (this.lib && this.lib.setLinearVelocityRaw) {
      this.lib.setLinearVelocityRaw(body.realmId, body.id, x, y, z, wakeUp);
    } else if (this.lib) {
      this.lib.setLinearVelocity(body.realmId, body.id, [x, y, z]);
    }
  }

  setAngularVelocityRaw(body: PhysicsBody, x: number, y: number, z: number, wakeUp: boolean): void {
    const state = this.getBodyState(body);
    if (state) {
      state.angularVelocity[0] = x; state.angularVelocity[1] = y; state.angularVelocity[2] = z;
    }
    if (this.lib && this.lib.setAngularVelocityRaw) {
      this.lib.setAngularVelocityRaw(body.realmId, body.id, x, y, z, wakeUp);
    } else if (this.lib) {
      this.lib.setAngularVelocity(body.realmId, body.id, [x, y, z]);
    }
  }

  isSleepingRaw(body: PhysicsBody): boolean {
    if (this.lib && this.lib.isSleepingRaw) {
      return this.lib.isSleepingRaw(body.realmId, body.id);
    }
    const state = this.getBodyState(body);
    return state ? state.sleeping : false;
  }

  readAwakeBodyStates(realmId: number, idsOut: Uint32Array, out: Float32Array, maxCount: number): number {
    if (this.lib?.readAwakeBodyStates) {
      return this.lib.readAwakeBodyStates(realmId, idsOut, out, maxCount);
    }
    const realm = this.realms.get(realmId);
    if (!realm) return 0;
    let n = 0;
    for (const [bodyId, b] of realm.bodies) {
      if (n >= maxCount) break;
      if (b.sleeping || b.desc.type !== "dynamic") continue;
      const o = n * 10;
      out[o] = b.position[0]; out[o + 1] = b.position[1]; out[o + 2] = b.position[2];
      out[o + 3] = b.rotation[0]; out[o + 4] = b.rotation[1]; out[o + 5] = b.rotation[2]; out[o + 6] = b.rotation[3];
      out[o + 7] = b.linearVelocity[0]; out[o + 8] = b.linearVelocity[1]; out[o + 9] = b.linearVelocity[2];
      idsOut[n] = bodyId;
      n++;
    }
    return n;
  }

  swapColliderShapeRaw(realmId: number, colliderId: number, vertices: Float32Array, indices: Uint32Array): boolean {
    if (this.lib && this.lib.swapColliderShapeRaw) {
      return this.lib.swapColliderShapeRaw(realmId, colliderId, vertices, indices);
    }
    return false;
  }

  reserveMemory(bytes: number): void {
    if (this.lib && this.lib.reserveMemory) {
      this.lib.reserveMemory(bytes);
    }
  }

  setIntegrationDt(realmId: number, dt: number): void {
    if (this.lib && this.lib.setIntegrationDt) {
      this.lib.setIntegrationDt(realmId, dt);
    }
  }

  setSleepThresholds(realmId: number, linearThreshold: number, angularThreshold: number): void {
    if (this.lib) {
      this.lib.setSleepThresholds(realmId, linearThreshold, angularThreshold);
    }
  }

  setSolverIterations(realmId: number, iterations: number): void {
    if (this.lib) {
      this.lib.setSolverIterations(realmId, iterations);
    }
  }

  setMinIslandSize(realmId: number, size: number): void {
    if (this.lib && this.lib.setMinIslandSize) {
      this.lib.setMinIslandSize(realmId, size);
    }
  }

  setCCDEnabled(body: PhysicsBody, enabled: boolean): void {
    if (this.lib) {
      this.lib.setCCDEnabled(body.realmId, body.id, enabled);
    }
  }

  raycast(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null {
    if (this.lib) {
      return this.lib.raycast(realmId, origin, direction, maxDistance, filter);
    }

    const realm = this.realms.get(realmId);
    if (!realm) return null;

    let closest: RaycastResult | null = null;
    let closestDist = maxDistance;

    for (const [, b] of realm.bodies) {
      if (filter?.excludeEntity && b.body.entity.index === filter.excludeEntity.index) continue;

      for (const collider of b.colliders.values()) {
        const hit = raycastCollider(
          origin,
          direction,
          maxDistance,
          b.position,
          collider.shape,
        );
        if (hit && hit.distance < closestDist) {
          closestDist = hit.distance;
          closest = {
            entity: b.body.entity,
            point: hit.point,
            normal: hit.normal,
            distance: hit.distance,
          };
        }
      }
    }

    return closest;
  }

  raycastMulti(
    realmId: number,
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[] {
    const results: RaycastResult[] = [];
    if (this.lib) {
      return this.lib.raycastMulti(realmId, origin, direction, maxDistance, filter);
    }

    const realm = this.realms.get(realmId);
    if (!realm) return [];

    for (const [, b] of realm.bodies) {
      if (filter?.excludeEntity && b.body.entity.index === filter.excludeEntity.index) continue;

      for (const collider of b.colliders.values()) {
        const hit = raycastCollider(origin, direction, maxDistance, b.position, collider.shape);
        if (hit) {
          results.push({
            entity: b.body.entity,
            point: hit.point,
            normal: hit.normal,
            distance: hit.distance,
          });
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }

  shapeCast(
    realmId: number,
    shape: ColliderShape,
    origin: [number, number, number],
    rotation: [number, number, number, number],
    direction: [number, number, number],
    maxDistance: number,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): ShapeCastResult | null {
    if (this.lib) {
      return this.lib.shapeCast(realmId, shape, origin, rotation, direction, maxDistance, filter);
    }
    return null;
  }

  step(realmId: number, dt: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;

    if (this.lib) {
      if (this.readBackTransformsOnStep && this.lib.readAwakeBodyStates && realm.bodies.size > 0) {
        // Batched readback: one lib call for the whole awake set instead of a
        // per-body getBodyTransform round trip. Sleeping bodies don't move, so
        // the JS cache keeps last-synced values for them.
        const cap = realm.bodies.size;
        if (realm.readbackIds.length < cap) {
          realm.readbackIds = new Uint32Array(cap);
          realm.readbackStates = new Float32Array(cap * 10);
        }
        const n = this.lib.stepAndReadAwake
          ? this.lib.stepAndReadAwake(realmId, dt, realm.readbackIds, realm.readbackStates, cap)
          : (this.lib.step(realmId, dt),
             this.lib.readAwakeBodyStates(realmId, realm.readbackIds, realm.readbackStates, cap));
        for (let i = 0; i < n; i++) {
          const b = realm.bodies.get(realm.readbackIds[i]);
          if (!b) continue;
          const o = i * 10;
          b.position[0] = realm.readbackStates[o];
          b.position[1] = realm.readbackStates[o + 1];
          b.position[2] = realm.readbackStates[o + 2];
          b.rotation[0] = realm.readbackStates[o + 3];
          b.rotation[1] = realm.readbackStates[o + 4];
          b.rotation[2] = realm.readbackStates[o + 5];
          b.rotation[3] = realm.readbackStates[o + 6];
          b.linearVelocity[0] = realm.readbackStates[o + 7];
          b.linearVelocity[1] = realm.readbackStates[o + 8];
          b.linearVelocity[2] = realm.readbackStates[o + 9];
        }
      } else {
        this.lib.step(realmId, dt);
        if (this.readBackTransformsOnStep) this.readBackTransforms(realm);
      }
      if (this.extractContacts) {
        realm.contacts = this.lib.getContacts(realmId);
        realm.intersections = this.lib.getIntersections(realmId);
      } else {
        realm.contacts.length = 0;
        realm.intersections.length = 0;
      }
      return;
    }

    this.stepFallback(realm, dt);
  }

  stepAll(dt: number): void {
    for (const realmId of this.realmIds) {
      this.step(realmId, dt);
    }
  }

  getContacts(realmId: number): ContactManifold[] {
    const realm = this.realms.get(realmId);
    return realm ? realm.contacts : [];
  }

  getIntersections(realmId: number): IntersectionPair[] {
    const realm = this.realms.get(realmId);
    return realm ? realm.intersections : [];
  }

  getIslands(realmId: number): IslandInfo[] {
    if (this.lib) {
      return this.lib.getIslands(realmId);
    }
    // Fallback: each body is its own island
    const realm = this.realms.get(realmId);
    if (!realm) return [];
    const islands: IslandInfo[] = [];
    for (const [bodyId, b] of realm.bodies) {
      const speed = Math.sqrt(
        b.linearVelocity[0] ** 2 + b.linearVelocity[1] ** 2 + b.linearVelocity[2] ** 2,
      );
      islands.push({ bodyIds: [bodyId], maxImportance: 0, avgVelocity: speed });
    }
    return islands;
  }

  createCharacterController(realmId: number, desc: CharacterControllerDesc, entity: Entity): CharacterControllerHandle {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);
    const controllerId = realm.nextControllerId++;
    const handle: CharacterControllerHandle = { realmId, controllerId, entity };
    if (this.lib) {
      this.lib.createCharacterController(realmId, desc, handle);
    }
    return handle;
  }

  destroyCharacterController(handle: CharacterControllerHandle): void {
    if (this.lib) {
      this.lib.destroyCharacterController(handle.realmId, handle.controllerId);
    }
  }

  characterMove(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult {
    if (this.lib) {
      return this.lib.characterMove(handle.realmId, handle.controllerId, desiredMovement, dt);
    }
    return this.characterMoveFallback(handle, desiredMovement, dt);
  }

  setCharacterColliderPosition(handle: CharacterControllerHandle, pos: [number, number, number]): void {
    if (this.lib && this.lib.setCharacterColliderPosition) {
      this.lib.setCharacterColliderPosition(handle.realmId, handle.controllerId, pos);
    }
  }

  createJoint(realmId: number, parentBody: PhysicsBody, childBody: PhysicsBody, desc: JointDesc): number {
    const realm = this.realms.get(realmId);
    if (!realm) throw new Error(`Realm ${realmId} not found`);
    const jointId = realm.nextJointId++;
    if (this.lib) {
      this.lib.createJoint(realmId, parentBody.id, childBody.id, jointId, desc);
    }
    return jointId;
  }

  destroyJoint(realmId: number, jointId: number): void {
    if (this.lib) {
      this.lib.destroyJoint(realmId, jointId);
    }
  }

  syncTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    for (const [, b] of realm.bodies) {
      const idx = b.body.entity.index;
      if (idx < entityCount) {
        const offset = idx * 8;
        b.position[0] = transformBuffer[offset];
        b.position[1] = transformBuffer[offset + 1];
        b.position[2] = transformBuffer[offset + 2];
        b.rotation[0] = transformBuffer[offset + 3];
        b.rotation[1] = transformBuffer[offset + 4];
        b.rotation[2] = transformBuffer[offset + 5];
        b.rotation[3] = transformBuffer[offset + 6];
      }
    }
  }

  readTransforms(realmId: number, transformBuffer: Float32Array, entityCount: number): void {
    const realm = this.realms.get(realmId);
    if (!realm) return;
    for (const [, b] of realm.bodies) {
      const idx = b.body.entity.index;
      if (idx < entityCount) {
        const offset = idx * 8;
        transformBuffer[offset] = b.position[0];
        transformBuffer[offset + 1] = b.position[1];
        transformBuffer[offset + 2] = b.position[2];
        transformBuffer[offset + 3] = b.rotation[0];
        transformBuffer[offset + 4] = b.rotation[1];
        transformBuffer[offset + 5] = b.rotation[2];
        transformBuffer[offset + 6] = b.rotation[3];
      }
    }
  }

  serializeRealm(realmId: number): Uint8Array {
    if (this.lib) {
      return this.lib.serializeRealm(realmId);
    }
    return new Uint8Array(0);
  }

  deserializeRealm(realmId: number, data: Uint8Array): void {
    if (this.lib) {
      this.lib.deserializeRealm(realmId, data);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.lib) {
      // Only destroy this backend's realms — do NOT call this.lib.destroy(),
      // which would clear the shared lib's closure maps for ALL backends
      // (the lib is a process-wide singleton via cachedLib).
      for (const realmId of this.realmIds) {
        this.lib.destroyRealm(realmId);
      }
    }
    this.realms.clear();
    this.realmIds = [];
  }

  private getBodyState(body: PhysicsBody): BodyState | undefined {
    const realm = this.realms.get(body.realmId);
    return realm?.bodies.get(body.id);
  }

  private characterMoveFallback(handle: CharacterControllerHandle, desiredMovement: [number, number, number], dt: number): CharacterMoveResult {
    const realm = this.realms.get(handle.realmId);
    if (!realm) {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0], collisions: [] };
    }

    // Find the body associated with this character controller's entity
    let body: BodyState | null = null;
    for (const b of realm.bodies.values()) {
      if (b.body.entity.index === handle.entity.index) { body = b; break; }
    }
    if (!body) {
      return { grounded: false, groundNormal: [0, 1, 0], groundEntity: null, slid: false, stepped: false, effectiveMovement: [0, 0, 0], collisions: [] };
    }

    const desired = [...desiredMovement] as [number, number, number];
    let effective = [...desired] as [number, number, number];
    let slid = false;
    let stepped = false;

    const groundRay = this.raycast(handle.realmId, body.position, [0, -1, 0], 1.2);
    const grounded = groundRay !== null && groundRay.distance <= 1.0;
    const groundNormal = groundRay ? groundRay.normal : [0, 1, 0] as [number, number, number];
    const groundEntity = groundRay ? groundRay.entity : null;

    if (grounded) {
      const slopeDot = groundNormal[1];
      const maxSlopeCos = Math.cos(Math.PI / 3);
      if (slopeDot < maxSlopeCos) {
        const slideDir: [number, number, number] = [
          groundNormal[0] * (1 - slopeDot),
          groundNormal[1] * (1 - slopeDot) - 1,
          groundNormal[2] * (1 - slopeDot),
        ];
        const slideLen = Math.sqrt(slideDir[0] ** 2 + slideDir[1] ** 2 + slideDir[2] ** 2);
        if (slideLen > 1e-6) {
          effective[0] = slideDir[0] / slideLen * Math.abs(desired[1]) * 0.5;
          effective[1] = slideDir[1] / slideLen * Math.abs(desired[1]) * 0.5;
          effective[2] = slideDir[2] / slideLen * Math.abs(desired[1]) * 0.5;
          slid = true;
        }
      }
    }

    const wallRay = this.raycast(handle.realmId, body.position, [desired[0], 0, desired[2]], 0.6);
    if (wallRay && wallRay.distance < 0.5) {
      const wallNormal = wallRay.normal;
      const dot = effective[0] * wallNormal[0] + effective[2] * wallNormal[2];
      if (dot < 0) {
        effective[0] -= dot * wallNormal[0];
        effective[2] -= dot * wallNormal[2];
        slid = true;
      }
    }

    body.position[0] += effective[0] * dt;
    body.position[1] += effective[1] * dt;
    body.position[2] += effective[2] * dt;

    return { grounded, groundNormal, groundEntity, slid, stepped, effectiveMovement: effective, collisions: [] };
  }

  private readBackTransforms(realm: RealmState): void {
    if (!this.lib) return;
    for (const [bodyId, b] of realm.bodies) {
      const transform = this.lib.getBodyTransform(realm.id, bodyId);
      if (transform) {
        b.position = transform.position;
        b.rotation = transform.rotation;
      }
    }
  }

  private stepFallback(realm: RealmState, dt: number): void {
    const gravity = realm.config.gravity;

    for (const [, b] of realm.bodies) {
      if (b.desc.type !== "dynamic" || b.sleeping) continue;

      b.linearVelocity[0] += gravity[0] * (b.desc.gravityScale ?? 1) * dt;
      b.linearVelocity[1] += gravity[1] * (b.desc.gravityScale ?? 1) * dt;
      b.linearVelocity[2] += gravity[2] * (b.desc.gravityScale ?? 1) * dt;

      const damping = b.desc.linearDamping ?? 0;
      const dampFactor = Math.max(0, 1 - damping * dt);
      b.linearVelocity[0] *= dampFactor;
      b.linearVelocity[1] *= dampFactor;
      b.linearVelocity[2] *= dampFactor;

      const angDamping = b.desc.angularDamping ?? 0;
      const angDampFactor = Math.max(0, 1 - angDamping * dt);
      b.angularVelocity[0] *= angDampFactor;
      b.angularVelocity[1] *= angDampFactor;
      b.angularVelocity[2] *= angDampFactor;

      b.position[0] += b.linearVelocity[0] * dt;
      b.position[1] += b.linearVelocity[1] * dt;
      b.position[2] += b.linearVelocity[2] * dt;

      integrateRotation(b.rotation, b.angularVelocity, dt);
    }

    realm.contacts = this.detectContacts(realm);
    realm.intersections = this.detectIntersections(realm);
  }

  private detectContacts(realm: RealmState): ContactManifold[] {
    const contacts: ContactManifold[] = [];
    const bodies = [...realm.bodies.values()];

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];

        for (const colA of a.colliders.values()) {
          if (colA.sensor) continue;
          for (const colB of b.colliders.values()) {
            if (colB.sensor) continue;
            const contact = checkColliderCollision(
              a.position,
              colA.shape,
              b.position,
              colB.shape,
            );
            if (contact) {
              contacts.push({
                entityA: a.body.entity,
                entityB: b.body.entity,
                normal: contact.normal,
                points: [contact.point],
                penetrationDepth: contact.penetration,
              });
            }
          }
        }
      }
    }

    return contacts;
  }

  private detectIntersections(realm: RealmState): IntersectionPair[] {
    const intersections: IntersectionPair[] = [];
    const bodies = [...realm.bodies.values()];

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];

        for (const colA of a.colliders.values()) {
          for (const colB of b.colliders.values()) {
            // Only report pairs where at least one collider is a sensor
            if (!colA.sensor && !colB.sensor) continue;
            const contact = checkColliderCollision(
              a.position,
              colA.shape,
              b.position,
              colB.shape,
            );
            if (contact) {
              intersections.push({
                entityA: a.body.entity,
                entityB: b.body.entity,
              });
            }
          }
        }
      }
    }

    return intersections;
  }
}

function integrateRotation(
  rot: [number, number, number, number],
  angularVel: [number, number, number],
  dt: number,
): void {
  const ax = angularVel[0] * dt * 0.5;
  const ay = angularVel[1] * dt * 0.5;
  const az = angularVel[2] * dt * 0.5;
  const dq: [number, number, number, number] = [ax, ay, az, 1];
  const len = Math.sqrt(dq[0] ** 2 + dq[1] ** 2 + dq[2] ** 2 + dq[3] ** 2);
  if (len > 1e-9) {
    dq[0] /= len; dq[1] /= len; dq[2] /= len; dq[3] /= len;
  }
  const result = multiplyQuat(rot, dq);
  rot[0] = result[0]; rot[1] = result[1]; rot[2] = result[2]; rot[3] = result[3];
}

function multiplyQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function raycastCollider(
  origin: [number, number, number],
  direction: [number, number, number],
  maxDistance: number,
  bodyPos: [number, number, number],
  shape: ColliderShape,
): { point: [number, number, number]; normal: [number, number, number]; distance: number } | null {
  if (shape.type === "sphere") {
    return raycastSphere(origin, direction, maxDistance, bodyPos, shape.radius);
  }
  if (shape.type === "box") {
    return raycastBox(origin, direction, maxDistance, bodyPos, shape.halfExtents);
  }
  return null;
}

function raycastSphere(
  origin: [number, number, number],
  dir: [number, number, number],
  maxDist: number,
  center: [number, number, number],
  radius: number,
): { point: [number, number, number]; normal: [number, number, number]; distance: number } | null {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxDist) return null;
  const point: [number, number, number] = [
    origin[0] + dir[0] * t,
    origin[1] + dir[1] * t,
    origin[2] + dir[2] * t,
  ];
  const normal: [number, number, number] = [
    (point[0] - center[0]) / radius,
    (point[1] - center[1]) / radius,
    (point[2] - center[2]) / radius,
  ];
  return { point, normal, distance: t };
}

function raycastBox(
  origin: [number, number, number],
  dir: [number, number, number],
  maxDist: number,
  center: [number, number, number],
  halfExtents: [number, number, number],
): { point: [number, number, number]; normal: [number, number, number]; distance: number } | null {
  let tmin = 0;
  let tmax = maxDist;

  for (let i = 0; i < 3; i++) {
    const o = origin[i] - center[i];
    const d = dir[i];
    const half = halfExtents[i];

    if (Math.abs(d) < 1e-9) {
      if (Math.abs(o) > half) return null;
    } else {
      let t1 = (-half - o) / d;
      let t2 = (half - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }

  const t = tmin;
  const point: [number, number, number] = [
    origin[0] + dir[0] * t,
    origin[1] + dir[1] * t,
    origin[2] + dir[2] * t,
  ];

  const rel: [number, number, number] = [
    point[0] - center[0],
    point[1] - center[1],
    point[2] - center[2],
  ];
  const nx = rel[0] / halfExtents[0];
  const ny = rel[1] / halfExtents[1];
  const nz = rel[2] / halfExtents[2];
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let normal: [number, number, number];
  if (ax >= ay && ax >= az) normal = [Math.sign(nx), 0, 0];
  else if (ay >= ax && ay >= az) normal = [0, Math.sign(ny), 0];
  else normal = [0, 0, Math.sign(nz)];

  return { point, normal, distance: t };
}

function checkColliderCollision(
  posA: [number, number, number],
  shapeA: ColliderShape,
  posB: [number, number, number],
  shapeB: ColliderShape,
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  if (shapeA.type === "sphere" && shapeB.type === "sphere") {
    return sphereSphere(posA, shapeA.radius, posB, shapeB.radius);
  }
  if (shapeA.type === "box" && shapeB.type === "box") {
    return aabbAabb(posA, shapeA.halfExtents, posB, shapeB.halfExtents);
  }
  if (shapeA.type === "sphere" && shapeB.type === "box") {
    return sphereAabb(posA, shapeA.radius, posB, shapeB.halfExtents);
  }
  if (shapeA.type === "box" && shapeB.type === "sphere") {
    const result = sphereAabb(posB, shapeB.radius, posA, shapeA.halfExtents);
    if (result) {
      result.normal = [-result.normal[0], -result.normal[1], -result.normal[2]] as [number, number, number];
    }
    return result;
  }
  return null;
}

function sphereSphere(
  posA: [number, number, number],
  rA: number,
  posB: [number, number, number],
  rB: number,
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  const dx = posB[0] - posA[0];
  const dy = posB[1] - posA[1];
  const dz = posB[2] - posA[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const sumR = rA + rB;
  if (dist >= sumR) return null;
  const penetration = sumR - dist;
  const normal: [number, number, number] = dist > 1e-9
    ? [dx / dist, dy / dist, dz / dist]
    : [0, 1, 0];
  const point: [number, number, number] = [
    posA[0] + normal[0] * rA,
    posA[1] + normal[1] * rA,
    posA[2] + normal[2] * rA,
  ];
  return { normal, point, penetration };
}

function aabbAabb(
  posA: [number, number, number],
  halfA: [number, number, number],
  posB: [number, number, number],
  halfB: [number, number, number],
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  const dx = posB[0] - posA[0];
  const px = halfA[0] + halfB[0] - Math.abs(dx);
  if (px <= 0) return null;

  const dy = posB[1] - posA[1];
  const py = halfA[1] + halfB[1] - Math.abs(dy);
  if (py <= 0) return null;

  const dz = posB[2] - posA[2];
  const pz = halfA[2] + halfB[2] - Math.abs(dz);
  if (pz <= 0) return null;

  if (px < py && px < pz) {
    const nx = dx < 0 ? -1 : 1;
    return {
      normal: [nx, 0, 0],
      point: [posA[0] + nx * halfA[0], posA[1], posA[2]],
      penetration: px,
    };
  } else if (py < pz) {
    const ny = dy < 0 ? -1 : 1;
    return {
      normal: [0, ny, 0],
      point: [posA[0], posA[1] + ny * halfA[1], posA[2]],
      penetration: py,
    };
  } else {
    const nz = dz < 0 ? -1 : 1;
    return {
      normal: [0, 0, nz],
      point: [posA[0], posA[1], posA[2] + nz * halfA[2]],
      penetration: pz,
    };
  }
}

function sphereAabb(
  spherePos: [number, number, number],
  radius: number,
  boxPos: [number, number, number],
  halfExtents: [number, number, number],
): { normal: [number, number, number]; point: [number, number, number]; penetration: number } | null {
  const closest: [number, number, number] = [
    Math.max(boxPos[0] - halfExtents[0], Math.min(spherePos[0], boxPos[0] + halfExtents[0])),
    Math.max(boxPos[1] - halfExtents[1], Math.min(spherePos[1], boxPos[1] + halfExtents[1])),
    Math.max(boxPos[2] - halfExtents[2], Math.min(spherePos[2], boxPos[2] + halfExtents[2])),
  ];

  const dx = spherePos[0] - closest[0];
  const dy = spherePos[1] - closest[1];
  const dz = spherePos[2] - closest[2];
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= radius * radius) return null;

  const dist = Math.sqrt(distSq);
  const penetration = radius - dist;
  const normal: [number, number, number] = dist > 1e-9
    ? [dx / dist, dy / dist, dz / dist]
    : [0, 1, 0];
  return { normal, point: closest, penetration };
}
