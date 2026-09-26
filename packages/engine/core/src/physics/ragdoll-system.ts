import type { Skeleton, SkeletonAnimator } from "../animation";
import type { Entity } from "../ecs/entity";
import type { Query } from "../ecs/query";
import { Stage, system } from "../ecs/system";
import type { World } from "../ecs/world";
import type { RagdollData } from "./ragdoll";
import { Ragdoll } from "./ragdoll";
import type { PhysicsRealm } from "./realm";

export class RagdollSystem {
  private realm: PhysicsRealm;
  private animator: SkeletonAnimator | null = null;
  private skeleton: Skeleton | null = null;
  private query: Query | null = null;
  private world: World | null = null;
  private activationRequests: Map<number, { entity: Entity; blendSpeed: number }> = new Map();
  private deactivationRequests: Set<number> = new Set();

  constructor(realm: PhysicsRealm) {
    this.realm = realm;
  }

  setAnimator(animator: SkeletonAnimator): void {
    this.animator = animator;
    this.skeleton = animator.getSkeleton();
  }

  activateRagdoll(entity: Entity, blendSpeed: number = 2): void {
    this.activationRequests.set(entity.index, { entity, blendSpeed });
  }

  deactivateRagdoll(entity: Entity): void {
    this.deactivationRequests.add(entity.index);
  }

  register(world: World, query: Query): void {
    this.world = world;
    this.query = query;
    const self = this;
    const ragdollSystem = system(
      "ragdoll-blend",
      Stage.Physics,
      (ctx) => {
        if (!self.query) return;
        self.query.iterate(ctx.tick, (entity, components) => {
          const ragdoll = components[0] as RagdollData;
          self.update(entity, ragdoll, ctx.dt);
        });
        self.processRequests();
      },
      { queries: [query] },
    );
    world.schedule.add(ragdollSystem);
  }

  private update(entity: Entity, ragdoll: RagdollData, dt: number): void {
    if (ragdoll.bodyHandles.length === 0) return;

    if (ragdoll.targetBlendWeight > ragdoll.blendWeight) {
      ragdoll.blendWeight = Math.min(
        ragdoll.targetBlendWeight,
        ragdoll.blendWeight + ragdoll.blendSpeed * dt,
      );
    } else if (ragdoll.targetBlendWeight < ragdoll.blendWeight) {
      ragdoll.blendWeight = Math.max(
        ragdoll.targetBlendWeight,
        ragdoll.blendWeight - ragdoll.blendSpeed * dt,
      );
    }

    if (ragdoll.blendWeight < 1.0) {
      this.driveFromAnimation(ragdoll);
    } else {
      this.driveFromPhysics(ragdoll);
    }
  }

  private driveFromAnimation(ragdoll: RagdollData): void {
    if (!this.animator || !this.skeleton) return;

    const boneTransforms = this.animator.getLocalPosFlat();
    const boneRotations = this.animator.getLocalRotFlat();
    const boneScales = this.animator.getLocalScaleFlat();
    const parentIndices = this.animator.getParentIndices();

    const boneCount = this.skeleton.getBoneCount();
    const worldPositions: [number, number, number][] = new Array(boneCount);
    const worldRotations: [number, number, number, number][] = new Array(boneCount);

    for (let i = 0; i < boneCount; i++) {
      const px = boneTransforms[i * 4];
      const py = boneTransforms[i * 4 + 1];
      const pz = boneTransforms[i * 4 + 2];
      const qx = boneRotations[i * 4];
      const qy = boneRotations[i * 4 + 1];
      const qz = boneRotations[i * 4 + 2];
      const qw = boneRotations[i * 4 + 3];
      const sx = boneScales[i * 4];
      const sy = boneScales[i * 4 + 1];
      const sz = boneScales[i * 4 + 2];

      const parentIdx = parentIndices[i];
      if (parentIdx >= 0 && worldPositions[parentIdx]) {
        const wp = worldPositions[parentIdx];
        const wr = worldRotations[parentIdx];
        worldPositions[i] = [
          wp[0] + px * sx,
          wp[1] + py * sy,
          wp[2] + pz * sz,
        ];
        worldRotations[i] = [
          wr[0] * qw + wr[1] * qz - wr[2] * qy + wr[3] * qx,
          -wr[0] * qz + wr[1] * qw + wr[2] * qx + wr[3] * qy,
          wr[0] * qy - wr[1] * qx + wr[2] * qw + wr[3] * qz,
          -wr[0] * qx - wr[1] * qy - wr[2] * qz + wr[3] * qw,
        ];
      } else {
        worldPositions[i] = [px, py, pz];
        worldRotations[i] = [qx, qy, qz, qw];
      }
    }

    for (let i = 0; i < ragdoll.boneNames.length; i++) {
      const boneName = ragdoll.boneNames[i];
      const handle = ragdoll.bodyHandles[i];
      if (handle.id < 0) continue;

      const boneIdx = this.skeleton.getBoneIndex(boneName);
      if (boneIdx < 0) continue;

      const config = ragdoll.config;
      if (!config) continue;
      const boneCfg = config.bones[i];
      if (!boneCfg) continue;

      const worldPos = worldPositions[boneIdx];
      this.realm.setPosition(handle, [
        worldPos[0] + boneCfg.boneToColliderOffset[0],
        worldPos[1] + boneCfg.boneToColliderOffset[1],
        worldPos[2] + boneCfg.boneToColliderOffset[2],
      ]);
      this.realm.setRotation(handle, worldRotations[boneIdx]);
      this.realm.setBodyType(handle, "kinematic");
    }
  }

