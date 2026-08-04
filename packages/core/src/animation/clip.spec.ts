import { AnimationClip } from "./clip";
import type { AnimationClipData, KeyframeTrack } from "./clip";

function makeTrack(boneIndex: number, path: "position" | "rotation" | "scale", times: number[], values: number[]): KeyframeTrack {
  return {
    boneName: `bone_${boneIndex}`,
    boneIndex,
    path,
    times: new Float32Array(times),
    values: new Float32Array(values),
    interpolation: "linear",
  };
}

function makeEmptyOutputs() {
  return {
    positions: [] as Array<[number, number, number]>,
    rotations: [] as Array<[number, number, number, number]>,
    scales: [] as Array<[number, number, number]>,
  };
}

describe("AnimationClip", () => {
  it("samples position tracks with linear interpolation", () => {
    const track = makeTrack(0, "position", [0, 1], [0, 0, 0, 10, 0, 0]);
    const clip = new AnimationClip({ name: "test", duration: 1, tracks: [track] });
    const out = makeEmptyOutputs();
    clip.sample(0.5, out.positions, out.rotations, out.scales);
    expect(out.positions[0]).toEqual([5, 0, 0]);
  });

  it("samples rotation tracks with slerp", () => {
    const track = makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, 0, 1, 0]);
    const clip = new AnimationClip({ name: "test_rot", duration: 1, tracks: [track] });
    const out = makeEmptyOutputs();
    clip.sample(0.5, out.positions, out.rotations, out.scales);
    const r = out.rotations[0];
    expect(r[0]).toBeCloseTo(0, 5);
    expect(r[1]).toBeCloseTo(0, 5);
    expect(r[2]).toBeCloseTo(0.7071, 3);
    expect(r[3]).toBeCloseTo(0.7071, 3);
  });

  it("wraps time past duration (modulo)", () => {
    const track = makeTrack(0, "position", [0, 1], [0, 0, 0, 10, 0, 0]);
    const clip = new AnimationClip({ name: "test_clamp", duration: 1, tracks: [track] });
    const out = makeEmptyOutputs();
    clip.sample(0.999, out.positions, out.rotations, out.scales);
    expect(out.positions[0][0]).toBeCloseTo(10, 0);
  });

  it("handles multiple tracks for different bones", () => {
    const t0 = makeTrack(0, "position", [0, 1], [0, 0, 0, 5, 0, 0]);
    const t1 = makeTrack(1, "position", [0, 1], [0, 0, 0, 0, 5, 0]);
    const clip = new AnimationClip({ name: "multi", duration: 1, tracks: [t0, t1] });
    const out = makeEmptyOutputs();
    clip.sample(0.999, out.positions, out.rotations, out.scales);
    expect(out.positions[0][0]).toBeCloseTo(5, 0);
    expect(out.positions[1][1]).toBeCloseTo(5, 0);
  });

  it("returns default pose for time before first keyframe", () => {
    const track = makeTrack(0, "position", [0.5, 1], [0, 0, 0, 10, 0, 0]);
    const clip = new AnimationClip({ name: "test_offset", duration: 1, tracks: [track] });
    const out = makeEmptyOutputs();
    clip.sample(0, out.positions, out.rotations, out.scales);
    expect(out.positions[0]).toEqual([0, 0, 0]);
  });
});
