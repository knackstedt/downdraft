// ============================================================================
// Animation helper — builds a Skeleton + AnimationClips from a loaded model's
// SkinData/AnimationData, and samples the active animation into skin matrices
// each frame for the ModelRenderer.
//
// The FBX parser stores rotation channels as the bone's Lcl Rotation (Euler →
// quaternion), with PreRotation captured separately in
// `AnimationData.sourcePreRotations`. The full local rotation is
// `preRot * lclRot`, so we bake the pre-rotation into each rotation keyframe
// when building clips (mirroring the SkeletonAnimator's Mixamo-direct path).
// The skin's rest rotations already include PreRotation (parseFBXNodes bakes
// `preRot * lclRot` into node.rotation), so the bind-pose skin matrices are
// ~identity and the model renders correctly with no animation selected.
// ============================================================================

import type { KeyframeTrack } from "@downdraft/core";
import {
    AnimationClip,
    Skeleton,
    eulerXYZToQuat,
    invertMat4,
    multiplyMat4Into,
    quatMul,
    skinDataToSkeletonData,
    type Quat
} from "@downdraft/core";
import type { AnimationData, SkinData } from "@downdraft/library-models";

/** Normalize a bone/channel name. The FBX parser now strips the "Model" suffix,
 * so this is a passthrough — kept for API compatibility. */
function normalizeName(name: string): string {
  return name;
}

/**
 * Build an AnimationClip from a parsed AnimationData, mapping channels to bone
 * indices via the skin's boneNameToIndex and baking PreRotation into rotation
 * keyframes. Returns null if no channels map to bones in this skeleton.
 */
export function buildClip(
  anim: AnimationData,
  boneNameToIndex: Map<string, number>,
): AnimationClip | null {
  const preRotations = anim.sourcePreRotations;
  const tracks: import("@downdraft/core").KeyframeTrack[] = [];

  for (let c = 0; c < anim.channels.length; c++) {
    const ch = anim.channels[c];
    const normName = normalizeName(ch.targetNode);

    // Resolve bone index: try normalized name first, then the raw name.
    let boneIdx = boneNameToIndex.get(normName);
    if (boneIdx === undefined) boneIdx = boneNameToIndex.get(ch.targetNode);
    if (boneIdx === undefined) continue;

    const path =
      ch.path === "translation" ? "position" :
      ch.path === "rotation" ? "rotation" : "scale";
    const interpolation =
      ch.interpolation === "LINEAR" ? "linear" :
      ch.interpolation === "STEP" ? "step" : "cubicspline";

    let values = ch.keyframeValues;

    // Bake PreRotation into rotation keyframes: finalRot = preRot * lclRot.
    if (path === "rotation" && preRotations) {
      let preRot = preRotations.get(normName);
      if (preRot === undefined) preRot = preRotations.get(ch.targetNode);
      if (preRot) {
        const baked = new Float32Array(ch.keyframeValues.length);
        const preRotQuat: Quat = { x: preRot[0], y: preRot[1], z: preRot[2], w: preRot[3] };
        for (let k = 0; k < ch.keyframeTimes.length; k++) {
          const v0 = k * 4;
          const lcl: Quat = {
            x: ch.keyframeValues[v0],
            y: ch.keyframeValues[v0 + 1],
            z: ch.keyframeValues[v0 + 2],
            w: ch.keyframeValues[v0 + 3],
          };
          const full = quatMul(preRotQuat, lcl);
          baked[v0] = full.x;
          baked[v0 + 1] = full.y;
          baked[v0 + 2] = full.z;
          baked[v0 + 3] = full.w;
        }
        values = baked;
      }
    }

    tracks.push({
      boneName: normName,
      boneIndex: boneIdx,
      path,
      times: ch.keyframeTimes,
      values,
      interpolation,
    });
  }

  if (tracks.length === 0) return null;
  return new AnimationClip({ name: anim.name, duration: anim.duration, tracks });
}

interface BoneTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

// ── Procedural clips ──
// The shipped character FBX files are rig-only (no embedded animations), so we
// generate a few demo clips that exercise the skeleton. They target the common
// bone-name conventions used by these rigs (UE-style: pelvis, spine_01, head,
// upperarm_r, …) and only emit tracks for bones that actually exist, so they
// work across different rigs and degrade gracefully on partial skeletons.

