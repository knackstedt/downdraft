import { createAnimationEventTrack, type AnimationEvent } from "./animation-event";
import { AnimationClip, type KeyframeTrack } from "./clip";
import { AnimationPlayer } from "./player";
import { buildRetargetMapping, retargetClip } from "./retarget";
import type { AnimationChannel, AnimationData, SkinData } from "./skeleton-animator";
import { SkeletonAnimator, skinDataToSkeletonData } from "./skeleton-animator";
import { Skeleton, type SkeletonData } from "./skeleton";
import { AnimationStateMachine } from "./state-machine";

function makeClipWithEvents(events: AnimationEvent[], duration: number): AnimationClip {
  return new AnimationClip({
    name: "eventclip",
    duration,
    tracks: [],
    eventTrack: createAnimationEventTrack(events),
  });
}

function makeSimpleSkeleton(): SkeletonData {
  return {
    name: "test",
    rootBoneIndex: 0,
    bones: [
      {
        name: "root",
        parentIndex: -1,
        childrenIndices: [1],
        bindPosition: [0, 0, 0],
        bindRotation: [0, 0, 0, 1],
        bindScale: [1, 1, 1],
        inverseBindMatrix: new Float32Array(16),
      },
      {
        name: "child",
        parentIndex: 0,
        childrenIndices: [],
        bindPosition: [0, 1, 0],
        bindRotation: [0, 0, 0, 1],
        bindScale: [1, 1, 1],
        inverseBindMatrix: new Float32Array(16),
      },
    ],
  };
}

function makeSimpleClip(): AnimationClip {
  const tracks: KeyframeTrack[] = [
    {
      boneName: "root",
      boneIndex: 0,
      path: "position",
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 0, 2, 0]),
      interpolation: "linear",
    },
  ];
  return new AnimationClip({ name: "test", duration: 1, tracks });
}

describe("AnimationClip", () => {
  it("should construct with data", () => {
    const clip = makeSimpleClip();
    expect(clip.name).toBe("test");
    expect(clip.duration).toBe(1);
    expect(clip.trackCount).toBe(1);
  });

  it("should sample at time 0", () => {
    const clip = makeSimpleClip();
    const positions: Array<[number, number, number]> = [];
    const rotations: Array<[number, number, number, number]> = [];
    const scales: Array<[number, number, number]> = [];
    clip.sample(0, positions, rotations, scales);
    expect(positions[0]).toEqual([0, 0, 0]);
  });

  it("should sample at time 1 (end)", () => {
    const clip = makeSimpleClip();
    const positions: Array<[number, number, number]> = [];
    const rotations: Array<[number, number, number, number]> = [];
    const scales: Array<[number, number, number]> = [];
    clip.sample(1, positions, rotations, scales);
    expect(positions[0]).toEqual([0, 2, 0]);
  });

  it("should interpolate linearly", () => {
    const clip = makeSimpleClip();
    const positions: Array<[number, number, number]> = [];
    const rotations: Array<[number, number, number, number]> = [];
    const scales: Array<[number, number, number]> = [];
    clip.sample(0.5, positions, rotations, scales);
    expect(positions[0][1]).toBeCloseTo(1, 5);
  });

  it("should wrap around duration", () => {
    const clip = makeSimpleClip();
    const positions: Array<[number, number, number]> = [];
    const rotations: Array<[number, number, number, number]> = [];
    const scales: Array<[number, number, number]> = [];
    clip.sample(1.5, positions, rotations, scales);
    expect(positions[0][1]).toBeCloseTo(1, 5);
  });

  it("getTracksForBone should return tracks for specific bone and path", () => {
    const clip = makeSimpleClip();
    const tracks = clip.getTracksForBone(0, "position");
    expect(tracks.length).toBe(1);
  });

  it("getTracksForBone should return empty for non-existent", () => {
    const clip = makeSimpleClip();
    const tracks = clip.getTracksForBone(99, "position");
    expect(tracks.length).toBe(0);
  });
});

