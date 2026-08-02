// ============================================================================
// Narrowphase shape functions — SAT and distance-based collision detection
//
// Each function returns a ContactManifoldLocal or null. Normal points from A
// to B. All positions are world-space centers.
// ============================================================================

import type { Vec3 } from "./types.ts";
import type { ContactManifoldLocal, ContactPoint } from "./narrowphase.ts";

// --- Math helpers ---

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-9) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/**
 * Rotate a vector by a quaternion (xyzw).
 */
export function rotateVec(v: Vec3, q: [number, number, number, number]): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  // result = v + qw * t + cross(q.xyz, t)
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Get the three axis vectors of a box from its quaternion.
 */
function boxAxes(q: [number, number, number, number]): Vec3[] {
  return [
    rotateVec([1, 0, 0], q),
    rotateVec([0, 1, 0], q),
    rotateVec([0, 0, 1], q),
  ];
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// --- Sphere-Sphere ---

export function sphereSphereContact(
  posA: Vec3, radiusA: number,
  posB: Vec3, radiusB: number,
): ContactManifoldLocal | null {
  const delta = sub(posB, posA);
  const dist = length(delta);
  const sumRadii = radiusA + radiusB;
  if (dist >= sumRadii) return null;

  const normal = dist > 1e-9 ? scale(delta, 1 / dist) : [0, 1, 0] as Vec3;
  const penetration = sumRadii - dist;
  const contactPoint = add(posA, scale(normal, radiusA - penetration * 0.5));

  return {
    normal: normal as Vec3,
    penetrationDepth: penetration,
    points: [{ point: contactPoint, penetration }],
  };
}

// --- Sphere-Box ---

export function sphereBoxContact(
  spherePos: Vec3, sphereRadius: number,
  boxPos: Vec3, boxRot: [number, number, number, number],
  boxHalf: [number, number, number],
): ContactManifoldLocal | null {
  // Transform sphere center into box local space
  const invRot = [boxRot[0], boxRot[1], boxRot[2], -boxRot[3]] as [number, number, number, number];
  const localSphere = rotateVec(sub(spherePos, boxPos), invRot);

  // Clamp to box to find closest point
  const closest: Vec3 = [
    clamp(localSphere[0], -boxHalf[0], boxHalf[0]),
    clamp(localSphere[1], -boxHalf[1], boxHalf[1]),
    clamp(localSphere[2], -boxHalf[2], boxHalf[2]),
  ];

  const localDelta = sub(localSphere, closest);
  const distSq = dot(localDelta, localDelta);
  if (distSq >= sphereRadius * sphereRadius) return null;

  const dist = Math.sqrt(distSq);
  let localNormal: Vec3;
  let penetration: number;

  if (dist > 1e-9) {
    localNormal = scale(localDelta, 1 / dist);
    penetration = sphereRadius - dist;
  } else {
    // Sphere center is inside the box — push out along the axis of least penetration
    const penX = boxHalf[0] - Math.abs(localSphere[0]);
    const penY = boxHalf[1] - Math.abs(localSphere[1]);
    const penZ = boxHalf[2] - Math.abs(localSphere[2]);
    if (penX <= penY && penX <= penZ) {
      localNormal = [Math.sign(localSphere[0]) || 1, 0, 0];
      penetration = penX + sphereRadius;
    } else if (penY <= penZ) {
      localNormal = [0, Math.sign(localSphere[1]) || 1, 0];
      penetration = penY + sphereRadius;
    } else {
      localNormal = [0, 0, Math.sign(localSphere[2]) || 1];
      penetration = penZ + sphereRadius;
    }
  }

  // Transform normal back to world space
  const worldNormal = rotateVec(localNormal, boxRot);
  const worldClosest = add(boxPos, rotateVec(closest, boxRot));
  // Normal points from box to sphere; we need A to B = box to sphere
  // But caller expects A=sphere, B=box so normal should be sphere to box = negated
  const normalAtoB = scale(worldNormal, -1) as Vec3;

  return {
    normal: normalAtoB,
    penetrationDepth: penetration,
    points: [{ point: worldClosest, penetration }],
  };
}

// --- Box-Box (SAT) ---

export function boxBoxContact(
  posA: Vec3, rotA: [number, number, number, number], halfA: [number, number, number],
  posB: Vec3, rotB: [number, number, number, number], halfB: [number, number, number],
): ContactManifoldLocal | null {
  const axesA = boxAxes(rotA);
  const axesB = boxAxes(rotB);

  // 15 axes to test: 3 from A, 3 from B, 9 cross products
  const axes: Vec3[] = [...axesA, ...axesB];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const ax = cross(axesA[i], axesB[j]);
      const len = length(ax);
      if (len > 1e-9) {
        axes.push(scale(ax, 1 / len));
      }
    }
  }

  const delta = sub(posB, posA);
  let minPen = Infinity;
  let minAxis: Vec3 = [0, 1, 0];

  for (const axis of axes) {
    const projA = projectBox(posA, axesA, halfA, axis);
    const projB = projectBox(posB, axesB, halfB, axis);
    const overlap = Math.min(projA.max, projB.max) - Math.max(projA.min, projB.min);
    if (overlap <= 0) return null;
    if (overlap < minPen) {
      minPen = overlap;
      minAxis = axis;
      // Ensure normal points from A to B
      if (dot(delta, axis) < 0) {
        minAxis = scale(axis, -1);
      }
    }
  }

  // Contact point: approximate as the midpoint of the overlap region projected
  const contactPoint = add(posA, scale(minAxis, 0)) as Vec3;
  // Better: average of centers projected onto the contact plane
  const centerA = posA;
  const centerB = posB;
  const mid = scale(add(centerA, centerB), 0.5);

  return {
    normal: minAxis,
    penetrationDepth: minPen,
    points: [{ point: mid, penetration: minPen }],
  };
}

