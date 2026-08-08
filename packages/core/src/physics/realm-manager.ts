import type { Entity } from "../ecs/entity";
import type {
    BodyDesc,
    ColliderDesc,
    PhysicsBackend,
    PhysicsBody,
    PhysicsRealmConfig,
    RealmTierConfig,
    RealmTransferHook,
} from "./interface";
import { RealmTier } from "./interface";
import { PhysicsRealm } from "./realm";

interface BodyMetadata {
  /** Stable key — same as `PhysicsBody.id`. Used as the key in `bodies` map. */
  bodyId: number;
  entity: Entity;
  tier: RealmTier;
  importance: number;
  /** Continuous seconds the body has been outside its current tier's demote threshold. */
  dwellTimer: number;
  /** Tick index of the last realm transfer (for hysteresis / telemetry). */
  lastTransferTick: number;
  /** Original body descriptor (for transfer recreation). */
  desc: BodyDesc;
  /** Collider descriptors added to this body, keyed by the canonical (near-realm) id. */
  colliders: Array<{ id: number; desc: ColliderDesc }>;
  /** The current `PhysicsBody` reference (refreshed on transfer). */
  body: PhysicsBody;
  /** True if the body is static (duplicated into all realms). */
  isStatic: boolean;
  /** Per-realm copies for static bodies (near/mid/far). Only set when `isStatic`. */
  staticCopies?: Map<RealmTier, PhysicsBody>;
}

export interface RealmManagerConfig {
  backend: PhysicsBackend;
  nearConfig: Omit<PhysicsRealmConfig, "id" | "tier"> & { tierConfig: RealmTierConfig };
  midConfig: Omit<PhysicsRealmConfig, "id" | "tier"> & { tierConfig: RealmTierConfig };
  farConfig: Omit<PhysicsRealmConfig, "id" | "tier"> & { tierConfig: RealmTierConfig };
  /** When true, static bodies are duplicated into all three realms (default). */
  duplicateStatics?: boolean;
}

const DEFAULT_NEAR_CONFIG: RealmTierConfig = {
  tickFrequency: 1,
  solverIterations: 4,
  promoteThreshold: 50,
  demoteThreshold: 60,
  demoteDwellTime: 1,
};
const DEFAULT_MID_CONFIG: RealmTierConfig = {
  tickFrequency: 2,
  solverIterations: 2,
  promoteThreshold: 120,
  demoteThreshold: 150,
  demoteDwellTime: 2,
};
const DEFAULT_FAR_CONFIG: RealmTierConfig = {
  tickFrequency: 6,
  solverIterations: 1,
  promoteThreshold: Infinity,
  demoteThreshold: Infinity,
  demoteDwellTime: 5,
};

/**
 * Manages three physics realm tiers (near/mid/far) with LOD-based body
 * transfers. Promotes bodies immediately when they approach a higher-fidelity
 * realm; demotes after a configurable dwell time (hysteresis).
 *
 * Static bodies are duplicated into all three realms by default so they
 * collide correctly in every tier without transfer overhead.
 */
export class RealmManager {
  private realms: Map<RealmTier, PhysicsRealm> = new Map();
  private tierConfigs: Map<RealmTier, RealmTierConfig> = new Map();
  /** All tracked bodies keyed by stable RealmManager bodyId. */
  private bodies: Map<number, BodyMetadata> = new Map();
  /** Reverse lookup: PhysicsBody.id (backend id) → stable bodyId. */
  private bodyIdByBackendId: Map<number, number> = new Map();
  /** Monotonic body-id allocator (stable across transfers). */
  private nextBodyId = 1;
  private transferHook: RealmTransferHook | null = null;
  private duplicateStatics: boolean;
  private tickCount = 0;
  private pendingTransfers: Array<{ meta: BodyMetadata; toTier: RealmTier }> = [];