describe("Skeleton", () => {
  it("should construct with bone data", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    expect(skel.getBoneCount()).toBe(2);
  });

  it("should get bone index by name", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    expect(skel.getBoneIndex("root")).toBe(0);
    expect(skel.getBoneIndex("child")).toBe(1);
    expect(skel.getBoneIndex("nonexistent")).toBe(-1);
  });

  it("should compute skin matrices", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const bindPose = skel.getBindPose();
    const matrices = skel.computeSkinMatrices(bindPose);
    expect(matrices.length).toBe(2 * 16);
  });

  it("should return bind pose", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const pose = skel.getBindPose();
    expect(pose.length).toBe(2);
    expect(pose[0].position).toEqual([0, 0, 0]);
    expect(pose[1].position).toEqual([0, 1, 0]);
  });
});

describe("AnimationPlayer", () => {
  it("should play a clip", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    expect(player.isPlaying("idle")).toBe(true);
  });

  it("should stop a clip", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.stop("idle");
    expect(player.isPlaying("idle")).toBe(false);
  });

  it("should pause and resume", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.pause("idle");
    expect(player.isPlaying("idle")).toBe(false);
    player.resume("idle");
    expect(player.isPlaying("idle")).toBe(true);
  });

  it("should update and advance time", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.update(0.5);
    expect(() => player.update(0.5)).not.toThrow();
  });

  it("should set speed", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.setSpeed("idle", 2.0);
    expect(() => player.update(0.5)).not.toThrow();
  });

  it("should set weight", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.setWeight("idle", 0.5);
    expect(() => player.update(0.5)).not.toThrow();
  });

  it("should get skin matrices", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.update(0.5);
    const matrices = player.getSkinMatrices();
    expect(matrices.length).toBe(2 * 16);
  });

  it("should handle no active clips", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    player.update(0.016);
    const matrices = player.getSkinMatrices();
    expect(matrices.length).toBe(2 * 16);
  });
});

function makeClipForBone(boneIndex: number, startPos: [number, number, number], endPos: [number, number, number]): AnimationClip {
  const tracks: KeyframeTrack[] = [
    {
      boneName: `bone_${boneIndex}`,
      boneIndex,
      path: "position",
      times: new Float32Array([0, 1]),
      values: new Float32Array([...startPos, ...endPos]),
      interpolation: "linear",
    },
  ];
  return new AnimationClip({ name: `clip_bone${boneIndex}`, duration: 1, tracks });
}

describe("AnimationStateMachine", () => {
  it("should add states", () => {
    const sm = new AnimationStateMachine();
    const clip = makeSimpleClip();
    sm.addState("idle", { clip, weight: 1.0 });
    expect(sm.getCurrentState()).toBeNull();
  });

  it("should set initial state", () => {
    const sm = new AnimationStateMachine();
    const clip = makeSimpleClip();
    sm.addState("idle", { clip, weight: 1.0 });
    sm.setInitialState("idle");
    expect(sm.getCurrentState()).toBe("idle");
  });

  it("should add transitions", () => {
    const sm = new AnimationStateMachine();
    const clip = makeSimpleClip();
    sm.addState("idle", { clip, weight: 1.0 });
    sm.addState("walk", { clip, weight: 1.0 });
    sm.addTransition("idle", "walk", { duration: 0.2, conditions: [{ parameter: "speed", op: ">", value: 0.5 }] });
    expect(() => sm.update(0.016, { speed: 1.0 })).not.toThrow();
  });

  it("should transition when condition is met", () => {
    const sm = new AnimationStateMachine();
    const clip = makeSimpleClip();
    sm.addState("idle", { clip, weight: 1.0 });
    sm.addState("walk", { clip, weight: 1.0 });
    sm.addTransition("idle", "walk", { duration: 0.2, conditions: [{ parameter: "speed", op: ">", value: 0.5 }] });
    sm.setInitialState("idle");
    sm.update(0.016, { speed: 1.0 });
    expect(sm.getCurrentState()).toBe("walk");
  });

  it("should not transition when condition is not met", () => {
    const sm = new AnimationStateMachine();
    const clip = makeSimpleClip();
    sm.addState("idle", { clip, weight: 1.0 });
    sm.addState("walk", { clip, weight: 1.0 });
    sm.addTransition("idle", "walk", { duration: 0.2, conditions: [{ parameter: "speed", op: ">", value: 0.5 }] });
    sm.setInitialState("idle");
    sm.update(0.016, { speed: 0.1 });
    expect(sm.getCurrentState()).toBe("idle");
  });

  it("should set parameters", () => {
    const sm = new AnimationStateMachine();
    sm.setParameter("speed", 1.5);
    expect(sm.getParameter("speed")).toBe(1.5);
  });

  it("should handle update with no states", () => {
    const sm = new AnimationStateMachine();
    expect(() => sm.update(0.016, {})).not.toThrow();
  });
});

