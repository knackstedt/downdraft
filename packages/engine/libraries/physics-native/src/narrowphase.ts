// ============================================================================
// Narrowphase — Shape-specific collision detection
//
// Computes contact manifolds (normal, penetration depth, contact points) for
// pairs of collider shapes: box-box, sphere-sphere, sphere-box, capsule
// shapes. Returns null for non-colliding pairs.
// ============================================================================

import type { ColliderShape } from "@downdraft/core/physics/interface";
import type { Vec3 } from "./types";
import {
  boxBoxContact,
  sphereSphereContact,
  sphereBoxContact,
  capsuleBoxContact,
  capsuleSphereContact,
  capsuleCapsuleContact,
} from "./narrowphase-shapes";

export interface ContactPoint {
  point: Vec3;
  penetration: number;
}

export interface ContactManifoldLocal {
  normal: Vec3;       // collision normal pointing from A to B
  points: ContactPoint[];
  penetrationDepth: number;
}

export function detectCollision(
  shapeA: ColliderShape,
  posA: Vec3,
  rotA: [number, number, number, number],
  shapeB: ColliderShape,
  posB: Vec3,
  rotB: [number, number, number, number],
): ContactManifoldLocal | null {
  const typeA = shapeA.type;
  const typeB = shapeB.type;

  if (typeA === "sphere" && typeB === "sphere") {
    return sphereSphereContact(
      posA, shapeA.radius,
      posB, shapeB.radius,
    );
  }

  if (typeA === "sphere" && typeB === "box") {
    return sphereBoxContact(
      posA, shapeA.radius,
      posB, rotB, shapeB.halfExtents,
    );
  }

  if (typeA === "box" && typeB === "sphere") {
    const result = sphereBoxContact(
      posB, shapeB.radius,
      posA, rotA, shapeA.halfExtents,
    );
    if (!result) return null;
    // Flip normal to point from A to B
    return {
      ...result,
      normal: [-result.normal[0], -result.normal[1], -result.normal[2]] as Vec3,
    };
  }

  if (typeA === "box" && typeB === "box") {
    return boxBoxContact(
      posA, rotA, shapeA.halfExtents,
      posB, rotB, shapeB.halfExtents,
    );
  }

  if (typeA === "capsule" && typeB === "box") {
    return capsuleBoxContact(
      posA, rotA, shapeA.halfHeight, shapeA.radius,
      posB, rotB, shapeB.halfExtents,
    );
  }

  if (typeA === "box" && typeB === "capsule") {
    const result = capsuleBoxContact(
      posB, rotB, shapeB.halfHeight, shapeB.radius,
      posA, rotA, shapeA.halfExtents,
    );
    if (!result) return null;
    return {
      ...result,
      normal: [-result.normal[0], -result.normal[1], -result.normal[2]] as Vec3,
    };
  }

  if (typeA === "capsule" && typeB === "sphere") {
    return capsuleSphereContact(
      posA, rotA, shapeA.halfHeight, shapeA.radius,
      posB, shapeB.radius,
    );
  }

  if (typeA === "sphere" && typeB === "capsule") {
    const result = capsuleSphereContact(
      posB, rotB, shapeB.halfHeight, shapeB.radius,
      posA, shapeA.radius,
    );
    if (!result) return null;
    return {
      ...result,
      normal: [-result.normal[0], -result.normal[1], -result.normal[2]] as Vec3,
    };
  }

  if (typeA === "capsule" && typeB === "capsule") {
    return capsuleCapsuleContact(
      posA, rotA, shapeA.halfHeight, shapeA.radius,
      posB, rotB, shapeB.halfHeight, shapeB.radius,
    );
  }

  // Mesh/convex shapes: not supported in native narrowphase
  return null;
}