  constructor(config: RealmManagerConfig) {
    this.duplicateStatics = config.duplicateStatics ?? true;

    const nearTierConfig = config.nearConfig.tierConfig ?? DEFAULT_NEAR_CONFIG;
    const midTierConfig = config.midConfig.tierConfig ?? DEFAULT_MID_CONFIG;
    const farTierConfig = config.farConfig.tierConfig ?? DEFAULT_FAR_CONFIG;

    this.tierConfigs.set(RealmTier.Near, nearTierConfig);
    this.tierConfigs.set(RealmTier.Mid, midTierConfig);
    this.tierConfigs.set(RealmTier.Far, farTierConfig);

    const nearRealm = new PhysicsRealm(config.backend, {
      ...config.nearConfig,
      tier: RealmTier.Near,
      tierConfig: nearTierConfig,
    });
    const midRealm = new PhysicsRealm(config.backend, {
      ...config.midConfig,
      tier: RealmTier.Mid,
      tierConfig: midTierConfig,
    });
    const farRealm = new PhysicsRealm(config.backend, {
      ...config.farConfig,
      tier: RealmTier.Far,
      tierConfig: farTierConfig,
    });

    this.realms.set(RealmTier.Near, nearRealm);
    this.realms.set(RealmTier.Mid, midRealm);
    this.realms.set(RealmTier.Far, farRealm);

    // Apply solver iterations per tier
    nearRealm.setSolverIterations(nearTierConfig.solverIterations);
    midRealm.setSolverIterations(midTierConfig.solverIterations);
    farRealm.setSolverIterations(farTierConfig.solverIterations);
  }

  getRealm(tier: RealmTier): PhysicsRealm {
    const r = this.realms.get(tier);
    if (!r) throw new Error(`Realm for tier ${tier} not found`);
    return r;
  }

  getRealmForBody(body: PhysicsBody): RealmTier {
    // Look up by the current body ref first, then fall back to searching
    const meta = this.findBodyMeta(body);
    return meta ? meta.tier : RealmTier.Near;
  }

  getBodyMetadata(body: PhysicsBody): BodyMetadata | undefined {
    return this.findBodyMeta(body);
  }

  /**
   * Find body metadata by PhysicsBody reference. Uses reverse lookup
   * by backend body id; falls back to linear search for static copies.
   */
  private findBodyMeta(body: PhysicsBody): BodyMetadata | undefined {
    // Fast path: reverse lookup by backend body id
    const bodyId = this.bodyIdByBackendId.get(body.id);
    if (bodyId !== undefined) {
      const meta = this.bodies.get(bodyId);
      if (meta) return meta;
    }
    // Fallback: search static copies (they have different backend ids)
    for (const meta of this.bodies.values()) {
      if (meta.staticCopies) {
        for (const copy of meta.staticCopies.values()) {
          if (copy.id === body.id && copy.realmId === body.realmId) return meta;
        }
      }
    }
    return undefined;
  }

  /**
   * Register a new body. Dynamic bodies are placed in the near realm by
   * default (or the realm matching their `importance`). Static bodies are
   * duplicated into all three realms when `duplicateStatics` is true.
   */
  registerBody(entity: Entity, desc: BodyDesc, importance: number = 0): PhysicsBody {
    const bodyId = this.nextBodyId++;
    const isStatic = desc.type === "static";
    const initialTier = isStatic ? RealmTier.Near : RealmTier.Near;

    const primaryRealm = this.getRealm(initialTier);
    const body = primaryRealm.createBody(desc, entity);

    const meta: BodyMetadata = {
      bodyId,
      entity,
      tier: initialTier,
      importance,
      dwellTimer: 0,
      lastTransferTick: this.tickCount,
      desc,
      colliders: [],
      body,
      isStatic,
    };

    if (isStatic && this.duplicateStatics) {
      const copies = new Map<RealmTier, PhysicsBody>();
      copies.set(initialTier, body);
      for (const tier of [RealmTier.Mid, RealmTier.Far]) {
        const r = this.getRealm(tier);
        copies.set(tier, r.createBody(desc, entity));
      }
      meta.staticCopies = copies;
    }

    this.bodies.set(bodyId, meta);
    this.bodyIdByBackendId.set(body.id, bodyId);
    return body;
  }

  unregisterBody(body: PhysicsBody): void {
    const meta = this.findBodyMeta(body);
    if (!meta) return;

    if (meta.staticCopies) {
      for (const [tier, copy] of meta.staticCopies) {
        this.getRealm(tier).destroyBody(copy);
        this.bodyIdByBackendId.delete(copy.id);
      }
    } else {
      this.getRealm(meta.tier).destroyBody(meta.body);
      this.bodyIdByBackendId.delete(meta.body.id);
    }
    this.bodies.delete(meta.bodyId);
  }

  addCollider(body: PhysicsBody, desc: ColliderDesc): number {
    const meta = this.findBodyMeta(body);
    if (!meta) return -1;

    let colliderId = -1;
    if (meta.staticCopies) {
      // Add to all copies; return the near-realm collider id as canonical
      for (const [tier, copy] of meta.staticCopies) {
        const id = this.getRealm(tier).addCollider(copy, desc);
        if (tier === meta.tier) colliderId = id;
      }
    } else {
      colliderId = this.getRealm(meta.tier).addCollider(meta.body, desc);
    }
    if (colliderId >= 0) meta.colliders.push({ id: colliderId, desc });
    return colliderId;
  }

