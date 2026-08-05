import { Component } from "../ecs/component";
import type { BodyType } from "./interface";

export interface RigidBodyData {
  [key: string]: unknown;
  bodyType: BodyType;
  bodyId: number;
  realmId: number;
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccdEnabled: boolean;
  canSleep: boolean;
  sleeping: boolean;
  lockedTranslation: [boolean, boolean, boolean] | null;
  lockedRotation: [boolean, boolean, boolean] | null;
}

export const RigidBody = Component.register<RigidBodyData>("PhysicsRigidBody", {
  bodyType: "dynamic",
  bodyId: -1,
  realmId: -1,
  mass: 1,
  linearDamping: 0.1,
  angularDamping: 0.1,
  gravityScale: 1,
  ccdEnabled: false,
  canSleep: true,
  sleeping: false,
  lockedTranslation: null,
  lockedRotation: null,
});

export interface VelocityData {
  [key: string]: unknown;
  linear: [number, number, number];
  angular: [number, number, number];
}

export const Velocity = Component.register<VelocityData>("PhysicsVelocity", {
  linear: [0, 0, 0],
  angular: [0, 0, 0],
});

export interface PhysicsTransformData {
  [key: string]: unknown;
  position: [number, number, number];
  rotation: [number, number, number, number];
  prevPosition: [number, number, number];
  prevRotation: [number, number, number, number];
}

export const PhysicsTransform = Component.register<PhysicsTransformData>("PhysicsTransform", {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  prevPosition: [0, 0, 0],
  prevRotation: [0, 0, 0, 1],
});