describe("AnimationPlayer bone masking / layering", () => {
  it("should only affect masked bones", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(1, [0, 1, 0], [0, 5, 0]);

    player.play("lower", clipA);
    player.play("upper", clipB, { boneMask: [1] });

    player.update(0.5);

    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(1, 5);
    expect(transforms.positions[1][1]).toBeCloseTo(3, 5);
  });

  it("should not clear existing animations when boneMask is set", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(1, [0, 1, 0], [0, 5, 0]);

    player.play("lower", clipA);
    player.play("upper", clipB, { boneMask: [1] });

    expect(player.getPlayingCount()).toBe(2);
  });
});

describe("AnimationPlayer additive blending", () => {
  it("should add delta from bind pose on top of base animation", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const baseClip = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const addClip = makeClipForBone(0, [0, 0, 0], [0, 3, 0]);

    player.play("base", baseClip);
    player.play("add", addClip, { additive: true, weight: 1 });

    player.update(0.5);

    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(2.5, 5);
  });

  it("should scale additive by weight", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const baseClip = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const addClip = makeClipForBone(0, [0, 0, 0], [0, 4, 0]);

    player.play("base", baseClip);
    player.play("add", addClip, { additive: true, weight: 0.5 });

    player.update(0.5);

    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(2, 5);
  });
});

describe("AnimationPlayer root motion", () => {
  it("should return zero delta on first update", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();

    player.play("walk", clip);
    player.update(0.5);

    const delta = player.getRootMotionDelta();
    expect(delta).toEqual([0, 0, 0]);
  });

  it("should compute per-frame root motion delta", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const tracks: KeyframeTrack[] = [{
      boneName: "root",
      boneIndex: 0,
      path: "position",
      times: new Float32Array([0, 2]),
      values: new Float32Array([0, 0, 0, 0, 4, 0]),
      interpolation: "linear",
    }];
    const clip = new AnimationClip({ name: "walk", duration: 2, tracks });

    player.play("walk", clip);
    player.update(0.5);
    player.update(0.5);

    const delta = player.getRootMotionDelta();
    expect(delta[1]).toBeCloseTo(1, 5);
  });

  it("should reset root motion", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();

    player.play("walk", clip);
    player.update(0.5);
    player.update(0.5);

    player.resetRootMotion();
    const delta = player.getRootMotionDelta();
    expect(delta).toEqual([0, 0, 0]);
  });
});

describe("AnimationStateMachine bone masks", () => {
  it("should pass boneMask to player when setting initial state", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);
    const clip = makeSimpleClip();

    sm.addState("idle", { clip, boneMask: [0] });
    sm.setInitialState("idle");

    expect(player.isPlaying("idle")).toBe(true);
  });

  it("should pass additive flag to player", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);
    const clip = makeSimpleClip();

    sm.addState("aim", { clip, additive: true });
    sm.setInitialState("aim");

    expect(player.isPlaying("aim")).toBe(true);
  });
});

describe("Retarget", () => {
  it("should build retarget mapping for matching bone names", () => {
    const sourceSkeleton = makeSimpleSkeleton();
    const targetSkeleton = makeSimpleSkeleton();
    const mapping = buildRetargetMapping(sourceSkeleton, targetSkeleton);
    expect(mapping.bones.size).toBeGreaterThan(0);
  });

  it("should retarget a clip", () => {
    const sourceSkeleton = makeSimpleSkeleton();
    const targetSkeleton = makeSimpleSkeleton();
    const mapping = buildRetargetMapping(sourceSkeleton, targetSkeleton);
    const clip = makeSimpleClip();
    const retargeted = retargetClip(clip.data, mapping);
    expect(retargeted.tracks.length).toBe(clip.data.tracks.length);
  });

  it("should handle no matching bones", () => {
    const sourceSkeleton: SkeletonData = {
      name: "source",
      rootBoneIndex: 0,
      bones: [{ name: "a", parentIndex: -1, childrenIndices: [], bindPosition: [0, 0, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1], inverseBindMatrix: new Float32Array(16) }],
    };
    const targetSkeleton: SkeletonData = {
      name: "target",
      rootBoneIndex: 0,
      bones: [{ name: "b", parentIndex: -1, childrenIndices: [], bindPosition: [0, 0, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1], inverseBindMatrix: new Float32Array(16) }],
    };
    const mapping = buildRetargetMapping(sourceSkeleton, targetSkeleton);
    expect(mapping.bones.size).toBe(0);
  });
});

