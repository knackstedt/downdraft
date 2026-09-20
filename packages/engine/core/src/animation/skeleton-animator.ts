// ============================================================================
// Skeleton Animator — skeletal animation with crossfade blending, retargeting,
// procedural idle, and foot IK. Generic, game-agnostic.
// Uses AnimationPlayer internally for blending (bone masks, additive, root motion).
// ============================================================================

import type { AnimationEvent } from "./animation-event";
import type { KeyframeTrack, TrackPath } from "./clip";
import { AnimationClip } from "./clip";
import { AnimationPlayer } from "./player";
import type { Bone, SkeletonData } from "./skeleton";
import { Skeleton } from "./skeleton";

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
  sourceRestTranslations?: Map<string, [number, number, number]>;
}

export interface BoneData {
  name: string;
  nodeIndex: number;
  parentIndex: number;
  inverseBindMatrix: Float32Array;
  restTranslation: [number, number, number];
  restRotation: [number, number, number, number];
  restScale: [number, number, number];
  rootAncestorMatrix?: Float32Array;
}

export interface SkinData {
  bones: BoneData[];
  boneNameToIndex: Map<string, number>;
  /** Native bone-space up axis of the rig ("z" for UE-style rigs). */
  skeletonUpAxis?: "y" | "z";
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
    rootAncestorMatrix: b.rootAncestorMatrix,
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

const IDENTITY_QUAT: readonly [number, number, number, number] = [0, 0, 0, 1];

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

function quatRotateVec(q: Float32Array | [number, number, number, number], v: [number, number, number]): [number, number, number] {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const c = 2 * (x * v[0] + y * v[1] + z * v[2]);
  const ss = w * w - (x * x + y * y + z * z);
  return [
    c * x + ss * v[0] + 2 * w * (y * v[2] - z * v[1]),
    c * y + ss * v[1] + 2 * w * (z * v[0] - x * v[2]),
    c * z + ss * v[2] + 2 * w * (x * v[1] - y * v[0]),
  ];
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

/** Extract the rotation part of a column-major 4x4 matrix as a quaternion
 *  (column lengths are normalized out, so uniform scale is tolerated). */
function quatFromMat4Rotation(m: Float32Array): Float32Array {
  let m00 = m[0], m10 = m[1], m20 = m[2];
  let m01 = m[4], m11 = m[5], m21 = m[6];
  let m02 = m[8], m12 = m[9], m22 = m[10];
  const n0 = Math.hypot(m00, m10, m20) || 1;
  const n1 = Math.hypot(m01, m11, m21) || 1;
  const n2 = Math.hypot(m02, m12, m22) || 1;
  m00 /= n0; m10 /= n0; m20 /= n0;
  m01 /= n1; m11 /= n1; m21 /= n1;
  m02 /= n2; m12 /= n2; m22 /= n2;
  const trace = m00 + m11 + m22;
  const q = new Float32Array(4);
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q[3] = s / 4; q[0] = (m21 - m12) / s; q[1] = (m02 - m20) / s; q[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q[3] = (m21 - m12) / s; q[0] = s / 4; q[1] = (m01 + m10) / s; q[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q[3] = (m02 - m20) / s; q[0] = (m01 + m10) / s; q[1] = s / 4; q[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q[3] = (m10 - m01) / s; q[0] = (m02 + m20) / s; q[1] = (m12 + m21) / s; q[2] = s / 4;
  }
  return q;
}

/** Slerp a packed quaternion keyframe channel (times, values) at time t into out. */
function sampleQuatChannel(times: Float32Array, values: Float32Array, t: number, out: Float32Array): void {
  if (times.length <= 1 || t <= times[0]) {
    out[0] = values[0]; out[1] = values[1]; out[2] = values[2]; out[3] = values[3];
    return;
  }
  const last = times.length - 1;
  if (t >= times[last]) {
    const o = last * 4;
    out[0] = values[o]; out[1] = values[o + 1]; out[2] = values[o + 2]; out[3] = values[o + 3];
    return;
  }
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  const alpha = (t - times[lo]) / (times[hi] - times[lo]);
  const a = new Float32Array([values[lo * 4], values[lo * 4 + 1], values[lo * 4 + 2], values[lo * 4 + 3]]);
  const b = new Float32Array([values[hi * 4], values[hi * 4 + 1], values[hi * 4 + 2], values[hi * 4 + 3]]);
  quatSlerp(a, b, alpha, out);
}

/** Swap a quaternion from Y-up (Mixamo/FBX source space) to Z-up (engine
 *  target space): (x, y, z, w) → (x, -z, y, w). Matches the position map
 *  (x, y, z) → (x, -z, y). */
function quatYupToZup(q: Float32Array, out: Float32Array): void {
  out[0] = q[0]; out[1] = -q[2]; out[2] = q[1]; out[3] = q[3];
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
  // Rotation of the non-bone intermediate transform each bone hangs under
  // (rootAncestorMatrix). Identity for bones directly under their bone parent.
  private intermediateRot: Float32Array[];
  // Full non-bone intermediate matrix (translation included) — needed to FK
  // bind world positions for retargeting frame alignment.
  private intermediateMat: (Float32Array | null)[];

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
  private sourceRestTranslations: Map<string, Map<string, [number, number, number]>> = new Map();

  private ikEnabled = true;
  private leftFootTarget: Float32Array | null = null;
  private rightFootTarget: Float32Array | null = null;
  private boneNameToIndex: Map<string, number>;
  private boneNames: string[] = [];

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
  /** True when the target skeleton's native bone space is Z-up (e.g. UE-style
   *  rigs like Aisha). Mixamo clips are Y-up, so world deltas and rest-pose
   *  direction alignment must be axis-swapped for Z-up targets but passed
   *  through unchanged for natively Y-up rigs (e.g. Humanling). Defaults to
   *  true for rigs loaded before SkinData.skeletonUpAxis existed. */
  private targetZUp = true;

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
    this.intermediateRot = [];
    this.intermediateMat = [];
    this.worldMatrices = [];

    for (let i = 0; i < this.boneCount; i++) {
      const bone = skin.bones[i];
      this.parentIndices[i] = bone.parentIndex;
      this.boneNames[i] = bone.name;

      const ibm = new Float32Array(16);
      ibm.set(bone.inverseBindMatrix);
      this.inverseBindMatrices.push(ibm);

      const rp = new Float32Array(bone.restTranslation);
      const rr = new Float32Array(bone.restRotation);
      const rs = new Float32Array(bone.restScale);
      this.restPos.push(rp);
      this.restRot.push(rr);
      this.restScale.push(rs);
      this.intermediateRot.push(
        bone.rootAncestorMatrix ? quatFromMat4Rotation(bone.rootAncestorMatrix) : new Float32Array(IDENTITY_QUAT),
      );
      this.intermediateMat.push(bone.rootAncestorMatrix ? new Float32Array(bone.rootAncestorMatrix) : null);

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

    this.targetZUp = skin.skeletonUpAxis !== "y";
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

  /**
   * Register a pre-built AnimationClip directly (bypassing the
   * AnimationData→retargeting pipeline). Use this for procedural clips
   * authored directly in the skeleton's local space, or clips loaded from
   * glTF that are already in the correct coordinate space.
   */
  registerClip(name: string, clip: AnimationClip): void {
    this.clips.set(name, clip);
  }

  private animationDataToClip(anim: AnimationData, animName: string): AnimationClip | null {
    const tracks: KeyframeTrack[] = [];
    // Keyed by SOURCE node name; falls back to the AnimationData's own maps
    // when the caller didn't go through registerRetargetedAnimations.
    const preRotMap = this.sourcePreRotations.get(animName) ?? anim.sourcePreRotations;
    const restRotMap = this.sourceRestRotations.get(animName) ?? anim.sourceRestRotations;

    if (!this.isMixamoSkeleton) {
      // Per-frame world-space retargeting for non-Mixamo skeletons.
      //
      // mixamorig:* channels are evaluated as world rotations on the SOURCE
      // (Mixamo) hierarchy — the target hierarchy may differ (e.g. the target
      // can skip intermediate bones like spine_02). Each source world delta is
      // then applied to the target's bind world rotation, and the target local
      // is solved against the target's own (possibly animated) parent chain:
      //
      //   srcDelta(t)      = srcWorld(t) * inv(srcRestWorld)     [Y-up space]
      //   desiredWorld(t)  = axisSwap(srcDelta(t)) * tgtBindWorld
      //   local(t)         = inv(intermediate) * inv(parentWorld(t)) * desiredWorld(t)
      //
      // where parentWorld(t) is the target parent's animated world rotation,
      // which keeps parent and child deltas from double-applying.
      //
      // Non-Mixamo channels are applied directly as locals (same-rig clips).

      // Retargeted tracks are baked to plain keyframes — never emit
      // "cubicspline" (that layout expects tangent triplets).
      const toInterp = (s: string): "linear" | "step" =>
        s === "STEP" ? "step" : "linear";

      // Partition channels.
      interface SrcRotChannel {
        times: Float32Array;
        values: Float32Array;
        boneIdx: number | undefined;
        interpolation: string;
      }
      const srcRotChannels = new Map<string, SrcRotChannel>();
      const directChannels: AnimationChannel[] = [];
      let hipsPosChannel: AnimationChannel | null = null;
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        if (ch.targetNode.startsWith("mixamorig:")) {
          if (ch.path === "rotation") {
            const tgtName = SkeletonAnimator.MIXAMO_TO_UE[ch.targetNode] ?? ch.targetNode;
            srcRotChannels.set(ch.targetNode, {
              times: ch.keyframeTimes,
              values: ch.keyframeValues,
              boneIdx: this.boneNameToIndex.get(tgtName),
              interpolation: ch.interpolation,
            });
          } else if (ch.path === "translation" && ch.targetNode === "mixamorig:Hips") {
            hipsPosChannel = ch;
          }
          // Mixamo scale channels are dropped — bone proportions differ across rigs.
        } else {
          directChannels.push(ch);
        }
      }

      // ── Source (Mixamo) world-rotation evaluator ──
      const srcLocalAt = (name: string, t: number, out: Float32Array): void => {
        const ch = srcRotChannels.get(name);
        if (ch) {
          const q = new Float32Array(4);
          sampleQuatChannel(ch.times, ch.values, t, q);
          const pre = preRotMap?.get(name);
          if (pre) {
            quatMul(new Float32Array(pre), q, out);
          } else {
            out.set(q);
          }
        } else {
          out.set(restRotMap?.get(name) ?? IDENTITY_QUAT);
        }
      };
      const srcWorldMemo = new Map<string, Map<number, Float32Array>>();
      const srcWorld = (name: string, t: number): Float32Array => {
        let memo = srcWorldMemo.get(name);
        if (!memo) { memo = new Map(); srcWorldMemo.set(name, memo); }
        const hit = memo.get(t);
        if (hit) return hit;
        const local = new Float32Array(4);
        srcLocalAt(name, t, local);
        const parent = SkeletonAnimator.MIXAMO_PARENT[name];
        const world = new Float32Array(4);
        if (parent) {
          quatMul(srcWorld(parent, t), local, world);
        } else {
          world.set(local);
        }
        memo.set(t, world);
        return world;
      };

      // ── Target bind world rotations (including non-bone intermediates) ──
      const ID = new Float32Array([0, 0, 0, 1]);
      const tgtBindWorld: Float32Array[] = [];
      for (let i = 0; i < this.boneCount; i++) {
        const parentIdx = this.parentIndices[i];
        const pw = parentIdx >= 0 ? tgtBindWorld[parentIdx] : ID;
        const tmp = new Float32Array(4);
        const w = new Float32Array(4);
        quatMul(pw, this.intermediateRot[i], tmp);
        quatMul(tmp, this.restRot[i], w);
        tgtBindWorld.push(w);
      }

      // ── Source REST world rotations (Mixamo bind pose) ──
      // The retarget delta must be measured against the source's rest pose,
      // NOT the clip's first keyframe: locomotion clips start mid-stride, so
      // a frame-0 reference would map that mid-stride pose onto the target's
      // bind pose and shift every other frame by that offset (which shows up
      // as e.g. knees hyperextending backwards).
      const srcRestWorldMemo = new Map<string, Float32Array>();
      const srcRestWorld = (name: string): Float32Array => {
        const hit = srcRestWorldMemo.get(name);
        if (hit) return hit;
        const w = new Float32Array(4);
        w.set(restRotMap?.get(name) ?? IDENTITY_QUAT);
        const parent = SkeletonAnimator.MIXAMO_PARENT[name];
        if (parent) {
          const out = new Float32Array(4);
          quatMul(srcRestWorld(parent), w, out);
          w.set(out);
        }
        srcRestWorldMemo.set(name, w);
        return w;
      };

      // ── Rest-pose direction data ──
      // Source rest (Mixamo T-pose) and target bind poses differ (e.g. A-pose
      // arms). Bone rest directions are needed to align the two rest poses;
      // they come from joint-to-child-joint vectors, so source rest
      // translations and target bind positions are FK'd here.
      const restTransMap = this.sourceRestTranslations.get(animName) ?? anim.sourceRestTranslations;

      // Source rest world POSITIONS via the Mixamo chain.
      const srcRestPosMemo = new Map<string, [number, number, number]>();
      const srcRestPos = (name: string): [number, number, number] => {
        const hit = srcRestPosMemo.get(name);
        if (hit) return hit;
        const lt = restTransMap?.get(name) ?? [0, 0, 0];
        const parent = SkeletonAnimator.MIXAMO_PARENT[name];
        let pos: [number, number, number];
        if (parent) {
          const pp = srcRestPos(parent);
          const pr = srcRestWorld(parent);
          const r = quatRotateVec(pr, lt);
          pos = [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]];
        } else {
          pos = [lt[0], lt[1], lt[2]];
        }
        srcRestPosMemo.set(name, pos);
        return pos;
      };

      // Source "tip" child per node (defines the bone's rest direction).
      const srcChildren = new Map<string, string[]>();
      for (const [child, parent] of Object.entries(SkeletonAnimator.MIXAMO_PARENT)) {
        if (!parent) continue;
        let list = srcChildren.get(parent);
        if (!list) { list = []; srcChildren.set(parent, list); }
        list.push(child);
      }
      const srcTip = (name: string): string | null => {
        const kids = srcChildren.get(name);
        if (!kids || kids.length === 0) return null;
        // Prefer the axial continuation (spine/neck/head, middle finger, toe).
        const preferred = kids.find((k) =>
          /Spine|Neck|HeadTop|Middle1|Toe_End/.test(k));
        return preferred ?? kids[0];
      };

      // Target bind world positions via matrix FK (includes non-bone
      // intermediate transforms in full, translation included).
      const tgtBindWPos: [number, number, number][] = [];
      {
        const worldMats: Float32Array[] = [];
        const localMat = new Float32Array(16);
        const tmp = new Float32Array(16);
        for (let i = 0; i < this.boneCount; i++) {
          buildLocalMatrix(this.restPos[i], this.restRot[i], this.restScale[i], localMat);
          const im = this.intermediateMat[i];
          let lm = localMat;
          if (im) { mat4Mul(im, localMat, tmp); lm = new Float32Array(tmp); }
          const pi = this.parentIndices[i];
          const wm = new Float32Array(16);
          if (pi >= 0 && worldMats[pi]) mat4Mul(worldMats[pi], lm, wm);
          else wm.set(lm);
          worldMats[i] = wm;
          tgtBindWPos.push([wm[12], wm[13], wm[14]]);
        }
      }

      // Target "tip" child per bone index (first bone child; prefer the
      // axial continuation for spine/hand/foot chains).
      const tgtChildren = new Map<number, number[]>();
      for (let i = 0; i < this.boneCount; i++) {
        const p = this.parentIndices[i];
        if (p < 0) continue;
        let list = tgtChildren.get(p);
        if (!list) { list = []; tgtChildren.set(p, list); }
        list.push(i);
      }
      const tgtTip = (i: number): number | null => {
        const kids = tgtChildren.get(i);
        if (!kids || kids.length === 0) return null;
        const preferred = kids.find((k) =>
          /spine|neck|head|middle_01|ball/.test(this.boneNames[k]));
        return preferred ?? kids[0];
      };

      // Per-bone rest-direction alignment. The source (Mixamo T-pose) and
      // target (e.g. A-pose) rest poses differ; measuring the animation delta
      // against the raw source rest double-counts that difference (an A-pose
      // arm receiving a "drop arm from T-pose" delta overshoots and crosses
      // the chest). Instead, pre-rotate the source rest reference by R — the
      // shortest-arc rotation taking the source bone's rest direction onto
      // the target bone's bind direction (expressed in source space). With
      // srcRest' = R·srcRest:
      //
      //   desiredWorld(t) = axisSwap(srcW(t) · srcRest'⁻¹) · tgtBindWorld
      //
      // which makes the target bone's world direction exactly
      // axisSwap(sourceBoneDirection(t)) at every frame, while twist about
      // the bone axis still transfers through the delta. When the rest
      // directions already match (e.g. legs), R ≈ identity and this reduces
      // to the plain rest-pose delta.
      const dirAlignMemo = new Map<number, Float32Array | null>();
      // UE target name → mixamorig source name, for leaf-bone alignment
      // inheritance (reverse of MIXAMO_TO_UE).
      const ueToSrc = new Map<string, string>();
      for (const [s, t] of Object.entries(SkeletonAnimator.MIXAMO_TO_UE)) ueToSrc.set(t, s);
      const srcDirAlign = (srcName: string, boneIdx: number): Float32Array | null => {
        let r = dirAlignMemo.get(boneIdx);
        if (r !== undefined) return r;
        r = null;
        const sTip = restTransMap ? srcTip(srcName) : null;
        const tTip = tgtTip(boneIdx);
        if (sTip && tTip !== null) {
          const a = srcRestPos(srcName), b = srcRestPos(sTip);
          const ds = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const ls = Math.hypot(ds[0], ds[1], ds[2]);
          const c = tgtBindWPos[boneIdx], d = tgtBindWPos[tTip];
          const dt = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
          const lt = Math.hypot(dt[0], dt[1], dt[2]);
          if (ls > 1e-4 && lt > 1e-4) {
            const from = [ds[0] / ls, ds[1] / ls, ds[2] / ls];
            // Target bind dir → source Y-up space. Z-up targets need
            // (x,y,z) → (x,z,-y); Y-up targets are already in source space.
            const to = this.targetZUp
              ? [dt[0] / lt, dt[2] / lt, -dt[1] / lt]
              : [dt[0] / lt, dt[1] / lt, dt[2] / lt];
            const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
            if (dot < 0.999999) {
              let ax: number, ay: number, az: number;
              if (dot < -0.999999) {
                // Antiparallel: pick any perpendicular axis.
                const px = Math.abs(from[0]) < 0.9 ? 1 : 0;
                const pxv = px ? [1, 0, 0] : [0, 1, 0];
                ax = from[1] * pxv[2] - from[2] * pxv[1];
                ay = from[2] * pxv[0] - from[0] * pxv[2];
                az = from[0] * pxv[1] - from[1] * pxv[0];
                const al = Math.hypot(ax, ay, az) || 1;
                r = new Float32Array([ax / al, ay / al, az / al, 0]);
              } else {
                ax = from[1] * to[2] - from[2] * to[1];
                ay = from[2] * to[0] - from[0] * to[2];
                az = from[0] * to[1] - from[1] * to[0];
                const al = Math.hypot(ax, ay, az, 1 + dot) || 1;
                r = new Float32Array([ax / al, ay / al, az / al, (1 + dot) / al]);
              }
            }
          }
        } else {
          // Leaf bone — no tip child to define a bone direction, so no R can
          // be computed. Without one, the raw source delta carries the
          // accumulated rest-pose mismatch of every ancestor in the chain
          // (e.g. Mixamo finger tips deviating ~120° from the target bind).
          // Inherit the parent's alignment so the leaf rides the corrected
          // frame and stays at its bind local when the source is at rest.
          const pIdx = this.parentIndices[boneIdx];
          if (pIdx >= 0) {
            const pSrc = ueToSrc.get(this.boneNames[pIdx]);
            if (pSrc) r = srcDirAlign(pSrc, pIdx);
          }
        }
        dirAlignMemo.set(boneIdx, r);
        return r;
      };

      // ── Desired world rotations per channeled target bone ──
      interface BoneChannel {
        srcName: string;
        times: Float32Array;
        desired: Float32Array;
        interpolation: string;
      }
      const boneChannels = new Map<number, BoneChannel>();

      const emitDesired = (srcName: string, boneIdx: number, times: Float32Array, interpolation: string): void => {
        const desired = new Float32Array(times.length * 4);
        // srcRest' = R·srcRestW where R aligns the source rest bone direction
        // with the target bind direction. inv(srcRest') = inv(srcRestW)·inv(R).
        const srcRestW = srcRestWorld(srcName);
        const invSrcW = new Float32Array(4);
        quatInvert(srcRestW, invSrcW);
        const align = srcDirAlign(srcName, boneIdx);
        const invSrcRef = new Float32Array(4);
        if (align) {
          const invR = new Float32Array(4);
          quatInvert(align, invR);
          quatMul(invSrcW, invR, invSrcRef);
        } else {
          invSrcRef.set(invSrcW);
        }
        const tgtRef = tgtBindWorld[boneIdx];
        const tmpA = new Float32Array(4);
        const tmpB = new Float32Array(4);
        let prev: Float32Array | null = null;
        for (let k = 0; k < times.length; k++) {
          quatMul(srcWorld(srcName, times[k]), invSrcRef, tmpA); // source deviation from reference frame
          if (this.targetZUp) quatYupToZup(tmpA, tmpB); else tmpB.set(tmpA);
          const w = new Float32Array(4);
          quatMul(tmpB, tgtRef, w);
          if (prev && w[0] * prev[0] + w[1] * prev[1] + w[2] * prev[2] + w[3] * prev[3] < 0) {
            w[0] = -w[0]; w[1] = -w[1]; w[2] = -w[2]; w[3] = -w[3];
          }
          prev = w;
          desired.set(w, k * 4);
        }
        boneChannels.set(boneIdx, { srcName, times, desired, interpolation });
      };

      for (const [srcName, ch] of srcRotChannels) {
        if (ch.boneIdx === undefined) continue;
        emitDesired(srcName, ch.boneIdx, ch.times, ch.interpolation);
      }

      // A mapped target bone whose SOURCE node has no channel still needs a
      // track when an ancestor in the source chain is animated (e.g.
      // mixamorig:Spine2 → spine_03 when only mixamorig:Spine1 is keyed).
      const hasChanneledAncestor = (srcName: string): boolean => {
        let p = SkeletonAnimator.MIXAMO_PARENT[srcName];
        while (p) {
          if (srcRotChannels.has(p)) return true;
          p = SkeletonAnimator.MIXAMO_PARENT[p];
        }
        return false;
      };
      let unionTimes: Float32Array | null = null;
      for (const [srcName, tgtName] of Object.entries(SkeletonAnimator.MIXAMO_TO_UE)) {
        if (srcRotChannels.has(srcName)) continue;
        const boneIdx = this.boneNameToIndex.get(tgtName);
        if (boneIdx === undefined || !hasChanneledAncestor(srcName)) continue;
        if (!unionTimes) {
          const set = new Set<number>();
          for (const ch of srcRotChannels.values()) for (const t of ch.times) set.add(t);
          unionTimes = new Float32Array([...set].sort((a, b) => a - b));
        }
        emitDesired(srcName, boneIdx, unionTimes, "LINEAR");
      }

      // ── Target animated world sampler (channels → desired; else bind-local) ──
      const tgtWorldMemo = new Map<number, Map<number, Float32Array>>();
      const tgtWorldAnim = (i: number, t: number): Float32Array => {
        const ch = boneChannels.get(i);
        if (ch) {
          const out = new Float32Array(4);
          sampleQuatChannel(ch.times, ch.desired, t, out);
          return out;
        }
        let memo = tgtWorldMemo.get(i);
        if (!memo) { memo = new Map(); tgtWorldMemo.set(i, memo); }
        const hit = memo.get(t);
        if (hit) return hit;
        const parentIdx = this.parentIndices[i];
        const pw = parentIdx >= 0 ? tgtWorldAnim(parentIdx, t) : ID;
        const tmp = new Float32Array(4);
        const w = new Float32Array(4);
        quatMul(pw, this.intermediateRot[i], tmp);
        quatMul(tmp, this.restRot[i], w);
        memo.set(t, w);
        return w;
      };

      // ── Emit local rotation tracks ──
      for (const [i, ch] of boneChannels) {
        const times = ch.times;
        const values = new Float32Array(times.length * 4);
        const parentIdx = this.parentIndices[i];
        const invIntermediate = new Float32Array(4);
        quatInvert(this.intermediateRot[i], invIntermediate);
        const tmpA = new Float32Array(4);
        const tmpB = new Float32Array(4);
        let prev: Float32Array | null = null;
        for (let k = 0; k < times.length; k++) {
          const pw = parentIdx >= 0 ? tgtWorldAnim(parentIdx, times[k]) : ID;
          const o = k * 4;
          const desired = new Float32Array([ch.desired[o], ch.desired[o + 1], ch.desired[o + 2], ch.desired[o + 3]]);
          quatInvert(pw, tmpA);
          quatMul(tmpA, desired, tmpB);
          const local = new Float32Array(4);
          quatMul(invIntermediate, tmpB, local);
          if (prev && local[0] * prev[0] + local[1] * prev[1] + local[2] * prev[2] + local[3] * prev[3] < 0) {
            local[0] = -local[0]; local[1] = -local[1]; local[2] = -local[2]; local[3] = -local[3];
          }
          prev = local;
          values.set(local, o);
        }
        tracks.push({
          boneName: this.boneNames[i],
          boneIndex: i,
          path: "rotation" as TrackPath,
          times,
          values,
          interpolation: toInterp(ch.interpolation),
        });
      }

      // ── Hips translation → pelvis position track ──
      // Applied as a scaled delta around the target's rest position. Forward
      // motion is stripped (root motion is gameplay-driven); lateral sway and
      // vertical bob are preserved.
      const pelvisIdx = this.boneNameToIndex.get("pelvis");
      if (hipsPosChannel && pelvisIdx !== undefined) {
        const times = hipsPosChannel.keyframeTimes;
        const v = hipsPosChannel.keyframeValues;
        const rest = this.restPos[pelvisIdx];
        // The pelvis' vertical rest component — Z for Z-up rigs, Y for Y-up.
        const upAxis = this.targetZUp ? 2 : 1;
        const srcY0 = v[1];
        const scale = Math.abs(srcY0) > 1e-3 ? Math.abs(rest[upAxis]) / Math.abs(srcY0) : 0.01;
        const values = new Float32Array(times.length * 3);
        for (let k = 0; k < times.length; k++) {
          const dx = (v[k * 3] - v[0]) * scale;
          const dy = (v[k * 3 + 1] - v[1]) * scale;
          values[k * 3] = rest[0] + dx;
          values[k * 3 + 1] = rest[1] + (this.targetZUp ? 0 : dy);
          values[k * 3 + 2] = rest[2] + (this.targetZUp ? dy : 0);
        }
        tracks.push({
          boneName: this.boneNames[pelvisIdx],
          boneIndex: pelvisIdx,
          path: "position" as TrackPath,
          times,
          values,
          interpolation: toInterp(hipsPosChannel.interpolation),
        });
      }

      // ── Non-Mixamo channels: applied directly as local-space tracks ──
      for (let c = 0; c < directChannels.length; c++) {
        const ch = directChannels[c];
        const boneIdx = this.boneNameToIndex.get(ch.targetNode);
        if (boneIdx === undefined) continue;
        const path: TrackPath = ch.path === "translation" ? "position" : ch.path === "rotation" ? "rotation" : "scale";
        const interp = toInterp(ch.interpolation);
        const times = ch.keyframeTimes;
        const srcValues = ch.keyframeValues;
        if (path === "rotation") {
          const values = new Float32Array(srcValues.length);
          const srcPreRot = preRotMap?.get(ch.targetNode);
          for (let k = 0; k < times.length; k++) {
            const v0 = k * 4;
            const q = new Float32Array([srcValues[v0], srcValues[v0 + 1], srcValues[v0 + 2], srcValues[v0 + 3]]);
            if (srcPreRot) {
              const result = new Float32Array(4);
              quatMul(new Float32Array(srcPreRot), q, result);
              values[v0] = result[0]; values[v0 + 1] = result[1]; values[v0 + 2] = result[2]; values[v0 + 3] = result[3];
            } else {
              values[v0] = q[0]; values[v0 + 1] = q[1]; values[v0 + 2] = q[2]; values[v0 + 3] = q[3];
            }
          }
          tracks.push({ boneName: ch.targetNode, boneIndex: boneIdx, path, times, values, interpolation: interp });
        } else {
          tracks.push({ boneName: ch.targetNode, boneIndex: boneIdx, path, times, values: srcValues, interpolation: interp });
        }
      }
    } else {
      // Mixamo skeleton: simple pre-rotation application
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        const nodeName = ch.targetNode;
        const boneIdx = this.boneNameToIndex.get(nodeName);
        if (boneIdx === undefined) continue;
        const path: TrackPath = ch.path === "translation" ? "position" : ch.path === "rotation" ? "rotation" : "scale";
        const interp: "linear" | "step" | "cubicspline" = ch.interpolation === "LINEAR" ? "linear" : ch.interpolation === "STEP" ? "step" : "cubicspline";
        const times = ch.keyframeTimes;
        const srcValues = ch.keyframeValues;

        if (path === "rotation") {
          const values = new Float32Array(srcValues.length);
          const srcPreRot = preRotMap?.get(nodeName);
          for (let k = 0; k < times.length; k++) {
            const v0 = k * 4;
            const q = new Float32Array([srcValues[v0], srcValues[v0+1], srcValues[v0+2], srcValues[v0+3]]);
            if (srcPreRot) {
              const result = new Float32Array(4);
              quatMul(new Float32Array(srcPreRot), q, result);
              values[v0] = result[0]; values[v0+1] = result[1]; values[v0+2] = result[2]; values[v0+3] = result[3];
            } else {
              values[v0] = q[0]; values[v0+1] = q[1]; values[v0+2] = q[2]; values[v0+3] = q[3];
            }
          }
          tracks.push({ boneName: nodeName, boneIndex: boneIdx, path, times, values, interpolation: interp });
        } else {
          tracks.push({ boneName: nodeName, boneIndex: boneIdx, path, times, values: srcValues, interpolation: interp });
        }
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
    "mixamorig:Head": "head",
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

  /** Parent of each bone in the standard Mixamo rig. Used to evaluate source
   *  world rotations when retargeting mixamorig:* clips onto non-Mixamo
   *  skeletons — the source hierarchy is independent of the target's. */
  private static MIXAMO_PARENT: Record<string, string | null> = {
    "mixamorig:Hips": null,
    "mixamorig:Spine": "mixamorig:Hips",
    "mixamorig:Spine1": "mixamorig:Spine",
    "mixamorig:Spine2": "mixamorig:Spine1",
    "mixamorig:Neck": "mixamorig:Spine2",
    "mixamorig:Head": "mixamorig:Neck",
    "mixamorig:HeadTop_End": "mixamorig:Head",
    "mixamorig:LeftShoulder": "mixamorig:Spine2",
    "mixamorig:LeftArm": "mixamorig:LeftShoulder",
    "mixamorig:LeftForeArm": "mixamorig:LeftArm",
    "mixamorig:LeftHand": "mixamorig:LeftForeArm",
    "mixamorig:RightShoulder": "mixamorig:Spine2",
    "mixamorig:RightArm": "mixamorig:RightShoulder",
    "mixamorig:RightForeArm": "mixamorig:RightArm",
    "mixamorig:RightHand": "mixamorig:RightForeArm",
    "mixamorig:LeftUpLeg": "mixamorig:Hips",
    "mixamorig:LeftLeg": "mixamorig:LeftUpLeg",
    "mixamorig:LeftFoot": "mixamorig:LeftLeg",
    "mixamorig:LeftToeBase": "mixamorig:LeftFoot",
    "mixamorig:LeftToe_End": "mixamorig:LeftToeBase",
    "mixamorig:RightUpLeg": "mixamorig:Hips",
    "mixamorig:RightLeg": "mixamorig:RightUpLeg",
    "mixamorig:RightFoot": "mixamorig:RightLeg",
    "mixamorig:RightToeBase": "mixamorig:RightFoot",
    "mixamorig:RightToe_End": "mixamorig:RightToeBase",
    "mixamorig:LeftHandThumb1": "mixamorig:LeftHand",
    "mixamorig:LeftHandThumb2": "mixamorig:LeftHandThumb1",
    "mixamorig:LeftHandThumb3": "mixamorig:LeftHandThumb2",
    "mixamorig:LeftHandThumb4": "mixamorig:LeftHandThumb3",
    "mixamorig:LeftHandIndex1": "mixamorig:LeftHand",
    "mixamorig:LeftHandIndex2": "mixamorig:LeftHandIndex1",
    "mixamorig:LeftHandIndex3": "mixamorig:LeftHandIndex2",
    "mixamorig:LeftHandIndex4": "mixamorig:LeftHandIndex3",
    "mixamorig:LeftHandMiddle1": "mixamorig:LeftHand",
    "mixamorig:LeftHandMiddle2": "mixamorig:LeftHandMiddle1",
    "mixamorig:LeftHandMiddle3": "mixamorig:LeftHandMiddle2",
    "mixamorig:LeftHandMiddle4": "mixamorig:LeftHandMiddle3",
    "mixamorig:LeftHandRing1": "mixamorig:LeftHand",
    "mixamorig:LeftHandRing2": "mixamorig:LeftHandRing1",
    "mixamorig:LeftHandRing3": "mixamorig:LeftHandRing2",
    "mixamorig:LeftHandRing4": "mixamorig:LeftHandRing3",
    "mixamorig:LeftHandPinky1": "mixamorig:LeftHand",
    "mixamorig:LeftHandPinky2": "mixamorig:LeftHandPinky1",
    "mixamorig:LeftHandPinky3": "mixamorig:LeftHandPinky2",
    "mixamorig:LeftHandPinky4": "mixamorig:LeftHandPinky3",
    "mixamorig:RightHandThumb1": "mixamorig:RightHand",
    "mixamorig:RightHandThumb2": "mixamorig:RightHandThumb1",
    "mixamorig:RightHandThumb3": "mixamorig:RightHandThumb2",
    "mixamorig:RightHandThumb4": "mixamorig:RightHandThumb3",
    "mixamorig:RightHandIndex1": "mixamorig:RightHand",
    "mixamorig:RightHandIndex2": "mixamorig:RightHandIndex1",
    "mixamorig:RightHandIndex3": "mixamorig:RightHandIndex2",
    "mixamorig:RightHandIndex4": "mixamorig:RightHandIndex3",
    "mixamorig:RightHandMiddle1": "mixamorig:RightHand",
    "mixamorig:RightHandMiddle2": "mixamorig:RightHandMiddle1",
    "mixamorig:RightHandMiddle3": "mixamorig:RightHandMiddle2",
    "mixamorig:RightHandMiddle4": "mixamorig:RightHandMiddle3",
    "mixamorig:RightHandRing1": "mixamorig:RightHand",
    "mixamorig:RightHandRing2": "mixamorig:RightHandRing1",
    "mixamorig:RightHandRing3": "mixamorig:RightHandRing2",
    "mixamorig:RightHandRing4": "mixamorig:RightHandRing3",
    "mixamorig:RightHandPinky1": "mixamorig:RightHand",
    "mixamorig:RightHandPinky2": "mixamorig:RightHandPinky1",
    "mixamorig:RightHandPinky3": "mixamorig:RightHandPinky2",
    "mixamorig:RightHandPinky4": "mixamorig:RightHandPinky3",
  };

  registerRetargetedAnimations(animations: AnimationData[], stateName: string): void {
    // Extract and store source rest/pre-rotations for pre-baking
    const sourceRests = animations[0]?.sourceRestRotations;
    const sourcePreRots = animations[0]?.sourcePreRotations;
    const sourceTrans = animations[0]?.sourceRestTranslations;

    const restRotMap = new Map<string, [number, number, number, number]>();
    const preRotMap = new Map<string, [number, number, number, number]>();

    // Keys are SOURCE node names — for Mixamo sources the full map is kept
    // (including bones with no target counterpart, since they still
    // participate in the source world-rotation chain).
    if (sourcePreRots) {
      for (const [boneName, quat] of sourcePreRots) {
        preRotMap.set(boneName, quat);
      }
    }
    if (sourceRests) {
      for (const [boneName, quat] of sourceRests) {
        restRotMap.set(boneName, quat);
      }
    }
    if (restRotMap.size > 0) {
      this.sourceRestRotations.set(stateName, restRotMap);
    }
    if (preRotMap.size > 0) {
      this.sourcePreRotations.set(stateName, preRotMap);
    }
    if (sourceTrans && sourceTrans.size > 0) {
      this.sourceRestTranslations.set(stateName, new Map(sourceTrans));
    }

    // Merge all animation channels into one AnimationData, then pre-bake to AnimationClip
    const allChannels: AnimationChannel[] = [];
    let duration = 0;
    for (let i = 0; i < animations.length; i++) {
      const anim = animations[i];
      duration = Math.max(duration, anim.duration);
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        const nodeName = ch.targetNode;
        if (this.isMixamoSkeleton) {
          if (this.boneNameToIndex.has(nodeName)) allChannels.push(ch);
          continue;
        }
        // Non-Mixamo skeleton: keep mixamorig:* channels under their SOURCE
        // names (resolved by world-space retargeting, including unmapped bones
        // needed for the source chain); keep same-name channels that hit a bone.
        if (nodeName.startsWith("mixamorig:") || this.boneNameToIndex.has(nodeName)) {
          allChannels.push(ch);
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
      console.log(`[Anim] Registered: ${stateName} (${allChannels.length} channels, ${this.isMixamoSkeleton ? "direct Mixamo" : "retargeted-v2"})`);
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

  /**
   * Advance the animation clock without changing state — for callers that
   * hold a SkeletonAnimator by composition (e.g. CharacterAnimator/Preview)
   * rather than subclassing it.
   */
  advance(dt: number): void {
    this.tick(dt);
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
