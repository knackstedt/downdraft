import type { AnimationEvent } from "./animation-event";
import { getEventsInRange } from "./animation-event";
import { BoneMaskPreset, buildBoneMask, buildCustomBoneMask } from "./bone-mask";
import type { AnimationClip } from "./clip";
import type { Skeleton, SkeletonData } from "./skeleton";

export const MAX_MORPH_TARGETS = 64;

export type LayerBlendMode = "override" | "additive";

interface BoneTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface PlayOptions {
  speed?: number;
  weight?: number;
  loop?: boolean;
  fadeDuration?: number;
  boneMask?: number[] | Set<number> | BoneMaskPreset | string;
  additive?: boolean;
  priority?: number;
  skeletonData?: SkeletonData;
}

interface AnimationLayer {
  name: string;
  clip: AnimationClip;
  time: number;
  speed: number;
  weight: number;
  targetWeight: number;
  fadeSpeed: number;
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
  priority: number;
  pendingClip: AnimationClip | null;
  clipSwapFade: number;
}

export class AnimationPlayer {
  private skeleton: Skeleton;
  private layers: Map<string, AnimationLayer> = new Map();
  private layerOrder: string[] = [];
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
  private morphWeights: Float32Array;
  private accMorphWeights: Float32Array;
  private accMorphWeight: Float32Array;
  private resultMorphWeights: Float32Array;
  private maxMorphTargets: number;
  private eventHandlers: Map<string, Array<(event: AnimationEvent) => void>> = new Map();
  private pendingEvents: AnimationEvent[] = [];
  private lastSampleTimes: Map<string, number> = new Map();

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
    this.maxMorphTargets = MAX_MORPH_TARGETS;
    this.morphWeights = new Float32Array(this.maxMorphTargets);
    this.accMorphWeights = new Float32Array(this.maxMorphTargets);
    this.accMorphWeight = new Float32Array(this.maxMorphTargets);
    this.resultMorphWeights = new Float32Array(this.maxMorphTargets);
  }

  // ── Events ──

  onEvent(type: string, handler: (event: AnimationEvent) => void): void {
    let handlers = this.eventHandlers.get(type);
    if (!handlers) {
      handlers = [];
      this.eventHandlers.set(type, handlers);
    }
    handlers.push(handler);
  }

  offEvent(type: string, handler?: (event: AnimationEvent) => void): void {
    if (!handler) {
      this.eventHandlers.delete(type);
      return;
    }
    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
      if (handlers.length === 0) this.eventHandlers.delete(type);
    }
  }

  getPendingEvents(): AnimationEvent[] {
    return this.pendingEvents;
  }

  clearPendingEvents(): void {
    this.pendingEvents = [];
  }

  // ── Layer management ──

  play(name: string, clip: AnimationClip, options?: PlayOptions): void {
    const fadeDuration = options?.fadeDuration ?? 0;
    const priority = options?.priority ?? 0;
    const additive = options?.additive ?? false;

    let boneMask: Set<number> | null = null;
    if (options?.boneMask) {
      const bm = options.boneMask;
      if (bm instanceof Set) {
        boneMask = bm;
      } else if (Array.isArray(bm)) {
        boneMask = new Set(bm);
      } else if (typeof bm === "string") {
        if (Object.values(BoneMaskPreset).includes(bm as BoneMaskPreset) && options.skeletonData) {
          boneMask = buildBoneMask(bm as BoneMaskPreset, options.skeletonData);
        } else if (options.skeletonData) {
          boneMask = buildCustomBoneMask(bm, options.skeletonData);
        }
      }
    }

    // If fading in, fade out existing non-additive layers (runs before the
    // existing-layer check so re-playing a layer still fades out others).
    if (fadeDuration > 0 && priority === 0 && !additive) {
      for (const l of this.layers.values()) {
        if (l.name === name) continue; // don't fade out the layer we're about to play
        if (!l.additive && l.priority === 0) {
          l.blending = true;
          l.blendOutDuration = fadeDuration;
          l.blendOutElapsed = 0;
          l.blendOutStartWeight = l.weight;
          l.fadeInDuration = 0; // clear fade-in so it doesn't interfere with fade-out
        }
      }
    }

    const existing = this.layers.get(name);
    if (existing) {
      existing.clip = clip;
      existing.time = 0;
      existing.speed = options?.speed ?? 1;
      existing.weight = fadeDuration > 0 ? 0 : (options?.weight ?? 1);
      existing.targetWeight = options?.weight ?? 1;
      existing.loop = options?.loop ?? true;
      existing.blending = fadeDuration > 0;
      existing.fadeInDuration = fadeDuration;
      existing.fadeInElapsed = 0;
      existing.blendOutDuration = 0;  // clear any pending fade-out
      existing.blendOutElapsed = 0;
      existing.paused = false;
      existing.boneMask = boneMask;
      existing.additive = additive;
      existing.priority = priority;
      existing.fadeSpeed = 0;
      this.lastSampleTimes.set(name, 0);
      this.sortLayers();
      return;
    }

    // If no mask, no additive, no priority, and no fade → replace all (simple play)
    if (fadeDuration === 0 && !boneMask && !additive && priority === 0) {
      this.layers.clear();
      this.layerOrder = [];
    }

    const initialWeight = fadeDuration > 0 ? 0 : (options?.weight ?? 1);
    this.layers.set(name, {
      name,
      clip,
      time: 0,
      speed: options?.speed ?? 1,
      weight: initialWeight,
      targetWeight: options?.weight ?? 1,
      fadeSpeed: 0,
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
      priority,
      pendingClip: null,
      clipSwapFade: 0,
    });
    this.layerOrder.push(name);
    this.lastSampleTimes.set(name, 0);
    this.sortLayers();
  }

  stop(name?: string): void {
    if (name) {
      this.layers.delete(name);
      this.layerOrder = this.layerOrder.filter((n) => n !== name);
    } else {
      this.layers.clear();
      this.layerOrder = [];
    }
  }

  pause(name?: string): void {
    if (name) {
      const l = this.layers.get(name);
      if (l) l.paused = true;
    } else {
      for (const l of this.layers.values()) l.paused = true;
    }
  }

  resume(name?: string): void {
    if (name) {
      const l = this.layers.get(name);
      if (l) l.paused = false;
    } else {
      for (const l of this.layers.values()) l.paused = false;
    }
  }

  setSpeed(name: string, speed: number): void {
    const l = this.layers.get(name);
    if (l) l.speed = speed;
  }

  setWeight(name: string, weight: number, fadeDuration?: number): void {
    const l = this.layers.get(name);
    if (!l) return;
    if (fadeDuration && fadeDuration > 0) {
      l.targetWeight = weight;
      l.fadeSpeed = Math.abs(weight - l.weight) / fadeDuration;
    } else {
      l.targetWeight = weight;
      l.weight = weight;
      l.fadeSpeed = 0;
    }
  }

  setClip(name: string, clip: AnimationClip, fadeDuration?: number): void {
    const l = this.layers.get(name);
    if (!l) return;
    if (fadeDuration && fadeDuration > 0) {
      l.pendingClip = clip;
      l.clipSwapFade = fadeDuration;
    } else {
      l.clip = clip;
      l.time = 0;
      this.lastSampleTimes.set(name, 0);
    }
  }

  isPlaying(name?: string): boolean {
    if (name) {
      const l = this.layers.get(name);
      return l !== undefined && !l.paused;
    }
    for (const l of this.layers.values()) {
      if (!l.paused) return true;
    }
    return false;
  }

  getPlayingCount(): number {
    return this.layers.size;
  }

  getLayerCount(): number {
    return this.layers.size;
  }

  hasLayer(name: string): boolean {
    return this.layers.has(name);
  }

  private sortLayers(): void {
    this.layerOrder.sort((a, b) => {
      const la = this.layers.get(a)!;
      const lb = this.layers.get(b)!;
      return lb.priority - la.priority;
    });
  }

  // ── Update ──

  update(dt: number): void {
    const bindPose = this.skeleton.getBindPose();
    const stillPlaying: AnimationLayer[] = [];
    const activeNonAdditive: AnimationLayer[] = [];
    const activeAdditive: AnimationLayer[] = [];
    const toRemove: string[] = [];

    // Phase 1: Time update, weight fading, clip swapping
    for (const l of this.layers.values()) {
      if (!l.paused) {
        l.time += dt * l.speed;

        if (l.loop && l.clip.duration > 0) {
          l.time = l.time % l.clip.duration;
          if (l.time < 0) l.time += l.clip.duration;
        } else if (l.time >= l.clip.duration || l.time < 0) {
          l.time = Math.max(0, Math.min(l.time, l.clip.duration));
          l.weight = 0;
          l.targetWeight = 0;
        }

        // Fade out
        if (l.blending && l.blendOutDuration > 0) {
          l.blendOutElapsed += dt;
          const alpha = Math.min(1, l.blendOutElapsed / l.blendOutDuration);
          l.weight = l.blendOutStartWeight * (1 - alpha);
          if (alpha >= 1) {
            toRemove.push(l.name);
            continue;
          }
        }

        // Fade in
        if (l.blending && l.fadeInDuration > 0) {
          l.fadeInElapsed += dt;
          const alpha = Math.min(1, l.fadeInElapsed / l.fadeInDuration);
          l.weight = alpha;
          if (alpha >= 1) l.blending = false;
        }

        // Weight fade (from setWeight with fadeDuration)
        if (l.fadeSpeed > 0) {
          if (l.weight < l.targetWeight) {
            l.weight = Math.min(l.targetWeight, l.weight + l.fadeSpeed * dt);
          } else if (l.weight > l.targetWeight) {
            l.weight = Math.max(l.targetWeight, l.weight - l.fadeSpeed * dt);
          }
          if (l.weight === l.targetWeight) {
            l.fadeSpeed = 0;
            if (l.targetWeight === 0) {
              toRemove.push(l.name);
              continue;
            }
          }
        }

        // Clip swap with fade
        if (l.clipSwapFade > 0) {
          l.clipSwapFade -= dt;
          if (l.clipSwapFade <= 0 && l.pendingClip) {
            l.clip = l.pendingClip;
            l.pendingClip = null;
            l.time = 0;
            this.lastSampleTimes.set(l.name, 0);
          }
        }
      }

      if (l.weight <= 0.001) continue;

      const prevTime = this.lastSampleTimes.get(l.name) ?? l.time;
      if (l.clip.eventTrack && !l.paused) {
        const events = getEventsInRange(l.clip.eventTrack, prevTime, l.time, l.clip.duration);
        events.forEach((e) => {
          this.pendingEvents.push(e);
          const handlers = this.eventHandlers.get(e.type);
          if (handlers) {
            handlers.forEach((h) => { h(e);; });
          }
        });
      }
      this.lastSampleTimes.set(l.name, l.time);

      stillPlaying.push(l);
      if (l.additive) activeAdditive.push(l);
      else activeNonAdditive.push(l);
    }

    // Remove faded-out layers
    toRemove.forEach((name) => {
      this.layers.delete(name);
      this.layerOrder = this.layerOrder.filter((n) => n !== name);
    });

    // Phase 2: Reset accumulators
    this.accPos.fill(0);
    this.accRot.fill(0);
    this.accScale.fill(0);
    this.accWeight.fill(0);
    this.accMorphWeights.fill(0);
    this.accMorphWeight.fill(0);

    // Phase 3: Sample and accumulate non-additive layers (weighted average)
    activeNonAdditive.forEach((l) => {
      // Reset result arrays to bind pose before sampling so bones without
      // tracks in this clip get bind pose values (not stale data from a
      // previous clip or the [0,0,0] initialization). This is critical for
      // retargeted clips that only have rotation tracks (translation channels
      // skipped during retargeting) — without this reset, the position would
      // be zeroed out instead of falling back to bind pose.
      for (let i = 0; i < this.boneCount; i++) {
        this.resultPositions[i][0] = this.bindPositions[i][0];
        this.resultPositions[i][1] = this.bindPositions[i][1];
        this.resultPositions[i][2] = this.bindPositions[i][2];
        this.resultRotations[i][0] = this.bindRotations[i][0];
        this.resultRotations[i][1] = this.bindRotations[i][1];
        this.resultRotations[i][2] = this.bindRotations[i][2];
        this.resultRotations[i][3] = this.bindRotations[i][3];
        this.resultScales[i][0] = this.bindScales[i][0];
        this.resultScales[i][1] = this.bindScales[i][1];
        this.resultScales[i][2] = this.bindScales[i][2];
      }
      l.clip.sample(l.time, this.resultPositions, this.resultRotations, this.resultScales);
      l.clip.sampleMorphWeights(l.time, this.resultMorphWeights);
      const w = l.weight;
      for (const targetIdx of l.clip.morphTrackedTargets.values()) {
        this.accMorphWeights[targetIdx] += this.resultMorphWeights[targetIdx] * w;
        this.accMorphWeight[targetIdx] += w;
      }
      for (const boneIdx of l.clip.trackedBones.values()) {
        if (l.boneMask && !l.boneMask.has(boneIdx)) continue;
        const i3 = boneIdx * 3;
        const i4 = boneIdx * 4;

        this.accPos[i3] += this.resultPositions[boneIdx][0] * w;
        this.accPos[i3 + 1] += this.resultPositions[boneIdx][1] * w;
        this.accPos[i3 + 2] += this.resultPositions[boneIdx][2] * w;

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
    });

    // Phase 4: Normalize by total weight, fallback to bind pose
    for (let i = 0; i < this.maxMorphTargets; i++) {
      if (this.accMorphWeight[i] > 0.001) {
        this.morphWeights[i] = this.accMorphWeights[i] / this.accMorphWeight[i];
      } else {
        this.morphWeights[i] = 0;
      }
    }
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

    // Phase 5: Apply additive layers on top
    activeAdditive.forEach((l) => {
      // Reset result arrays to bind pose (same reason as Phase 3).
      for (let i = 0; i < this.boneCount; i++) {
        this.resultPositions[i][0] = this.bindPositions[i][0];
        this.resultPositions[i][1] = this.bindPositions[i][1];
        this.resultPositions[i][2] = this.bindPositions[i][2];
        this.resultRotations[i][0] = this.bindRotations[i][0];
        this.resultRotations[i][1] = this.bindRotations[i][1];
        this.resultRotations[i][2] = this.bindRotations[i][2];
        this.resultRotations[i][3] = this.bindRotations[i][3];
        this.resultScales[i][0] = this.bindScales[i][0];
        this.resultScales[i][1] = this.bindScales[i][1];
        this.resultScales[i][2] = this.bindScales[i][2];
      }
      l.clip.sample(l.time, this.resultPositions, this.resultRotations, this.resultScales);
      l.clip.sampleMorphWeights(l.time, this.resultMorphWeights);
      const w = l.weight;
      for (const targetIdx of l.clip.morphTrackedTargets.values()) {
        this.morphWeights[targetIdx] += this.resultMorphWeights[targetIdx] * w;
      }
      for (const boneIdx of l.clip.trackedBones.values()) {
        if (l.boneMask && !l.boneMask.has(boneIdx)) continue;

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
    });

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

  // ── Output ──

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

  getMorphWeights(): Float32Array {
    return this.morphWeights;
  }

  getMaxMorphTargets(): number {
    return this.maxMorphTargets;
  }

  setMaxMorphTargets(count: number): void {
    if (count > MAX_MORPH_TARGETS) count = MAX_MORPH_TARGETS;
    if (count === this.maxMorphTargets) return;
    this.maxMorphTargets = count;
    this.morphWeights = new Float32Array(count);
    this.accMorphWeights = new Float32Array(count);
    this.accMorphWeight = new Float32Array(count);
    this.resultMorphWeights = new Float32Array(count);
  }

  resetRootMotion(): void {
    this.lastRootPos = null;
    this.rootMotionDelta = [0, 0, 0];
  }

  destroy(): void {
    this.layers.clear();
    this.layerOrder = [];
    this.eventHandlers.clear();
    this.pendingEvents = [];
    this.lastSampleTimes.clear();
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
