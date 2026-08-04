import { Component } from "../ecs/component";
import type { SkeletonData } from "../animation/skeleton";
import type { AnimationClipData } from "../animation/clip";

export interface SkinnedMeshData {
  skeleton: SkeletonData;
  boneIndices: Uint16Array;
  boneWeights: Float32Array;
  boneIndexMap: Map<string, number>;
}

export const SkinnedMesh = Component.register<{
  [key: string]: unknown;
  skeletonData: SkeletonData | null;
  boneIndices: Uint16Array | null;
  boneWeights: Float32Array | null;
  skinMatrices: Float32Array | null;
  rootBoneIndex: number;
  clips: Map<string, AnimationClipData>;
  currentClip: string | null;
}>("SkinnedMesh", {
  skeletonData: null,
  boneIndices: null,
  boneWeights: null,
  skinMatrices: null,
  rootBoneIndex: 0,
  clips: new Map(),
  currentClip: null,
});

export interface BoneTransformData {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export const BoneTransforms = Component.register<{
  [key: string]: unknown;
  transforms: BoneTransformData[];
  dirty: boolean;
}>("BoneTransforms", {
  transforms: [],
  dirty: true,
});

export function buildSkinnedMeshFromGLTF(
  skeleton: SkeletonData,
  boneIndices: Uint16Array,
  boneWeights: Float32Array,
): SkinnedMeshData {
  const boneIndexMap = new Map<string, number>();
  for (let i = 0; i < skeleton.bones.length; i++) {
    boneIndexMap.set(skeleton.bones[i].name, i);
  }

  return {
    skeleton,
    boneIndices,
    boneWeights,
    boneIndexMap,
  };
}

export function createSkinMatricesBuffer(boneCount: number): Float32Array {
  return new Float32Array(boneCount * 16);
}

export const MAX_BONES = 256;
