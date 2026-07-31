// ============================================================================
// Skeleton Animator — skeletal animation with crossfade blending, retargeting,
// procedural idle, and foot IK. Generic, game-agnostic.
// ============================================================================

export interface AnimationChannel {
  targetNode: string;
  path: "translation" | "rotation" | "scale" | "weights";
  keyframeTimes: Float32Array;
  keyframeValues: Float32Array;
  interpolation: "LINEAR" | "STEP" | "CUBICSPLINE";
}

export interface AnimationData {
  name: string;
  duration: number;
  channels: AnimationChannel[];
  sourceRestRotations?: Map<string, [number, number, number, number]>;
  sourcePreRotations?: Map<string, [number, number, number, number]>;
}

export interface BoneData {
  name: string;
  nodeIndex: number;
  parentIndex: number;
  inverseBindMatrix: Float32Array;
  restTranslation: [number, number, number];
  restRotation: [number, number, number, number];
  restScale: [number, number, number];
}

export interface SkinData {
  bones: BoneData[];
  boneNameToIndex: Map<string, number>;
}

export type AnimState = string;

// ── Vec3 / Quaternion math helpers ──

function vec3Lerp(a: Float32Array, b: Float32Array, t: number, out: Float32Array): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function quatInvert(q: Float32Array, out: Float32Array): void {
  out[0] = -q[0];
  out[1] = -q[1];
  out[2] = -q[2];
  out[3] = q[3];
}

