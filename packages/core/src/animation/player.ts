import type { AnimationClip } from "./clip.ts";
import type { Skeleton } from "./skeleton.ts";

interface BoneTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface PlayingAnimation {
  name: string;
  clip: AnimationClip;
  time: number;
  speed: number;
  weight: number;
  loop: boolean;
  blending: boolean;
  blendOutDuration: number;
  blendOutElapsed: number;
  blendOutStartWeight: number;
  fadeInDuration: number;
  fadeInElapsed: number;
  paused: boolean;
  boneMask: Set<number> | null;
  additive: boolean;
}

export class AnimationPlayer {
  private skeleton: Skeleton;
  private playing: Map<string, PlayingAnimation> = new Map();
  private boneCount: number;
  private positions: Array<[number, number, number]>;
  private rotations: Array<[number, number, number, number]>;
  private scales: Array<[number, number, number]>;
  private resultPositions: Array<[number, number, number]>;
  private resultRotations: Array<[number, number, number, number]>;
  private resultScales: Array<[number, number, number]>;
  private skinMatrices: Float32Array | null = null;
  private bindPositions: Array<[number, number, number]>;
  private bindRotations: Array<[number, number, number, number]>;
  private bindScales: Array<[number, number, number]>;
  private rootBoneIndex: number;
  private lastRootPos: [number, number, number] | null = null;
  private rootMotionDelta: [number, number, number] = [0, 0, 0];
  private accPos: Float32Array;
  private accRot: Float32Array;
  private accScale: Float32Array;
  private accWeight: Float32Array;

  constructor(skeleton: Skeleton) {
    this.skeleton = skeleton;
    this.boneCount = skeleton.getBoneCount();
    const bindPose = skeleton.getBindPose();
    this.positions = bindPose.map((b) => [...b.position] as [number, number, number]);
    this.rotations = bindPose.map((b) => [...b.rotation] as [number, number, number, number]);
    this.scales = bindPose.map((b) => [...b.scale] as [number, number, number]);
    this.resultPositions = bindPose.map(() => [0, 0, 0] as [number, number, number]);
    this.resultRotations = bindPose.map(() => [0, 0, 0, 1] as [number, number, number, number]);
    this.resultScales = bindPose.map(() => [1, 1, 1] as [number, number, number]);
    this.bindPositions = bindPose.map((b) => [...b.position] as [number, number, number]);
    this.bindRotations = bindPose.map((b) => [...b.rotation] as [number, number, number, number]);
    this.bindScales = bindPose.map((b) => [...b.scale] as [number, number, number]);
    this.rootBoneIndex = skeleton.data.rootBoneIndex;
    this.accPos = new Float32Array(this.boneCount * 3);
    this.accRot = new Float32Array(this.boneCount * 4);
    this.accScale = new Float32Array(this.boneCount * 3);
    this.accWeight = new Float32Array(this.boneCount);
  }

  play(name: string, clip: AnimationClip, options?: { speed?: number; weight?: number; loop?: boolean; fadeDuration?: number; boneMask?: number[] | Set<number>; additive?: boolean }): void {
    const fadeDuration = options?.fadeDuration ?? 0;
    const boneMask = options?.boneMask
      ? (options.boneMask instanceof Set ? options.boneMask : new Set(options.boneMask))
      : null;
    const additive = options?.additive ?? false;
    const existing = this.playing.get(name);

    if (existing) {
      existing.clip = clip;
      existing.speed = options?.speed ?? 1;
      existing.weight = options?.weight ?? 1;
      existing.loop = options?.loop ?? true;
      existing.blending = false;
      existing.paused = false;
      existing.boneMask = boneMask;
      existing.additive = additive;
      return;
    }

    if (fadeDuration > 0 && this.playing.size > 0) {
      for (const p of this.playing.values()) {
        p.blending = true;
        p.blendOutDuration = fadeDuration;
        p.blendOutElapsed = 0;
        p.blendOutStartWeight = p.weight;
      }
    } else if (fadeDuration === 0 && !boneMask && !additive) {
      this.playing.clear();
    }

    this.playing.set(name, {
      name,
      clip,
      time: 0,
      speed: options?.speed ?? 1,
      weight: fadeDuration > 0 ? 0 : (options?.weight ?? 1),
      loop: options?.loop ?? true,
      blending: fadeDuration > 0,
      blendOutDuration: 0,
      blendOutElapsed: 0,
      blendOutStartWeight: 0,
      fadeInDuration: fadeDuration,
      fadeInElapsed: 0,
      paused: false,
      boneMask,
      additive,
    });
  }

  stop(name?: string): void {
    if (name) {
      this.playing.delete(name);
    } else {
      this.playing.clear();
    }
  }

  pause(name?: string): void {
    if (name) {
      const p = this.playing.get(name);
      if (p) p.paused = true;
    } else {
      for (const p of this.playing.values()) p.paused = true;
    }
  }