/** Build a rotation keyframe track for one bone over the given times. */
function rotTrack(
  boneName: string,
  boneIndex: number,
  times: number[],
  eulers: [number, number, number][],
): KeyframeTrack {
  const values = new Float32Array(times.length * 4);
  for (let i = 0; i < times.length; i++) {
    const q = eulerXYZToQuat(eulers[i][0], eulers[i][1], eulers[i][2]);
    values[i * 4] = q.x;
    values[i * 4 + 1] = q.y;
    values[i * 4 + 2] = q.z;
    values[i * 4 + 3] = q.w;
  }
  return { boneName, boneIndex, path: "rotation", times: new Float32Array(times), values, interpolation: "linear" };
}

/** Build a scale keyframe track for one bone over the given times. */
function scaleTrack(
  boneName: string,
  boneIndex: number,
  times: number[],
  scales: [number, number, number][],
): KeyframeTrack {
  const values = new Float32Array(times.length * 3);
  for (let i = 0; i < times.length; i++) {
    values[i * 3] = scales[i][0];
    values[i * 3 + 1] = scales[i][1];
    values[i * 3 + 2] = scales[i][2];
  }
  return { boneName, boneIndex, path: "scale", times: new Float32Array(times), values, interpolation: "linear" };
}

/** Resolve a bone index trying several naming conventions. */
function findBoneIdx(boneNameToIndex: Map<string, number>, names: string[]): number {
  for (const n of names) {
    const idx = boneNameToIndex.get(n);
    if (idx !== undefined) return idx;
  }
  return -1;
}

/**
 * Build procedural demo clips for a skeleton. Returns clips keyed by display
 * name. Only bones present in the rig contribute tracks.
 */
export function buildProceduralClips(boneNameToIndex: Map<string, number>): { name: string; clip: AnimationClip }[] {
  const out: { name: string; clip: AnimationClip }[] = [];
  const T = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0];

  // ── Idle: breathing + gentle arm sway (3s loop) ──
  {
    const tracks: KeyframeTrack[] = [];
    const spine = findBoneIdx(boneNameToIndex, ["spine_02", "spine_01", "Spine", "spine", "mixamorig:Spine1", "mixamorig:Spine"]);
    if (spine >= 0) {
      const breath = [1, 1.02, 1, 1.02, 1, 1.02, 1];
      tracks.push(scaleTrack("spine", spine, T, breath.map((b) => [1, b, 1] as [number, number, number])));
    }
    const lArm = findBoneIdx(boneNameToIndex, ["upperarm_l", "UpperArm_Left", "ArmUp_Left", "mixamorig:LeftArm"]);
    const rArm = findBoneIdx(boneNameToIndex, ["upperarm_r", "UpperArm_Right", "ArmUp_Right", "mixamorig:RightArm"]);
    const sway = [0, 0.03, 0, -0.03, 0, 0.03, 0];
    if (lArm >= 0) tracks.push(rotTrack("upperarm_l", lArm, T, sway.map((s) => [0, 0, s] as [number, number, number])));
    if (rArm >= 0) tracks.push(rotTrack("upperarm_r", rArm, T, sway.map((s) => [0, 0, -s] as [number, number, number])));
    if (tracks.length > 0) out.push({ name: "Procedural: Idle", clip: new AnimationClip({ name: "Procedural: Idle", duration: 3.0, tracks }) });
  }

  // ── Wave: right arm raises and waves (3s loop) ──
  {
    const tracks: KeyframeTrack[] = [];
    const rArm = findBoneIdx(boneNameToIndex, ["upperarm_r", "UpperArm_Right", "ArmUp_Right", "mixamorig:RightArm"]);
    const rForearm = findBoneIdx(boneNameToIndex, ["lowerarm_r", "LowerArm_Right", "ArmDown_Right", "mixamorig:RightForeArm"]);
    const rClavicle = findBoneIdx(boneNameToIndex, ["clavicle_r", "Shoulder_Right", "mixamorig:RightShoulder"]);
    // Raise the upper arm out to the side (negative Z rotation ~ arm abduction).
    if (rClavicle >= 0) tracks.push(rotTrack("clavicle_r", rClavicle, T, T.map(() => [0, 0, -0.4] as [number, number, number])));
    if (rArm >= 0) tracks.push(rotTrack("upperarm_r", rArm, T, T.map(() => [0, 0, -1.2] as [number, number, number])));
    if (rForearm >= 0) {
      // Wave the forearm back and forth.
      const wave = [0.3, -0.6, 0.3, -0.6, 0.3, -0.6, 0.3];
      tracks.push(rotTrack("lowerarm_r", rForearm, T, wave.map((w) => [0, 0, w] as [number, number, number])));
    }
    if (tracks.length > 0) out.push({ name: "Procedural: Wave", clip: new AnimationClip({ name: "Procedural: Wave", duration: 3.0, tracks }) });
  }

  // ── Nod: head nods yes (2s loop) ──
  {
    const tracks: KeyframeTrack[] = [];
    const head = findBoneIdx(boneNameToIndex, ["head", "Head", "mixamorig:Head"]);
    const neck = findBoneIdx(boneNameToIndex, ["neck_01", "neck", "Neck", "mixamorig:Neck"]);
    const Tn = [0, 0.5, 1.0, 1.5, 2.0];
    const nod = [0, 0.35, 0, -0.2, 0];
    if (head >= 0) tracks.push(rotTrack("head", head, Tn, nod.map((n) => [n, 0, 0] as [number, number, number])));
    if (neck >= 0) tracks.push(rotTrack("neck", neck, Tn, nod.map((n) => [n * 0.5, 0, 0] as [number, number, number])));
    if (tracks.length > 0) out.push({ name: "Procedural: Nod", clip: new AnimationClip({ name: "Procedural: Nod", duration: 2.0, tracks }) });
  }

  return out;
}

