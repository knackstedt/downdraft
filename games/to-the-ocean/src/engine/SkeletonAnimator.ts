import type { SkinData, AnimationData, AnimationChannel } from "./loaders/types";

// Player flags from sim-buffer (mirrors PLR_FLAG)
const PLR_FLAG = {
  SLEEPING: 1 << 0,
  DEAD: 1 << 1,
  UNDERWATER: 1 << 2,
  ONBOARD: 1 << 3,
  SWIMMING: 1 << 4,
  FISHING: 1 << 5,
  PILOTING: 1 << 6,
  CLIMBING: 1 << 7,
  NOCLIP: 1 << 8,
  GROUNDED: 1 << 9,
} as const;

// Animation state names
export type AnimState = "Idle" | "Walk" | "Run" | "JumpStart" | "JumpLoop" | "JumpEnd" | "Swim";

interface BoneLocal {
  translation: Float32Array; // 3
  rotation: Float32Array;    // 4 (quaternion xyzw)
  scale: Float32Array;       // 3
}

// Vec3 math helpers
function vec3Lerp(a: Float32Array, b: Float32Array, t: number, out: Float32Array): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

// Quaternion inverse (conjugate for unit quaternions)
function quatInvert(q: Float32Array, out: Float32Array): void {
  out[0] = -q[0];
  out[1] = -q[1];
  out[2] = -q[2];
  out[3] = q[3];
}

// Quaternion SLERP
function quatSlerp(a: Float32Array, b: Float32Array, t: number, out: Float32Array): void {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    out[0] = -b[0]; out[1] = -b[1]; out[2] = -b[2]; out[3] = -b[3];
    dot = -dot;
  } else {
    out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; out[3] = b[3];
  }
  if (dot > 0.9995) {
    // Linear interpolation for very close quaternions
    out[0] = a[0] + (out[0] - a[0]) * t;
    out[1] = a[1] + (out[1] - a[1]) * t;
    out[2] = a[2] + (out[2] - a[2]) * t;
    out[3] = a[3] + (out[3] - a[3]) * t;
    // Normalize
    const len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]);
    if (len > 0) { out[0] /= len; out[1] /= len; out[2] /= len; out[3] /= len; }
    return;
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const sinT = Math.sin(t * theta) / sinTheta;
  const oneMinusT = Math.sin((1 - t) * theta) / sinTheta;
  out[0] = a[0] * oneMinusT + out[0] * sinT;
  out[1] = a[1] * oneMinusT + out[1] * sinT;
  out[2] = a[2] * oneMinusT + out[2] * sinT;
  out[3] = a[3] * oneMinusT + out[3] * sinT;
}

