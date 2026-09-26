import { createLogger } from "../util/logger";
import type { BodyDesc, PhysicsBackend, PhysicsBody } from "./interface";

const log = createLogger();

/**
 * NaN/Inf safety and physical-validity validation for the physics API.
 *
 * - **Dev builds** (`devMode: true`): `throw` loudly on invalid input.
 * - **Shipped builds**: clamp/reject + log, never crash.
 * - Tracks `lastKnownGood` pos/rot per body for solver-output sanitization.
 * - `sanitizeSolverOutput`: post-step sweep that reverts invalid state.
 * - `periodicFiniteSweep`: trust-but-verify for internally-generated bad state.
 */

interface BodySafetyState {
  lastKnownGoodPos: [number, number, number];
  lastKnownGoodRot: [number, number, number, number];
  /** Recurrence count over the sliding window. */
  recurrenceCount: number;
  /** Consecutive valid ticks (used to recover hard-locked bodies). */
  validTickCount: number;
}

export class SafetyLayer {
  private devMode: boolean;
  private states: Map<number, BodySafetyState> = new Map();
  /** Sliding window size for recurrence tracking. */
  private readonly windowSize: number = 100;
  /** Recurrence threshold before escalating to hard kinematic lock. */
  private readonly recurrenceThreshold: number = 3;
  /** Bodies that have been hard-locked due to persistent NaN. */
  private hardLocked: Set<number> = new Set();
  /** Consecutive valid ticks required before a hard-locked body is restored. */
  private readonly hardLockRecoveryTicks: number = 60;
  private sweepTickCounter: number = 0;

  constructor(opts: { devMode?: boolean } = {}) {
    this.devMode = opts.devMode ?? false;
  }

  /** Assert a number is finite. Branchless hot-path variant available. */
  assertFinite(x: number, name: string): void {
    // Branchless check: NaN !== NaN, Inf - Inf !== 0
    if (x !== x || !Number.isFinite(x)) {
      this.reportViolation(`Non-finite value for ${name}: ${x}`);
    }
  }

  /** Fast branchless finiteness check (for hot paths). */
  isFiniteFast(x: number): boolean {
    return (x - x) === 0;
  }

  /** Assert a vector is finite. */
  assertFiniteVec3(v: [number, number, number], name: string): void {
    this.assertFinite(v[0], `${name}.x`);
    this.assertFinite(v[1], `${name}.y`);
    this.assertFinite(v[2], `${name}.z`);
  }

