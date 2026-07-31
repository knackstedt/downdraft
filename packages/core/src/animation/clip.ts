export type TrackPath = "position" | "rotation" | "scale";

export interface KeyframeTrack {
  boneName: string;
  boneIndex: number;
  path: TrackPath;
  times: Float32Array;
  values: Float32Array;
  interpolation: "step" | "linear" | "cubicspline";
}

export interface AnimationClipData {
  name: string;
  duration: number;
  tracks: KeyframeTrack[];
}

export class AnimationClip {
  data: AnimationClipData;
  private trackIndexMap: Map<string, KeyframeTrack[]> = new Map();
  trackedBones: Set<number>;

  constructor(data: AnimationClipData) {
    this.data = data;
    this.trackedBones = new Set();
    for (const track of data.tracks) {
      this.trackedBones.add(track.boneIndex);
      const key = `${track.boneIndex}:${track.path}`;
      let tracks = this.trackIndexMap.get(key);
      if (!tracks) {
        tracks = [];
        this.trackIndexMap.set(key, tracks);
      }
      tracks.push(track);
    }
  }

  get duration(): number {
    return this.data.duration;
  }

  get name(): string {
    return this.data.name;
  }

  get trackCount(): number {
    return this.data.tracks.length;
  }

  getTracksForBone(boneIndex: number, path: TrackPath): KeyframeTrack[] {
    return this.trackIndexMap.get(`${boneIndex}:${path}`) ?? [];
  }

  sample(
    time: number,
    outPositions: Array<[number, number, number]>,
    outRotations: Array<[number, number, number, number]>,
    outScales: Array<[number, number, number]>,
  ): void {
    let t: number;
    if (this.data.duration > 0) {
      t = time % this.data.duration;
      if (t === 0 && time > 0) t = this.data.duration;
    } else {
      t = 0;
    }

    for (const track of this.data.tracks) {
      switch (track.path) {
        case "position":
          outPositions[track.boneIndex] = sampleVec3(track, t, outPositions[track.boneIndex] ?? [0, 0, 0]);
          break;
        case "rotation":
          outRotations[track.boneIndex] = sampleQuat(track, t, outRotations[track.boneIndex] ?? [0, 0, 0, 1]);
          break;
        case "scale":
          outScales[track.boneIndex] = sampleVec3(track, t, outScales[track.boneIndex] ?? [1, 1, 1]);
          break;
      }
    }
  }
}

function findKeyframeIndex(times: Float32Array, t: number): { index: number; alpha: number } {
  if (times.length === 0) return { index: 0, alpha: 0 };
  if (times.length === 1) return { index: 0, alpha: 0 };
  if (t <= times[0]) return { index: 0, alpha: 0 };
  if (t >= times[times.length - 1]) return { index: times.length - 2, alpha: 1 };

  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }

  const duration = times[hi] - times[lo];
  const alpha = duration > 0 ? (t - times[lo]) / duration : 0;
  return { index: lo, alpha };
}

function sampleVec3(track: KeyframeTrack, t: number, out: [number, number, number]): [number, number, number] {
  const { index, alpha } = findKeyframeIndex(track.times, t);
  const base = index * 3;
  if (track.interpolation === "step" || alpha === 0) {
    out[0] = track.values[base];
    out[1] = track.values[base + 1];
    out[2] = track.values[base + 2];
  } else {
    const next = (index + 1) * 3;
    out[0] = track.values[base] + (track.values[next] - track.values[base]) * alpha;
    out[1] = track.values[base + 1] + (track.values[next + 1] - track.values[base + 1]) * alpha;
    out[2] = track.values[base + 2] + (track.values[next + 2] - track.values[base + 2]) * alpha;
  }
  return out;
}

function slerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return [
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ];
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const sinT0 = Math.sin((1 - t) * theta) / sinTheta;
  const sinT1 = Math.sin(t * theta) / sinTheta;
  return [
    a[0] * sinT0 + bx * sinT1,
    a[1] * sinT0 + by * sinT1,
    a[2] * sinT0 + bz * sinT1,
    a[3] * sinT0 + bw * sinT1,
  ];
}

function sampleQuat(track: KeyframeTrack, t: number, out: [number, number, number, number]): [number, number, number, number] {
  const { index, alpha } = findKeyframeIndex(track.times, t);
  const base = index * 4;
  if (track.interpolation === "step" || alpha === 0) {
    out[0] = track.values[base];
    out[1] = track.values[base + 1];
    out[2] = track.values[base + 2];
    out[3] = track.values[base + 3];
  } else {
    const a: [number, number, number, number] = [
      track.values[base], track.values[base + 1], track.values[base + 2], track.values[base + 3],
    ];
    const next = (index + 1) * 4;
    const b: [number, number, number, number] = [
      track.values[next], track.values[next + 1], track.values[next + 2], track.values[next + 3],
    ];
    const result = slerpQuat(a, b, alpha);
    out[0] = result[0]; out[1] = result[1]; out[2] = result[2]; out[3] = result[3];
  }
  return out;
}

export function buildAnimationClipFromGLTF(
  name: string,
  channels: Array<{
    nodeIndex: number;
    boneName: string;
    boneIndex: number;
    path: TrackPath;
    times: Float32Array;
    values: Float32Array;
    interpolation?: "step" | "linear" | "cubicspline";
  }>,
): AnimationClip {
  let maxTime = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.times.length; i++) {
      if (ch.times[i] > maxTime) maxTime = ch.times[i];
    }
  }

  const tracks: KeyframeTrack[] = channels.map((ch) => ({
    boneName: ch.boneName,
    boneIndex: ch.boneIndex,
    path: ch.path,
    times: ch.times,
    values: ch.values,
    interpolation: ch.interpolation ?? "linear",
  }));

  return new AnimationClip({
    name,
    duration: maxTime,
    tracks,
  });
}
