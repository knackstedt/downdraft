import type { AnimationClip } from "./clip.ts";
import type { Skeleton } from "./skeleton.ts";
import { AnimationPlayer } from "./player.ts";
import { BoneMaskPreset, buildBoneMask, buildCustomBoneMask } from "./bone-mask.ts";
import type { SkeletonData } from "./skeleton.ts";

export type LayerBlendMode = "override" | "additive";

export interface AnimationLayerConfig {
  clip: AnimationClip;
  mask: Set<number> | null;
  weight: number;
  blendMode: LayerBlendMode;
  speed: number;
  loop: boolean;
  priority: number;
}

interface ActiveLayer {
  name: string;
  config: AnimationLayerConfig;
  player: AnimationPlayer;
  targetWeight: number;
  currentWeight: number;
  fadeSpeed: number;
  clipSwapFade: number;
  pendingClip: AnimationClip | null;
}

export class AnimationLayerManager {
  private skeleton: Skeleton;
  private skeletonData: SkeletonData;
  private layers: Map<string, ActiveLayer> = new Map();
  private layerOrder: string[] = [];

  constructor(skeleton: Skeleton, skeletonData: SkeletonData) {
    this.skeleton = skeleton;
    this.skeletonData = skeletonData;
  }

  addLayer(
    name: string,
    clip: AnimationClip,
    options?: {
      mask?: Set<number> | BoneMaskPreset | string;
      weight?: number;
      blendMode?: LayerBlendMode;
      speed?: number;
      loop?: boolean;
      priority?: number;
      fadeDuration?: number;
    },
  ): void {
    let mask: Set<number> | null = null;
    if (options?.mask) {
      if (options.mask instanceof Set) {
        mask = options.mask;
      } else if (typeof options.mask === "string") {
        if (Object.values(BoneMaskPreset).includes(options.mask as BoneMaskPreset)) {
          mask = buildBoneMask(options.mask as BoneMaskPreset, this.skeletonData);
        } else {
          mask = buildCustomBoneMask(options.mask, this.skeletonData);
        }
      }
    }

    const config: AnimationLayerConfig = {
      clip,
      mask,
      weight: options?.weight ?? 1,
      blendMode: options?.blendMode ?? "override",
      speed: options?.speed ?? 1,
      loop: options?.loop ?? true,
      priority: options?.priority ?? 0,
    };

    const player = new AnimationPlayer(this.skeleton);
    player.play(name, clip, {
      weight: config.weight,
      speed: config.speed,
      loop: config.loop,
      additive: config.blendMode === "additive",
      boneMask: mask ?? undefined,
      fadeDuration: options?.fadeDuration ?? 0,
    });

    this.layers.set(name, {
      name,
      config,
      player,
      targetWeight: config.weight,
      currentWeight: options?.fadeDuration ? 0 : config.weight,
      fadeSpeed: options?.fadeDuration ? config.weight / options.fadeDuration : 0,
      clipSwapFade: 0,
      pendingClip: null,
    });
    this.layerOrder.push(name);
    this.sortLayers();
  }

  removeLayer(name: string, fadeDuration?: number): void {
    const layer = this.layers.get(name);
    if (!layer) return;

    if (fadeDuration && fadeDuration > 0) {
      layer.targetWeight = 0;
      layer.fadeSpeed = layer.currentWeight / fadeDuration;
    } else {
      this.layers.delete(name);
      this.layerOrder = this.layerOrder.filter((n) => n !== name);
    }
  }

  setLayerWeight(name: string, weight: number, fadeDuration?: number): void {
    const layer = this.layers.get(name);
    if (!layer) return;

    if (fadeDuration && fadeDuration > 0) {
      layer.targetWeight = weight;
      layer.fadeSpeed = Math.abs(weight - layer.currentWeight) / fadeDuration;
    } else {
      layer.targetWeight = weight;
      layer.currentWeight = weight;
      layer.config.weight = weight;
      layer.player.setWeight(name, weight);
    }
  }

  setLayerClip(name: string, clip: AnimationClip, fadeDuration?: number): void {
    const layer = this.layers.get(name);
    if (!layer) return;

    if (fadeDuration && fadeDuration > 0) {
      layer.pendingClip = clip;
      layer.clipSwapFade = fadeDuration;
    } else {
      layer.config.clip = clip;
      layer.player.stop();
      layer.player.play(name, clip, {
        weight: layer.currentWeight,
        speed: layer.config.speed,
        loop: layer.config.loop,
        additive: layer.config.blendMode === "additive",
        boneMask: layer.config.mask ?? undefined,
      });
    }
  }