function makeSimpleSkin(): SkinData {
  const boneNameToIndex = new Map<string, number>();
  boneNameToIndex.set("root", 0);
  boneNameToIndex.set("child", 1);
  return {
    bones: [
      {
        name: "root",
        nodeIndex: 0,
        parentIndex: -1,
        restTranslation: [0, 0, 0],
        restRotation: [0, 0, 0, 1],
        restScale: [1, 1, 1],
        inverseBindMatrix: new Float32Array(16),
      },
      {
        name: "child",
        nodeIndex: 1,
        parentIndex: 0,
        restTranslation: [0, 1, 0],
        restRotation: [0, 0, 0, 1],
        restScale: [1, 1, 1],
        inverseBindMatrix: new Float32Array(16),
      },
    ],
    boneNameToIndex,
  };
}

function makeSimpleAnimData(name: string, boneName: string, endRot: [number, number, number, number]): AnimationData {
  const channels: AnimationChannel[] = [
    {
      targetNode: boneName,
      path: "rotation",
      keyframeTimes: new Float32Array([0, 1]),
      keyframeValues: new Float32Array([0, 0, 0, 1, ...endRot]),
      interpolation: "LINEAR",
    },
  ];
  return { name, duration: 1, channels };
}

describe("skinDataToSkeletonData", () => {
  it("should convert SkinData to SkeletonData", () => {
    const skin = makeSimpleSkin();
    const skelData = skinDataToSkeletonData(skin);
    expect(skelData.bones.length).toBe(2);
    expect(skelData.bones[0].name).toBe("root");
    expect(skelData.bones[0].parentIndex).toBe(-1);
    expect(skelData.bones[0].childrenIndices).toEqual([1]);
    expect(skelData.bones[1].parentIndex).toBe(0);
    expect(skelData.rootBoneIndex).toBe(0);
  });
});

describe("SkeletonAnimator", () => {
  it("should construct from SkinData", () => {
    const skin = makeSimpleSkin();
    const animator = new SkeletonAnimator(skin);
    expect(animator.getBoneCount()).toBe(2);
    expect(animator.getCurrentState()).toBe("Idle");
  });

  it("should register and play animations via AnimationPlayer", () => {
    const skin = makeSimpleSkin();
    const animator = new SkeletonAnimator(skin);
    animator.registerAnimations([makeSimpleAnimData("Walk", "root", [0, 0, 0.7071, 0.7071])]);
    expect(animator.hasAnimation("Walk")).toBe(true);
    expect(animator.hasAnimation("Run")).toBe(false);
  });

  it("should sample animation through tick", () => {
    const skin = makeSimpleSkin();
    const animator = new SkeletonAnimator(skin);
    animator.registerAnimations([makeSimpleAnimData("Walk", "root", [0, 0, 0.7071, 0.7071])]);

    // Use protected methods via a subclass
    class TestAnimator extends SkeletonAnimator {
      testSetState(state: string) { this.setAnimationState(state); }
      testTick(dt: number) { this.tick(dt); }
    }

    const test = new TestAnimator(skin);
    test.registerAnimations([makeSimpleAnimData("Walk", "root", [0, 0, 0.7071, 0.7071])]);
    test.testSetState("Walk");
    // tick clamps dt to 0.1, so call multiple times to reach t=0.5
    for (let i = 0; i < 5; i++) test.testTick(0.1);

    const rot = test.getLocalRotFlat();
    // At t=0.5, slerp from [0,0,0,1] to pre-baked [0,-0.7071,0,0.7071] (axis-swapped)
    // gives approximately [0, -0.3827, 0, 0.9239]
    expect(rot[1]).toBeCloseTo(-0.3827, 3);
    expect(rot[3]).toBeCloseTo(0.9239, 3);
  });

  it("should expose root motion delta", () => {
    const skin = makeSimpleSkin();
    class TestAnimator extends SkeletonAnimator {
      testSetState(state: string) { this.setAnimationState(state); }
      testTick(dt: number) { this.tick(dt); }
    }

    const test = new TestAnimator(skin);
    test.registerAnimations([makeSimpleAnimData("Walk", "root", [0, 0, 0.7071, 0.7071])]);
    test.testSetState("Walk");
    // tick clamps dt to 0.1
    test.testTick(0.1); // first update: delta should be 0
    expect(test.getRootMotionDelta()[0]).toBe(0);
    expect(test.getRootMotionDelta()[1]).toBe(0);
    expect(test.getRootMotionDelta()[2]).toBe(0);
    test.testTick(0.1); // second update: root position unchanged (rotation only), so delta still 0
    expect(test.getRootMotionDelta()[0]).toBe(0);
    expect(test.getRootMotionDelta()[1]).toBe(0);
    expect(test.getRootMotionDelta()[2]).toBe(0);
  });

  it("should expose AnimationPlayer and Skeleton", () => {
    const skin = makeSimpleSkin();
    const animator = new SkeletonAnimator(skin);
    expect(animator.getPlayer()).toBeDefined();
    expect(animator.getSkeleton()).toBeDefined();
    expect(animator.getSkeleton().getBoneCount()).toBe(2);
  });
});

