import { Component } from "../ecs/component";
import type { ColliderShape } from "./interface";

export interface ColliderData {
  [key: string]: unknown;
  shape: ColliderShape;
  friction: number;
  restitution: number;
  density: number;
  sensor: boolean;
  collisionGroups: number;
  solverGroups: number;
  colliderId: number;
}

export const Collider = Component.register<ColliderData>("Collider", {
  shape: { type: "box", halfExtents: [0.5, 0.5, 0.5] },
  friction: 0.5,
  restitution: 0.0,
  density: 1.0,
  sensor: false,
  collisionGroups: 0xffffffff,
  solverGroups: 0xffffffff,
  colliderId: -1,
});

export function createBoxCollider(halfExtents: [number, number, number]): ColliderData {
  return Collider.create({
    shape: { type: "box", halfExtents },
  });
}

export function createSphereCollider(radius: number): ColliderData {
  return Collider.create({
    shape: { type: "sphere", radius },
  });
}

export function createCapsuleCollider(halfHeight: number, radius: number): ColliderData {
  return Collider.create({
    shape: { type: "capsule", halfHeight, radius },
  });
}

export function createMeshCollider(vertices: Float32Array, indices: Uint32Array): ColliderData {
  return Collider.create({
    shape: { type: "mesh", vertices, indices },
  });
}

export function createConvexCollider(vertices: Float32Array): ColliderData {
  return Collider.create({
    shape: { type: "convex", vertices },
  });
}