  setLayerSpeed(name: string, speed: number): void {
    const layer = this.layers.get(name);
    if (layer) {
      layer.config.speed = speed;
      layer.player.setSpeed(name, speed);
    }
  }

  hasLayer(name: string): boolean {
    return this.layers.has(name);
  }

  getLayerCount(): number {
    return this.layers.size;
  }

  private sortLayers(): void {
    this.layerOrder.sort((a, b) => {
      const la = this.layers.get(a)!;
      const lb = this.layers.get(b)!;
      return lb.config.priority - la.config.priority;
    });
  }

  update(dt: number): void {
    const toRemove: string[] = [];

    for (const layer of this.layers.values()) {
      if (layer.fadeSpeed > 0) {
        if (layer.currentWeight < layer.targetWeight) {
          layer.currentWeight = Math.min(layer.targetWeight, layer.currentWeight + layer.fadeSpeed * dt);
        } else if (layer.currentWeight > layer.targetWeight) {
          layer.currentWeight = Math.max(layer.targetWeight, layer.currentWeight - layer.fadeSpeed * dt);
        }
        if (layer.currentWeight === layer.targetWeight) {
          layer.fadeSpeed = 0;
          if (layer.targetWeight === 0) {
            toRemove.push(layer.name);
          }
        }
        layer.config.weight = layer.currentWeight;
        layer.player.setWeight(layer.name, layer.currentWeight);
      }

      if (layer.clipSwapFade > 0) {
        layer.clipSwapFade -= dt;
        if (layer.clipSwapFade <= 0 && layer.pendingClip) {
          layer.config.clip = layer.pendingClip;
          layer.pendingClip = null;
          layer.player.stop();
          layer.player.play(layer.name, layer.config.clip, {
            weight: layer.currentWeight,
            speed: layer.config.speed,
            loop: layer.config.loop,
            additive: layer.config.blendMode === "additive",
            boneMask: layer.config.mask ?? undefined,
          });
        }
      }

      layer.player.update(dt);
    }

    for (const name of toRemove) {
      this.layers.delete(name);
      this.layerOrder = this.layerOrder.filter((n) => n !== name);
    }
  }

