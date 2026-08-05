import type { BodyDesc, ColliderDesc, Entity, RealmTier } from "./interface";

/**
 * Protocol messages for realm worker communication.
 * The host (RealmWorkerPool) sends requests; the worker sends responses.
 */

export type RealmWorkerRequest =
  | { type: "INIT_REALM"; realmId: number; tier: RealmTier; gravity: [number, number, number] }
  | { type: "STEP_REALM"; realmId: number; dt: number; solverIterations: number }
  | { type: "CREATE_BODY"; realmId: number; bodyId: number; desc: BodyDesc; entity: Entity }
  | { type: "DESTROY_BODY"; realmId: number; bodyId: number }
  | { type: "ADD_COLLIDER"; realmId: number; bodyId: number; colliderId: number; desc: ColliderDesc }
  | { type: "READ_TRANSFORMS"; realmId: number; buffer: Float32Array; entityCount: number }
  | { type: "SNAPSHOT_REALM"; realmId: number }
  | { type: "RESTORE_REALM"; realmId: number; data: Uint8Array }
  | { type: "DESTROY_REALM"; realmId: number }
  | { type: "DESTROY_ALL" };

export type RealmWorkerResponse =
  | { type: "STEP_RESULT"; realmId: number; wallTimeMs: number }
  | { type: "READ_TRANSFORMS_RESULT"; realmId: number; buffer: Float32Array }
  | { type: "SNAPSHOT_RESULT"; realmId: number; data: Uint8Array }
  | { type: "CREATE_BODY_RESULT"; realmId: number; bodyId: number; success: boolean }
  | { type: "DESTROY_BODY_RESULT"; realmId: number; bodyId: number }
  | { type: "ADD_COLLIDER_RESULT"; realmId: number; colliderId: number; success: boolean }
  | { type: "RESTORE_REALM_RESULT"; realmId: number; success: boolean }
  | { type: "ERROR"; message: string; realmId?: number };

export type RealmWorkerMessage = RealmWorkerRequest | RealmWorkerResponse;