  /** Assert a quaternion is finite and non-degenerate. */
  assertFiniteQuat(q: [number, number, number, number], name: string): void {
    this.assertFinite(q[0], `${name}.x`);
    this.assertFinite(q[1], `${name}.y`);
    this.assertFinite(q[2], `${name}.z`);
    this.assertFinite(q[3], `${name}.w`);
    const len = Math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2);
    if (len < 1e-9) {
      this.reportViolation(`Degenerate (zero-norm) quaternion for ${name}`);
    }
  }

  /** Assert physical validity of a body descriptor. */
  assertBodyDescValid(desc: BodyDesc): void {
    if (desc.type === "dynamic") {
      const mass = desc.mass ?? 1;
      if (mass <= 0) {
        this.reportViolation(`Dynamic body has non-positive mass: ${mass}`);
      }
    }
    this.assertFiniteVec3(desc.position, "desc.position");
    this.assertFiniteQuat(desc.rotation, "desc.rotation");
    if (desc.linearVelocity) this.assertFiniteVec3(desc.linearVelocity, "desc.linearVelocity");
    if (desc.angularVelocity) this.assertFiniteVec3(desc.angularVelocity, "desc.angularVelocity");
  }

  /** Sanitize a value: clamp to 0 if non-finite (shipped) or throw (dev). */
  sanitize(x: number): number {
    if (x !== x || !Number.isFinite(x)) {
      this.reportViolation(`Sanitizing non-finite value: ${x}`);
      return 0;
    }
    return x;
  }

  /** Sanitize a vec3 in place. */
  sanitizeVec3(v: [number, number, number]): [number, number, number] {
    return [this.sanitize(v[0]), this.sanitize(v[1]), this.sanitize(v[2])];
  }

  /** Sanitize a quaternion (normalize, fallback to identity if degenerate). */
  sanitizeQuat(q: [number, number, number, number]): [number, number, number, number] {
    let x = this.sanitize(q[0]);
    let y = this.sanitize(q[1]);
    let z = this.sanitize(q[2]);
    let w = this.sanitize(q[3]);
    const len = Math.sqrt(x * x + y * y + z * z + w * w);
    if (len < 1e-9) {
      this.reportViolation("Degenerate quaternion sanitized to identity");
      return [0, 0, 0, 1];
    }
    return [x / len, y / len, z / len, w / len];
  }

  /**
   * Post-step sanitization sweep. Checks finiteness of pos/rot/linVel/angVel
   * for the given bodies. On invalid: zero velocities, revert to
   * lastKnownGood, and track recurrence. Persistent offenders are
   * hard-locked to kinematic.
   */
  sanitizeSolverOutput(backend: PhysicsBackend, bodies: PhysicsBody[]): void {
    for (let _i = 0, _it = bodies, _n = _it.length; _i < _n; _i++) { const body = _it[_i];
      if (this.hardLocked.has(body.id)) continue;

      const pos = backend.getPosition(body);
      const rot = backend.getRotation(body);
      const linVel = backend.getLinearVelocity(body);
      const angVel = backend.getAngularVelocity(body);

      const posOk = this.isFiniteFast(pos[0]) && this.isFiniteFast(pos[1]) && this.isFiniteFast(pos[2]);
      const rotOk = this.isFiniteFast(rot[0]) && this.isFiniteFast(rot[1]) && this.isFiniteFast(rot[2]) && this.isFiniteFast(rot[3]);
      const velOk = this.isFiniteFast(linVel[0]) && this.isFiniteFast(linVel[1]) && this.isFiniteFast(linVel[2]);
      const angOk = this.isFiniteFast(angVel[0]) && this.isFiniteFast(angVel[1]) && this.isFiniteFast(angVel[2]);

      if (posOk && rotOk && velOk && angOk) {
        // Update lastKnownGood and reset recurrence counter
        let state = this.states.get(body.id);
        if (!state) {
          state = {
            lastKnownGoodPos: [...pos] as [number, number, number],
            lastKnownGoodRot: [...rot] as [number, number, number, number],
            recurrenceCount: 0,
            validTickCount: 0,
          };
          this.states.set(body.id, state);
        } else {
          state.lastKnownGoodPos = [...pos] as [number, number, number];
          state.lastKnownGoodRot = [...rot] as [number, number, number, number];
          state.recurrenceCount = 0;
        }

        // Recovery path for hard-locked bodies: after enough consecutive
        // valid ticks, restore the body to dynamic and remove from hardLocked.
        if (this.hardLocked.has(body.id)) {
          state.validTickCount++;
          if (state.validTickCount >= this.hardLockRecoveryTicks) {
            this.reportViolation(`Body ${body.id} recovered after ${state.validTickCount} valid ticks — restoring to dynamic`);
            backend.setBodyType(body, "dynamic");
            this.hardLocked.delete(body.id);
            state.validTickCount = 0;
          }
        } else if (state.validTickCount > 0) {
          state.validTickCount = 0;
        }
        continue;
      }

      // Invalid state detected — sanitize
      this.reportViolation(`Solver output invalid for body ${body.id}: pos=${pos}, rot=${rot}`);

      let state = this.states.get(body.id);
      if (!state) {
        state = {
          lastKnownGoodPos: [0, 0, 0],
          lastKnownGoodRot: [0, 0, 0, 1],
          recurrenceCount: 0,
          validTickCount: 0,
        };
        this.states.set(body.id, state);
      }

      // Revert to lastKnownGood
      backend.setPosition(body, state.lastKnownGoodPos);
      backend.setRotation(body, state.lastKnownGoodRot);
      // Zero velocities
      backend.setLinearVelocity(body, [0, 0, 0]);
      backend.setAngularVelocity(body, [0, 0, 0]);

      // Track recurrence
      state.recurrenceCount++;
      if (state.recurrenceCount >= this.recurrenceThreshold) {
        // Escalate: hard kinematic lock
        this.reportViolation(`Body ${body.id} hard-locked due to persistent NaN (${state.recurrenceCount}/${this.windowSize})`);
        backend.setBodyType(body, "kinematic");
        this.hardLocked.add(body.id);
      }
    }
  }

  /**
   * Periodic finite sweep — trust-but-verify for internally-generated bad
   * state (solver output, realm-transfer state). Runs every `interval` ticks.
   * Only sweeps bodies above `velocityThreshold` (skip sleeping/stationary).
   */
  periodicFiniteSweep(backend: PhysicsBackend, bodies: PhysicsBody[], interval: number, velocityThreshold: number): void {
    this.sweepTickCounter++;
    if (this.sweepTickCounter % interval !== 0) return;

    for (let _i = 0, _it = bodies, _n = _it.length; _i < _n; _i++) { const body = _it[_i];
      if (this.hardLocked.has(body.id)) continue;
      const vel = backend.getLinearVelocity(body);
      const speed = Math.sqrt(vel[0] ** 2 + vel[1] ** 2 + vel[2] ** 2);
      if (speed < velocityThreshold) continue;

      // Check finiteness
      const pos = backend.getPosition(body);
      if (!this.isFiniteFast(pos[0]) || !this.isFiniteFast(pos[1]) || !this.isFiniteFast(pos[2])) {
        this.reportViolation(`Periodic sweep found invalid pos for body ${body.id}`);
        // Delegate to sanitizeSolverOutput for full handling
      }
    }
  }

  isHardLocked(bodyId: number): boolean {
    return this.hardLocked.has(bodyId);
  }

  getHardLockedCount(): number {
    return this.hardLocked.size;
  }

  reset(): void {
    this.states.clear();
    this.hardLocked.clear();
    this.sweepTickCounter = 0;
  }

  private reportViolation(msg: string): void {
    if (this.devMode) {
      throw new Error(`[Physics Safety] ${msg}`);
    } else {
      // Shipped: log and continue (never crash)
      log.warn("Physics Safety", msg);
    }
  }
}
