// ============================================================================
// Skeleton Animator — skeletal animation with crossfade blending, retargeting,
// procedural idle, and foot IK. Generic, game-agnostic.
// Uses AnimationPlayer internally for blending (bone masks, additive, root motion).
// ============================================================================

import type { AnimationEvent } from "./animation-event.ts";
import type { KeyframeTrack, TrackPath } from "./clip.ts";
import { AnimationClip } from "./clip.ts";
import { AnimationPlayer } from "./player.ts";
import type { Bone, SkeletonData } from "./skeleton.ts";
import { Skeleton } from "./skeleton.ts";

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

// ── SkinData → SkeletonData conversion ──

export function skinDataToSkeletonData(skin: SkinData): SkeletonData {
  const bones: Bone[] = skin.bones.map((b) => ({
    name: b.name,
    parentIndex: b.parentIndex,
    childrenIndices: [] as number[],
    bindPosition: b.restTranslation,
    bindRotation: b.restRotation,
    bindScale: b.restScale,
    inverseBindMatrix: b.inverseBindMatrix,
  }));

  for (let i = 0; i < bones.length; i++) {
    const parentIdx = bones[i].parentIndex;
    if (parentIdx >= 0 && parentIdx < bones.length) {
      bones[parentIdx].childrenIndices.push(i);
    }
  }

  let rootBoneIndex = 0;
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].parentIndex < 0) {
      rootBoneIndex = i;
      break;
    }
  }

  return { bones, name: "skeleton", rootBoneIndex };
}

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

  private skeleton: Skeleton;
  private player: AnimationPlayer;

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

  private clips: Map<string, AnimationClip> = new Map();
  private currentState: AnimState = "Idle";
  private timeSinceLastStateChange = 0;
  private blendDuration = 0.2;
  private sourceRestRotations: Map<string, Map<string, [number, number, number, number]>> = new Map();
  private sourcePreRotations: Map<string, Map<string, [number, number, number, number]>> = new Map();

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

    // Create Skeleton and AnimationPlayer from SkinData
    const skelData = skinDataToSkeletonData(skin);
    this.skeleton = new Skeleton(skelData);
    this.player = new AnimationPlayer(this.skeleton);

    this.localPos = [];
    this.localRot = [];
    this.localScale = [];
    this.restPos = [];
    this.restRot = [];
    this.restScale = [];
    this.worldMatrices = [];

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
      const clip = this.animationDataToClip(animations[i], animations[i].name);
      if (clip) {
        this.clips.set(animations[i].name, clip);
      }
    }
  }

  private animationDataToClip(anim: AnimationData, animName: string): AnimationClip | null {
    const tracks: KeyframeTrack[] = [];
    const preRotMap = this.sourcePreRotations.get(animName);
    const restRotMap = this.sourceRestRotations.get(animName);

    for (let c = 0; c < anim.channels.length; c++) {
      const ch = anim.channels[c];
      let nodeName = ch.targetNode;
      if (nodeName.endsWith("Model")) nodeName = nodeName.slice(0, -5);

      // For non-Mixamo, apply bone name mapping
      if (!this.isMixamoSkeleton) {
        nodeName = nodeName.startsWith("mixamorig:")
          ? (SkeletonAnimator.MIXAMO_TO_UE[nodeName] ?? nodeName)
          : nodeName;
        // Non-Mixamo retargeting skips translation channels
        if (ch.path === "translation") continue;
      }

      const boneIdx = this.boneNameToIndex.get(nodeName);
      if (boneIdx === undefined) continue;

      const path: TrackPath = ch.path === "translation" ? "position" : ch.path === "rotation" ? "rotation" : "scale";
      const interpolation = ch.interpolation === "LINEAR" ? "linear" : ch.interpolation === "STEP" ? "step" : "cubic";
      const times = ch.keyframeTimes;
      const srcValues = ch.keyframeValues;

      if (path === "rotation") {
        // Pre-bake retargeting for rotation at each keyframe
        const values = new Float32Array(srcValues.length);
        const srcPreRot = preRotMap?.get(nodeName);
        const srcRest = restRotMap?.get(nodeName);

        for (let k = 0; k < times.length; k++) {
          const v0 = k * 4;
          const q = new Float32Array([srcValues[v0], srcValues[v0 + 1], srcValues[v0 + 2], srcValues[v0 + 3]]);
          const result = new Float32Array(4);

          if (this.isMixamoSkeleton) {
            // Direct Mixamo: apply pre-rotation
            if (srcPreRot) {
              quatMul(new Float32Array(srcPreRot), q, result);
            } else {
              result.set(q);
            }
          } else if (srcRest && srcPreRot) {
            // Full retargeting: preRot * q, then delta = invRest * (preRot * q), then axis swap, then * restRot
            const fullAnimRot = new Float32Array(4);
            quatMul(new Float32Array(srcPreRot), q, fullAnimRot);
            const invSrcRest = new Float32Array(4);
            quatInvert(new Float32Array(srcRest), invSrcRest);
            const deltaYup = new Float32Array(4);
            quatMul(invSrcRest, fullAnimRot, deltaYup);
            const deltaLocal = new Float32Array(4);
            deltaLocal[0] = deltaYup[0];
            deltaLocal[1] = -deltaYup[2];
            deltaLocal[2] = deltaYup[1];
            deltaLocal[3] = deltaYup[3];
            quatMul(this.restRot[boneIdx], deltaLocal, result);
          } else {
            // Simple axis swap + rest rotation
            const animLclLocal = new Float32Array(4);
            animLclLocal[0] = q[0];
            animLclLocal[1] = -q[2];
            animLclLocal[2] = q[1];
            animLclLocal[3] = q[3];
            quatMul(this.restRot[boneIdx], animLclLocal, result);
          }

          values[v0] = result[0]; values[v0 + 1] = result[1]; values[v0 + 2] = result[2]; values[v0 + 3] = result[3];
        }
        tracks.push({ boneName: nodeName, boneIndex: boneIdx, path, times, values, interpolation });
      } else if (path === "position") {
        // For non-Mixamo, axis-swap position. For Mixamo, direct copy.
        if (this.isMixamoSkeleton) {
          tracks.push({ boneName: nodeName, boneIndex: boneIdx, path, times, values: srcValues, interpolation });
        } else {
          // Axis swap: x=x, y=-z, z=y
          const values = new Float32Array(srcValues.length);
          for (let k = 0; k < times.length; k++) {
            const v0 = k * 3;
            values[v0] = srcValues[v0];
            values[v0 + 1] = -srcValues[v0 + 2];
            values[v0 + 2] = srcValues[v0 + 1];
          }
          tracks.push({ boneName: nodeName, boneIndex: boneIdx, path, times, values, interpolation });
        }
      } else {
        // Scale: direct copy
        tracks.push({ boneName: nodeName, boneIndex: boneIdx, path, times, values: srcValues, interpolation });
      }
    }

    if (tracks.length === 0) return null;
    return new AnimationClip({ name: animName, duration: anim.duration, tracks });
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
    // Extract and store source rest/pre-rotations for pre-baking
    const map = SkeletonAnimator.MIXAMO_TO_UE;
    const sourceRests = animations[0]?.sourceRestRotations;
    const sourcePreRots = animations[0]?.sourcePreRotations;

    const restRotMap = new Map<string, [number, number, number, number]>();
    const preRotMap = new Map<string, [number, number, number, number]>();

    if (sourcePreRots) {
      for (const [boneName, quat] of sourcePreRots) {
        let name = boneName;
        if (name.endsWith("Model")) name = name.slice(0, -5);
        const targetName = this.isMixamoSkeleton
          ? name
          : (name.startsWith("mixamorig:") ? (map[name] ?? name) : name);
        if (this.boneNameToIndex.has(targetName)) {
          preRotMap.set(targetName, quat);
        }
      }
    }
    if (sourceRests) {
      for (const [boneName, quat] of sourceRests) {
        let name = boneName;
        if (name.endsWith("Model")) name = name.slice(0, -5);
        const targetName = this.isMixamoSkeleton
          ? name
          : (name.startsWith("mixamorig:") ? (map[name] ?? name) : name);
        if (this.boneNameToIndex.has(targetName)) {
          restRotMap.set(targetName, quat);
        }
      }
    }
    if (restRotMap.size > 0) {
      this.sourceRestRotations.set(stateName, restRotMap);
    }
    if (preRotMap.size > 0) {
      this.sourcePreRotations.set(stateName, preRotMap);
    }

    // Merge all animation channels into one AnimationData, then pre-bake to AnimationClip
    const allChannels: AnimationChannel[] = [];
    let duration = 0;
    for (let i = 0; i < animations.length; i++) {
      const anim = animations[i];
      duration = Math.max(duration, anim.duration);
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        let nodeName = ch.targetNode;
        if (nodeName.endsWith("Model")) nodeName = nodeName.slice(0, -5);
        const targetName = this.isMixamoSkeleton
          ? nodeName
          : (nodeName.startsWith("mixamorig:") ? (map[nodeName] ?? nodeName) : nodeName);
        if (this.boneNameToIndex.has(targetName)) {
          allChannels.push({ ...ch, targetNode: targetName });
        }
      }
    }

    if (allChannels.length === 0) return;

    const mergedAnim: AnimationData = {
      name: stateName,
      duration,
      channels: allChannels,
    };

    const clip = this.animationDataToClip(mergedAnim, stateName);
    if (clip) {
      this.clips.set(stateName, clip);
      console.log(`[Anim] Registered: ${stateName} (${allChannels.length} channels, ${this.isMixamoSkeleton ? "direct Mixamo" : "retargeted"})`);
    }
  }

  protected setAnimationState(state: AnimState): void {
    if (state === this.currentState && this.player.isPlaying(state)) return;
    if (this.timeSinceLastStateChange < 0.5 && this.player.isPlaying()) return;
    const clip = this.clips.get(state);
    if (!clip) return;

    // Use AnimationPlayer's fade for crossfade blending
    this.player.play(state, clip, { fadeDuration: this.blendDuration });
    this.currentState = state;
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
    return this.clips.has(name);
  }

  protected tick(dt: number): void {
    if (dt > 0.1) dt = 0.1;
    this.timeSinceLastStateChange += dt;

    // AnimationPlayer handles time progression, blending, layering, and sampling
    this.player.update(dt);

    // Copy output to local arrays
    const transforms = this.player.getBoneTransforms();
    const hasActiveAnim = this.player.isPlaying();

    for (let i = 0; i < this.boneCount; i++) {
      this.localPos[i][0] = transforms.positions[i][0];
      this.localPos[i][1] = transforms.positions[i][1];
      this.localPos[i][2] = transforms.positions[i][2];
      this.localRot[i][0] = transforms.rotations[i][0];
      this.localRot[i][1] = transforms.rotations[i][1];
      this.localRot[i][2] = transforms.rotations[i][2];
      this.localRot[i][3] = transforms.rotations[i][3];
      this.localScale[i][0] = transforms.scales[i][0];
      this.localScale[i][1] = transforms.scales[i][1];
      this.localScale[i][2] = transforms.scales[i][2];
    }

    // Apply procedural idle when no animation is playing
    if (!hasActiveAnim) {
      this.applyProceduralIdle(dt);
    }

    // Apply foot IK as post-processing
    if (this.ikEnabled) {
      this.applyFootIK();
    }

    // Flatten for GPU upload
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
  getRootMotionDelta(): [number, number, number] { return this.player.getRootMotionDelta(); }
  getPlayer(): AnimationPlayer { return this.player; }
  getSkeleton(): Skeleton { return this.skeleton; }

  onAnimationEvent(type: string, handler: (event: AnimationEvent) => void): void {
    this.player.onEvent(type, handler);
  }

  offAnimationEvent(type: string, handler?: (event: AnimationEvent) => void): void {
    this.player.offEvent(type, handler);
  }

  getPendingAnimationEvents(): AnimationEvent[] {
    return this.player.getPendingEvents();
  }

  clearPendingAnimationEvents(): void {
    this.player.clearPendingEvents();
  }
}
