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
  paused: boolean;
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
  }

  play(name: string, clip: AnimationClip, options?: { speed?: number; weight?: number; loop?: boolean; fadeDuration?: number }): void {
    const fadeDuration = options?.fadeDuration ?? 0;
    const existing = this.playing.get(name);

    if (existing) {
      existing.clip = clip;
      existing.speed = options?.speed ?? 1;
      existing.weight = options?.weight ?? 1;
      existing.loop = options?.loop ?? true;
      existing.blending = false;
      existing.paused = false;
      return;
    }

    if (fadeDuration > 0 && this.playing.size > 0) {
      for (const p of this.playing.values()) {
        p.blending = true;
        p.blendOutDuration = fadeDuration;
        p.blendOutElapsed = 0;
        p.blendOutStartWeight = p.weight;
      }
    } else if (fadeDuration === 0) {
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
      paused: false,
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
    for (let i = 0; i < this.boneCount; i++) {
      this.positions[i] = [...bindPose[i].position] as [number, number, number];
      this.rotations[i] = [...bindPose[i].rotation] as [number, number, number, number];
      this.scales[i] = [...bindPose[i].scale] as [number, number, number];
    }

    const stillPlaying: PlayingAnimation[] = [];

    for (const p of this.playing.values()) {
      if (p.paused) {
        stillPlaying.push(p);
        continue;
      }
      p.time += dt * p.speed;

      if (p.loop && p.clip.duration > 0) {
        p.time = p.time % p.clip.duration;
        if (p.time < 0) p.time += p.clip.duration;
      } else if (p.time >= p.clip.duration || p.time < 0) {
        p.time = Math.max(0, Math.min(p.time, p.clip.duration));
        p.weight = 0;
      }

      if (p.blending && p.blendOutDuration > 0) {
        p.blendOutElapsed += dt;
        const alpha = Math.min(1, p.blendOutElapsed / p.blendOutDuration);
        p.weight = p.blendOutStartWeight * (1 - alpha);
        if (alpha >= 1) continue;
      }

      if (p.blending && p.blendOutDuration === 0) {
        p.weight = Math.min(1, p.weight + dt * 5);
        if (p.weight >= 1) p.blending = false;
      }

      if (p.weight <= 0.001) continue;

      p.clip.sample(p.time, this.resultPositions, this.resultRotations, this.resultScales);

      const w = p.weight;
      for (let i = 0; i < this.boneCount; i++) {
        if (w >= 0.999) {
          this.positions[i] = [...this.resultPositions[i]] as [number, number, number];
          this.rotations[i] = [...this.resultRotations[i]] as [number, number, number, number];
          this.scales[i] = [...this.resultScales[i]] as [number, number, number];
        } else {
          const rp = this.resultPositions[i];
          this.positions[i][0] += (rp[0] - this.positions[i][0]) * w;
          this.positions[i][1] += (rp[1] - this.positions[i][1]) * w;
          this.positions[i][2] += (rp[2] - this.positions[i][2]) * w;

          this.rotations[i] = slerpQuat(this.rotations[i], this.resultRotations[i], w);

          const rs = this.resultScales[i];
          this.scales[i][0] += (rs[0] - this.scales[i][0]) * w;
          this.scales[i][1] += (rs[1] - this.scales[i][1]) * w;
          this.scales[i][2] += (rs[2] - this.scales[i][2]) * w;
        }
      }

      stillPlaying.push(p);
    }

    this.playing.clear();
    for (const p of stillPlaying) this.playing.set(p.name, p);
    this.skinMatrices = null;
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
  const sinT = Math.sin(t * theta) / sinTheta;
  const cosT = Math.cos(t * theta);
  return [
    a[0] * cosT + bx * sinT,
    a[1] * cosT + by * sinT,
    a[2] * cosT + bz * sinT,
    a[3] * cosT + bw * sinT,
  ];
}