/**
 * Runtime animation state for a loaded skinned model. Owns the Skeleton and
 * the per-frame sampled skin matrices. Call `sample(time)` each frame (or
 * leave time undefined to use the bind pose), then read `skinMatrices`.
 */
export class ModelAnimator {
  readonly skeleton: Skeleton;
  readonly boneCount: number;
  /** All playable clips (embedded first, then procedural). Parallel to clipNames/clipDurations. */
  readonly clips: (AnimationClip | null)[];
  /** Display names parallel to clips (for the animation panel). */
  readonly clipNames: string[];
  /** Durations (seconds) parallel to clips. */
  readonly clipDurations: number[];
  /** Flat skin matrices (boneCount * 16 floats), updated by sample(). */
  readonly skinMatrices: Float32Array;

  /** The normalization matrix (T) applied to mesh vertices, or null. */
  readonly normalizationMatrix: Float32Array | null;

  private bindPose: BoneTransform[];
  private positions: [number, number, number][];
  private rotations: [number, number, number, number][];
  private scales: [number, number, number][];
  private transforms: BoneTransform[];

  // Normalization conjugation: T and T^-1 to transform skin matrices as
  // T * skinMatrix * T^-1 so they map normalized vertices correctly.
  // Null when no normalization was applied (identity transform).
  private normMatrix: Float32Array | null;
  private normMatrixInv: Float32Array | null;
  // Scratch buffers for conjugation (avoid per-bone per-frame allocations)
  private scratchTmp: Float32Array;
  private scratchResult: Float32Array;