  private driveFromPhysics(ragdoll: RagdollData): void {
    if (!this.skeleton) return;

    for (let i = 0; i < ragdoll.bodyHandles.length; i++) {
      const handle = ragdoll.bodyHandles[i];
      if (handle.id < 0) continue;
      this.realm.setBodyType(handle, "dynamic");
    }

    if (this.animator && ragdoll.blendWeight >= 1.0) {
      const boneCount = this.skeleton.getBoneCount();
      const localPos = this.animator.getLocalPosFlat();
      const localRot = this.animator.getLocalRotFlat();
      const parentIndices = this.animator.getParentIndices();

      const worldPositions: [number, number, number][] = new Array(boneCount);
      const worldRotations: [number, number, number, number][] = new Array(boneCount);

      for (let i = 0; i < boneCount; i++) {
        const parentIdx = parentIndices[i];
        if (parentIdx >= 0 && worldPositions[parentIdx]) {
          const wp = worldPositions[parentIdx];
          const lp = [localPos[i * 4], localPos[i * 4 + 1], localPos[i * 4 + 2]];
          worldPositions[i] = [wp[0] + lp[0], wp[1] + lp[1], wp[2] + lp[2]];
          worldRotations[i] = [
            localRot[i * 4],
            localRot[i * 4 + 1],
            localRot[i * 4 + 2],
            localRot[i * 4 + 3],
          ];
        } else {
          worldPositions[i] = [localPos[i * 4], localPos[i * 4 + 1], localPos[i * 4 + 2]];
          worldRotations[i] = [localRot[i * 4], localRot[i * 4 + 1], localRot[i * 4 + 2], localRot[i * 4 + 3]];
        }
      }

      for (let i = 0; i < ragdoll.boneNames.length; i++) {
        const boneName = ragdoll.boneNames[i];
        const handle = ragdoll.bodyHandles[i];
        if (handle.id < 0) continue;

        const boneIdx = this.skeleton.getBoneIndex(boneName);
        if (boneIdx < 0) continue;

        const config = ragdoll.config;
        if (!config) continue;
      }
    }
  }

  private processRequests(): void {
    for (const [entityIdx, req] of this.activationRequests.entries()) {
      if (!this.world) continue;
      const ragdoll = this.world.getComponent<RagdollData>(req.entity, Ragdoll.id);
      if (ragdoll) {
        ragdoll.active = true;
        ragdoll.targetBlendWeight = 1.0;
        ragdoll.blendSpeed = req.blendSpeed;
      }
    }
    this.activationRequests.clear();

    for (const entityIdx of this.deactivationRequests.values()) {
      if (!this.world) continue;
      const entity = { index: entityIdx, generation: 0 };
      const ragdoll = this.world.getComponent<RagdollData>(entity, Ragdoll.id);
      if (ragdoll) {
        ragdoll.active = false;
        ragdoll.targetBlendWeight = 0.0;
      }
    }
    this.deactivationRequests.clear();
  }
}