function projectBox(
  pos: Vec3,
  axes: Vec3[],
  half: [number, number, number],
  axis: Vec3,
): { min: number; max: number } {
  const center = dot(pos, axis);
  let radius = 0;
  for (let i = 0; i < 3; i++) {
    radius += Math.abs(dot(axes[i], axis)) * half[i];
  }
  return { min: center - radius, max: center + radius };
}

// --- Capsule helpers ---

/**
 * Get the two endpoints of a capsule's axis in world space.
 */
function capsuleEndpoints(
  pos: Vec3,
  rot: [number, number, number, number],
  halfHeight: number,
): [Vec3, Vec3] {
  const up = rotateVec([0, 1, 0], rot);
  const top = add(pos, scale(up, halfHeight));
  const bottom = add(pos, scale(up, -halfHeight));
  return [top, bottom];
}

/**
 * Closest point on a line segment to a point.
 */
function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / dot(ab, ab), 0, 1);
  return add(a, scale(ab, t));
}

/**
 * Closest points between two line segments.
 */
function segmentSegmentClosest(
  a1: Vec3, a2: Vec3,
  b1: Vec3, b2: Vec3,
): { pointA: Vec3; pointB: Vec3; dist: number } {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const r = sub(a1, b1);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s, t;
  if (a <= 1e-9 && e <= 1e-9) {
    s = 0; t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = clamp(-f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-9) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      if (denom > 1e-9) {
        s = clamp((b * f - c * e) / denom, 0, 1);
      } else {
        s = 0;
      }
      t = clamp((b * s + f) / e, 0, 1);
    }
  }

  const pointA = add(a1, scale(d1, s));
  const pointB = add(b1, scale(d2, t));
  const dist = length(sub(pointA, pointB));
  return { pointA, pointB, dist };
}

// --- Capsule-Box ---

