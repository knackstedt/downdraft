import { describe, it, expect } from "bun:test";
import {
  type MorphTarget,
  type MorphTargetTrack,
  buildMorphTargetData,
  createMorphTargetTrack,
  sampleMorphWeight,
  findMorphKeyframeIndex,
} from "./morph-target";
import { AnimationClip, buildAnimationClipFromGLTF } from "./clip";

describe("MorphTarget", () => {
  it("should build morph target data", () => {
    const targets: MorphTarget[] = [
      { name: "smile", deltaPositions: new Float32Array([0.1, 0, 0]), weight: 0 },
      { name: "frown", deltaPositions: new Float32Array([-0.1, 0, 0]), weight: 0 },
    ];
    const data = buildMorphTargetData(targets);
    expect(data.targets.length).toBe(2);
    expect(data.maxInfluences).toBe(2);
  });

  it("should clamp max influences", () => {
    const targets: MorphTarget[] = Array.from({ length: 10 }, (_, i) => ({
      name: `t${i}`,
      deltaPositions: new Float32Array(3),
      weight: 0,
    }));
    const data = buildMorphTargetData(targets, 4);
    expect(data.maxInfluences).toBe(4);
  });

  it("should create morph target track", () => {
    const track = createMorphTargetTrack(0, new Float32Array([0, 1]), new Float32Array([0, 1]));
    expect(track.targetIndex).toBe(0);
    expect(track.interpolation).toBe("linear");
  });
});

describe("findMorphKeyframeIndex", () => {
  it("should find correct keyframe", () => {
    const times = new Float32Array([0, 0.5, 1.0, 2.0]);
    const { index, alpha } = findMorphKeyframeIndex(times, 0.75);
    expect(index).toBe(1);
    expect(alpha).toBeCloseTo(0.5, 5);
  });

  it("should clamp before first keyframe", () => {
    const times = new Float32Array([0.5, 1.0]);
    const { index, alpha } = findMorphKeyframeIndex(times, 0.1);
    expect(index).toBe(0);
    expect(alpha).toBe(0);
  });

  it("should clamp after last keyframe", () => {
    const times = new Float32Array([0, 1.0]);
    const { index, alpha } = findMorphKeyframeIndex(times, 2.0);
    expect(index).toBe(0);
    expect(alpha).toBe(1);
  });

  it("should handle single keyframe", () => {
    const times = new Float32Array([0.5]);
    const { index, alpha } = findMorphKeyframeIndex(times, 1.0);
    expect(index).toBe(0);
    expect(alpha).toBe(0);
  });
});

describe("sampleMorphWeight", () => {
  it("should interpolate linearly", () => {
    const track: MorphTargetTrack = {
      targetIndex: 0,
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 1]),
      interpolation: "linear",
    };
    expect(sampleMorphWeight(track, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("should use step interpolation", () => {
    const track: MorphTargetTrack = {
      targetIndex: 0,
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 1]),
      interpolation: "step",
    };
    expect(sampleMorphWeight(track, 0.5)).toBe(0);
  });

  it("should clamp at end", () => {
    const track: MorphTargetTrack = {
      targetIndex: 0,
      times: new Float32Array([0, 1]),
      values: new Float32Array([0, 1]),
      interpolation: "linear",
    };
    expect(sampleMorphWeight(track, 2.0)).toBe(1);
  });
});

describe("AnimationClip morph tracks", () => {
  it("should sample morph weights", () => {
    const morphTracks: MorphTargetTrack[] = [
      { targetIndex: 0, times: new Float32Array([0, 1]), values: new Float32Array([0, 1]), interpolation: "linear" },
      { targetIndex: 1, times: new Float32Array([0, 1]), values: new Float32Array([1, 0]), interpolation: "linear" },
    ];
    const clip = buildAnimationClipFromGLTF("test", [], morphTracks);
    expect(clip.morphTrackCount).toBe(2);
    expect(clip.morphTrackedTargets.size).toBe(2);

    const out = new Float32Array(2);
    clip.sampleMorphWeights(0.5, out);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
  });

  it("should handle clip with no morph tracks", () => {
    const clip = buildAnimationClipFromGLTF("test", []);
    expect(clip.morphTrackCount).toBe(0);
    expect(clip.morphTrackedTargets.size).toBe(0);

    const out = new Float32Array(4);
    clip.sampleMorphWeights(0.5, out);
    expect(out[0]).toBe(0);
  });

  it("should wrap around duration", () => {
    const morphTracks: MorphTargetTrack[] = [
      { targetIndex: 0, times: new Float32Array([0, 2]), values: new Float32Array([0, 1]), interpolation: "linear" },
    ];
    const clip = buildAnimationClipFromGLTF("test", [], morphTracks);
    const out = new Float32Array(1);
    clip.sampleMorphWeights(2.5, out);
    expect(out[0]).toBeCloseTo(0.25, 5);
  });
});