describe("AnimationPlayer layer management", () => {
  it("should report layer count and hasLayer", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("base", clip);
    expect(player.getLayerCount()).toBe(1);
    expect(player.hasLayer("base")).toBe(true);
    expect(player.hasLayer("other")).toBe(false);
  });

  it("should support priority-based layering", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    player.play("base", clipA);
    player.play("overlay", clipB, { priority: 1 });

    player.update(0.5);
    const transforms = player.getBoneTransforms();
    // Both layers affect bone 0, weighted average: (1*1 + 5*1) / 2 = 3
    expect(transforms.positions[0][1]).toBeCloseTo(3, 5);
  });

  it("should fade weight over time", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();

    player.play("idle", clip);
    player.setWeight("idle", 0, 0.5);

    player.update(0.25);
    // With a single layer, weight normalization cancels out the weight factor.
    // At t=0.25, clip samples position y=0.5, weight=0.5, but after normalization: 0.5*0.5/0.5 = 0.5
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(0.5, 2);
  });

  it("should swap clips with setClip", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    player.play("layer", clipA);
    player.update(0.5);
    let transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(1, 5);

    player.setClip("layer", clipB);
    player.update(0.5);
    transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(5, 5);
  });

  it("should swap clips with fade", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    player.play("layer", clipA);
    player.update(0.5);

    player.setClip("layer", clipB, 0.3);
    // Before fade completes, clip should still be A
    player.update(0.1);
    expect(player.hasLayer("layer")).toBe(true);
  });

  it("should destroy and clear all layers", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("a", clip);
    player.play("b", clip, { priority: 1 });
    player.destroy();
    expect(player.getLayerCount()).toBe(0);
  });

  it("should crossfade when playing with fadeDuration", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    player.play("a", clipA);
    player.update(0.5);

    player.play("b", clipB, { fadeDuration: 0.5 });
    player.update(0.25);

    // a: time=0.75, samples y=1.5, weight=0.5 (fading out)
    // b: time=0.25, samples y=2.5, weight=0.5 (fading in)
    // weighted: (1.5*0.5 + 2.5*0.5) / (0.5+0.5) = 2.0
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(2, 1);
  });
});

describe("AnimationPlayer stop / pause / resume all", () => {
  it("should stop all layers when called without name", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("a", clip);
    player.play("b", clip, { priority: 1 });
    expect(player.getLayerCount()).toBe(2);
    player.stop();
    expect(player.getLayerCount()).toBe(0);
    expect(player.isPlaying()).toBe(false);
  });

  it("should pause all layers when called without name", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("a", clip);
    player.play("b", clip, { priority: 1 });
    player.pause();
    expect(player.isPlaying("a")).toBe(false);
    expect(player.isPlaying("b")).toBe(false);
    expect(player.isPlaying()).toBe(false);
  });

  it("should resume all layers when called without name", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("a", clip);
    player.play("b", clip, { priority: 1 });
    player.pause();
    player.resume();
    expect(player.isPlaying("a")).toBe(true);
    expect(player.isPlaying("b")).toBe(true);
    expect(player.isPlaying()).toBe(true);
  });

  it("isPlaying() without name should return true if any layer is playing", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    expect(player.isPlaying()).toBe(false);
    player.play("idle", clip);
    expect(player.isPlaying()).toBe(true);
    player.pause("idle");
    expect(player.isPlaying()).toBe(false);
  });
});

