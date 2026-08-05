import type { Skeleton } from "../animation/skeleton";
import type { ComponentDefinition } from "../ecs/component";
import { Component } from "../ecs/component";
import type { Entity } from "../ecs/entity";
import type { ColliderShape, JointDesc, PhysicsBody } from "./interface";
import type { PhysicsRealm } from "./realm";

// ── Config interfaces ──

export interface RagdollBoneConfig {
  boneName: string;
  shape: ColliderShape;
  boneToColliderOffset: [number, number, number];
  mass: number;
  linearDamping: number;
  angularDamping: number;
}

export interface RagdollJointConfig {
  parentBone: string;
  childBone: string;
  anchor: [number, number, number];
  coneAngle: number;
  twistAngle: number;
}

export interface RagdollConfig {
  bones: RagdollBoneConfig[];
  joints: RagdollJointConfig[];
}

// ── ECS component ──

export interface RagdollData {
  [key: string]: unknown;
  config: RagdollConfig | null;
  bodyHandles: PhysicsBody[];
  jointIds: number[];
  boneNames: string[];
  blendWeight: number;
  targetBlendWeight: number;
  blendSpeed: number;
  active: boolean;
  realmId: number;
}

export const Ragdoll: ComponentDefinition<RagdollData> = Component.register<RagdollData>("Ragdoll", {
  config: null,
  bodyHandles: [],
  jointIds: [],
  boneNames: [],
  blendWeight: 0,
  targetBlendWeight: 0,
  blendSpeed: 2,
  active: false,
  realmId: -1,
});

// ── Factory ──

export function createRagdoll(
  realm: PhysicsRealm,
  skeleton: Skeleton,
  config: RagdollConfig,
  entity: Entity,
): RagdollData {
  const bodyHandles: PhysicsBody[] = [];
  const jointIds: number[] = [];
  const boneNames: string[] = [];

  for (const boneCfg of config.bones) {
    const boneIdx = skeleton.getBoneIndex(boneCfg.boneName);
    if (boneIdx < 0) {
      bodyHandles.push({ realmId: realm.id, id: -1, entity });
      boneNames.push(boneCfg.boneName);
      continue;
    }

    const bone = skeleton.data.bones[boneIdx];
    const worldPos = computeBoneWorldPosition(skeleton, boneIdx);

    const handle = realm.createBody(
      {
        type: "dynamic",
        position: [
          worldPos[0] + boneCfg.boneToColliderOffset[0],
          worldPos[1] + boneCfg.boneToColliderOffset[1],
          worldPos[2] + boneCfg.boneToColliderOffset[2],
        ],
        rotation: bone.bindRotation,
        mass: boneCfg.mass,
        linearDamping: boneCfg.linearDamping,
        angularDamping: boneCfg.angularDamping,
      },
      entity,
    );

    realm.addCollider(handle, { shape: boneCfg.shape });
    bodyHandles.push(handle);
    boneNames.push(boneCfg.boneName);
  }

  for (const jointCfg of config.joints) {
    const parentIdx = boneNames.indexOf(jointCfg.parentBone);
    const childIdx = boneNames.indexOf(jointCfg.childBone);
    if (parentIdx < 0 || childIdx < 0) {
      jointIds.push(-1);
      continue;
    }

    const parentHandle = bodyHandles[parentIdx];
    const childHandle = bodyHandles[childIdx];
    if (parentHandle.id < 0 || childHandle.id < 0) {
      jointIds.push(-1);
      continue;
    }

    const jointDesc: JointDesc = {
      type: "cone-twist",
      anchorA: jointCfg.anchor,
      anchorB: [0, 0, 0],
      coneAngle: jointCfg.coneAngle,
      twistAngle: jointCfg.twistAngle,
    };

    const jointId = realm.createJoint(parentHandle, childHandle, jointDesc);
    jointIds.push(jointId);
  }

  return {
    config,
    bodyHandles,
    jointIds,
    boneNames,
    blendWeight: 0,
    targetBlendWeight: 0,
    blendSpeed: 2,
    active: false,
    realmId: realm.id,
    __componentId: Ragdoll.id,
  };
}

export function destroyRagdoll(realm: PhysicsRealm, ragdoll: RagdollData): void {
  for (const jointId of ragdoll.jointIds) {
    if (jointId >= 0) {
      realm.destroyJoint(jointId);
    }
  }
  for (const handle of ragdoll.bodyHandles) {
    if (handle.id >= 0) {
      realm.destroyBody(handle);
    }
  }
  ragdoll.jointIds = [];
  ragdoll.bodyHandles = [];
  ragdoll.active = false;
  ragdoll.blendWeight = 0;
  ragdoll.targetBlendWeight = 0;
}

// ── Helpers ──

function computeBoneWorldPosition(skeleton: Skeleton, boneIdx: number): [number, number, number] {
  const bones = skeleton.data.bones;
  let pos: [number, number, number] = [0, 0, 0];
  let idx = boneIdx;
  const chain: number[] = [];
  while (idx >= 0) {
    chain.unshift(idx);
    idx = bones[idx].parentIndex;
  }
  for (const bi of chain) {
    const bone = bones[bi];
    pos = [
      pos[0] + bone.bindPosition[0],
      pos[1] + bone.bindPosition[1],
      pos[2] + bone.bindPosition[2],
    ];
  }
  return pos;
}
