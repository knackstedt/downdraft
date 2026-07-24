import type { AnimationClipData, KeyframeTrack } from "./clip.ts";
import type { Bone, SkeletonData } from "./skeleton.ts";

export interface BoneMapping {
  sourceBoneName: string;
  targetBoneIndex: number;
  sourceBoneIndex: number;
  rotationOffset: [number, number, number, number];
  positionOffset: [number, number, number];
  scaleRatio: [number, number, number];
}

export interface RetargetMapping {
  mappings: BoneMapping[];
  bones: Map<string, BoneMapping>;
  sourceSkeleton: SkeletonData;
  targetSkeleton: SkeletonData;
}

export function buildRetargetMapping(
  sourceSkeleton: SkeletonData,
  targetSkeleton: SkeletonData,
): RetargetMapping {
  const mappings: BoneMapping[] = [];
  const bones = new Map<string, BoneMapping>();

  for (let ti = 0; ti < targetSkeleton.bones.length; ti++) {
    const targetBone = targetSkeleton.bones[ti];
    const sourceIndex = sourceSkeleton.bones.findIndex(
      (b) => b.name === targetBone.name || matchBoneName(b.name, targetBone.name),
    );

    if (sourceIndex >= 0) {
      const sourceBone = sourceSkeleton.bones[sourceIndex];
      const rotOffset = computeRotationOffset(sourceBone, targetBone);
      const posOffset = computePositionOffset(sourceBone, targetBone);
      const scaleRatio = computeScaleRatio(sourceBone, targetBone);

      const mapping: BoneMapping = {
        sourceBoneName: sourceBone.name,
        sourceBoneIndex: sourceIndex,
        targetBoneIndex: ti,
        rotationOffset: rotOffset,
        positionOffset: posOffset,
        scaleRatio,
      };
      mappings.push(mapping);
      bones.set(sourceBone.name, mapping);
    }
  }

  return { mappings, bones, sourceSkeleton, targetSkeleton };
}

export function retargetClip(
  clip: AnimationClipData,
  mapping: RetargetMapping,
): AnimationClipData {
  const retargetedTracks: KeyframeTrack[] = [];

  for (const track of clip.tracks) {
    const m = mapping.mappings.find((m) => m.sourceBoneIndex === track.boneIndex);
    if (!m) continue;

    const newValues = new Float32Array(track.values.length);

    if (track.path === "rotation") {
      for (let i = 0; i < track.values.length; i += 4) {
        const qx = track.values[i];
        const qy = track.values[i + 1];
        const qz = track.values[i + 2];
        const qw = track.values[i + 3];
        const result = multiplyQuat(
          [qx, qy, qz, qw],
          m.rotationOffset,
        );
        newValues[i] = result[0];
        newValues[i + 1] = result[1];
        newValues[i + 2] = result[2];
        newValues[i + 3] = result[3];
      }
    } else if (track.path === "position") {
      for (let i = 0; i < track.values.length; i += 3) {
        newValues[i] = (track.values[i] + m.positionOffset[0]) * m.scaleRatio[0];
        newValues[i + 1] = (track.values[i + 1] + m.positionOffset[1]) * m.scaleRatio[1];
        newValues[i + 2] = (track.values[i + 2] + m.positionOffset[2]) * m.scaleRatio[2];
      }
    } else {
      newValues.set(track.values);
    }

    retargetedTracks.push({
      ...track,
      boneIndex: m.targetBoneIndex,
      boneName: mapping.targetSkeleton.bones[m.targetBoneIndex].name,
      values: newValues,
    });
  }

  return {
    name: clip.name,
    duration: clip.duration,
    tracks: retargetedTracks,
  };
}

function matchBoneName(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalize(a) === normalize(b);
}

function computeRotationOffset(
  source: Bone,
  target: Bone,
): [number, number, number, number] {
  return multiplyQuat(
    target.bindRotation,
    conjugateQuat(source.bindRotation),
  );
}

function computePositionOffset(
  source: Bone,
  target: Bone,
): [number, number, number] {
  return [
    target.bindPosition[0] - source.bindPosition[0],
    target.bindPosition[1] - source.bindPosition[1],
    target.bindPosition[2] - source.bindPosition[2],
  ];
}

function computeScaleRatio(
  source: Bone,
  target: Bone,
): [number, number, number] {
  return [
    source.bindScale[0] !== 0 ? target.bindScale[0] / source.bindScale[0] : 1,
    source.bindScale[1] !== 0 ? target.bindScale[1] / source.bindScale[1] : 1,
    source.bindScale[2] !== 0 ? target.bindScale[2] / source.bindScale[2] : 1,
  ];
}

function conjugateQuat(q: [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
}

function multiplyQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
