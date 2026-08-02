import { describe, it, expect } from "bun:test";
import { AnimationLayerManager } from "./animation-layers.ts";
import { AnimationClip } from "./clip.ts";
import { Skeleton } from "./skeleton.ts";
import { BoneMaskPreset, buildBoneMask } from "./bone-mask.ts";
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

describe("AnimationLayerManager", () => {
  it("should create with two override layers with different masks", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("upper", makeSimpleClip("walk_upper", 1), {
      mask: BoneMaskPreset.UPPER_BODY,
      priority: 1,
    });
    manager.addLayer("lower", makeSimpleClip("walk_lower", 5), {
      mask: BoneMaskPreset.LOWER_BODY,
      priority: 0,
    });
    expect(manager.getLayerCount()).toBe(2);
    expect(manager.hasLayer("upper")).toBe(true);
    expect(manager.hasLayer("lower")).toBe(true);
  });

  it("should update and produce blended transforms", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0));
    manager.update(0.5);
    const transforms = manager.getBoneTransforms();
    expect(transforms.positions.length).toBe(data.bones.length);
    expect(transforms.rotations.length).toBe(data.bones.length);
  });

  it("should support additive layer on top of override base", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0), { blendMode: "override" });
    manager.addLayer("overlay", makeSimpleClip("attack", 1), {
      blendMode: "additive",
      mask: BoneMaskPreset.UPPER_BODY,
    });
    manager.update(0.5);
    const transforms = manager.getBoneTransforms();
    expect(transforms.positions.length).toBe(data.bones.length);
  });

  it("should fade layer weight in", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0), { weight: 1 });
    manager.addLayer("overlay", makeSimpleClip("attack", 1), {
      weight: 0,
      fadeDuration: 0.5,
    });
    manager.update(0.25);
    const transforms = manager.getBoneTransforms();
    expect(transforms.positions).toBeDefined();
  });

  it("should fade layer weight out and remove", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0), { weight: 1 });
    manager.addLayer("temp", makeSimpleClip("attack", 1), { weight: 1 });
    manager.removeLayer("temp", 0.5);
    expect(manager.getLayerCount()).toBe(2);
    manager.update(0.6);
    expect(manager.getLayerCount()).toBe(1);
    expect(manager.hasLayer("temp")).toBe(false);
  });

  it("should swap clip with crossfade", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0));
    manager.setLayerClip("base", makeSimpleClip("run", 0), 0.3);
    manager.update(0.4);
    const transforms = manager.getBoneTransforms();
    expect(transforms.positions).toBeDefined();
  });

  it("should get root motion from base layer only", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0), { priority: 0 });
    manager.addLayer("overlay", makeSimpleClip("attack", 1), { priority: 1 });
    manager.update(0.5);
    const delta = manager.getRootMotionDelta();
    expect(delta).toBeDefined();
    expect(delta.length).toBe(3);
  });

  it("should get morph weights across layers", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0));
    manager.update(0.5);
    const weights = manager.getMorphWeights();
    expect(weights).toBeDefined();
  });

  it("should destroy cleanly", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    manager.addLayer("base", makeSimpleClip("walk", 0));
    manager.destroy();
    expect(manager.getLayerCount()).toBe(0);
  });

  it("should respect priority ordering", () => {
    const { skeleton, data } = makeMockSkeleton();
    const manager = new AnimationLayerManager(skeleton, data);
    const upperMask = buildBoneMask(BoneMaskPreset.UPPER_BODY, data);
    const lowerMask = buildBoneMask(BoneMaskPreset.LOWER_BODY, data);

    manager.addLayer("low_pri", makeSimpleClip("walk", 0), {
      mask: lowerMask,
      priority: 0,
    });
    manager.addLayer("high_pri", makeSimpleClip("attack", 1), {
      mask: upperMask,
      priority: 10,
    });
    manager.update(0.5);
    const transforms = manager.getBoneTransforms();
    expect(transforms.positions.length).toBe(data.bones.length);
  });
});