  /**
   * Remove a collider from a body (and all static copies).
   * The collider is removed from the `colliders` metadata array too.
   */
  removeCollider(body: PhysicsBody, colliderId: number): void {
    const meta = this.findBodyMeta(body);
    if (!meta) return;

    if (meta.staticCopies) {
      // Remove from each copy's own realm. Collider ids may differ per realm;
      // the backend handles missing ids gracefully (no-op if not found).
      for (const [tier, copy] of meta.staticCopies) {
        this.getRealm(tier).removeCollider(copy, colliderId);
      }
    } else {
      this.getRealm(meta.tier).removeCollider(meta.body, colliderId);
    }

    // Remove from metadata by canonical id
    const idx = meta.colliders.findIndex((c) => c.id === colliderId);
    if (idx >= 0) meta.colliders.splice(idx, 1);
  }

  setImportance(body: PhysicsBody, importance: number): void {
    const meta = this.findBodyMeta(body);
    if (meta) meta.importance = importance;
  }

  setTransferHook(hook: RealmTransferHook): void {
    this.transferHook = hook;
  }

  /**
   * Per-frame realm membership update. Computes the minimum distance from
   * each dynamic body to any player camera and promotes/demotes as needed.
   *
   * Promotion is immediate (with swept-position prediction). Demotion is
   * debounced by `demoteDwellTime` (hysteresis).
   */
  updateRealmMembership(playerCameras: ReadonlyArray<readonly [number, number, number]>, dt: number): void {
    if (playerCameras.length === 0) return;

    for (const meta of this.bodies.values()) {
      if (meta.isStatic) continue;

      const realm = this.getRealm(meta.tier);
      const pos = realm.getPosition(meta.body);
      const vel = realm.getLinearVelocity(meta.body);

      // Swept / predicted position (look-ahead to promote fast-approaching bodies)
      const predicted: [number, number, number] = [
        pos[0] + vel[0] * dt,
        pos[1] + vel[1] * dt,
        pos[2] + vel[2] * dt,
      ];

      let minDist = Infinity;
      for (const cam of playerCameras) {
        const dx = predicted[0] - cam[0];
        const dy = predicted[1] - cam[1];
        const dz = predicted[2] - cam[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < minDist) minDist = d;
      }

      // Promotion: immediate if within a higher tier's promote threshold
      const higherTier = this.nextHigherTier(meta.tier);
      if (higherTier !== null) {
        const higherConfig = this.getRealm(higherTier);
        const promoteThreshold = this.getTierConfig(higherTier).promoteThreshold;
        if (minDist < promoteThreshold) {
          // Allow hook to override
          let targetTier: RealmTier | null = higherTier;
          if (this.transferHook?.shouldTransfer) {
            let override = this.transferHook.shouldTransfer(meta.bodyId, meta.tier, [minDist]);
            if (override !== null && ![0, 1, 2].includes(override)) override = null;
            if (override !== null) targetTier = override;
          }
          if (targetTier !== null && targetTier !== meta.tier) {
            this.scheduleTransfer(meta, targetTier);
            continue;
          }
        }
      }

      // Demotion: debounced by dwell time (hysteresis)
      const demoteThreshold = this.getTierConfig(meta.tier).demoteThreshold;
      if (minDist > demoteThreshold) {
        meta.dwellTimer += dt;
        const dwellRequired = this.getTierConfig(meta.tier).demoteDwellTime;
        if (meta.dwellTimer >= dwellRequired) {
          const lowerTier = this.nextLowerTier(meta.tier);
          if (lowerTier !== null) {
            let targetTier: RealmTier | null = lowerTier;
            if (this.transferHook?.shouldTransfer) {
              let override = this.transferHook.shouldTransfer(meta.bodyId, meta.tier, [minDist]);
              if (override !== null && ![0, 1, 2].includes(override)) override = null;
              if (override !== null) targetTier = override;
            }
            if (targetTier !== null && targetTier !== meta.tier) {
              this.scheduleTransfer(meta, targetTier);
            }
          }
        }
      } else {
        // Inside threshold — reset dwell timer
        meta.dwellTimer = 0;
      }
    }

    this.flushTransfers();
  }

