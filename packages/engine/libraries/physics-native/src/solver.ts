// ============================================================================
// Solver — Impulse-based collision response + position correction
//
// Resolves velocity constraints (restitution + friction) and applies positional
// correction (Baumgarte stabilization) to prevent sinking.
// ============================================================================

import type { ContactManifoldLocal } from "./narrowphase";
import type { Vec3 } from "./types";

export interface BodyData {
  position: Vec3;
  rotation: [number, number, number, number];
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  mass: number;
  invMass: number;
  invInertia: number; // simplified: scalar for now
  restitution: number;
  friction: number;
  isStatic: boolean;
  isKinematic: boolean;
}

/**
 * Resolve a single contact manifold between two bodies.
 * Mutates body velocities in-place.
 */
export function resolveContact(
  a: BodyData,
  b: BodyData,
  manifold: ContactManifoldLocal,
): void {
  if (a.isStatic && b.isStatic) return;
  if (a.isKinematic && b.isKinematic) return;

  const normal = manifold.normal;
  const penetration = manifold.penetrationDepth;

  // --- Positional correction (Baumgarte) ---
  const percent = 0.4; // penetration slop correction factor
  const slop = 0.01;   // penetration allowance
  const correctionMag = Math.max(penetration - slop, 0) * percent;
  const totalInvMass = a.invMass + b.invMass;
  if (totalInvMass > 0) {
    const correction = scale(normal, correctionMag / totalInvMass);
    if (!a.isStatic && !a.isKinematic) {
      a.position = sub(a.position, scale(correction, a.invMass));
    }
    if (!b.isStatic && !b.isKinematic) {
      b.position = add(b.position, scale(correction, b.invMass));
    }
  }

  // --- Velocity resolution ---
  for (let _i = 0, _it = manifold.points, _n = _it.length; _i < _n; _i++) { const cp = _it[_i];
    const ra = sub(cp.point, a.position);
    const rb = sub(cp.point, b.position);

    // Velocities at contact point (simplified: no angular contribution for now)
    const velA = a.linearVelocity;
    const velB = b.linearVelocity;
    const relVel = sub(velB, velA);
    const velAlongNormal = dot(relVel, normal);

    if (velAlongNormal > 0) continue; // separating

    const e = Math.min(a.restitution, b.restitution);
    const j = -(1 + e) * velAlongNormal / totalInvMass;

    const impulse = scale(normal, j);
    if (!a.isStatic && !a.isKinematic) {
      a.linearVelocity = sub(a.linearVelocity, scale(impulse, a.invMass));
    }
    if (!b.isStatic && !b.isKinematic) {
      b.linearVelocity = add(b.linearVelocity, scale(impulse, b.invMass));
    }

    // --- Friction (simplified Coulomb) ---
    const tangent = sub(relVel, scale(normal, dot(relVel, normal)));
    const tangentLen = length(tangent);
    if (tangentLen < 1e-6) continue;

    const tangentDir = scale(tangent, 1 / tangentLen);
    const frictionCoef = Math.sqrt(a.friction * b.friction);
    const jt = -dot(relVel, tangentDir) / totalInvMass;
    const jtMax = frictionCoef * Math.abs(j);
    const jtClamped = Math.max(-jtMax, Math.min(jtMax, jt));

    const frictionImpulse = scale(tangentDir, jtClamped);
    if (!a.isStatic && !a.isKinematic) {
      a.linearVelocity = sub(a.linearVelocity, scale(frictionImpulse, a.invMass));
    }
    if (!b.isStatic && !b.isKinematic) {
      b.linearVelocity = add(b.linearVelocity, scale(frictionImpulse, b.invMass));
    }
  }
}

/**
 * Integrate body position and apply gravity.
 */
export function integrate(body: BodyData, gravity: Vec3, dt: number): void {
  if (body.isStatic || body.isKinematic) return;

  // Validate finiteness of inputs to prevent NaN/Inf propagation
  if (!Number.isFinite(dt) ||
      !Number.isFinite(gravity[0]) || !Number.isFinite(gravity[1]) || !Number.isFinite(gravity[2]) ||
      !Number.isFinite(body.linearVelocity[0]) || !Number.isFinite(body.linearVelocity[1]) || !Number.isFinite(body.linearVelocity[2]) ||
      !Number.isFinite(body.position[0]) || !Number.isFinite(body.position[1]) || !Number.isFinite(body.position[2])) {
    return;
  }

  // Apply gravity
  body.linearVelocity = add(body.linearVelocity, scale(gravity, dt));

  // Integrate position
  body.position = add(body.position, scale(body.linearVelocity, dt));
}

// --- Vec3 helpers (local to solver to avoid import cycle) ---

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}
