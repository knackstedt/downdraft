import type { BodyDesc, ColliderDesc, Entity } from "./interface";
import { RealmTier } from "./interface";
import { RealmWorker, supportsNestedWorkers, supportsSharedArrayBuffer } from "./realm-worker";
import type { RealmWorkerRequest } from "./worker-protocol";

/**
 * Pool of realm workers for parallel mid/far realm simulation.
 *
 * The near realm always runs on the sim thread (tightest latency).
 * Mid/far realms are delegated to workers when `workerCount > 0`.
 *
 * `workerCount: 0` = single-threaded fallback (all realms on sim thread).
 */
export class RealmWorkerPool {
  private workers: Map<RealmTier, RealmWorker> = new Map();
  private workerUrl: string | URL;
  private workerCount: number;
  private useSharedBuffer: boolean;
  private initialized: boolean = false;

  constructor(opts: { workerUrl: string | URL; workerCount?: number }) {
    this.workerUrl = opts.workerUrl;
    this.workerCount = opts.workerCount ?? 0;
    this.useSharedBuffer = supportsSharedArrayBuffer() && supportsNestedWorkers();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isParallel(): boolean {
    return this.workers.size > 0;
  }

  supportsSharedBuffer(): boolean {
    return this.useSharedBuffer;
  }

  /**
   * Initialize workers for mid/far realms. Returns true if workers are
   * available; false if single-threaded fallback should be used.
   */
  async init(): Promise<boolean> {
    if (this.workerCount === 0) {
      this.initialized = true;
      return false;
    }

    if (!supportsNestedWorkers()) {
      // Single-threaded fallback
      this.initialized = true;
      return false;
    }

    try {
      // Create one worker per tier (mid, far) up to workerCount
      const tiers = [RealmTier.Mid, RealmTier.Far];
      for (let i = 0; i < Math.min(this.workerCount, tiers.length); i++) {
        const tier = tiers[i];
        const worker = new RealmWorker(this.workerUrl, tier);
        this.workers.set(tier, worker);
      }
      this.initialized = true;
      return this.workers.size > 0;
    } catch {
      this.initialized = true;
      return false;
    }
  }

  hasWorkerForTier(tier: RealmTier): boolean {
    return this.workers.has(tier);
  }

  getWorker(tier: RealmTier): RealmWorker | undefined {
    return this.workers.get(tier);
  }

  /**
   * Initialize a realm on the appropriate worker.
   */
  async initRealm(tier: RealmTier, realmId: number, gravity: [number, number, number]): Promise<boolean> {
    const worker = this.workers.get(tier);
    if (!worker) return false;
    worker.addRealm(realmId);
    const req: RealmWorkerRequest = { type: "INIT_REALM", realmId, tier, gravity };
    await worker.request(req);
    return true;
  }

  /**
   * Step a realm on its worker. Returns the wall time in ms, or 0 if
   * no worker is available (caller should step in-process).
   */
  async stepRealm(tier: RealmTier, realmId: number, dt: number, solverIterations: number): Promise<number> {
    const worker = this.workers.get(tier);
    if (!worker || !worker.hasRealm(realmId)) return 0;
    const req: RealmWorkerRequest = { type: "STEP_REALM", realmId, dt, solverIterations };
    const resp = await worker.request(req);
    if (resp.type === "STEP_RESULT") return resp.wallTimeMs;
    return 0;
  }

  /**
   * Create a body on the worker for the given realm.
   */
  async createBody(tier: RealmTier, realmId: number, bodyId: number, desc: BodyDesc, entity: Entity): Promise<boolean> {
    const worker = this.workers.get(tier);
    if (!worker) return false;
    const req: RealmWorkerRequest = { type: "CREATE_BODY", realmId, bodyId, desc, entity };
    const resp = await worker.request(req);
    return resp.type === "CREATE_BODY_RESULT" && resp.success;
  }

  /**
   * Destroy a body on the worker.
   */
  async destroyBody(tier: RealmTier, realmId: number, bodyId: number): Promise<void> {
    const worker = this.workers.get(tier);
    if (!worker) return;
    const req: RealmWorkerRequest = { type: "DESTROY_BODY", realmId, bodyId };
    await worker.request(req);
  }

  /**
   * Add a collider on the worker.
   */
  async addCollider(tier: RealmTier, realmId: number, bodyId: number, colliderId: number, desc: ColliderDesc): Promise<boolean> {
    const worker = this.workers.get(tier);
    if (!worker) return false;
    const req: RealmWorkerRequest = { type: "ADD_COLLIDER", realmId, bodyId, colliderId, desc };
    const resp = await worker.request(req);
    return resp.type === "ADD_COLLIDER_RESULT" && resp.success;
  }

  /**
   * Read transforms from the worker into the provided buffer.
   * The buffer is transferred to the worker and back.
   */
  async readTransforms(tier: RealmTier, realmId: number, buffer: Float32Array, entityCount: number): Promise<Float32Array> {
    const worker = this.workers.get(tier);
    if (!worker) return buffer;
    const req: RealmWorkerRequest = { type: "READ_TRANSFORMS", realmId, buffer, entityCount };
    const resp = await worker.request(req, [buffer.buffer]);
    if (resp.type === "READ_TRANSFORMS_RESULT") return resp.buffer;
    return buffer;
  }

  /**
   * Snapshot a realm on the worker.
   */
  async snapshotRealm(tier: RealmTier, realmId: number): Promise<Uint8Array | null> {
    const worker = this.workers.get(tier);
    if (!worker) return null;
    const req: RealmWorkerRequest = { type: "SNAPSHOT_REALM", realmId };
    const resp = await worker.request(req);
    if (resp.type === "SNAPSHOT_RESULT") return resp.data;
    return null;
  }

  /**
   * Restore a realm on the worker from snapshot data.
   */
  async restoreRealm(tier: RealmTier, realmId: number, data: Uint8Array): Promise<boolean> {
    const worker = this.workers.get(tier);
    if (!worker) return false;
    const req: RealmWorkerRequest = { type: "RESTORE_REALM", realmId, data };
    const resp = await worker.request(req, [data.buffer]);
    return resp.type === "RESTORE_REALM_RESULT" && resp.success;
  }

  /**
   * Destroy a realm on the worker.
   */
  async destroyRealm(tier: RealmTier, realmId: number): Promise<void> {
    const worker = this.workers.get(tier);
    if (!worker) return;
    worker.removeRealm(realmId);
    const req: RealmWorkerRequest = { type: "DESTROY_REALM", realmId };
    await worker.request(req);
  }

  destroy(): void {
    for (const worker of this.workers.values()) {
      worker.terminate();
    }
    this.workers.clear();
    this.initialized = false;
  }
}

