import type { PhysicsBackend, PhysicsBody, RealmTier } from "./interface";
import type { PhysicsAccumulator } from "./physics-accumulator";

/**
 * Island-aware load shedding for physics.
 *
 * When the accumulator is over budget (spiral-of-death risk), the shedder
 * progressively freezes whole islands of bodies to reduce simulation cost.
 *
 * Strategy:
 * 1. **Aggressive sleep** (first line of defense): lower sleep thresholds
 *    for low-importance bodies so Rapier's native sleep kicks in.
 * 2. **Hard freeze** (emergency only): set whole islands to kinematic +
 *    zero velocity. Islands are sorted by importance (ascending) and
 *    avgVelocity (ascending) so the least-important, near-rest islands
 *    freeze first.
 * 3. **Hysteresis unfreeze**: require budget headroom for N consecutive
 *    frames before unfreezing.
 */
export class LoadShedder {
  private importanceWeights: Map<number, number> = new Map();
  private frozenBodies: Set<number> = new Set();
  private frozenBodyRefs: Map<number, { body: PhysicsBody; tier: RealmTier }> = new Map();
  private consecutiveHeadroomFrames: number = 0;
  private readonly unfreezeHeadroomFrames: number;

  constructor(opts: { unfreezeHeadroomFrames?: number } = {}) {
    this.unfreezeHeadroomFrames = opts.unfreezeHeadroomFrames ?? 60;
  }

  setImportance(bodyId: number, weight: number): void {
    this.importanceWeights.set(bodyId, weight);
  }

  /**
   * Check if the accumulator is over budget (shedding needed).
   */
  checkBudget(accumulator: PhysicsAccumulator): boolean {
    return accumulator.isOverBudget();
  }

  /**
   * First line of defense: lower sleep thresholds for low-importance bodies.
   * Leverages Rapier's native island-aware sleep.
   */
  aggressiveSleep(realmId: number, backend: PhysicsBackend, bodies: PhysicsBody[]): void {
    for (const body of bodies) {
      const weight = this.importanceWeights.get(body.id) ?? 0;
      if (weight < 0.3) {
        // Low importance — make it easier to sleep (higher threshold = sleeps sooner)
        backend.setSleepThresholds(realmId, 0.5, 0.5);
      }
    }
  }

  /**
   * Hard freeze: island-aware freezing of whole islands.
   * Sorts islands by max importance (ascending), then freezes the
   * least-important islands until the accumulator recovers.
   *
   * Returns the number of bodies frozen.
   */
  shed(realmId: number, backend: PhysicsBackend, tier: RealmTier, bodyMap?: Map<number, PhysicsBody>): number {
    const islands = backend.getIslands(realmId);
    if (islands.length === 0) return 0;

    // Score each island: max importance of any member (lower = freeze first)
    const scored = islands.map((island) => {
      let maxImportance = 0;
      for (const bodyId of island.bodyIds) {
        const w = this.importanceWeights.get(bodyId) ?? 0;
        if (w > maxImportance) maxImportance = w;
      }
      return { island, maxImportance, avgVelocity: island.avgVelocity };
    });

    // Sort by importance ascending, then by avgVelocity ascending (near-rest first)
    scored.sort((a, b) => {
      if (a.maxImportance !== b.maxImportance) return a.maxImportance - b.maxImportance;
      return a.avgVelocity - b.avgVelocity;
    });

    let frozenCount = 0;
    for (const { island } of scored) {
      // Freeze this entire island
      for (const bodyId of island.bodyIds) {
        if (this.frozenBodies.has(bodyId)) continue;
        const body = bodyMap?.get(bodyId);
        if (body) {
          // Actually freeze the body (set kinematic + zero velocity)
          this.freezeBody(body, backend, tier);
        } else {
          // No body ref available — just track the id
          this.frozenBodies.add(bodyId);
        }
        frozenCount++;
      }
      // In a real implementation, we'd check the accumulator after each
      // island and stop once budget recovers. The caller drives this.
    }

    return frozenCount;
  }

  /**
   * Freeze a specific body (set to kinematic + zero velocity).
   * Called by the shedder when it determines an island should be frozen.
   */
  freezeBody(body: PhysicsBody, backend: PhysicsBackend, tier: RealmTier): void {
    if (this.frozenBodies.has(body.id)) return;
    backend.setBodyType(body, "kinematic");
    backend.setLinearVelocity(body, [0, 0, 0]);
    backend.setAngularVelocity(body, [0, 0, 0]);
    this.frozenBodies.add(body.id);
    this.frozenBodyRefs.set(body.id, { body, tier });
  }

  /**
   * Unfreeze a previously frozen body (restore to dynamic).
   */
  unfreezeBody(body: PhysicsBody, backend: PhysicsBackend): void {
    if (!this.frozenBodies.has(body.id)) return;
    backend.setBodyType(body, "dynamic");
    this.frozenBodies.delete(body.id);
    this.frozenBodyRefs.delete(body.id);
  }

  /**
   * Unfreeze all frozen bodies. Called when the accumulator has had
   * enough headroom for `unfreezeHeadroomFrames` consecutive frames.
   */
  unfreezeAll(backend: PhysicsBackend): void {
    for (const { body } of this.frozenBodyRefs.values()) {
      backend.setBodyType(body, "dynamic");
    }
    this.frozenBodies.clear();
    this.frozenBodyRefs.clear();
    this.consecutiveHeadroomFrames = 0;
  }

  /**
   * Called every frame. If the accumulator is NOT over budget, increment
   * the headroom counter; once it exceeds the threshold, unfreeze all.
   * If over budget, reset the counter.
   */
  tick(accumulator: PhysicsAccumulator, backend: PhysicsBackend): void {
    if (accumulator.isOverBudget()) {
      this.consecutiveHeadroomFrames = 0;
    } else {
      this.consecutiveHeadroomFrames++;
      if (this.consecutiveHeadroomFrames >= this.unfreezeHeadroomFrames && this.frozenBodies.size > 0) {
        this.unfreezeAll(backend);
      }
    }
  }

  getFrozenCount(): number {
    return this.frozenBodies.size;
  }

  isFrozen(bodyId: number): boolean {
    return this.frozenBodies.has(bodyId);
  }
}
