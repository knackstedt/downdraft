// ============================================================================
// Types — Shared types for the native physics backend
// ============================================================================

export type Vec3 = [number, number, number];

export type Quat = [number, number, number, number];

export interface NativeBody {
  id: number;
  realmId: number;
  type: "static" | "dynamic" | "kinematic";
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  mass: number;
  invMass: number;
  restitution: number;
  friction: number;
  gravityScale: number;
  linearDamping: number;
  angularDamping: number;
  ccdEnabled: boolean;
  canSleep: boolean;
  sleeping: boolean;
  lockedTranslation: [boolean, boolean, boolean] | null;
  lockedRotation: [boolean, boolean, boolean] | null;
  colliders: NativeCollider[];
  entityIndex: number;
  entityGeneration: number;
}

export interface NativeCollider {
  id: number;
  shape: ColliderShapeData;
  friction: number;
  restitution: number;
  density: number;
  sensor: boolean;
  collisionGroups: number;
  solverGroups: number;
}

export type ColliderShapeData =
  | { type: "box"; halfExtents: [number, number, number] }
  | { type: "sphere"; radius: number }
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "mesh"; vertices: Float32Array; indices: Uint32Array }
  | { type: "convex"; vertices: Float32Array }
  | { type: "heightfield"; nrows: number; ncols: number; heights: Float32Array; scale: [number, number, number] };

export interface NativeRealm {
  id: number;
  name: string;
  gravity: Vec3;
  bodies: Map<number, NativeBody>;
  nextBodyId: number;
  nextColliderId: number;
  broadphaseCellSize: number;
}

export interface NativeCharacterController {
  id: number;
  realmId: number;
  bodyId: number;
  entityIndex: number;
  entityGeneration: number;
  offset: Vec3;
  radius: number;
  halfHeight: number;
  slide: boolean;
  autostep: { enabled: boolean; minWidth: number; maxHeight: number };
  maxSlope: number;
  snapToGround: number;
}