describe("AnimationPlayer morph weights", () => {
  it("should return morph weights array", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const weights = player.getMorphWeights();
    expect(weights).toBeInstanceOf(Float32Array);
    expect(weights.length).toBeGreaterThan(0);
  });

  it("should return max morph targets", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    expect(player.getMaxMorphTargets()).toBeGreaterThan(0);
  });

  it("should set max morph targets", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const original = player.getMaxMorphTargets();
    player.setMaxMorphTargets(32);
    expect(player.getMaxMorphTargets()).toBe(32);
    expect(player.getMorphWeights().length).toBe(32);
  });

  it("should clamp max morph targets to MAX_MORPH_TARGETS", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    player.setMaxMorphTargets(999);
    expect(player.getMaxMorphTargets()).toBe(64);
  });

  it("should not change if same value", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const original = player.getMaxMorphTargets();
    const weightsRef = player.getMorphWeights();
    player.setMaxMorphTargets(original);
    expect(player.getMorphWeights()).toBe(weightsRef);
  });
});

describe("AnimationPlayer non-looping clip", () => {
  it("should stop at end and set weight to 0 for non-looping clip", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("oneshot", clip, { loop: false });
    player.update(1.5);
    // Non-looping clip past duration: weight=0, layer skipped
    const transforms = player.getBoneTransforms();
    // With no active weight, falls back to bind pose
    expect(transforms.positions[0][1]).toBe(0);
  });
});

describe("AnimationPlayer re-play existing layer", () => {
  it("should replace clip when playing same layer name", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    player.play("layer", clipA);
    player.update(0.5);
    expect(player.getBoneTransforms().positions[0][1]).toBeCloseTo(1, 5);

    // Re-play same name → replaces clip, resets time
    player.play("layer", clipB);
    expect(player.getLayerCount()).toBe(1);
    player.update(0.5);
    expect(player.getBoneTransforms().positions[0][1]).toBeCloseTo(5, 5);
  });
});

describe("AnimationPlayer Set bone mask", () => {
  it("should accept Set<number> as bone mask", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(1, [0, 1, 0], [0, 5, 0]);

    player.play("lower", clipA);
    player.play("upper", clipB, { boneMask: new Set([1]) });

    player.update(0.5);
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(1, 5);
    expect(transforms.positions[1][1]).toBeCloseTo(3, 5);
  });
});

describe("AnimationPlayer negative speed", () => {
  it("should play in reverse with negative speed", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();

    player.play("rev", clip, { speed: -1 });
    player.update(0.5);

    // At t=-0.5 with loop, wraps to 0.5 → y=1
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(1, 5);
  });
});

describe("AnimationPlayer offEvent without handler", () => {
  it("should remove all handlers for an event type", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeClipWithEvents([{ time: 0.5, type: "hit" }], 2.0);
    player.play("attack", clip);

    let callCount = 0;
    player.onEvent("hit", () => { callCount++; });
    player.onEvent("hit", () => { callCount++; });
    player.offEvent("hit"); // remove all
    player.update(0.6);
    expect(callCount).toBe(0);
  });
});

describe("AnimationPlayer crossfade completion", () => {
  it("should remove old layer after crossfade completes", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    player.play("a", clipA);
    player.update(0.5);

    player.play("b", clipB, { fadeDuration: 0.3 });
    // After 0.3s, fade should complete: "a" removed, "b" at full weight
    player.update(0.3);
    expect(player.hasLayer("a")).toBe(false);
    expect(player.hasLayer("b")).toBe(true);
    // "b" at full weight, t=0.3 → y=3
    player.update(0.1);
    expect(player.getBoneTransforms().positions[0][1]).toBeCloseTo(4, 5);
  });
});