  /**
   * Step all realms at their respective tick frequencies.
   * `tickCount` is incremented once per call.
   */
  step(dt: number): void {
    this.tickCount++;

    const nearConfig = this.getTierConfig(RealmTier.Near);
    const midConfig = this.getTierConfig(RealmTier.Mid);
    const farConfig = this.getTierConfig(RealmTier.Far);

    // Near: every tick
    this.getRealm(RealmTier.Near).step(dt);

    // Mid: every tickFrequency-th tick
    if (midConfig.tickFrequency > 0 && this.tickCount % midConfig.tickFrequency === 0) {
      this.getRealm(RealmTier.Mid).step(dt);
    }

    // Far: every tickFrequency-th tick
    if (farConfig.tickFrequency > 0 && this.tickCount % farConfig.tickFrequency === 0) {
      this.getRealm(RealmTier.Far).step(dt);
    }
  }

  getTickCount(): number {
    return this.tickCount;
  }

  getBodyCount(): number {
    return this.bodies.size;
  }

  getFrozenCount(): number {
    return 0; // Tracked by LoadShedder (Phase 5)
  }

  destroy(): void {
    for (const realm of this.realms.values()) {
      realm.destroy();
    }
    this.realms.clear();
    this.bodies.clear();
    this.bodyIdByBackendId.clear();
    this.pendingTransfers = [];
  }

  // --- Private helpers ---

  private getTierConfig(tier: RealmTier): RealmTierConfig {
    const cfg = this.tierConfigs.get(tier);
    if (cfg) return cfg;
    switch (tier) {
      case RealmTier.Near: return DEFAULT_NEAR_CONFIG;
      case RealmTier.Mid: return DEFAULT_MID_CONFIG;
      case RealmTier.Far: return DEFAULT_FAR_CONFIG;
      default: return DEFAULT_NEAR_CONFIG;
    }
  }

  private nextHigherTier(tier: RealmTier): RealmTier | null {
    if (tier === RealmTier.Mid) return RealmTier.Near;
    if (tier === RealmTier.Far) return RealmTier.Mid;
    return null; // Already at near
  }

  private nextLowerTier(tier: RealmTier): RealmTier | null {
    if (tier === RealmTier.Near) return RealmTier.Mid;
    if (tier === RealmTier.Mid) return RealmTier.Far;
    return null; // Already at far
  }

  private scheduleTransfer(meta: BodyMetadata, toTier: RealmTier): void {
    // Avoid duplicate scheduling
    const existing = this.pendingTransfers.find((p) => p.meta === meta);
    if (existing) {
      existing.toTier = toTier;
    } else {
      this.pendingTransfers.push({ meta, toTier });
    }
  }

  private flushTransfers(): void {
    if (this.pendingTransfers.length === 0) return;

    for (const { meta, toTier } of this.pendingTransfers) {
      if (meta.tier === toTier) continue;
      this.transferBody(meta, toTier);
    }
    this.pendingTransfers = [];
  }

  private transferBody(meta: BodyMetadata, toTier: RealmTier): void {
    const fromRealm = this.getRealm(meta.tier);
    const toRealm = this.getRealm(toTier);

    // Read current state from the old realm
    const pos = fromRealm.getPosition(meta.body);
    const rot = fromRealm.getRotation(meta.body);
    const linVel = fromRealm.getLinearVelocity(meta.body);
    const angVel = fromRealm.getAngularVelocity(meta.body);

    // Destroy from old realm
    const oldBody = meta.body;
    fromRealm.destroyBody(meta.body);
    // Delete the old backend id from the reverse lookup so stale refs
    // don't accidentally resolve to this metadata via the old id.
    this.bodyIdByBackendId.delete(oldBody.id);

    // Recreate in new realm with current state
    const newDesc: BodyDesc = {
      ...meta.desc,
      position: pos,
      rotation: rot,
      linearVelocity: linVel,
      angularVelocity: angVel,
    };
    const newBody = toRealm.createBody(newDesc, meta.entity);

    // Re-add colliders
    for (const { desc: colliderDesc } of meta.colliders) {
      toRealm.addCollider(newBody, colliderDesc);
    }

    // Update metadata + reverse lookup (add new backend id)
    const fromTier = meta.tier;
    meta.body = newBody;
    meta.tier = toTier;
    meta.dwellTimer = 0;
    meta.lastTransferTick = this.tickCount;
    this.bodyIdByBackendId.set(newBody.id, meta.bodyId);

    // Invoke hooks
    const promoted = toTier < fromTier; // Near=0 < Mid=1 < Far=2
    if (promoted) {
      this.transferHook?.onPromote?.(meta.bodyId, fromTier, toTier);
    } else {
      this.transferHook?.onDemote?.(meta.bodyId, fromTier, toTier);
    }
  }
}
