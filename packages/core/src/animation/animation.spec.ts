import { AnimationClip, type KeyframeTrack } from "./clip.ts";
import { AnimationPlayer } from "./player.ts";
import { buildRetargetMapping, retargetClip } from "./retarget.ts";
import type { AnimationChannel, AnimationData, SkinData } from "./skeleton-animator.ts";
import { SkeletonAnimator, skinDataToSkeletonData } from "./skeleton-animator.ts";
import { Skeleton, type SkeletonData } from "./skeleton.ts";
import { AnimationStateMachine } from "./state-machine.ts";

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