  resume(name?: string): void {
    if (name) {
      const p = this.playing.get(name);
      if (p) p.paused = false;
    } else {
      for (const p of this.playing.values()) p.paused = false;
    }
  }

  setSpeed(name: string, speed: number): void {
    const p = this.playing.get(name);
    if (p) p.speed = speed;
  }

  setWeight(name: string, weight: number): void {
    const p = this.playing.get(name);
    if (p) p.weight = weight;
  }

  isPlaying(name?: string): boolean {
    if (name) {
      const p = this.playing.get(name);
      return p !== undefined && !p.paused;
    }
    for (const p of this.playing.values()) {
      if (!p.paused) return true;
    }
    return false;
  }

  getPlayingCount(): number {
    return this.playing.size;
  }

  update(dt: number): void {
    const bindPose = this.skeleton.getBindPose();
    const stillPlaying: PlayingAnimation[] = [];
    const activeNonAdditive: PlayingAnimation[] = [];
    const activeAdditive: PlayingAnimation[] = [];

    // Phase 1: Time update and weight fade for all animations
    for (const p of this.playing.values()) {
      if (!p.paused) {
        p.time += dt * p.speed;

        if (p.loop && p.clip.duration > 0) {
          p.time = p.time % p.clip.duration;
          if (p.time < 0) p.time += p.clip.duration;
        } else if (p.time >= p.clip.duration || p.time < 0) {
          p.time = Math.max(0, Math.min(p.time, p.clip.duration));
          p.weight = 0;
        }

        // Fade out
        if (p.blending && p.blendOutDuration > 0) {
          p.blendOutElapsed += dt;
          const alpha = Math.min(1, p.blendOutElapsed / p.blendOutDuration);
          p.weight = p.blendOutStartWeight * (1 - alpha);
          if (alpha >= 1) continue;
        }

        // Fade in
        if (p.blending && p.fadeInDuration > 0) {
          p.fadeInElapsed += dt;
          const alpha = Math.min(1, p.fadeInElapsed / p.fadeInDuration);
          p.weight = alpha;
          if (alpha >= 1) p.blending = false;
        }
      }

      if (p.weight <= 0.001) continue;

      stillPlaying.push(p);
      if (p.additive) activeAdditive.push(p);
      else activeNonAdditive.push(p);
    }

    // Phase 2: Reset accumulators
    this.accPos.fill(0);
    this.accRot.fill(0);
    this.accScale.fill(0);
    this.accWeight.fill(0);

    // Phase 3: Sample and accumulate non-additive animations (weighted average)
    for (const p of activeNonAdditive) {
      p.clip.sample(p.time, this.resultPositions, this.resultRotations, this.resultScales);
      const w = p.weight;
      for (const boneIdx of p.clip.trackedBones) {
        if (p.boneMask && !p.boneMask.has(boneIdx)) continue;
        const i3 = boneIdx * 3;
        const i4 = boneIdx * 4;

        this.accPos[i3] += this.resultPositions[boneIdx][0] * w;
        this.accPos[i3 + 1] += this.resultPositions[boneIdx][1] * w;
        this.accPos[i3 + 2] += this.resultPositions[boneIdx][2] * w;

        // Quaternion sign consistency for weighted average
        if (this.accWeight[boneIdx] === 0) {
          this.accRot[i4] = this.resultRotations[boneIdx][0] * w;
          this.accRot[i4 + 1] = this.resultRotations[boneIdx][1] * w;
          this.accRot[i4 + 2] = this.resultRotations[boneIdx][2] * w;
          this.accRot[i4 + 3] = this.resultRotations[boneIdx][3] * w;
        } else {
          let sign = 1;
          if (this.accRot[i4] * this.resultRotations[boneIdx][0] +
              this.accRot[i4 + 1] * this.resultRotations[boneIdx][1] +
              this.accRot[i4 + 2] * this.resultRotations[boneIdx][2] +
              this.accRot[i4 + 3] * this.resultRotations[boneIdx][3] < 0) {
            sign = -1;
          }
          this.accRot[i4] += this.resultRotations[boneIdx][0] * w * sign;
          this.accRot[i4 + 1] += this.resultRotations[boneIdx][1] * w * sign;
          this.accRot[i4 + 2] += this.resultRotations[boneIdx][2] * w * sign;
          this.accRot[i4 + 3] += this.resultRotations[boneIdx][3] * w * sign;
        }

        this.accScale[i3] += this.resultScales[boneIdx][0] * w;
        this.accScale[i3 + 1] += this.resultScales[boneIdx][1] * w;
        this.accScale[i3 + 2] += this.resultScales[boneIdx][2] * w;

        this.accWeight[boneIdx] += w;
      }
    }

    // Phase 4: Normalize by total weight, fallback to bind pose
    for (let i = 0; i < this.boneCount; i++) {
      const i3 = i * 3;
      const i4 = i * 4;
      if (this.accWeight[i] > 0.001) {
        const invW = 1 / this.accWeight[i];
        this.positions[i][0] = this.accPos[i3] * invW;
        this.positions[i][1] = this.accPos[i3 + 1] * invW;
        this.positions[i][2] = this.accPos[i3 + 2] * invW;
        const rx = this.accRot[i4], ry = this.accRot[i4 + 1], rz = this.accRot[i4 + 2], rw = this.accRot[i4 + 3];
        const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
        if (rlen > 0) {
          this.rotations[i][0] = rx / rlen;
          this.rotations[i][1] = ry / rlen;
          this.rotations[i][2] = rz / rlen;
          this.rotations[i][3] = rw / rlen;
        }
        this.scales[i][0] = this.accScale[i3] * invW;
        this.scales[i][1] = this.accScale[i3 + 1] * invW;
        this.scales[i][2] = this.accScale[i3 + 2] * invW;
      } else {
        this.positions[i][0] = bindPose[i].position[0];
        this.positions[i][1] = bindPose[i].position[1];
        this.positions[i][2] = bindPose[i].position[2];
        this.rotations[i][0] = bindPose[i].rotation[0];
        this.rotations[i][1] = bindPose[i].rotation[1];
        this.rotations[i][2] = bindPose[i].rotation[2];
        this.rotations[i][3] = bindPose[i].rotation[3];
        this.scales[i][0] = bindPose[i].scale[0];
        this.scales[i][1] = bindPose[i].scale[1];
        this.scales[i][2] = bindPose[i].scale[2];
      }
    }

    // Phase 5: Apply additive animations on top
    for (const p of activeAdditive) {
      p.clip.sample(p.time, this.resultPositions, this.resultRotations, this.resultScales);
      const w = p.weight;
      for (const boneIdx of p.clip.trackedBones) {
        if (p.boneMask && !p.boneMask.has(boneIdx)) continue;

        const rp = this.resultPositions[boneIdx];
        const bp = this.bindPositions[boneIdx];
        this.positions[boneIdx][0] += (rp[0] - bp[0]) * w;
        this.positions[boneIdx][1] += (rp[1] - bp[1]) * w;
        this.positions[boneIdx][2] += (rp[2] - bp[2]) * w;

        const deltaRot = quatMulTuple(quatInvertTuple(this.bindRotations[boneIdx]), this.resultRotations[boneIdx]);
        const appliedRot = slerpQuat(IDENTITY_QUAT, deltaRot, w);
        this.rotations[boneIdx] = quatMulTuple(this.rotations[boneIdx], appliedRot);

        const rs = this.resultScales[boneIdx];
        const bs = this.bindScales[boneIdx];
        this.scales[boneIdx][0] += (rs[0] - bs[0]) * w;
        this.scales[boneIdx][1] += (rs[1] - bs[1]) * w;
        this.scales[boneIdx][2] += (rs[2] - bs[2]) * w;
      }
    }

    this.playing.clear();
    for (const p of stillPlaying) this.playing.set(p.name, p);
    this.skinMatrices = null;

    // Root motion
    const rootPos = this.positions[this.rootBoneIndex];
    if (this.lastRootPos) {
      this.rootMotionDelta[0] = rootPos[0] - this.lastRootPos[0];
      this.rootMotionDelta[1] = rootPos[1] - this.lastRootPos[1];
      this.rootMotionDelta[2] = rootPos[2] - this.lastRootPos[2];
    } else {
      this.rootMotionDelta[0] = 0;
      this.rootMotionDelta[1] = 0;
      this.rootMotionDelta[2] = 0;
    }
    this.lastRootPos = [rootPos[0], rootPos[1], rootPos[2]];
  }

  getSkinMatrices(): Float32Array {
    if (!this.skinMatrices) {
      const transforms: BoneTransform[] = [];
      for (let i = 0; i < this.boneCount; i++) {
        transforms.push({
          position: this.positions[i],
          rotation: this.rotations[i],
          scale: this.scales[i],
        });
      }
      this.skinMatrices = this.skeleton.computeSkinMatrices(transforms);
    }
    return this.skinMatrices;
  }

  getBoneTransforms(): { positions: Array<[number, number, number]>; rotations: Array<[number, number, number, number]>; scales: Array<[number, number, number]> } {
    return {
      positions: this.positions,
      rotations: this.rotations,
      scales: this.scales,
    };
  }

  getRootMotionDelta(): [number, number, number] {
    return [this.rootMotionDelta[0], this.rootMotionDelta[1], this.rootMotionDelta[2]];
  }

  resetRootMotion(): void {
    this.lastRootPos = null;
    this.rootMotionDelta = [0, 0, 0];
  }
}

const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

function quatMulTuple(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatInvertTuple(q: [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
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
