import type { AnimationClip } from "./clip.ts";
import type { Skeleton } from "./skeleton.ts";
import { AnimationPlayer } from "./player.ts";
import { BoneMaskPreset, buildBoneMask, buildCustomBoneMask } from "./bone-mask.ts";
import type { SkeletonData } from "./skeleton.ts";

export interface AnimationLayerOptions {
  mask?: Set<number> | BoneMaskPreset | string;
  weight?: number;
  speed?: number;
  loop?: boolean;
  additive?: boolean;
  fadeDuration?: number;
}

interface GroupLayer {
  name: string;
  clip: AnimationClip;
  mask: Set<number> | null;
  weight: number;
  speed: number;
  loop: boolean;
  additive: boolean;
  player: AnimationPlayer;
}

export class AnimationGroup {
  private skeleton: Skeleton;
  private skeletonData: SkeletonData;
  private layers: Map<string, GroupLayer> = new Map();
  private layerOrder: string[] = [];

  constructor(skeleton: Skeleton, skeletonData: SkeletonData) {
    this.skeleton = skeleton;
    this.skeletonData = skeletonData;
  }

  addLayer(name: string, clip: AnimationClip, options?: AnimationLayerOptions): void {
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

    const player = new AnimationPlayer(this.skeleton);

    this.layers.set(name, {
      name,
      clip,
      mask,
      weight: options?.weight ?? 1,
      speed: options?.speed ?? 1,
      loop: options?.loop ?? true,
      additive: options?.additive ?? false,
      player,
    });
    this.layerOrder.push(name);

    player.play(name, clip, {
      weight: options?.weight ?? 1,
      speed: options?.speed ?? 1,
      loop: options?.loop ?? true,
      additive: options?.additive ?? false,
      boneMask: mask ?? undefined,
      fadeDuration: options?.fadeDuration ?? 0,
    });
  }

  removeLayer(name: string): void {
    this.layers.delete(name);
    this.layerOrder = this.layerOrder.filter((n) => n !== name);
  }

  setLayerWeight(name: string, weight: number): void {
    const layer = this.layers.get(name);
    if (layer) {
      layer.weight = weight;
      layer.player.setWeight(name, weight);
    }
  }

  setLayerSpeed(name: string, speed: number): void {
    const layer = this.layers.get(name);
    if (layer) {
      layer.speed = speed;
      layer.player.setSpeed(name, speed);
    }
  }

  getLayerCount(): number {
    return this.layers.size;
  }

  hasLayer(name: string): boolean {
    return this.layers.has(name);
  }

  update(dt: number): void {
    for (const layer of this.layers.values()) {
      layer.player.update(dt);
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

    let totalWeight: Float32Array = new Float32Array(boneCount);
    let firstNonAdditive = true;

    for (const name of this.layerOrder) {
      const layer = this.layers.get(name)!;
      if (layer.weight <= 0.001) continue;

      const transforms = layer.player.getBoneTransforms();

      if (layer.additive) {
        for (let i = 0; i < boneCount; i++) {
          if (layer.mask && !layer.mask.has(i)) continue;
          const bp = bindPose[i];
          positions[i][0] += (transforms.positions[i][0] - bp.position[0]) * layer.weight;
          positions[i][1] += (transforms.positions[i][1] - bp.position[1]) * layer.weight;
          positions[i][2] += (transforms.positions[i][2] - bp.position[2]) * layer.weight;
          scales[i][0] += (transforms.scales[i][0] - bp.scale[0]) * layer.weight;
          scales[i][1] += (transforms.scales[i][1] - bp.scale[1]) * layer.weight;
          scales[i][2] += (transforms.scales[i][2] - bp.scale[2]) * layer.weight;
        }
      } else {
        if (firstNonAdditive) {
          for (let i = 0; i < boneCount; i++) {
            if (layer.mask && !layer.mask.has(i)) continue;
            positions[i][0] = transforms.positions[i][0] * layer.weight;
            positions[i][1] = transforms.positions[i][1] * layer.weight;
            positions[i][2] = transforms.positions[i][2] * layer.weight;
            rotations[i][0] = transforms.rotations[i][0] * layer.weight;
            rotations[i][1] = transforms.rotations[i][1] * layer.weight;
            rotations[i][2] = transforms.rotations[i][2] * layer.weight;
            rotations[i][3] = transforms.rotations[i][3] * layer.weight;
            scales[i][0] = transforms.scales[i][0] * layer.weight;
            scales[i][1] = transforms.scales[i][1] * layer.weight;
            scales[i][2] = transforms.scales[i][2] * layer.weight;
            totalWeight[i] = layer.weight;
          }
          firstNonAdditive = false;
        } else {
          for (let i = 0; i < boneCount; i++) {
            if (layer.mask && !layer.mask.has(i)) continue;
            if (totalWeight[i] === 0) {
              positions[i][0] = transforms.positions[i][0] * layer.weight;
              positions[i][1] = transforms.positions[i][1] * layer.weight;
              positions[i][2] = transforms.positions[i][2] * layer.weight;
              rotations[i][0] = transforms.rotations[i][0] * layer.weight;
              rotations[i][1] = transforms.rotations[i][1] * layer.weight;
              rotations[i][2] = transforms.rotations[i][2] * layer.weight;
              rotations[i][3] = transforms.rotations[i][3] * layer.weight;
              scales[i][0] = transforms.scales[i][0] * layer.weight;
              scales[i][1] = transforms.scales[i][1] * layer.weight;
              scales[i][2] = transforms.scales[i][2] * layer.weight;
              totalWeight[i] = layer.weight;
            } else {
              const w = layer.weight;
              positions[i][0] += transforms.positions[i][0] * w;
              positions[i][1] += transforms.positions[i][1] * w;
              positions[i][2] += transforms.positions[i][2] * w;
              let sign = 1;
              if (rotations[i][0] * transforms.rotations[i][0] +
                  rotations[i][1] * transforms.rotations[i][1] +
                  rotations[i][2] * transforms.rotations[i][2] +
                  rotations[i][3] * transforms.rotations[i][3] < 0) {
                sign = -1;
              }
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
      if (layer.weight <= 0.001) continue;
      const weights = layer.player.getMorphWeights();
      for (let i = 0; i < maxMorph; i++) {
        result[i] += (weights[i] ?? 0) * layer.weight;
      }
      totalWeight += layer.weight;
    }

    if (totalWeight > 0) {
      const invW = 1 / totalWeight;
      for (let i = 0; i < maxMorph; i++) {
        result[i] *= invW;
      }
    }

    return result;
  }

  destroy(): void {
    this.layers.clear();
    this.layerOrder = [];
  }
}