export function capsuleBoxContact(
  capPos: Vec3, capRot: [number, number, number, number], capHalfH: number, capRadius: number,
  boxPos: Vec3, boxRot: [number, number, number, number], boxHalf: [number, number, number],
): ContactManifoldLocal | null {
  const [top, bottom] = capsuleEndpoints(capPos, capRot, capHalfH);

  // Transform capsule endpoints into box local space
  const invRot = [boxRot[0], boxRot[1], boxRot[2], -boxRot[3]] as [number, number, number, number];
  const localTop = rotateVec(sub(top, boxPos), invRot);
  const localBottom = rotateVec(sub(bottom, boxPos), invRot);

  // Sample the capsule axis at a few points and find closest on box
  let bestDist = Infinity;
  let bestLocalPoint: Vec3 = [0, 0, 0];
  let bestAxisPoint: Vec3 = [0, 0, 0];

  const samples = 8;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = add(localBottom, scale(sub(localTop, localBottom), t));
    const closest: Vec3 = [
      clamp(p[0], -boxHalf[0], boxHalf[0]),
      clamp(p[1], -boxHalf[1], boxHalf[1]),
      clamp(p[2], -boxHalf[2], boxHalf[2]),
    ];
    const d = length(sub(p, closest));
    if (d < bestDist) {
      bestDist = d;
      bestLocalPoint = closest;
      bestAxisPoint = p;
    }
  }

  if (bestDist >= capRadius) return null;

  const localDelta = sub(bestAxisPoint, bestLocalPoint);
  const dist = bestDist;
  let localNormal: Vec3;
  let penetration: number;

  if (dist > 1e-9) {
    localNormal = scale(localDelta, 1 / dist);
    penetration = capRadius - dist;
  } else {
    // Capsule axis inside box — push out along least penetration axis
    const penX = boxHalf[0] - Math.abs(bestAxisPoint[0]);
    const penY = boxHalf[1] - Math.abs(bestAxisPoint[1]);
    const penZ = boxHalf[2] - Math.abs(bestAxisPoint[2]);
    if (penX <= penY && penX <= penZ) {
      localNormal = [Math.sign(bestAxisPoint[0]) || 1, 0, 0];
      penetration = penX + capRadius;
    } else if (penY <= penZ) {
      localNormal = [0, Math.sign(bestAxisPoint[1]) || 1, 0];
      penetration = penY + capRadius;
    } else {
      localNormal = [0, 0, Math.sign(bestAxisPoint[2]) || 1];
      penetration = penZ + capRadius;
    }
  }

  // Normal points from box to capsule; we need A=capsule to B=box, so negate
  const worldNormal = rotateVec(localNormal, boxRot);
  const normalAtoB = scale(worldNormal, -1) as Vec3;
  const worldContact = add(boxPos, rotateVec(bestLocalPoint, boxRot));

  return {
    normal: normalAtoB,
    penetrationDepth: penetration,
    points: [{ point: worldContact, penetration }],
  };
}

// --- Capsule-Sphere ---

export function capsuleSphereContact(
  capPos: Vec3, capRot: [number, number, number, number], capHalfH: number, capRadius: number,
  spherePos: Vec3, sphereRadius: number,
): ContactManifoldLocal | null {
  const [top, bottom] = capsuleEndpoints(capPos, capRot, capHalfH);
  const closest = closestPointOnSegment(spherePos, bottom, top);
  const delta = sub(spherePos, closest);
  const dist = length(delta);
  const sumRadii = capRadius + sphereRadius;

  if (dist >= sumRadii) return null;

  const normal = dist > 1e-9 ? scale(delta, 1 / dist) : [0, 1, 0] as Vec3;
  const penetration = sumRadii - dist;
  const contactPoint = add(closest, scale(normal, capRadius - penetration * 0.5));

  return {
    normal: normal as Vec3,
    penetrationDepth: penetration,
    points: [{ point: contactPoint, penetration }],
  };
}

// --- Capsule-Capsule ---

export function capsuleCapsuleContact(
  posA: Vec3, rotA: [number, number, number, number], halfHA: number, radiusA: number,
  posB: Vec3, rotB: [number, number, number, number], halfHB: number, radiusB: number,
): ContactManifoldLocal | null {
  const [topA, bottomA] = capsuleEndpoints(posA, rotA, halfHA);
  const [topB, bottomB] = capsuleEndpoints(posB, rotB, halfHB);

  const { pointA, pointB, dist } = segmentSegmentClosest(bottomA, topA, bottomB, topB);
  const sumRadii = radiusA + radiusB;
  if (dist >= sumRadii) return null;

  const normal = dist > 1e-9
    ? normalize(sub(pointB, pointA))
    : [0, 1, 0] as Vec3;
  const penetration = sumRadii - dist;
  const contactPoint = scale(add(pointA, pointB), 0.5);

  return {
    normal: normal as Vec3,
    penetrationDepth: penetration,
    points: [{ point: contactPoint, penetration }],
  };
}