  getBoneTransforms(): {
    positions: Array<[number, number, number]>;
    rotations: Array<[number, number, number, number]>;
    scales: Array<[number, number, number]>;
  } {
    const boneCount = this.skeleton.getBoneCount();
    const bindPose = this.skeleton.getBindPose();

    const positions = bindPose.map((b) => [...b.position] as [number, number, number]);
    const rotations = bindPose.map((b) => [...b.rotation] as [number, number, number, number]);
    const scales = bindPose.map((b) => [...b.scale] as [number, number, number]);

    const totalWeight = new Float32Array(boneCount);
    let firstOverride = true;

    for (const name of this.layerOrder) {
      const layer = this.layers.get(name)!;
      if (layer.currentWeight <= 0.001) continue;

      const transforms = layer.player.getBoneTransforms();
      const w = layer.currentWeight;

      if (layer.config.blendMode === "additive") {
        for (let i = 0; i < boneCount; i++) {
          if (layer.config.mask && !layer.config.mask.has(i)) continue;
          const bp = bindPose[i];
          positions[i][0] += (transforms.positions[i][0] - bp.position[0]) * w;
          positions[i][1] += (transforms.positions[i][1] - bp.position[1]) * w;
          positions[i][2] += (transforms.positions[i][2] - bp.position[2]) * w;
          scales[i][0] += (transforms.scales[i][0] - bp.scale[0]) * w;
          scales[i][1] += (transforms.scales[i][1] - bp.scale[1]) * w;
          scales[i][2] += (transforms.scales[i][2] - bp.scale[2]) * w;
        }
      } else {
        if (firstOverride) {
          for (let i = 0; i < boneCount; i++) {
            if (layer.config.mask && !layer.config.mask.has(i)) continue;
            positions[i][0] = transforms.positions[i][0] * w;
            positions[i][1] = transforms.positions[i][1] * w;
            positions[i][2] = transforms.positions[i][2] * w;
            rotations[i][0] = transforms.rotations[i][0] * w;
            rotations[i][1] = transforms.rotations[i][1] * w;
            rotations[i][2] = transforms.rotations[i][2] * w;
            rotations[i][3] = transforms.rotations[i][3] * w;
            scales[i][0] = transforms.scales[i][0] * w;
            scales[i][1] = transforms.scales[i][1] * w;
            scales[i][2] = transforms.scales[i][2] * w;
            totalWeight[i] = w;
          }
          firstOverride = false;
        } else {
          for (let i = 0; i < boneCount; i++) {
            if (layer.config.mask && !layer.config.mask.has(i)) continue;
            if (totalWeight[i] === 0) {
              positions[i][0] = transforms.positions[i][0] * w;
              positions[i][1] = transforms.positions[i][1] * w;
              positions[i][2] = transforms.positions[i][2] * w;
              rotations[i][0] = transforms.rotations[i][0] * w;
              rotations[i][1] = transforms.rotations[i][1] * w;
              rotations[i][2] = transforms.rotations[i][2] * w;
              rotations[i][3] = transforms.rotations[i][3] * w;
              scales[i][0] = transforms.scales[i][0] * w;
              scales[i][1] = transforms.scales[i][1] * w;
              scales[i][2] = transforms.scales[i][2] * w;
              totalWeight[i] = w;
            } else {
              let sign = 1;
              if (rotations[i][0] * transforms.rotations[i][0] +
                  rotations[i][1] * transforms.rotations[i][1] +
                  rotations[i][2] * transforms.rotations[i][2] +
                  rotations[i][3] * transforms.rotations[i][3] < 0) {
                sign = -1;
              }
              positions[i][0] += transforms.positions[i][0] * w;
              positions[i][1] += transforms.positions[i][1] * w;
              positions[i][2] += transforms.positions[i][2] * w;
              rotations[i][0] += transforms.rotations[i][0] * w * sign;
              rotations[i][1] += transforms.rotations[i][1] * w * sign;
              rotations[i][2] += transforms.rotations[i][2] * w * sign;
              rotations[i][3] += transforms.rotations[i][3] * w * sign;
              scales[i][0] += transforms.scales[i][0] * w;
              scales[i][1] += transforms.scales[i][1] * w;
              scales[i][2] += transforms.scales[i][2] * w;
              totalWeight[i] += w;
            }
          }
        }
      }
    }

    for (let i = 0; i < boneCount; i++) {
      if (totalWeight[i] > 0.001) {
        const invW = 1 / totalWeight[i];
        positions[i][0] *= invW;
        positions[i][1] *= invW;
        positions[i][2] *= invW;
        const rlen = Math.sqrt(
          rotations[i][0] ** 2 + rotations[i][1] ** 2 +
          rotations[i][2] ** 2 + rotations[i][3] ** 2,
        );
        if (rlen > 0) {
          rotations[i][0] /= rlen;
          rotations[i][1] /= rlen;
          rotations[i][2] /= rlen;
          rotations[i][3] /= rlen;
        }
        scales[i][0] *= invW;
        scales[i][1] *= invW;
        scales[i][2] *= invW;
      }
    }

    return { positions, rotations, scales };
  }

  getMorphWeights(): Float32Array {
    let maxMorph = 0;
    for (const layer of this.layers.values()) {
      maxMorph = Math.max(maxMorph, layer.player.getMaxMorphTargets());
    }
    if (maxMorph === 0) return new Float32Array(0);

    const result = new Float32Array(maxMorph);
    let totalWeight = 0;

    for (const layer of this.layers.values()) {
      if (layer.currentWeight <= 0.001) continue;
      const weights = layer.player.getMorphWeights();
      for (let i = 0; i < maxMorph; i++) {
        result[i] += (weights[i] ?? 0) * layer.currentWeight;
      }
      totalWeight += layer.currentWeight;
    }

    if (totalWeight > 0) {
      const invW = 1 / totalWeight;
      for (let i = 0; i < maxMorph; i++) {
        result[i] *= invW;
      }
    }

    return result;
  }

  getRootMotionDelta(): [number, number, number] {
    for (const name of this.layerOrder) {
      const layer = this.layers.get(name)!;
      if (layer.config.blendMode === "override" && layer.config.priority <= 0) {
        return layer.player.getRootMotionDelta();
      }
    }
    return [0, 0, 0];
  }

  destroy(): void {
    this.layers.clear();
    this.layerOrder = [];
  }
}