  constructor(skin: SkinData, animations: AnimationData[]) {
    const skelData = skinDataToSkeletonData(skin);
    this.skeleton = new Skeleton(skelData);
    this.boneCount = skin.bones.length;

    // Read the normalization transform (if any) and precompute its inverse.
    this.normMatrix = skin.normalizationMatrix ?? null;
    this.normMatrixInv = this.normMatrix ? invertMat4(this.normMatrix) : null;
    this.normalizationMatrix = this.normMatrix;

    // Build clips with pre-rotation baking, kept parallel to the input
    // animations array so the model viewer's animationIndex aligns directly.
    this.clips = [];
    this.clipNames = [];
    this.clipDurations = [];
    for (let i = 0; i < animations.length; i++) {
      const clip = buildClip(animations[i], skin.boneNameToIndex);
      this.clips.push(clip);
      this.clipNames.push(animations[i].name || `anim_${i}`);
      this.clipDurations.push(animations[i].duration);
    }

    // Append procedural demo clips (the shipped character FBX files are
    // rig-only with no embedded animations, so these provide playable motion).
    const proc = buildProceduralClips(skin.boneNameToIndex);
    for (const p of proc) {
      this.clips.push(p.clip);
      this.clipNames.push(p.name);
      this.clipDurations.push(p.clip.duration);
    }

    // Cached bind-pose arrays (cloned so sampling can mutate safely).
    const bind = this.skeleton.getBindPose();
    this.bindPose = bind.map((b) => ({
      position: [...b.position] as [number, number, number],
      rotation: [...b.rotation] as [number, number, number, number],
      scale: [...b.scale] as [number, number, number],
    }));
    this.positions = this.bindPose.map((b) => [...b.position] as [number, number, number]);
    this.rotations = this.bindPose.map((b) => [...b.rotation] as [number, number, number, number]);
    this.scales = this.bindPose.map((b) => [...b.scale] as [number, number, number]);
    this.transforms = this.bindPose.map(() => ({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }));

    this.skinMatrices = new Float32Array(this.boneCount * 16);
    this.scratchTmp = new Float32Array(16);
    this.scratchResult = new Float32Array(16);
    // Initialize to bind-pose skin matrices (~identity).
    this.sample(null);
  }

  /**
   * Sample the active clip at `time` (seconds) and recompute skin matrices.
   * Pass `undefined` or a nullish clipIndex to use the bind pose.
   */
  sample(clipIndex: number | null, time = 0): void {
    // Reset to bind pose so unanimated bones keep their rest transform.
    for (let i = 0; i < this.boneCount; i++) {
      const b = this.bindPose[i];
      this.positions[i][0] = b.position[0];
      this.positions[i][1] = b.position[1];
      this.positions[i][2] = b.position[2];
      this.rotations[i][0] = b.rotation[0];
      this.rotations[i][1] = b.rotation[1];
      this.rotations[i][2] = b.rotation[2];
      this.rotations[i][3] = b.rotation[3];
      this.scales[i][0] = b.scale[0];
      this.scales[i][1] = b.scale[1];
      this.scales[i][2] = b.scale[2];
    }

    if (clipIndex !== null && clipIndex >= 0 && clipIndex < this.clips.length) {
      const clip = this.clips[clipIndex];
      if (clip) clip.sample(time, this.positions, this.rotations, this.scales);
    }

    // Build the transforms array the Skeleton expects, then compute skin matrices.
    for (let i = 0; i < this.boneCount; i++) {
      const t = this.transforms[i];
      t.position = this.positions[i];
      t.rotation = this.rotations[i];
      t.scale = this.scales[i];
    }
    const matrices = this.skeleton.computeSkinMatrices(this.transforms);

    // Conjugate skin matrices with the normalization transform: T * sm * T^-1.
    // This maps normalized vertices (v' = T * v) to the correct normalized world
    // positions: T * sm * T^-1 * v' = T * sm * v = T * (skinned position).
    if (this.normMatrix && this.normMatrixInv) {
      const T = this.normMatrix;
      const Tinv = this.normMatrixInv;
      const tmp = this.scratchTmp;
      const result = this.scratchResult;
      for (let i = 0; i < this.boneCount; i++) {
        const off = i * 16;
        const sm = matrices.subarray(off, off + 16);
        multiplyMat4Into(T, sm, tmp);
        multiplyMat4Into(tmp, Tinv, result);
        this.skinMatrices.set(result, off);
      }
    } else {
      this.skinMatrices.set(matrices);
    }
  }

  /**
   * Returns the animated bone world matrices from the last `sample()` call.
   * Each entry is a column-major mat4 in the bone's original (pre-normalization)
   * coordinate space. The caller should apply `normalizationMatrix` to transform
   * them into the same space as the normalized mesh vertices.
   */
  getBoneWorldMatrices(): Float32Array[] {
    return this.skeleton.getWorldMatrices();
  }
}