describe("AnimationPlayer additive with bone mask", () => {
  it("should only apply additive delta to masked bones", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const baseClip = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const addClip0 = makeClipForBone(0, [0, 0, 0], [0, 4, 0]);
    const addClip1 = makeClipForBone(1, [0, 1, 0], [0, 10, 0]);

    player.play("base", baseClip);
    // Additive on bone 1 only, masked
    player.play("add", addClip1, { additive: true, boneMask: [1] });
    // Another additive on bone 0, masked to bone 0
    player.play("add0", addClip0, { additive: true, boneMask: [0] });

    player.update(0.5);
    const transforms = player.getBoneTransforms();
    // bone 0: base y=1, additive delta=(2-0)*1=2 → 1+2=3
    expect(transforms.positions[0][1]).toBeCloseTo(3, 5);
    // bone 1: base bind y=1, additive delta=(5.5-1)*1=4.5 → 1+4.5=5.5
    expect(transforms.positions[1][1]).toBeCloseTo(5.5, 5);
  });
});

describe("AnimationPlayer weight fade to zero removes layer", () => {
  it("should remove layer when weight fades to 0", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();

    player.play("idle", clip);
    player.update(0.1);

    player.setWeight("idle", 0, 0.5);
    player.update(0.5);
    expect(player.hasLayer("idle")).toBe(false);
  });
});

describe("AnimationStateMachine advanced", () => {
  it("should report transitioning state", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);
    const clip = makeSimpleClip();

    sm.addState("idle", { clip });
    sm.addState("walk", { clip });
    sm.addTransition("idle", "walk", { duration: 0.3, conditions: [{ parameter: "speed", op: ">", value: 0.5 }] });
    sm.setInitialState("idle");
    sm.update(0.016, { speed: 1.0 });
    expect(sm.isTransitioning()).toBe(true);
  });

  it("should complete transition after duration", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);
    const clip = makeSimpleClip();

    sm.addState("idle", { clip });
    sm.addState("walk", { clip });
    sm.addTransition("idle", "walk", { duration: 0.3, conditions: [{ parameter: "speed", op: ">", value: 0.5 }] });
    sm.setInitialState("idle");
    sm.update(0.016, { speed: 1.0 });
    expect(sm.isTransitioning()).toBe(true);
    sm.update(0.3);
    expect(sm.isTransitioning()).toBe(false);
    expect(sm.getCurrentState()).toBe("walk");
  });

  it("should support start() as alias for setInitialState", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);
    const clip = makeSimpleClip();

    sm.addState("idle", { clip });
    sm.start("idle");
    expect(sm.getCurrentState()).toBe("idle");
  });

  it("should throw on unknown initial state", () => {
    const sm = new AnimationStateMachine();
    expect(() => sm.setInitialState("nonexistent")).toThrow();
  });

  it("should support all condition operators", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);

    const ops = [
      { op: ">", value: 0.5, param: 1.0, shouldTransition: true },
      { op: "<", value: 0.5, param: 0.1, shouldTransition: true },
      { op: "==", value: 1, param: 1, shouldTransition: true },
      { op: "!=", value: 1, param: 2, shouldTransition: true },
      { op: ">=", value: 1, param: 1, shouldTransition: true },
      { op: "<=", value: 1, param: 1, shouldTransition: true },
    ] as const;

    for (const { op, value, param, shouldTransition } of ops) {
      const sm = new AnimationStateMachine(player);
      const clip = makeSimpleClip();
      sm.addState("idle", { clip });
      sm.addState("walk", { clip });
      sm.addTransition("idle", "walk", { duration: 0.1, conditions: [{ parameter: "x", op, value }] });
      sm.setInitialState("idle");
      sm.update(0.016, { x: param });
      expect(sm.getCurrentState() === "walk").toBe(shouldTransition);
    }
  });

  it("should not transition from wrong source state", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);
    const clip = makeSimpleClip();

    sm.addState("idle", { clip });
    sm.addState("walk", { clip });
    sm.addState("run", { clip });
    // Transition from walk→run, but we're in idle
    sm.addTransition("walk", "run", { duration: 0.2, conditions: [{ parameter: "speed", op: ">", value: 0.5 }] });
    sm.setInitialState("idle");
    sm.update(0.016, { speed: 1.0 });
    expect(sm.getCurrentState()).toBe("idle");
  });
});