function quatSlerp(a: Float32Array, b: Float32Array, t: number, out: Float32Array): void {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    out[0] = -b[0]; out[1] = -b[1]; out[2] = -b[2]; out[3] = -b[3];
    dot = -dot;
  } else {
    out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; out[3] = b[3];
  }
  if (dot > 0.9995) {
    out[0] = a[0] + (out[0] - a[0]) * t;
    out[1] = a[1] + (out[1] - a[1]) * t;
    out[2] = a[2] + (out[2] - a[2]) * t;
    out[3] = a[3] + (out[3] - a[3]) * t;
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

function quatMul(q1: Float32Array, q2: Float32Array, out: Float32Array): void {
  const ax = q1[0], ay = q1[1], az = q1[2], aw = q1[3];
  const bx = q2[0], by = q2[1], bz = q2[2], bw = q2[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

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
  private inverseBindMatrices: Float32Array[];

  private localPos: Float32Array[];
  private localRot: Float32Array[];
  private localScale: Float32Array[];

  private restPos: Float32Array[];
  private restRot: Float32Array[];
  private restScale: Float32Array[];

  private worldMatrices: Float32Array[];

  private localPosFlat: Float32Array;
  private localRotFlat: Float32Array;
  private localScaleFlat: Float32Array;

  private inverseBindMatricesFlat: Float32Array;

  private normalizationMatrix: Float32Array | null = null;
  private inverseNormalizationMatrix: Float32Array | null = null;

  private animations: Map<string, AnimationData> = new Map();
  private currentState: AnimState = "Idle";
  private currentAnim: AnimationData | null = null;
  private animTime = 0;
  private timeSinceLastStateChange = 0;
  private blendAnim: AnimationData | null = null;
  private blendTime = 0;
  private blendDuration = 0.2;
  private prevState: AnimState | null = null;
  private sourceRestRotations: Map<string, Map<string, [number, number, number, number]>> = new Map();
  private sourcePreRotations: Map<string, Map<string, [number, number, number, number]>> = new Map();

  private blendLocalPos: Float32Array[];
  private blendLocalRot: Float32Array[];
  private blendLocalScale: Float32Array[];

  private ikEnabled = true;
  private leftFootTarget: Float32Array | null = null;
  private rightFootTarget: Float32Array | null = null;
  private boneNameToIndex: Map<string, number>;

  private leftLegUpIdx = -1;
  private leftLegDownIdx = -1;
  private leftFootIdx = -1;
  private rightLegUpIdx = -1;
  private rightLegDownIdx = -1;
  private rightFootIdx = -1;

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

      this.localPos.push(new Float32Array(rp));
      this.localRot.push(new Float32Array(rr));
      this.localScale.push(new Float32Array(rs));

      this.worldMatrices.push(new Float32Array(16));
      this.blendLocalPos.push(new Float32Array(3));
      this.blendLocalRot.push(new Float32Array(4));
      this.blendLocalScale.push(new Float32Array(3));
    }

    this.inverseBindMatricesFlat = new Float32Array(this.boneCount * 16);
    for (let i = 0; i < this.boneCount; i++) {
      this.inverseBindMatricesFlat.set(this.inverseBindMatrices[i], i * 16);
    }

    this.localPosFlat = new Float32Array(this.boneCount * 4);
    this.localRotFlat = new Float32Array(this.boneCount * 4);
    this.localScaleFlat = new Float32Array(this.boneCount * 4);

    this.leftLegUpIdx = this.findBone(["LegUp_Left", "thigh_l", "UpperLeg_Left", "mixamorig:LeftUpLeg"]);
    this.leftLegDownIdx = this.findBone(["LegDown_Left", "calf_l", "LowerLeg_Left", "mixamorig:LeftLeg"]);
    this.leftFootIdx = this.findBone(["FootStart_Left", "foot_l", "Foot_Left", "mixamorig:LeftFoot"]);
    this.rightLegUpIdx = this.findBone(["LegUp_Right", "thigh_r", "UpperLeg_Right", "mixamorig:RightUpLeg"]);
    this.rightLegDownIdx = this.findBone(["LegDown_Right", "calf_r", "LowerLeg_Right", "mixamorig:RightLeg"]);
    this.rightFootIdx = this.findBone(["FootStart_Right", "foot_r", "Foot_Right", "mixamorig:RightFoot"]);

    this.leftUpperArmIdx = this.findBone(["UpperArm_Left", "upperarm_l", "ArmUp_Left", "mixamorig:LeftArm"]);
    this.rightUpperArmIdx = this.findBone(["UpperArm_Right", "upperarm_r", "ArmUp_Right", "mixamorig:RightArm"]);
    this.spineIdx = this.findBone(["Spine", "spine_01", "Spine_01", "mixamorig:Spine"]);
    this.headIdx = this.findBone(["Head", "head", "mixamorig:Head"]);

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

  registerRetargetedAnimations(animations: AnimationData[], stateName: string): void {
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
        if (ch.path === "translation") continue;
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

  protected setAnimationState(state: AnimState): void {
    if (state === this.currentState && this.currentAnim !== null) return;
    if (this.timeSinceLastStateChange < 0.5 && this.currentAnim !== null) return;
    const anim = this.animations.get(state);
    if (!anim) return;

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

  hasAnimation(name: string): boolean {
    return this.animations.has(name);
  }

  protected tick(dt: number): void {
    if (dt > 0.1) dt = 0.1;
    this.timeSinceLastStateChange += dt;

    if (this.currentAnim) {
      this.animTime += dt;
      if (this.currentAnim.duration > 0 && this.animTime >= this.currentAnim.duration) {
        this.animTime = this.animTime % this.currentAnim.duration;
      }
    }

    if (this.blendAnim !== null) {
      this.blendTime += dt;
      if (this.blendTime >= this.blendDuration) {
        this.blendAnim = null;
        this.prevState = null;
      }
    }

    this.sampleAnimation(this.currentAnim, this.animTime, this.localPos, this.localRot, this.localScale, this.currentState);

    if (this.blendAnim !== null && this.prevState !== null) {
      this.sampleAnimation(this.blendAnim, this.blendTime, this.blendLocalPos, this.blendLocalRot, this.blendLocalScale, this.prevState);
      const blendFactor = this.blendTime / this.blendDuration;
      for (let i = 0; i < this.boneCount; i++) {
        vec3Lerp(this.blendLocalPos[i], this.localPos[i], blendFactor, this.localPos[i]);
        quatSlerp(this.blendLocalRot[i], this.localRot[i], blendFactor, this.localRot[i]);
        vec3Lerp(this.blendLocalScale[i], this.localScale[i], blendFactor, this.localScale[i]);
      }
    }

    if (!this.currentAnim) {
      this.applyProceduralIdle(dt);
    }

    if (false && this.ikEnabled) {
      this.applyFootIK();
    }

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

  protected sampleAnimation(
    anim: AnimationData | null,
    time: number,
    posArr: Float32Array[],
    rotArr: Float32Array[],
    scaleArr: Float32Array[],
    animName?: string,
  ): void {
    if (!anim) {
      for (let i = 0; i < this.boneCount; i++) {
        posArr[i].set(this.restPos[i]);
        rotArr[i].set(this.restRot[i]);
        scaleArr[i].set(this.restScale[i]);
      }
      return;
    }

    for (let i = 0; i < this.boneCount; i++) {
      posArr[i].set(this.restPos[i]);
      rotArr[i].set(this.restRot[i]);
      scaleArr[i].set(this.restScale[i]);
    }

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

    for (let c = 0; c < anim.channels.length; c++) {
      const ch = anim.channels[c];
      const boneIdx = this.boneNameToIndex.get(ch.targetNode);
      if (boneIdx === undefined) continue;

      const times = ch.keyframeTimes;
      const values = ch.keyframeValues;
      if (times.length === 0) continue;

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
        posArr[boneIdx][0] = values[v0] + (values[v1] - values[v0]) * t;
        posArr[boneIdx][1] = -(values[v0 + 2] + (values[v1 + 2] - values[v0 + 2]) * t);
        posArr[boneIdx][2] = values[v0 + 1] + (values[v1 + 1] - values[v0 + 1]) * t;
      } else if (ch.path === "rotation") {
        const v0 = k0 * 4;
        const v1 = k1 * 4;
        const q0 = new Float32Array([values[v0], values[v0 + 1], values[v0 + 2], values[v0 + 3]]);
        const q1 = new Float32Array([values[v1], values[v1 + 1], values[v1 + 2], values[v1 + 3]]);
        const animLcl = new Float32Array(4);
        quatSlerp(q0, q1, t, animLcl);
        const restRotMap = animName ? this.sourceRestRotations.get(animName) : undefined;
        const preRotMap = animName ? this.sourcePreRotations.get(animName) : undefined;
        const srcRest = restRotMap?.get(ch.targetNode);
        const srcPreRot = preRotMap?.get(ch.targetNode);
        if (srcRest && srcPreRot) {
          const fullAnimRot = new Float32Array(4);
          quatMul(new Float32Array(srcPreRot), animLcl, fullAnimRot);
          const invSrcRest = new Float32Array(4);
          quatInvert(new Float32Array(srcRest), invSrcRest);
          const deltaYup = new Float32Array(4);
          quatMul(invSrcRest, fullAnimRot, deltaYup);
          const deltaLocal = new Float32Array(4);
          deltaLocal[0] = deltaYup[0];
          deltaLocal[1] = -deltaYup[2];
          deltaLocal[2] = deltaYup[1];
          deltaLocal[3] = deltaYup[3];
          quatMul(this.restRot[boneIdx], deltaLocal, rotArr[boneIdx]);
        } else {
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

  protected applyFootIK(): void {
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
    const rootWorld = this.computeBoneWorldPos(rootIdx);
    const midWorld = this.computeBoneWorldPos(midIdx);
    const endWorld = this.computeBoneWorldPos(endIdx);

    const targetY = target[1];

    const dx = target[0] - rootWorld[0];
    const dy = targetY - rootWorld[1];
    const dz = target[2] - rootWorld[2];
    const targetDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

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

    const maxReach = upperLen + lowerLen - 0.001;
    const minReach = Math.abs(upperLen - lowerLen) + 0.001;
    const clampedDist = Math.max(minReach, Math.min(maxReach, targetDist));

    const cosKnee = (upperLen * upperLen + lowerLen * lowerLen - clampedDist * clampedDist) / (2 * upperLen * lowerLen);
    const kneeAngle = Math.acos(Math.max(-1, Math.min(1, cosKnee)));

    const dirX = dx / targetDist;
    const dirY = dy / targetDist;
    const dirZ = dz / targetDist;

    const restKneeAngle = Math.acos(Math.max(-1, Math.min(1,
      ((midWorld[0] - rootWorld[0]) * (endWorld[0] - midWorld[0]) +
       (midWorld[1] - rootWorld[1]) * (endWorld[1] - midWorld[1]) +
       (midWorld[2] - rootWorld[2]) * (endWorld[2] - midWorld[2])) / (upperLen * lowerLen)
    )));

    const kneeDelta = kneeAngle - restKneeAngle;
    if (Math.abs(kneeDelta) < 0.001) return;

    const halfDelta = kneeDelta * 0.5;
    const rotQuat = new Float32Array([Math.sin(halfDelta), 0, 0, Math.cos(halfDelta)]);
    const newRot = new Float32Array(4);
    quatMul(this.localRot[midIdx], rotQuat, newRot);
    this.localRot[midIdx].set(newRot);
  }

  private computeBoneWorldPos(boneIdx: number): Float32Array {
    const chain: number[] = [];
    let idx = boneIdx;
    while (idx >= 0) {
      chain.unshift(idx);
      idx = this.parentIndices[idx];
    }

    const pos = new Float32Array(3);
    const tmpMat = new Float32Array(16);
    const accumMat = new Float32Array(16);
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

  protected applyProceduralIdle(dt: number): void {
    this.proceduralTime += dt;
    const t = this.proceduralTime;

    const breath = Math.sin(t * 1.5) * 0.5 + 0.5;
    if (this.spineIdx >= 0) {
      this.localScale[this.spineIdx][1] = 1.0 + breath * 0.02;
    }

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

    if (this.headIdx >= 0) {
      const headSway = Math.sin(t * 0.8) * 0.03;
      deltaRot[0] = 0; deltaRot[1] = 0; deltaRot[2] = Math.sin(headSway * 0.5); deltaRot[3] = Math.cos(headSway * 0.5);
      quatMul(this.localRot[this.headIdx], deltaRot, tmpRot);
      this.localRot[this.headIdx].set(tmpRot);
    }
  }

  setNormalizationMatrix(mat: Float32Array, invMat: Float32Array): void {
    this.normalizationMatrix = mat;
    this.inverseNormalizationMatrix = invMat;
  }

  getLocalPosFlat(): Float32Array { return this.localPosFlat; }
  getLocalRotFlat(): Float32Array { return this.localRotFlat; }
  getLocalScaleFlat(): Float32Array { return this.localScaleFlat; }
  getParentIndices(): Int32Array { return this.parentIndices; }
  getInverseBindMatricesFlat(): Float32Array { return this.inverseBindMatricesFlat; }
  getNormalizationMatrix(): Float32Array | null { return this.normalizationMatrix; }
  getInverseNormalizationMatrix(): Float32Array | null { return this.inverseNormalizationMatrix; }
  getBoneCount(): number { return this.boneCount; }
  getCurrentState(): AnimState { return this.currentState; }
}