// Quaternion multiply: q1 * q2
function quatMul(q1: Float32Array, q2: Float32Array, out: Float32Array): void {
  const ax = q1[0], ay = q1[1], az = q1[2], aw = q1[3];
  const bx = q2[0], by = q2[1], bz = q2[2], bw = q2[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

// Build a 4x4 local transform matrix from translation, rotation, scale (column-major)
function buildLocalMatrix(pos: Float32Array, rot: Float32Array, scale: Float32Array, out: Float32Array): void {
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale[0], sy = scale[1], sz = scale[2];

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
}

// Multiply two 4x4 matrices (column-major): result = a * b
function mat4Mul(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

export class SkeletonAnimator {
  private boneCount: number;
  private parentIndices: Int32Array;
  private inverseBindMatrices: Float32Array[]; // per bone, 16 floats each

  // Per-bone local transforms (current pose)
  private localPos: Float32Array[];
  private localRot: Float32Array[];
  private localScale: Float32Array[];

  // Rest pose local transforms
  private restPos: Float32Array[];
  private restRot: Float32Array[];
  private restScale: Float32Array[];

  // Per-bone world transforms (computed each frame) — kept for IK, no longer computed in update()
  private worldMatrices: Float32Array[];

  // Flat GPU-ready arrays for local transforms (packed after animation sampling)
  // vec4 stride (16 bytes) per bone to match WGSL array<vec4<f32>> alignment
  private localPosFlat: Float32Array;   // boneCount * 4 (w=0)
  private localRotFlat: Float32Array;   // boneCount * 4
  private localScaleFlat: Float32Array; // boneCount * 4 (w=0)

  // Flat GPU-ready inverse bind matrices (constant after init)
  private inverseBindMatricesFlat: Float32Array; // boneCount * 16

  // Normalization matrix and its inverse (passed to GPU for compute shader)
  private normalizationMatrix: Float32Array | null = null;
  private inverseNormalizationMatrix: Float32Array | null = null;

  // Animation state
  private animations: Map<string, AnimationData> = new Map();
  private currentState: AnimState = "Idle";
  private currentAnim: AnimationData | null = null;
  private animTime = 0;
  private frameCount = 0;
  private prevState: AnimState | null = null;
  private timeSinceLastStateChange = 0;
  private blendAnim: AnimationData | null = null;
  private blendTime = 0;
  private blendDuration = 0.2; // 200ms crossfade
  // Source rest rotations per animation state (Mixamo bone name -> quaternion)
  private sourceRestRotations: Map<string, Map<string, [number, number, number, number]>> = new Map();
  private sourcePreRotations: Map<string, Map<string, [number, number, number, number]>> = new Map();

  // Per-bone local transforms for blend source
  private blendLocalPos: Float32Array[];
  private blendLocalRot: Float32Array[];
  private blendLocalScale: Float32Array[];

  // IK state
  private ikEnabled = true;
  private leftFootTarget: Float32Array | null = null;  // world-space Y target
  private rightFootTarget: Float32Array | null = null;
  private boneNameToIndex: Map<string, number>;

  // Bone name lookups for IK
  private leftLegUpIdx = -1;
  private leftLegDownIdx = -1;
  private leftFootIdx = -1;
  private rightLegUpIdx = -1;
  private rightLegDownIdx = -1;
  private rightFootIdx = -1;

  // Bone name lookups for procedural idle
  private leftUpperArmIdx = -1;
  private rightUpperArmIdx = -1;
  private spineIdx = -1;
  private headIdx = -1;
  private proceduralTime = 0;
  private isMixamoSkeleton = false;

  constructor(skin: SkinData) {
    this.boneCount = skin.bones.length;
    this.parentIndices = new Int32Array(this.boneCount);
    this.inverseBindMatrices = [];
    this.boneNameToIndex = skin.boneNameToIndex;

    this.localPos = [];
    this.localRot = [];
    this.localScale = [];
    this.restPos = [];
    this.restRot = [];
    this.restScale = [];
    this.worldMatrices = [];
    this.blendLocalPos = [];
    this.blendLocalRot = [];
    this.blendLocalScale = [];

    for (let i = 0; i < this.boneCount; i++) {
      const bone = skin.bones[i];
      this.parentIndices[i] = bone.parentIndex;

      const ibm = new Float32Array(16);
      ibm.set(bone.inverseBindMatrix);
      this.inverseBindMatrices.push(ibm);

      const rp = new Float32Array(bone.restTranslation);
      const rr = new Float32Array(bone.restRotation);
      const rs = new Float32Array(bone.restScale);
      this.restPos.push(rp);
      this.restRot.push(rr);
      this.restScale.push(rs);

      // Initialize current pose to rest pose
      this.localPos.push(new Float32Array(rp));
      this.localRot.push(new Float32Array(rr));
      this.localScale.push(new Float32Array(rs));

      this.worldMatrices.push(new Float32Array(16));
      this.blendLocalPos.push(new Float32Array(3));
      this.blendLocalRot.push(new Float32Array(4));
      this.blendLocalScale.push(new Float32Array(3));
    }

    // Build flat inverse bind matrices array for GPU upload
    this.inverseBindMatricesFlat = new Float32Array(this.boneCount * 16);
    for (let i = 0; i < this.boneCount; i++) {
      this.inverseBindMatricesFlat.set(this.inverseBindMatrices[i], i * 16);
    }

    // Initialize flat local transform arrays (vec4 stride for WGSL alignment)
    this.localPosFlat = new Float32Array(this.boneCount * 4);
    this.localRotFlat = new Float32Array(this.boneCount * 4);
    this.localScaleFlat = new Float32Array(this.boneCount * 4);

    // Look up IK bone indices by name
    this.leftLegUpIdx = this.findBone(["LegUp_Left", "thigh_l", "UpperLeg_Left", "mixamorig:LeftUpLeg"]);
    this.leftLegDownIdx = this.findBone(["LegDown_Left", "calf_l", "LowerLeg_Left", "mixamorig:LeftLeg"]);
    this.leftFootIdx = this.findBone(["FootStart_Left", "foot_l", "Foot_Left", "mixamorig:LeftFoot"]);
    this.rightLegUpIdx = this.findBone(["LegUp_Right", "thigh_r", "UpperLeg_Right", "mixamorig:RightUpLeg"]);
    this.rightLegDownIdx = this.findBone(["LegDown_Right", "calf_r", "LowerLeg_Right", "mixamorig:RightLeg"]);
    this.rightFootIdx = this.findBone(["FootStart_Right", "foot_r", "Foot_Right", "mixamorig:RightFoot"]);

    // Arm and spine bones for procedural idle
    this.leftUpperArmIdx = this.findBone(["UpperArm_Left", "upperarm_l", "ArmUp_Left", "mixamorig:LeftArm"]);
    this.rightUpperArmIdx = this.findBone(["UpperArm_Right", "upperarm_r", "ArmUp_Right", "mixamorig:RightArm"]);
    this.spineIdx = this.findBone(["Spine", "spine_01", "Spine_01", "mixamorig:Spine"]);
    this.headIdx = this.findBone(["Head", "head", "mixamorig:Head"]);

    // Detect Mixamo skeleton — if bones use mixamorig: names, animations match directly
    this.isMixamoSkeleton = this.boneNameToIndex.has("mixamorig:Hips");
    if (this.isMixamoSkeleton) {
      console.log("[Anim] Mixamo skeleton detected — direct animation mapping (no retargeting)");
    }
  }

  private findBone(names: string[]): number {
    for (let i = 0; i < names.length; i++) {
      const idx = this.boneNameToIndex.get(names[i]);
      if (idx !== undefined) return idx;
    }
    return -1;
  }

  registerAnimations(animations: AnimationData[]): void {
    for (let i = 0; i < animations.length; i++) {
      this.animations.set(animations[i].name, animations[i]);
    }
  }

  // Mixamo bone name -> UE bone name mapping
  private static MIXAMO_TO_UE: Record<string, string> = {
    "mixamorig:Hips": "pelvis",
    "mixamorig:Spine": "spine_01",
    "mixamorig:Spine1": "spine_02",
    "mixamorig:Spine2": "spine_03",
    "mixamorig:Neck": "neck_01",
    "mixamorig:Head": "Head",
    "mixamorig:LeftShoulder": "clavicle_l",
    "mixamorig:LeftArm": "upperarm_l",
    "mixamorig:LeftForeArm": "lowerarm_l",
    "mixamorig:LeftHand": "hand_l",
    "mixamorig:RightShoulder": "clavicle_r",
    "mixamorig:RightArm": "upperarm_r",
    "mixamorig:RightForeArm": "lowerarm_r",
    "mixamorig:RightHand": "hand_r",
    "mixamorig:LeftUpLeg": "thigh_l",
    "mixamorig:LeftLeg": "calf_l",
    "mixamorig:LeftFoot": "foot_l",
    "mixamorig:LeftToeBase": "ball_l",
    "mixamorig:RightUpLeg": "thigh_r",
    "mixamorig:RightLeg": "calf_r",
    "mixamorig:RightFoot": "foot_r",
    "mixamorig:RightToeBase": "ball_r",
    // Finger mapping (left)
    "mixamorig:LeftHandThumb1": "thumb_01_l",
    "mixamorig:LeftHandThumb2": "thumb_02_l",
    "mixamorig:LeftHandThumb3": "thumb_03_l",
    "mixamorig:LeftHandIndex1": "index_01_l",
    "mixamorig:LeftHandIndex2": "index_02_l",
    "mixamorig:LeftHandIndex3": "index_03_l",
    "mixamorig:LeftHandMiddle1": "middle_01_l",
    "mixamorig:LeftHandMiddle2": "middle_02_l",
    "mixamorig:LeftHandMiddle3": "middle_03_l",
    "mixamorig:LeftHandRing1": "ring_01_l",
    "mixamorig:LeftHandRing2": "ring_02_l",
    "mixamorig:LeftHandRing3": "ring_03_l",
    "mixamorig:LeftHandPinky1": "pinky_01_l",
    "mixamorig:LeftHandPinky2": "pinky_02_l",
    "mixamorig:LeftHandPinky3": "pinky_03_l",
    // Finger mapping (right)
    "mixamorig:RightHandThumb1": "thumb_01_r",
    "mixamorig:RightHandThumb2": "thumb_02_r",
    "mixamorig:RightHandThumb3": "thumb_03_r",
    "mixamorig:RightHandIndex1": "index_01_r",
    "mixamorig:RightHandIndex2": "index_02_r",
    "mixamorig:RightHandIndex3": "index_03_r",
    "mixamorig:RightHandMiddle1": "middle_01_r",
    "mixamorig:RightHandMiddle2": "middle_02_r",
    "mixamorig:RightHandMiddle3": "middle_03_r",
    "mixamorig:RightHandRing1": "ring_01_r",
    "mixamorig:RightHandRing2": "ring_02_r",
    "mixamorig:RightHandRing3": "ring_03_r",
    "mixamorig:RightHandPinky1": "pinky_01_r",
    "mixamorig:RightHandPinky2": "pinky_02_r",
    "mixamorig:RightHandPinky3": "pinky_03_r",
  };

  // Map animation state names to FBX animation stack names
  private static ANIM_NAME_MAP: Record<string, string> = {
    "Idle": "Idle",
    "Walk": "Walk",
    "Run": "Run",
    "Swim": "Swim",
    "JumpStart": "Jump",
    "JumpLoop": "Jump",
    "JumpEnd": "Jump",
  };

  registerRetargetedAnimations(animations: AnimationData[], stateName: string): void {
    // For Mixamo skeletons, animations match directly — no name remapping or coordinate transform
    if (this.isMixamoSkeleton) {
      const preRotMap = new Map<string, [number, number, number, number]>();
      const sourcePreRots = animations[0]?.sourcePreRotations;
      if (sourcePreRots) {
        for (const [boneName, quat] of sourcePreRots) {
          let name = boneName;
          if (name.endsWith("Model")) name = name.slice(0, -5);
          if (this.boneNameToIndex.has(name)) {
            preRotMap.set(name, quat);
          }
        }
      }
      if (preRotMap.size > 0) {
        this.sourcePreRotations.set(stateName, preRotMap);
      }

      const channels: AnimationChannel[] = [];
      for (let i = 0; i < animations.length; i++) {
        const anim = animations[i];
        for (let c = 0; c < anim.channels.length; c++) {
          const ch = anim.channels[c];
          let nodeName = ch.targetNode;
          if (nodeName.endsWith("Model")) nodeName = nodeName.slice(0, -5);
          if (this.boneNameToIndex.has(nodeName)) {
            channels.push({ ...ch, targetNode: nodeName });
          }
        }
      }
      if (channels.length > 0) {
        this.animations.set(stateName, {
          name: stateName,
          duration: animations[0]?.duration ?? 0,
          channels,
        });
        console.log(`[Anim] Registered: ${stateName} (${channels.length} channels, direct Mixamo)`);
      }
      return;
    }

    const map = SkeletonAnimator.MIXAMO_TO_UE;
    const retargeted: AnimationChannel[] = [];
    // Build a mapping from UE bone name -> Mixamo bone name for rest rotation lookup
    const restRotMap = new Map<string, [number, number, number, number]>();
    const preRotMap = new Map<string, [number, number, number, number]>();
    const sourceRests = animations[0]?.sourceRestRotations;
    const sourcePreRots = animations[0]?.sourcePreRotations;
    if (sourceRests) {
      for (const [mixamoName, quat] of sourceRests) {
        const ueName = mixamoName.startsWith("mixamorig:") ? (map[mixamoName] ?? mixamoName) : mixamoName;
        if (this.boneNameToIndex.has(ueName)) {
          restRotMap.set(ueName, quat);
        }
      }
    }
    if (sourcePreRots) {
      for (const [mixamoName, quat] of sourcePreRots) {
        const ueName = mixamoName.startsWith("mixamorig:") ? (map[mixamoName] ?? mixamoName) : mixamoName;
        if (this.boneNameToIndex.has(ueName)) {
          preRotMap.set(ueName, quat);
        }
      }
    }
    if (restRotMap.size > 0) {
      this.sourceRestRotations.set(stateName, restRotMap);
    }
    if (preRotMap.size > 0) {
      this.sourcePreRotations.set(stateName, preRotMap);
    }
    for (let i = 0; i < animations.length; i++) {
      const anim = animations[i];
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        // Skip translation channels — Mixamo skeleton proportions differ from UE skeleton
        // Rotations drive the visible animation; rest pose translations define bone positions
        if (ch.path === "translation") continue;
        // FBX Model node names may have "Model" suffix appended
        let nodeName = ch.targetNode;
        if (nodeName.endsWith("Model")) nodeName = nodeName.slice(0, -5);
        const targetName = nodeName.startsWith("mixamorig:")
          ? map[nodeName] ?? nodeName
          : nodeName;
        if (this.boneNameToIndex.has(targetName)) {
          retargeted.push({
            ...ch,
            targetNode: targetName,
          });
        }
      }
    }
    if (retargeted.length > 0) {
      const retargetedAnim: AnimationData = {
        name: stateName,
        duration: animations[0]?.duration ?? 0,
        channels: retargeted,
      };
      this.animations.set(stateName, retargetedAnim);
      console.log(`[Anim] Registered: ${stateName} (${retargeted.length} rot channels, ${restRotMap.size} rest rots)`);
    }
  }

  setAnimationState(state: AnimState): void {
    if (state === this.currentState && this.currentAnim !== null) return;
    // Cooldown: don't allow state changes more often than every 0.5s
    if (this.timeSinceLastStateChange < 0.5 && this.currentAnim !== null) return;
    const anim = this.animations.get(state);
    if (!anim) return;

    // Start crossfade from current to new
    this.prevState = this.currentState;
    this.blendAnim = this.currentAnim;
    this.blendTime = 0;
    this.currentState = state;
    this.currentAnim = anim;
    this.animTime = 0;
    this.timeSinceLastStateChange = 0;
  }

  setFootTargets(left: Float32Array | null, right: Float32Array | null): void {
    this.leftFootTarget = left;
    this.rightFootTarget = right;
  }

  setIKEnabled(enabled: boolean): void {
    this.ikEnabled = enabled;
  }

  update(dt: number, playerFlags: number, velocity: number): void {
    // Clamp dt to prevent huge jumps from sim stalls
    if (dt > 0.1) dt = 0.1;
    this.timeSinceLastStateChange += dt;
    // Determine animation state from player flags + velocity
    const grounded = (playerFlags & PLR_FLAG.GROUNDED) !== 0;
    const swimming = (playerFlags & PLR_FLAG.SWIMMING) !== 0;

    let desiredState: AnimState;
    if (swimming) {
      desiredState = "Swim";
    } else if (!grounded) {
      if (velocity > 0.5) desiredState = "JumpStart";
      else if (velocity < -0.5) desiredState = "JumpEnd";
      else desiredState = "JumpLoop";
    } else {
      // Hysteresis: use different thresholds depending on current state
      // to prevent rapid oscillation at velocity boundaries
      const isMoving = this.currentState === "Walk" || this.currentState === "Run";
      const walkEnter = 0.8, walkExit = 0.3;
      const runEnter = 3.5, runExit = 2.5;
      if (isMoving) {
        if (velocity > runEnter) desiredState = "Run";
        else if (velocity > walkExit) desiredState = "Walk";
        else desiredState = "Idle";
      } else {
        if (velocity > runEnter) desiredState = "Run";
        else if (velocity > walkEnter) desiredState = "Walk";
        else desiredState = "Idle";
      }
    }

    // If Swim animation isn't available, fall back to Idle
    if (desiredState === "Swim" && !this.animations.has("Swim")) {
      desiredState = "Idle";
    }

    this.setAnimationState(desiredState);

    // Advance animation time
    if (this.currentAnim) {
      this.animTime += dt;
      if (this.currentAnim.duration > 0 && this.animTime >= this.currentAnim.duration) {
        this.animTime = this.animTime % this.currentAnim.duration;
      }
    }

    // Advance blend time
    if (this.blendAnim !== null) {
      this.blendTime += dt;
      if (this.blendTime >= this.blendDuration) {
        this.blendAnim = null;
        this.prevState = null;
      }
    }

    // Sample animation(s) into local transforms
    this.sampleAnimation(this.currentAnim, this.animTime, this.localPos, this.localRot, this.localScale, this.currentState);

    if (this.blendAnim !== null && this.prevState !== null) {
      this.sampleAnimation(this.blendAnim, this.blendTime, this.blendLocalPos, this.blendLocalRot, this.blendLocalScale, this.prevState);
      const blendFactor = this.blendTime / this.blendDuration;
      // Blend current (target) with previous (source)
      for (let i = 0; i < this.boneCount; i++) {
        vec3Lerp(this.blendLocalPos[i], this.localPos[i], blendFactor, this.localPos[i]);
        quatSlerp(this.blendLocalRot[i], this.localRot[i], blendFactor, this.localRot[i]);
        vec3Lerp(this.blendLocalScale[i], this.localScale[i], blendFactor, this.localScale[i]);
      }
    }

    // Procedural idle pose when no real animation is loaded
    if (!this.currentAnim) {
      this.applyProceduralIdle(dt);
    }

    // Apply IK corrections to leg bones
    if (false && this.ikEnabled && grounded) {
      this.applyFootIK();
    }

    // Pack local transforms into flat arrays for GPU upload (vec4 stride)
    for (let i = 0; i < this.boneCount; i++) {
      this.localPosFlat[i * 4]     = this.localPos[i][0];
      this.localPosFlat[i * 4 + 1] = this.localPos[i][1];
      this.localPosFlat[i * 4 + 2] = this.localPos[i][2];
      this.localPosFlat[i * 4 + 3] = 0.0;
      this.localRotFlat[i * 4]     = this.localRot[i][0];
      this.localRotFlat[i * 4 + 1] = this.localRot[i][1];
      this.localRotFlat[i * 4 + 2] = this.localRot[i][2];
      this.localRotFlat[i * 4 + 3] = this.localRot[i][3];
      this.localScaleFlat[i * 4]     = this.localScale[i][0];
      this.localScaleFlat[i * 4 + 1] = this.localScale[i][1];
      this.localScaleFlat[i * 4 + 2] = this.localScale[i][2];
      this.localScaleFlat[i * 4 + 3] = 0.0;
    }
  }

  private sampleAnimation(
    anim: AnimationData | null,
    time: number,
    posArr: Float32Array[],
    rotArr: Float32Array[],
    scaleArr: Float32Array[],
    animName?: string,
  ): void {
    if (!anim) {
      // Use rest pose
      for (let i = 0; i < this.boneCount; i++) {
        posArr[i].set(this.restPos[i]);
        rotArr[i].set(this.restRot[i]);
        scaleArr[i].set(this.restScale[i]);
      }
      return;
    }

    // Start with rest pose (for bones not animated)
    for (let i = 0; i < this.boneCount; i++) {
      posArr[i].set(this.restPos[i]);
      rotArr[i].set(this.restRot[i]);
      scaleArr[i].set(this.restScale[i]);
    }

    // For Mixamo skeletons, animation values are in the same coordinate space
    // as the skeleton — apply directly without any retargeting or coordinate transform
    if (this.isMixamoSkeleton) {
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        const boneIdx = this.boneNameToIndex.get(ch.targetNode);
        if (boneIdx === undefined) continue;

        const times = ch.keyframeTimes;
        const values = ch.keyframeValues;
        if (times.length === 0) continue;

        let k0 = 0, k1 = 0, t = 0;
        if (time <= times[0]) {
          k0 = 0; k1 = 0; t = 0;
        } else if (time >= times[times.length - 1]) {
          k0 = times.length - 1; k1 = k0; t = 0;
        } else {
          for (let k = 0; k < times.length - 1; k++) {
            if (time >= times[k] && time <= times[k + 1]) {
              k0 = k; k1 = k + 1;
              const range = times[k1] - times[k0];
              t = range > 0 ? (time - times[k0]) / range : 0;
              break;
            }
          }
        }

        if (ch.path === "translation") {
          const v0 = k0 * 3;
          const v1 = k1 * 3;
          posArr[boneIdx][0] = values[v0] + (values[v1] - values[v0]) * t;
          posArr[boneIdx][1] = values[v0 + 1] + (values[v1 + 1] - values[v0 + 1]) * t;
          posArr[boneIdx][2] = values[v0 + 2] + (values[v1 + 2] - values[v0 + 2]) * t;
        } else if (ch.path === "rotation") {
          const v0 = k0 * 4;
          const v1 = k1 * 4;
          const q0 = new Float32Array([values[v0], values[v0 + 1], values[v0 + 2], values[v0 + 3]]);
          const q1 = new Float32Array([values[v1], values[v1 + 1], values[v1 + 2], values[v1 + 3]]);
          const animLcl = new Float32Array(4);
          quatSlerp(q0, q1, t, animLcl);
          // Apply PreRotation if available: fullRot = PreRotation * animLcl
          const preRotMap = animName ? this.sourcePreRotations.get(animName) : undefined;
          const srcPreRot = preRotMap?.get(ch.targetNode);
          if (srcPreRot) {
            quatMul(new Float32Array(srcPreRot), animLcl, rotArr[boneIdx]);
          } else {
            rotArr[boneIdx].set(animLcl);
          }
        } else if (ch.path === "scale") {
          const v0 = k0 * 3;
          const v1 = k1 * 3;
          scaleArr[boneIdx][0] = values[v0] + (values[v1] - values[v0]) * t;
          scaleArr[boneIdx][1] = values[v0 + 1] + (values[v1 + 1] - values[v0 + 1]) * t;
          scaleArr[boneIdx][2] = values[v0 + 2] + (values[v1 + 2] - values[v0 + 2]) * t;
        }
      }
      return;
    }

    // Sample each channel
    for (let c = 0; c < anim.channels.length; c++) {
      const ch = anim.channels[c];
      const boneIdx = this.boneNameToIndex.get(ch.targetNode);
      if (boneIdx === undefined) continue;

      const times = ch.keyframeTimes;
      const values = ch.keyframeValues;
      if (times.length === 0) continue;

      // Find keyframe pair
      let k0 = 0;
      let k1 = 0;
      let t = 0;
      if (time <= times[0]) {
        k0 = 0; k1 = 0; t = 0;
      } else if (time >= times[times.length - 1]) {
        k0 = times.length - 1; k1 = k0; t = 0;
      } else {
        for (let k = 0; k < times.length - 1; k++) {
          if (time >= times[k] && time <= times[k + 1]) {
            k0 = k; k1 = k + 1;
            const range = times[k1] - times[k0];
            t = range > 0 ? (time - times[k0]) / range : 0;
            break;
          }
        }
      }

      if (ch.path === "translation") {
        const v0 = k0 * 3;
        const v1 = k1 * 3;
        // Transform from Mixamo Y-up to root-local space (root has -90° X rotation)
        // Conjugation by q_root^-1: (x, y, z) → (x, -z, y)
        posArr[boneIdx][0] = values[v0] + (values[v1] - values[v0]) * t;
        posArr[boneIdx][1] = -(values[v0 + 2] + (values[v1 + 2] - values[v0 + 2]) * t);
        posArr[boneIdx][2] = values[v0 + 1] + (values[v1 + 1] - values[v0 + 1]) * t;
      } else if (ch.path === "rotation") {
        const v0 = k0 * 4;
        const v1 = k1 * 4;
        const q0 = new Float32Array([values[v0], values[v0 + 1], values[v0 + 2], values[v0 + 3]]);
        const q1 = new Float32Array([values[v1], values[v1 + 1], values[v1 + 2], values[v1 + 3]]);
        // Mixamo FBX is Y-up (UpAxis=1). The GLTF skeleton's root bone has a -90° X rotation,
        // so all bones below root live in a Z-down, Y-forward local space. The delta computed in
        // Mixamo's Y-up space must be transformed to the UE skeleton's local space.
        // For rotation quaternions, the transform is conjugation by q_root^-1:
        //   q_local = q_root^-1 * q_yup * q_root
        // which gives: (x, y, z, w) → (x, -z, y, w)
        // Retargeting formula:
        //   delta_yup = inverse(restRot_mixamo) * (PreRotation * animLcl)   [in Y-up space]
        //   delta_local = conjugate_by_q_root_inv(delta_yup)  // (x,y,z,w) → (x,-z,y,w)
        //   finalRot = restRot_ue * delta_local
        const animLcl = new Float32Array(4);
        quatSlerp(q0, q1, t, animLcl);
        const restRotMap = animName ? this.sourceRestRotations.get(animName) : undefined;
        const preRotMap = animName ? this.sourcePreRotations.get(animName) : undefined;
        const srcRest = restRotMap?.get(ch.targetNode);
        const srcPreRot = preRotMap?.get(ch.targetNode);
        if (srcRest && srcPreRot) {
          // fullAnimRot = PreRotation * animLclRotation (in Y-up space)
          const fullAnimRot = new Float32Array(4);
          quatMul(new Float32Array(srcPreRot), animLcl, fullAnimRot);
          // delta_yup = inverse(restRot_mixamo) * fullAnimRot (in Y-up space)
          const invSrcRest = new Float32Array(4);
          quatInvert(new Float32Array(srcRest), invSrcRest);
          const deltaYup = new Float32Array(4);
          quatMul(invSrcRest, fullAnimRot, deltaYup);
          // Transform delta from Y-up to root-local: conjugate by q_root^-1 → (x,y,z,w) → (x,-z,y,w)
          const deltaLocal = new Float32Array(4);
          deltaLocal[0] = deltaYup[0];
          deltaLocal[1] = -deltaYup[2];
          deltaLocal[2] = deltaYup[1];
          deltaLocal[3] = deltaYup[3];
          // finalRot = restRot_ue * delta_local
          quatMul(this.restRot[boneIdx], deltaLocal, rotArr[boneIdx]);
        } else {
          // No source rest rotation — transform animLcl from Y-up to root-local, then apply to UE rest
          const animLclLocal = new Float32Array(4);
          animLclLocal[0] = animLcl[0];
          animLclLocal[1] = -animLcl[2];
          animLclLocal[2] = animLcl[1];
          animLclLocal[3] = animLcl[3];
          quatMul(this.restRot[boneIdx], animLclLocal, rotArr[boneIdx]);
        }
      } else if (ch.path === "scale") {
        const v0 = k0 * 3;
        const v1 = k1 * 3;
        scaleArr[boneIdx][0] = values[v0] + (values[v1] - values[v0]) * t;
        scaleArr[boneIdx][1] = values[v0 + 1] + (values[v1 + 1] - values[v0 + 1]) * t;
        scaleArr[boneIdx][2] = values[v0 + 2] + (values[v1 + 2] - values[v0 + 2]) * t;
      }
    }
  }

  private applyFootIK(): void {
    // Two-bone IK for each leg: LegUp -> LegDown -> Foot
    // Simple version: adjust LegDown rotation to place foot at target Y
    if (this.leftFootTarget && this.leftLegUpIdx >= 0 && this.leftLegDownIdx >= 0 && this.leftFootIdx >= 0) {
      this.applyTwoBoneIK(
        this.leftLegUpIdx, this.leftLegDownIdx, this.leftFootIdx,
        this.leftFootTarget,
      );
    }
    if (this.rightFootTarget && this.rightLegUpIdx >= 0 && this.rightLegDownIdx >= 0 && this.rightFootIdx >= 0) {
      this.applyTwoBoneIK(
        this.rightLegUpIdx, this.rightLegDownIdx, this.rightFootIdx,
        this.rightFootTarget,
      );
    }
  }

  private applyTwoBoneIK(
    rootIdx: number,
    midIdx: number,
    endIdx: number,
    target: Float32Array,
  ): void {
    // Get current world positions of root, mid, end joints
    // We need to compute these from the current local transforms
    // For simplicity, compute world positions on the fly

    // Root world position (compute from hierarchy)
    const rootWorld = this.computeBoneWorldPos(rootIdx);
    const midWorld = this.computeBoneWorldPos(midIdx);
    const endWorld = this.computeBoneWorldPos(endIdx);

    // Target is in world space, but we only care about Y for now
    const targetY = target[1];

    // Distance from root to target
    const dx = target[0] - rootWorld[0];
    const dy = targetY - rootWorld[1];
    const dz = target[2] - rootWorld[2];
    const targetDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Bone lengths
    let upperLen = 0;
    let lowerLen = 0;
    for (let i = 0; i < 3; i++) {
      const d = midWorld[i] - rootWorld[i];
      upperLen += d * d;
    }
    upperLen = Math.sqrt(upperLen);
    for (let i = 0; i < 3; i++) {
      const d = endWorld[i] - midWorld[i];
      lowerLen += d * d;
    }
    lowerLen = Math.sqrt(lowerLen);

    if (upperLen < 0.001 || lowerLen < 0.001) return;

    // Clamp target distance to achievable range
    const maxReach = upperLen + lowerLen - 0.001;
    const minReach = Math.abs(upperLen - lowerLen) + 0.001;
    const clampedDist = Math.max(minReach, Math.min(maxReach, targetDist));

    // Compute knee angle using law of cosines
    // cos(kneeAngle) = (upperLen^2 + lowerLen^2 - clampedDist^2) / (2 * upperLen * lowerLen)
    const cosKnee = (upperLen * upperLen + lowerLen * lowerLen - clampedDist * clampedDist) / (2 * upperLen * lowerLen);
    const kneeAngle = Math.acos(Math.max(-1, Math.min(1, cosKnee)));

    // The knee should bend from its rest angle toward the computed angle
    // For simplicity, we adjust the mid bone's rotation to bend the knee
    // This is a simplified IK that only adjusts the knee rotation

    // Compute the direction from root to target
    const dirX = dx / targetDist;
    const dirY = dy / targetDist;
    const dirZ = dz / targetDist;

    // Adjust mid bone rotation: rotate around the axis perpendicular to the leg plane
    // For a simple approach, we just adjust the X-axis rotation of the mid bone
    // (knees typically bend around the X axis in character rigs)
    const restKneeAngle = Math.acos(Math.max(-1, Math.min(1,
      ((midWorld[0] - rootWorld[0]) * (endWorld[0] - midWorld[0]) +
       (midWorld[1] - rootWorld[1]) * (endWorld[1] - midWorld[1]) +
       (midWorld[2] - rootWorld[2]) * (endWorld[2] - midWorld[2])) / (upperLen * lowerLen)
    )));

    const kneeDelta = kneeAngle - restKneeAngle;
    if (Math.abs(kneeDelta) < 0.001) return;

    // Apply rotation to mid bone (bend knee)
    // Rotate around X axis: quaternion (sin(theta/2), 0, 0, cos(theta/2))
    const halfDelta = kneeDelta * 0.5;
    const rotQuat = new Float32Array([Math.sin(halfDelta), 0, 0, Math.cos(halfDelta)]);
    const newRot = new Float32Array(4);
    quatMul(this.localRot[midIdx], rotQuat, newRot);
    this.localRot[midIdx].set(newRot);
  }

  private computeBoneWorldPos(boneIdx: number): Float32Array {
    // Compute world position by accumulating parent transforms
    // Build chain from root to this bone
    const chain: number[] = [];
    let idx = boneIdx;
    while (idx >= 0) {
      chain.unshift(idx);
      idx = this.parentIndices[idx];
    }

    // Accumulate world position
    const pos = new Float32Array(3);
    const tmpMat = new Float32Array(16);
    const accumMat = new Float32Array(16);
    // Identity
    accumMat[0] = 1; accumMat[5] = 1; accumMat[10] = 1; accumMat[15] = 1;

    for (let c = 0; c < chain.length; c++) {
      const bi = chain[c];
      buildLocalMatrix(this.localPos[bi], this.localRot[bi], this.localScale[bi], tmpMat);
      const newAccum = new Float32Array(16);
      mat4Mul(accumMat, tmpMat, newAccum);
      accumMat.set(newAccum);
    }

    pos[0] = accumMat[12];
    pos[1] = accumMat[13];
    pos[2] = accumMat[14];
    return pos;
  }

  private applyProceduralIdle(dt: number): void {
    this.proceduralTime += dt;
    const t = this.proceduralTime;

    // Breathing: subtle spine scale
    const breath = Math.sin(t * 1.5) * 0.5 + 0.5; // 0..1
    if (this.spineIdx >= 0) {
      this.localScale[this.spineIdx][1] = 1.0 + breath * 0.02;
    }

    // Subtle arm sway — in Mixamo Y-up space, arms hang along -Y and sway around Z
    const armSwing = Math.sin(t * 1.5) * 0.03;
    const tmpRot = new Float32Array(4);
    const deltaRot = new Float32Array(4);

    if (this.leftUpperArmIdx >= 0) {
      const a = armSwing;
      deltaRot[0] = 0; deltaRot[1] = 0; deltaRot[2] = Math.sin(a * 0.5); deltaRot[3] = Math.cos(a * 0.5);
      quatMul(this.localRot[this.leftUpperArmIdx], deltaRot, tmpRot);
      this.localRot[this.leftUpperArmIdx].set(tmpRot);
    }

    if (this.rightUpperArmIdx >= 0) {
      const a = -armSwing;
      deltaRot[0] = 0; deltaRot[1] = 0; deltaRot[2] = Math.sin(a * 0.5); deltaRot[3] = Math.cos(a * 0.5);
      quatMul(this.localRot[this.rightUpperArmIdx], deltaRot, tmpRot);
      this.localRot[this.rightUpperArmIdx].set(tmpRot);
    }

    // Subtle head movement — rotate around Z (nod) in Y-up space
    if (this.headIdx >= 0) {
      const headSway = Math.sin(t * 0.8) * 0.03;
      deltaRot[0] = 0; deltaRot[1] = 0; deltaRot[2] = Math.sin(headSway * 0.5); deltaRot[3] = Math.cos(headSway * 0.5);
      quatMul(this.localRot[this.headIdx], deltaRot, tmpRot);
      this.localRot[this.headIdx].set(tmpRot);
    }
  }

  private computeWorldMatrices(): void {
    // Build local matrices first, then resolve world matrices iteratively
    // to handle bones that may not be ordered parents-first (e.g. GLTF)
    const tmpMat = new Float32Array(16);
    const resolved = new Uint8Array(this.boneCount);

    for (let i = 0; i < this.boneCount; i++) {
      buildLocalMatrix(this.localPos[i], this.localRot[i], this.localScale[i], tmpMat);
      // Store local matrix in worldMatrices temporarily for roots
      const parentIdx = this.parentIndices[i];
      if (parentIdx < 0) {
        this.worldMatrices[i].set(tmpMat);
        resolved[i] = 1;
      }
    }

    // Iteratively resolve children of already-resolved bones
    let resolvedCount = 0;
    for (let i = 0; i < this.boneCount; i++) {
      if (resolved[i]) resolvedCount++;
    }
    while (resolvedCount < this.boneCount) {
      let progress = false;
      for (let i = 0; i < this.boneCount; i++) {
        if (resolved[i]) continue;
        const parentIdx = this.parentIndices[i];
        if (parentIdx >= 0 && resolved[parentIdx]) {
          buildLocalMatrix(this.localPos[i], this.localRot[i], this.localScale[i], tmpMat);
          mat4Mul(this.worldMatrices[parentIdx], tmpMat, this.worldMatrices[i]);
          resolved[i] = 1;
          resolvedCount++;
          progress = true;
        }
      }
      if (!progress) break; // safety: avoid infinite loop on cyclic deps
    }
  }

  setNormalizationMatrix(mat: Float32Array, invMat: Float32Array): void {
    this.normalizationMatrix = mat;
    this.inverseNormalizationMatrix = invMat;
  }

  getLocalPosFlat(): Float32Array {
    return this.localPosFlat;
  }

  getLocalRotFlat(): Float32Array {
    return this.localRotFlat;
  }

  getLocalScaleFlat(): Float32Array {
    return this.localScaleFlat;
  }

  getParentIndices(): Int32Array {
    return this.parentIndices;
  }

  getInverseBindMatricesFlat(): Float32Array {
    return this.inverseBindMatricesFlat;
  }

  getNormalizationMatrix(): Float32Array | null {
    return this.normalizationMatrix;
  }

  getInverseNormalizationMatrix(): Float32Array | null {
    return this.inverseNormalizationMatrix;
  }

  getBoneCount(): number {
    return this.boneCount;
  }

  getCurrentState(): AnimState {
    return this.currentState;
  }
}
