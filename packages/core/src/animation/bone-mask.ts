import type { SkeletonData } from "./skeleton.ts";

export enum BoneMaskPreset {
  UPPER_BODY = "upper_body",
  LOWER_BODY = "lower_body",
  LEFT_ARM = "left_arm",
  RIGHT_ARM = "right_arm",
  HEAD = "head",
  HANDS = "hands",
  FULL_BODY = "full_body",
  SPINE_ONLY = "spine_only",
}

const UPPER_BODY_NAMES = [
  "spine", "spine1", "spine2", "spine_01", "spine_02", "spine_03",
  "neck", "head",
  "clavicle_l", "clavicle_r", "arm_upper_l", "arm_upper_r",
  "arm_lower_l", "arm_lower_r", "hand_l", "hand_r",
  "shoulder_l", "shoulder_r",
  "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r",
  "LeftArm", "RightArm", "LeftForeArm", "RightForeArm",
  "LeftHand", "RightHand", "LeftShoulder", "RightShoulder",
  "Spine", "Spine1", "Spine2", "Neck", "Head",
];

const LOWER_BODY_NAMES = [
  "hip", "hips", "pelvis",
  "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r",
  "upperleg_l", "upperleg_r", "lowerleg_l", "lowerleg_r",
  "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftFoot", "RightFoot",
  "Hips", "Pelvis",
];

const LEFT_ARM_NAMES = [
  "clavicle_l", "shoulder_l", "arm_upper_l", "upperarm_l",
  "arm_lower_l", "lowerarm_l", "hand_l",
  "LeftArm", "LeftForeArm", "LeftHand", "LeftShoulder",
];

const RIGHT_ARM_NAMES = [
  "clavicle_r", "shoulder_r", "arm_upper_r", "upperarm_r",
  "arm_lower_r", "lowerarm_r", "hand_r",
  "RightArm", "RightForeArm", "RightHand", "RightShoulder",
];

const HEAD_NAMES = ["neck", "head", "Neck", "Head"];

const HAND_NAMES = [
  "hand_l", "hand_r", "LeftHand", "RightHand",
  "thumb_01_l", "thumb_02_l", "thumb_03_l",
  "thumb_01_r", "thumb_02_r", "thumb_03_r",
  "index_01_l", "index_02_l", "index_03_l",
  "index_01_r", "index_02_r", "index_03_r",
  "middle_01_l", "middle_02_l", "middle_03_l",
  "middle_01_r", "middle_02_r", "middle_03_r",
  "ring_01_l", "ring_02_l", "ring_03_l",
  "ring_01_r", "ring_02_r", "ring_03_r",
  "pinky_01_l", "pinky_02_l", "pinky_03_l",
  "pinky_01_r", "pinky_02_r", "pinky_03_r",
];

const SPINE_NAMES = [
  "spine", "spine1", "spine2", "spine_01", "spine_02", "spine_03",
  "Spine", "Spine1", "Spine2",
];

const PRESET_NAMES: Record<BoneMaskPreset, string[]> = {
  [BoneMaskPreset.UPPER_BODY]: UPPER_BODY_NAMES,
  [BoneMaskPreset.LOWER_BODY]: LOWER_BODY_NAMES,
  [BoneMaskPreset.LEFT_ARM]: LEFT_ARM_NAMES,
  [BoneMaskPreset.RIGHT_ARM]: RIGHT_ARM_NAMES,
  [BoneMaskPreset.HEAD]: HEAD_NAMES,
  [BoneMaskPreset.HANDS]: HAND_NAMES,
  [BoneMaskPreset.FULL_BODY]: [],
  [BoneMaskPreset.SPINE_ONLY]: SPINE_NAMES,
};

export function buildBoneMask(preset: BoneMaskPreset, skeleton: SkeletonData): Set<number> {
  if (preset === BoneMaskPreset.FULL_BODY) {
    return new Set(skeleton.bones.map((_, i) => i));
  }

  const names = PRESET_NAMES[preset];
  if (!names || names.length === 0) {
    return new Set(skeleton.bones.map((_, i) => i));
  }

  const nameSet = new Set(names.map((n) => n.toLowerCase()));
  const result = new Set<number>();

  for (let i = 0; i < skeleton.bones.length; i++) {
    const boneName = skeleton.bones[i].name.toLowerCase();
    if (nameSet.has(boneName)) {
      result.add(i);
    }
  }

  return result;
}

const customMasks: Map<string, string[]> = new Map();

export function registerCustomMask(name: string, boneNames: string[]): void {
  customMasks.set(name, boneNames);
}

export function buildCustomBoneMask(name: string, skeleton: SkeletonData): Set<number> {
  const names = customMasks.get(name);
  if (!names) return new Set(skeleton.bones.map((_, i) => i));

  const nameSet = new Set(names.map((n) => n.toLowerCase()));
  const result = new Set<number>();

  for (let i = 0; i < skeleton.bones.length; i++) {
    const boneName = skeleton.bones[i].name.toLowerCase();
    if (nameSet.has(boneName)) {
      result.add(i);
    }
  }

  return result;
}
