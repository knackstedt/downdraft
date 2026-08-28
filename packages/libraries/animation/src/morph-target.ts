export interface MorphTarget {
  name: string;
  deltaPositions: Float32Array;
  deltaNormals?: Float32Array;
  weight: number;
}

export interface MorphTargetData {
  targets: MorphTarget[];
  maxInfluences: number;
}

export interface MorphTargetTrack {
  targetIndex: number;
  times: Float32Array;
  values: Float32Array;
  interpolation: "step" | "linear" | "cubicspline";
}

export function buildMorphTargetData(
  targets: MorphTarget[],
  maxInfluences?: number,
): MorphTargetData {
  const inferred = maxInfluences ?? Math.min(targets.length, 8);
  return { targets, maxInfluences: inferred };
}

export function createMorphTargetTrack(
  targetIndex: number,
  times: Float32Array,
  values: Float32Array,
  interpolation: "step" | "linear" | "cubicspline" = "linear",
): MorphTargetTrack {
  return { targetIndex, times, values, interpolation };
}

export function findMorphKeyframeIndex(
  times: Float32Array,
  t: number,
): { index: number; alpha: number } {
  if (times.length === 0) return { index: 0, alpha: 0 };
  if (times.length === 1) return { index: 0, alpha: 0 };
  if (t <= times[0]) return { index: 0, alpha: 0 };
  if (t >= times[times.length - 1])
    return { index: times.length - 2, alpha: 1 };

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

export function sampleMorphWeight(
  track: MorphTargetTrack,
  t: number,
): number {
  const { index, alpha } = findMorphKeyframeIndex(track.times, t);
  const base = track.values[index];
  if (track.interpolation === "step" || alpha === 0) return base;
  const next = track.values[index + 1] ?? base;
  return base + (next - base) * alpha;
}
