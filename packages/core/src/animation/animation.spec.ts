import { AnimationClip, buildAnimationClipFromGLTF, type AnimationClipData, type KeyframeTrack } from "./clip.ts";
import { Skeleton, buildSkeletonFromGLTF, type SkeletonData } from "./skeleton.ts";
import { AnimationPlayer } from "./player.ts";
import { AnimationStateMachine, type AnimationState, type AnimationTransition } from "./state-machine.ts";
import { buildRetargetMapping, retargetClip, type BoneMapping } from "./retarget.ts";

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
