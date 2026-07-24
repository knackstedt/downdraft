import type { SkeletonData, Bone } from "./skeleton.ts";
import type { AnimationClipData, KeyframeTrack } from "./clip.ts";
import { buildRetargetMapping, retargetClip, type RetargetMapping } from "./retarget.ts";

const MIXAMO_PREFIX = "mixamorig:";

export interface MixamoRetargetConfig {
  stripPrefix: boolean;
  tPoseToAPose: boolean;
  aPoseArmAngle: number;
}

export const DEFAULT_MIXAMO_CONFIG: MixamoRetargetConfig = {
  stripPrefix: true,
  tPoseToAPose: true,
  aPoseArmAngle: 20,
};

export class MixamoRetargeter {
  private config: MixamoRetargetConfig;
  private mappingCache: Map<string, RetargetMapping> = new Map();

  constructor(config: Partial<MixamoRetargetConfig> = {}) {
    this.config = { ...DEFAULT_MIXAMO_CONFIG, ...config };
  }

  stripMixamoPrefix(name: string): string {
    if (name.startsWith(MIXAMO_PREFIX)) {
      return name.slice(MIXAMO_PREFIX.length);
    }
    return name;
  }

  normalizeSkeleton(skeleton: SkeletonData): SkeletonData {
    const normalizedBones: Bone[] = skeleton.bones.map((bone) => ({
      ...bone,
      name: this.config.stripPrefix ? this.stripMixamoPrefix(bone.name) : bone.name,
      childrenIndices: [...bone.childrenIndices],
    }));
    return { ...skeleton, bones: normalizedBones };
  }

  buildMapping(
    mixamoSkeleton: SkeletonData,
    targetSkeleton: SkeletonData,
  ): RetargetMapping {
    const cacheKey = `${mixamoSkeleton.name}:${targetSkeleton.name}`;
    const cached = this.mappingCache.get(cacheKey);
    if (cached) return cached;

    const normalizedMixamo = this.normalizeSkeleton(mixamoSkeleton);
    const mapping = buildRetargetMapping(normalizedMixamo, targetSkeleton);

    if (this.config.tPoseToAPose) {
      this.applyTPoseToAPoseCorrection(mapping, targetSkeleton);
    }

    this.mappingCache.set(cacheKey, mapping);
    return mapping;
  }

  retarget(
    clip: AnimationClipData,
    mixamoSkeleton: SkeletonData,
    targetSkeleton: SkeletonData,
  ): AnimationClipData {
    const mapping = this.buildMapping(mixamoSkeleton, targetSkeleton);
    return retargetClip(clip, mapping);
  }

  private applyTPoseToAPoseCorrection(
    mapping: RetargetMapping,
    targetSkeleton: SkeletonData,
  ): void {
    const armBones = [
      "LeftArm", "RightArm",
      "LeftForeArm", "RightForeArm",
      "LeftUpArm", "RightUpArm",
    ];

    for (const m of mapping.mappings) {
      const targetBone = targetSkeleton.bones[m.targetBoneIndex];
      if (armBones.includes(targetBone.name)) {
        const isLeft = targetBone.name.startsWith("Left");
        const angle = isLeft ? this.config.aPoseArmAngle : -this.config.aPoseArmAngle;
        const rad = (angle * Math.PI) / 180;
        const correction: [number, number, number, number] = [
          0,
          Math.sin(rad / 2),
          0,
          Math.cos(rad / 2),
        ];
        m.rotationOffset = multiplyQuat(correction, m.rotationOffset);
      }
    }
  }

  clearCache(): void {
    this.mappingCache.clear();
  }
}

function multiplyQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