describe("AnimationStateMachine blend trees", () => {
  it("should blend 1D blend tree based on parameter", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    sm.addState("locomotion", {
      blendTree: {
        type: "1d",
        parameter: "speed",
        children: [
          { clip: clipA, threshold: 0 },
          { clip: clipB, threshold: 1 },
        ],
      },
    });
    sm.setInitialState("locomotion");
    sm.setParameter("speed", 0.5);
    sm.update(0.016);
    player.update(0.5);

    // At speed=0.5, blend 50/50: clipA at t=0.5 → y=1, clipB at t=0.5 → y=5
    // weighted: (1*0.5 + 5*0.5) / 1 = 3
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(3, 5);
  });

  it("should clamp 1D blend tree to first child below threshold", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    sm.addState("locomotion", {
      blendTree: {
        type: "1d",
        parameter: "speed",
        children: [
          { clip: clipA, threshold: 0 },
          { clip: clipB, threshold: 1 },
        ],
      },
    });
    sm.setInitialState("locomotion");
    sm.setParameter("speed", -1);
    sm.update(0.016);
    player.update(0.5);

    // Below threshold 0 → clipA at weight 1
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(1, 5);
  });

  it("should clamp 1D blend tree to last child above threshold", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);

    sm.addState("locomotion", {
      blendTree: {
        type: "1d",
        parameter: "speed",
        children: [
          { clip: clipA, threshold: 0 },
          { clip: clipB, threshold: 1 },
        ],
      },
    });
    sm.setInitialState("locomotion");
    sm.setParameter("speed", 5);
    sm.update(0.016);
    player.update(0.5);

    // Above threshold 1 → clipB at weight 1
    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(5, 5);
  });

  it("should blend 2D blend tree based on parameters", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);
    const clipB = makeClipForBone(0, [0, 0, 0], [0, 10, 0]);
    const clipC = makeClipForBone(0, [0, 0, 0], [0, 20, 0]);
    const clipD = makeClipForBone(0, [0, 0, 0], [0, 30, 0]);

    sm.addState("locomotion", {
      blendTree: {
        type: "2d",
        parameterX: "x",
        parameterY: "y",
        children: [
          { clip: clipA, position: [0, 0] },
          { clip: clipB, position: [1, 0] },
          { clip: clipC, position: [0, 1] },
          { clip: clipD, position: [1, 1] },
        ],
      },
    });
    sm.setInitialState("locomotion");
    // At (0.5, 0.5) → equidistant to all 4, but 2D picks 2 closest
    sm.setParameter("x", 0.5);
    sm.setParameter("y", 0.5);
    sm.update(0.016);
    player.update(0.5);

    // Should be playing something
    expect(player.isPlaying()).toBe(true);
  });

  it("should handle 2D blend tree with single child", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const sm = new AnimationStateMachine(player);

    const clipA = makeClipForBone(0, [0, 0, 0], [0, 2, 0]);

    sm.addState("single", {
      blendTree: {
        type: "2d",
        parameterX: "x",
        parameterY: "y",
        children: [{ clip: clipA, position: [0, 0] }],
      },
    });
    sm.setInitialState("single");
    sm.update(0.016);
    player.update(0.5);

    const transforms = player.getBoneTransforms();
    expect(transforms.positions[0][1]).toBeCloseTo(1, 5);
  });
});

describe("AnimationPlayer getSkinMatrices caching", () => {
  it("should return cached skin matrices on repeated calls", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.update(0.5);
    const m1 = player.getSkinMatrices();
    const m2 = player.getSkinMatrices();
    expect(m1).toBe(m2); // same reference (cached)
  });

  it("should recompute skin matrices after update", () => {
    const skel = new Skeleton(makeSimpleSkeleton());
    const player = new AnimationPlayer(skel);
    const clip = makeSimpleClip();
    player.play("idle", clip);
    player.update(0.5);
    const m1 = player.getSkinMatrices();
    player.update(0.1);
    const m2 = player.getSkinMatrices();
    // After update, skinMatrices is nulled and recomputed
    // Values may be the same but it should be a valid array
    expect(m2).toBeInstanceOf(Float32Array);
    expect(m2.length).toBe(m1.length);
  });
});
