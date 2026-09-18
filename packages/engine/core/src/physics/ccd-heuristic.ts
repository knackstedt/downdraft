import type { PhysicsBackend, PhysicsBody } from "./interface";

/**
 * Per-object CCD (Continuous Collision Detection) heuristic.
 *
 * Tunneling risk = `speed × dt / colliderSize`. If the risk exceeds
 * `ccdTunnelingRatio` (default 0.5), CCD is enabled for that body.
 *
 * This avoids the global CCD cost by only opting in bodies that are
 * actually at risk of tunneling this tick.
 */
export class CCDHeuristic {
  /** Ratio threshold for enabling CCD (default 0.5). */
  readonly ccdTunnelingRatio: number;

  constructor(opts: { ccdTunnelingRatio?: number } = {}) {
    this.ccdTunnelingRatio = opts.ccdTunnelingRatio ?? 0.5;
  }

  /**
   * Compute whether CCD should be enabled for a body given its velocity,
   * collider size, and the fixed timestep.
   *
   * `colliderSize` is the smallest dimension of the body's colliders
   * (e.g. sphere radius, min box half-extent × 2).
   */
  shouldEnableCCD(velocity: [number, number, number], colliderSize: number, dt: number): boolean {
    if (colliderSize <= 0) return false;
    const speed = Math.sqrt(velocity[0] ** 2 + velocity[1] ** 2 + velocity[2] ** 2);
    const risk = (speed * dt) / colliderSize;
    return risk > this.ccdTunnelingRatio;
  }

  /**
   * Per-tick update: for each dynamic body, check speed vs collider size
   * and enable/disable CCD accordingly.
   *
   * `getColliderSize(body)` returns the smallest collider dimension for
   * the body (caller-provided; the backend doesn't expose collider sizes
   * in a uniform way).
   */
  updateCCD(
    backend: PhysicsBackend,
    bodies: PhysicsBody[],
    dt: number,
    getColliderSize: (body: PhysicsBody) => number,
  ): void {
    for (const body of bodies) {
      const vel = backend.getLinearVelocity(body);
      const size = getColliderSize(body);
      const enable = this.shouldEnableCCD(vel, size, dt);
      backend.setCCDEnabled(body, enable);
    }
  }
}
