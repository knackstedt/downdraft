import { describe, it, expect } from "bun:test";
import {
  BoneMaskPreset,
  buildBoneMask,
  registerCustomMask,
  buildCustomBoneMask,
} from "./bone-mask.ts";
import { AnimationGroup } from "./animation-group.ts";
import { AnimationClip } from "./clip.ts";
import { Skeleton } from "./skeleton.ts";
import type { Bone, SkeletonData } from "./skeleton.ts";

function makeMockSkeleton(): { skeleton: Skeleton; data: SkeletonData } {
  const bones: Bone[] = [
    { name: "Hips", nodeIndex: 0, parentIndex: -1, childrenIndices: [1, 5], inverseBindMatrix: new Float32Array(16), bindPosition: [0, 0, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "Spine", nodeIndex: 1, parentIndex: 0, childrenIndices: [2], inverseBindMatrix: new Float32Array(16), bindPosition: [0, 1, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "Neck", nodeIndex: 2, parentIndex: 1, childrenIndices: [3], inverseBindMatrix: new Float32Array(16), bindPosition: [0, 2, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "Head", nodeIndex: 3, parentIndex: 2, childrenIndices: [], inverseBindMatrix: new Float32Array(16), bindPosition: [0, 3, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "LeftArm", nodeIndex: 4, parentIndex: 1, childrenIndices: [], inverseBindMatrix: new Float32Array(16), bindPosition: [1, 2, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "LeftUpLeg", nodeIndex: 5, parentIndex: 0, childrenIndices: [6], inverseBindMatrix: new Float32Array(16), bindPosition: [0.5, 0, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "LeftLeg", nodeIndex: 6, parentIndex: 5, childrenIndices: [7], inverseBindMatrix: new Float32Array(16), bindPosition: [0.5, -1, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "LeftFoot", nodeIndex: 7, parentIndex: 6, childrenIndices: [], inverseBindMatrix: new Float32Array(16), bindPosition: [0.5, -2, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
  ];
  const data: SkeletonData = { name: "test", bones, rootBoneIndex: 0 };
  return { skeleton: new Skeleton(data), data };
}

function makeSimpleClip(name: string, boneIndex: number, duration = 1.0): AnimationClip {
  return new AnimationClip({
    name,
    duration,
    tracks: [
      {
        boneName: `bone_${boneIndex}`,
        boneIndex,
        path: "position",
        times: new Float32Array([0, duration]),
        values: new Float32Array([0, 0, 0, 1, 1, 1]),
        interpolation: "linear",
      },
    ],
  });
}

describe("BoneMask", () => {
  it("should build upper body mask", () => {
    const { data } = makeMockSkeleton();
    const mask = buildBoneMask(BoneMaskPreset.UPPER_BODY, data);
    expect(mask.has(1)).toBe(true); // Spine
    expect(mask.has(2)).toBe(true); // Neck
    expect(mask.has(3)).toBe(true); // Head
    expect(mask.has(4)).toBe(true); // LeftArm
    expect(mask.has(5)).toBe(false); // LeftUpLeg
    expect(mask.has(6)).toBe(false); // LeftLeg
  });

  it("should build lower body mask", () => {
    const { data } = makeMockSkeleton();
    const mask = buildBoneMask(BoneMaskPreset.LOWER_BODY, data);
    expect(mask.has(0)).toBe(true); // Hips
    expect(mask.has(5)).toBe(true); // LeftUpLeg
    expect(mask.has(6)).toBe(true); // LeftLeg
    expect(mask.has(7)).toBe(true); // LeftFoot
    expect(mask.has(1)).toBe(false); // Spine
  });

  it("should build full body mask", () => {
    const { data } = makeMockSkeleton();
    const mask = buildBoneMask(BoneMaskPreset.FULL_BODY, data);
    expect(mask.size).toBe(data.bones.length);
  });

  it("should build head mask", () => {
    const { data } = makeMockSkeleton();
    const mask = buildBoneMask(BoneMaskPreset.HEAD, data);
    expect(mask.has(2)).toBe(true); // Neck
    expect(mask.has(3)).toBe(true); // Head
    expect(mask.has(0)).toBe(false); // Hips
  });

  it("should register and build custom mask", () => {
    const { data } = makeMockSkeleton();
    registerCustomMask("custom_head_arms", ["Head", "LeftArm"]);
    const mask = buildCustomBoneMask("custom_head_arms", data);
    expect(mask.has(3)).toBe(true); // Head
    expect(mask.has(4)).toBe(true); // LeftArm
    expect(mask.has(0)).toBe(false); // Hips
  });
});

describe("AnimationGroup", () => {
  it("should create group with 2 layers", () => {
    const { skeleton, data } = makeMockSkeleton();
    const group = new AnimationGroup(skeleton, data);
    group.addLayer("upper", makeSimpleClip("walk", 1), {
      mask: BoneMaskPreset.UPPER_BODY,
    });
    group.addLayer("lower", makeSimpleClip("walk_lower", 5), {
      mask: BoneMaskPreset.LOWER_BODY,
    });
    expect(group.getLayerCount()).toBe(2);
    expect(group.hasLayer("upper")).toBe(true);
    expect(group.hasLayer("lower")).toBe(true);
  });

  it("should update and produce blended transforms", () => {
    const { skeleton, data } = makeMockSkeleton();
    const group = new AnimationGroup(skeleton, data);
    group.addLayer("base", makeSimpleClip("walk", 0));
    group.update(0.5);
    const transforms = group.getBoneTransforms();
    expect(transforms.positions.length).toBe(data.bones.length);
    expect(transforms.rotations.length).toBe(data.bones.length);
    expect(transforms.scales.length).toBe(data.bones.length);
  });

  it("should adjust layer weight at runtime", () => {
    const { skeleton, data } = makeMockSkeleton();
    const group = new AnimationGroup(skeleton, data);
    group.addLayer("base", makeSimpleClip("walk", 0), { weight: 1 });
    group.setLayerWeight("base", 0.5);
    group.update(0.5);
    // Should not throw, transforms should be valid
    const transforms = group.getBoneTransforms();
    expect(transforms.positions[0]).toBeDefined();
  });

  it("should remove layer", () => {
    const { skeleton, data } = makeMockSkeleton();
    const group = new AnimationGroup(skeleton, data);
    group.addLayer("base", makeSimpleClip("walk", 0));
    group.addLayer("overlay", makeSimpleClip("attack", 1));
    expect(group.getLayerCount()).toBe(2);
    group.removeLayer("overlay");
    expect(group.getLayerCount()).toBe(1);
    expect(group.hasLayer("overlay")).toBe(false);
  });

  it("should get morph weights", () => {
    const { skeleton, data } = makeMockSkeleton();
    const group = new AnimationGroup(skeleton, data);
    group.addLayer("base", makeSimpleClip("walk", 0));
    group.update(0.5);
    const weights = group.getMorphWeights();
    expect(weights).toBeDefined();
  });

  it("should destroy cleanly", () => {
    const { skeleton, data } = makeMockSkeleton();
    const group = new AnimationGroup(skeleton, data);
    group.addLayer("base", makeSimpleClip("walk", 0));
    group.destroy();
    expect(group.getLayerCount()).toBe(0);
  });
});
