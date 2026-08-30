import type { Skeleton } from "../animation";
import type { RagdollBoneConfig, RagdollConfig, RagdollJointConfig } from "./ragdoll";

interface BoneMatch {
  names: string[];
  shape: "capsule" | "sphere" | "box";
  radius: number;
  halfHeight: number;
  halfExtents: [number, number, number];
  offset: [number, number, number];
  mass: number;
  linearDamping: number;
  angularDamping: number;
}

const BONE_MATCHES: BoneMatch[] = [
  {
    names: ["Hips", "pelvis", "mixamorig:Hips", "Pelvis"],
    shape: "box",
    radius: 0,
    halfHeight: 0,
    halfExtents: [0.18, 0.12, 0.12],
    offset: [0, 0, 0],
    mass: 8,
    linearDamping: 0.5,
    angularDamping: 0.5,
  },
  {
    names: ["Spine", "spine_01", "mixamorig:Spine", "Spine_01"],
    shape: "box",
    radius: 0,
    halfHeight: 0,
    halfExtents: [0.16, 0.12, 0.10],
    offset: [0, 0.12, 0],
    mass: 6,
    linearDamping: 0.5,
    angularDamping: 0.5,
  },
  {
    names: ["Head", "head", "mixamorig:Head"],
    shape: "sphere",
    radius: 0.12,
    halfHeight: 0,
    halfExtents: [0, 0, 0],
    offset: [0, 0.1, 0],
    mass: 3,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["UpperArm_Left", "upperarm_l", "mixamorig:LeftArm", "ArmUp_Left"],
    shape: "capsule",
    radius: 0.06,
    halfHeight: 0.12,
    halfExtents: [0, 0, 0],
    offset: [0, -0.12, 0],
    mass: 2,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["UpperArm_Right", "upperarm_r", "mixamorig:RightArm", "ArmUp_Right"],
    shape: "capsule",
    radius: 0.06,
    halfHeight: 0.12,
    halfExtents: [0, 0, 0],
    offset: [0, -0.12, 0],
    mass: 2,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["LowerArm_Left", "lowerarm_l", "mixamorig:LeftForeArm", "ArmDown_Left"],
    shape: "capsule",
    radius: 0.05,
    halfHeight: 0.12,
    halfExtents: [0, 0, 0],
    offset: [0, -0.12, 0],
    mass: 1.5,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["LowerArm_Right", "lowerarm_r", "mixamorig:RightForeArm", "ArmDown_Right"],
    shape: "capsule",
    radius: 0.05,
    halfHeight: 0.12,
    halfExtents: [0, 0, 0],
    offset: [0, -0.12, 0],
    mass: 1.5,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["UpperLeg_Left", "thigh_l", "mixamorig:LeftUpLeg", "LegUp_Left"],
    shape: "capsule",
    radius: 0.08,
    halfHeight: 0.22,
    halfExtents: [0, 0, 0],
    offset: [0, -0.22, 0],
    mass: 4,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["UpperLeg_Right", "thigh_r", "mixamorig:RightUpLeg", "LegUp_Right"],
    shape: "capsule",
    radius: 0.08,
    halfHeight: 0.22,
    halfExtents: [0, 0, 0],
    offset: [0, -0.22, 0],
    mass: 4,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["LowerLeg_Left", "calf_l", "mixamorig:LeftLeg", "LegDown_Left"],
    shape: "capsule",
    radius: 0.06,
    halfHeight: 0.22,
    halfExtents: [0, 0, 0],
    offset: [0, -0.22, 0],
    mass: 3,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
  {
    names: ["LowerLeg_Right", "calf_r", "mixamorig:RightLeg", "LegDown_Right"],
    shape: "capsule",
    radius: 0.06,
    halfHeight: 0.22,
    halfExtents: [0, 0, 0],
    offset: [0, -0.22, 0],
    mass: 3,
    linearDamping: 0.3,
    angularDamping: 0.3,
  },
];

interface JointMatch {
  parent: string[];
  child: string[];
  anchor: [number, number, number];
  coneAngle: number;
  twistAngle: number;
}

const JOINT_MATCHES: JointMatch[] = [
  {
    parent: ["Hips", "pelvis", "mixamorig:Hips", "Pelvis"],
    child: ["Spine", "spine_01", "mixamorig:Spine", "Spine_01"],
    anchor: [0, 0.12, 0],
    coneAngle: Math.PI / 6,
    twistAngle: Math.PI / 8,
  },
  {
    parent: ["Spine", "spine_01", "mixamorig:Spine", "Spine_01"],
    child: ["Head", "head", "mixamorig:Head"],
    anchor: [0, 0.1, 0],
    coneAngle: Math.PI / 4,
    twistAngle: Math.PI / 6,
  },
  {
    parent: ["Spine", "spine_01", "mixamorig:Spine", "Spine_01"],
    child: ["UpperArm_Left", "upperarm_l", "mixamorig:LeftArm", "ArmUp_Left"],
    anchor: [0.18, 0.05, 0],
    coneAngle: Math.PI / 2,
    twistAngle: Math.PI / 4,
  },
  {
    parent: ["Spine", "spine_01", "mixamorig:Spine", "Spine_01"],
    child: ["UpperArm_Right", "upperarm_r", "mixamorig:RightArm", "ArmUp_Right"],
    anchor: [-0.18, 0.05, 0],
    coneAngle: Math.PI / 2,
    twistAngle: Math.PI / 4,
  },
  {
    parent: ["UpperArm_Left", "upperarm_l", "mixamorig:LeftArm", "ArmUp_Left"],
    child: ["LowerArm_Left", "lowerarm_l", "mixamorig:LeftForeArm", "ArmDown_Left"],
    anchor: [0, -0.12, 0],
    coneAngle: Math.PI / 2,
    twistAngle: 0,
  },
  {
    parent: ["UpperArm_Right", "upperarm_r", "mixamorig:RightArm", "ArmUp_Right"],
    child: ["LowerArm_Right", "lowerarm_r", "mixamorig:RightForeArm", "ArmDown_Right"],
    anchor: [0, -0.12, 0],
    coneAngle: Math.PI / 2,
    twistAngle: 0,
  },
  {
    parent: ["Hips", "pelvis", "mixamorig:Hips", "Pelvis"],
    child: ["UpperLeg_Left", "thigh_l", "mixamorig:LeftUpLeg", "LegUp_Left"],
    anchor: [0.1, -0.1, 0],
    coneAngle: Math.PI / 4,
    twistAngle: Math.PI / 8,
  },
  {
    parent: ["Hips", "pelvis", "mixamorig:Hips", "Pelvis"],
    child: ["UpperLeg_Right", "thigh_r", "mixamorig:RightUpLeg", "LegUp_Right"],
    anchor: [-0.1, -0.1, 0],
    coneAngle: Math.PI / 4,
    twistAngle: Math.PI / 8,
  },
  {
    parent: ["UpperLeg_Left", "thigh_l", "mixamorig:LeftUpLeg", "LegUp_Left"],
    child: ["LowerLeg_Left", "calf_l", "mixamorig:LeftLeg", "LegDown_Left"],
    anchor: [0, -0.22, 0],
    coneAngle: 0,
    twistAngle: Math.PI / 2,
  },
  {
    parent: ["UpperLeg_Right", "thigh_r", "mixamorig:RightUpLeg", "LegUp_Right"],
    child: ["LowerLeg_Right", "calf_r", "mixamorig:RightLeg", "LegDown_Right"],
    anchor: [0, -0.22, 0],
    coneAngle: 0,
    twistAngle: Math.PI / 2,
  },
];

function findBoneInSkeleton(skeleton: Skeleton, names: string[]): string | null {
  for (const name of names) {
    if (skeleton.getBoneIndex(name) >= 0) return name;
  }
  return null;
}

export function humanoidRagdoll(skeleton: Skeleton): RagdollConfig {
  const bones: RagdollBoneConfig[] = [];
  const boneNameMap = new Map<string, string>();

  for (const match of BONE_MATCHES) {
    const foundName = findBoneInSkeleton(skeleton, match.names);
    if (!foundName) continue;

    let shape;
    if (match.shape === "sphere") {
      shape = { type: "sphere", radius: match.radius } as const;
    } else if (match.shape === "capsule") {
      shape = { type: "capsule", radius: match.radius, halfHeight: match.halfHeight } as const;
    } else {
      shape = { type: "box", halfExtents: match.halfExtents } as const;
    }

    bones.push({
      boneName: foundName,
      shape,
      boneToColliderOffset: match.offset,
      mass: match.mass,
      linearDamping: match.linearDamping,
      angularDamping: match.angularDamping,
    });
    boneNameMap.set(match.names[0], foundName);
  }

  const joints: RagdollJointConfig[] = [];
  for (const jmatch of JOINT_MATCHES) {
    const parentName = findBoneInSkeleton(skeleton, jmatch.parent);
    const childName = findBoneInSkeleton(skeleton, jmatch.child);
    if (!parentName || !childName) continue;

    joints.push({
      parentBone: parentName,
      childBone: childName,
      anchor: jmatch.anchor,
      coneAngle: jmatch.coneAngle,
      twistAngle: jmatch.twistAngle,
    });
  }

  return { bones, joints };
}
