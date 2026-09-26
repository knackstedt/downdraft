// ============================================================================
// CharacterAnimator — model skin data → final skin matrices for ModelRenderer
//
// Generalized from andrews-sandbox's PlayerAnimator (which mirrored
// model-viewer's ModelAnimator): runs a SkeletonAnimator (state machine +
// procedural idle + foot IK), feeds its local bone transforms into
// Skeleton.computeSkinMatrices, and conjugates by the model's normalization
// matrix (T * sm * T^-1) so normalized vertices map correctly.
//
// Also exports the humanoid bone-name resolver (UE-style, generic, and
// Mixamo naming conventions) and the procedural locomotion clip builder.
// ============================================================================

import {
    AnimationClip,
    Skeleton,
    SkeletonAnimator,
    eulerXYZToQuat,
    invertMat4,
    multiplyMat4Into,
    skinDataToSkeletonData,
    type KeyframeTrack,
} from "@downdraft/engine";
import type { ModelData, SkinData } from "@downdraft/engine/libraries/models";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

// ── Bone-name resolver ──
// Tries UE-style, generic, and Mixamo names so procedural clips work across
// rigs that use different naming conventions.

export function findBoneIndex(boneNameToIndex: Map<string, number>, names: string[]): number {
  for (const n of names) {
    const idx = boneNameToIndex.get(n);
    if (idx !== undefined) return idx;
  }
  return -1;
}

// ── Keyframe track builders ──

export function rotationTrack(
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

export function positionTrack(
  boneName: string,
  boneIndex: number,
  times: number[],
  positions: [number, number, number][],
): KeyframeTrack {
  const values = new Float32Array(times.length * 3);
  for (let i = 0; i < times.length; i++) {
    values[i * 3] = positions[i][0];
    values[i * 3 + 1] = positions[i][1];
    values[i * 3 + 2] = positions[i][2];
  }
  return { boneName, boneIndex, path: "position", times: new Float32Array(times), values, interpolation: "linear" };
}

export interface HumanoidBoneIndices {
  pelvis: number;
  spine: number;
  head: number;
  neck: number;
  upperarmL: number;
  lowerarmL: number;
  upperarmR: number;
  lowerarmR: number;
  thighL: number;
  calfL: number;
  thighR: number;
  calfR: number;
}

export function resolveHumanoidBones(boneNameToIndex: Map<string, number>): HumanoidBoneIndices {
  return {
    pelvis: findBoneIndex(boneNameToIndex, ["pelvis", "Pelvis", "Hips", "mixamorig:Hips", "Root"]),
    spine: findBoneIndex(boneNameToIndex, ["spine_02", "spine_01", "Spine", "spine", "mixamorig:Spine1", "mixamorig:Spine"]),
    head: findBoneIndex(boneNameToIndex, ["head", "Head", "mixamorig:Head"]),
    neck: findBoneIndex(boneNameToIndex, ["neck_01", "neck", "Neck", "mixamorig:Neck"]),
    upperarmL: findBoneIndex(boneNameToIndex, ["upperarm_l", "UpperArm_Left", "ArmUp_Left", "mixamorig:LeftArm"]),
    lowerarmL: findBoneIndex(boneNameToIndex, ["lowerarm_l", "LowerArm_Left", "ArmDown_Left", "mixamorig:LeftForeArm"]),
    upperarmR: findBoneIndex(boneNameToIndex, ["upperarm_r", "UpperArm_Right", "ArmUp_Right", "mixamorig:RightArm"]),
    lowerarmR: findBoneIndex(boneNameToIndex, ["lowerarm_r", "LowerArm_Right", "ArmDown_Right", "mixamorig:RightForeArm"]),
    thighL: findBoneIndex(boneNameToIndex, ["thigh_l", "Thigh_Left", "LegUp_Left", "mixamorig:LeftUpLeg"]),
    calfL: findBoneIndex(boneNameToIndex, ["calf_l", "Calf_Left", "LegDown_Left", "mixamorig:LeftLeg"]),
    thighR: findBoneIndex(boneNameToIndex, ["thigh_r", "Thigh_Right", "LegUp_Right", "mixamorig:RightUpLeg"]),
    calfR: findBoneIndex(boneNameToIndex, ["calf_r", "Calf_Right", "LegDown_Right", "mixamorig:RightLeg"]),
  };
}

/**
 * Build procedural humanoid locomotion clips (Walk, Run, Jump) for a skeleton.
 * Idle is intentionally NOT built — SkeletonAnimator's built-in procedural
 * idle (breathing, arm/head sway) covers it. Only tracks for bones that
 * resolved are emitted, so partial rigs get partial clips.
 */
export function buildLocomotionClips(
  boneNameToIndex: Map<string, number>,
): { name: string; clip: AnimationClip }[] {
  const b = resolveHumanoidBones(boneNameToIndex);
  const out: { name: string; clip: AnimationClip }[] = [];

  // ── Walk: leg + arm swing (1s loop) ──
  {
    const tracks: KeyframeTrack[] = [];
    const T = [0, 0.25, 0.5, 0.75, 1.0];
    // Legs swing forward/back (X-axis rotation). Left and right are 180° out of phase.
    const legSwing: [number, number, number][] = [
      [0.4, 0, 0], [-0.4, 0, 0], [0.4, 0, 0], [-0.4, 0, 0], [0.4, 0, 0],
    ];
    const legSwingInv: [number, number, number][] = [
      [-0.4, 0, 0], [0.4, 0, 0], [-0.4, 0, 0], [0.4, 0, 0], [-0.4, 0, 0],
    ];
    // Knees bend slightly during the swing.
    const kneeBend: [number, number, number][] = [
      [0.2, 0, 0], [0.6, 0, 0], [0.2, 0, 0], [0.6, 0, 0], [0.2, 0, 0],
    ];
    // Arms swing opposite to legs (X-axis). Right arm with left leg.
    const armSwing: [number, number, number][] = [
      [-0.3, 0, 0], [0.3, 0, 0], [-0.3, 0, 0], [0.3, 0, 0], [-0.3, 0, 0],
    ];
    const armSwingInv: [number, number, number][] = [
      [0.3, 0, 0], [-0.3, 0, 0], [0.3, 0, 0], [-0.3, 0, 0], [0.3, 0, 0],
    ];
    if (b.thighL >= 0) tracks.push(rotationTrack("thigh_l", b.thighL, T, legSwing));
    if (b.thighR >= 0) tracks.push(rotationTrack("thigh_r", b.thighR, T, legSwingInv));
    if (b.calfL >= 0) tracks.push(rotationTrack("calf_l", b.calfL, T, kneeBend));
    if (b.calfR >= 0) tracks.push(rotationTrack("calf_r", b.calfR, T, kneeBend));
    if (b.upperarmL >= 0) tracks.push(rotationTrack("upperarm_l", b.upperarmL, T, armSwing));
    if (b.upperarmR >= 0) tracks.push(rotationTrack("upperarm_r", b.upperarmR, T, armSwingInv));
    // Slight pelvis bob (vertical position).
    if (b.pelvis >= 0) {
      const bob: [number, number, number][] = [
        [0, 0, 0], [0, 0.03, 0], [0, 0, 0], [0, 0.03, 0], [0, 0, 0],
      ];
      tracks.push(positionTrack("pelvis", b.pelvis, T, bob));
    }
    if (tracks.length > 0) out.push({ name: "Walk", clip: new AnimationClip({ name: "Walk", duration: 1.0, tracks }) });
  }

  // ── Run: faster, wider leg + arm swing (0.6s loop) ──
  {
    const tracks: KeyframeTrack[] = [];
    const T = [0, 0.15, 0.3, 0.45, 0.6];
    const legSwing: [number, number, number][] = [
      [0.8, 0, 0], [-0.8, 0, 0], [0.8, 0, 0], [-0.8, 0, 0], [0.8, 0, 0],
    ];
    const legSwingInv: [number, number, number][] = [
      [-0.8, 0, 0], [0.8, 0, 0], [-0.8, 0, 0], [0.8, 0, 0], [-0.8, 0, 0],
    ];
    const kneeBend: [number, number, number][] = [
      [0.4, 0, 0], [1.0, 0, 0], [0.4, 0, 0], [1.0, 0, 0], [0.4, 0, 0],
    ];
    const armSwing: [number, number, number][] = [
      [-0.6, 0, 0], [0.6, 0, 0], [-0.6, 0, 0], [0.6, 0, 0], [-0.6, 0, 0],
    ];
    const armSwingInv: [number, number, number][] = [
      [0.6, 0, 0], [-0.6, 0, 0], [0.6, 0, 0], [-0.6, 0, 0], [0.6, 0, 0],
    ];
    if (b.thighL >= 0) tracks.push(rotationTrack("thigh_l", b.thighL, T, legSwing));
    if (b.thighR >= 0) tracks.push(rotationTrack("thigh_r", b.thighR, T, legSwingInv));
    if (b.calfL >= 0) tracks.push(rotationTrack("calf_l", b.calfL, T, kneeBend));
    if (b.calfR >= 0) tracks.push(rotationTrack("calf_r", b.calfR, T, kneeBend));
    if (b.upperarmL >= 0) tracks.push(rotationTrack("upperarm_l", b.upperarmL, T, armSwing));
    if (b.upperarmR >= 0) tracks.push(rotationTrack("upperarm_r", b.upperarmR, T, armSwingInv));
    // Bigger pelvis bob for running.
    if (b.pelvis >= 0) {
      const bob: [number, number, number][] = [
        [0, 0, 0], [0, 0.06, 0], [0, 0, 0], [0, 0.06, 0], [0, 0, 0],
      ];
      tracks.push(positionTrack("pelvis", b.pelvis, T, bob));
    }
    // Lean forward slightly.
    if (b.spine >= 0) {
      tracks.push(rotationTrack("spine", b.spine, T, T.map(() => [0.15, 0, 0] as [number, number, number])));
    }
    if (tracks.length > 0) out.push({ name: "Run", clip: new AnimationClip({ name: "Run", duration: 0.6, tracks }) });
  }

  // ── Jump: tuck pose (single pose, 0.5s) ──
  {
    const tracks: KeyframeTrack[] = [];
    const T = [0, 0.25, 0.5];
    // Tuck legs up.
    const tuck: [number, number, number][] = [[0.6, 0, 0], [0.9, 0, 0], [0.6, 0, 0]];
    const tuckKnee: [number, number, number][] = [[0.8, 0, 0], [1.4, 0, 0], [0.8, 0, 0]];
    // Arms up.
    const armsUp: [number, number, number][] = [[-1.2, 0, 0], [-1.5, 0, 0], [-1.2, 0, 0]];
    if (b.thighL >= 0) tracks.push(rotationTrack("thigh_l", b.thighL, T, tuck));
    if (b.thighR >= 0) tracks.push(rotationTrack("thigh_r", b.thighR, T, tuck));
    if (b.calfL >= 0) tracks.push(rotationTrack("calf_l", b.calfL, T, tuckKnee));
    if (b.calfR >= 0) tracks.push(rotationTrack("calf_r", b.calfR, T, tuckKnee));
    if (b.upperarmL >= 0) tracks.push(rotationTrack("upperarm_l", b.upperarmL, T, armsUp));
    if (b.upperarmR >= 0) tracks.push(rotationTrack("upperarm_r", b.upperarmR, T, armsUp));
    if (tracks.length > 0) out.push({ name: "Jump", clip: new AnimationClip({ name: "Jump", duration: 0.5, tracks }) });
  }

  return out;
}

// ── CharacterAnimator: produces final skin matrices for the ModelRenderer ──

interface BoneTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export class CharacterAnimator {
  readonly boneCount: number;
  /** Flat skin matrices (boneCount * 16 floats) — the ModelRenderer input. */
  readonly skinMatrices: Float32Array;

  readonly animator: SkeletonAnimator;
  private skeleton: Skeleton;
  private norm: Float32Array | null;
  private normInv: Float32Array | null;
  private transforms: BoneTransform[];
  private scratchTmp: Float32Array;
  private scratchResult: Float32Array;

  constructor(modelData: ModelData, animator?: SkeletonAnimator) {
    if (!modelData.skin) throw new Error("[CharacterAnimator] Model has no skin data");

    const skin: SkinData = modelData.skin;
    this.boneCount = skin.bones.length;

    // The animator (state machine + procedural idle + foot IK). Games pass a
    // configured subclass (e.g. LocomotionAnimator); default is a plain one.
    this.animator = animator ?? new SkeletonAnimator(skin);

    // Register retargeted animations (handles mixamorig: → UE bone name
    // mapping + pre-rotation/rest-rotation baking).
    if (modelData.animations) {
      for (const anim of modelData.animations) {
        this.animator.registerRetargetedAnimations([anim], anim.name);
      }
      log.info("CharacterAnimator", `Registered ${modelData.animations.length} retargeted animations: ${modelData.animations.map((a) => a.name).join(", ")}`);
    }

    // Skeleton for computing final skin matrices.
    this.skeleton = new Skeleton(skinDataToSkeletonData(skin));

    // Normalization conjugation (T * sm * T^-1) so normalized vertices map
    // correctly.
    this.norm = skin.normalizationMatrix ?? null;
    this.normInv = this.norm ? invertMat4(this.norm) : null;

    this.skinMatrices = new Float32Array(this.boneCount * 16);
    this.scratchTmp = new Float32Array(16);
    this.scratchResult = new Float32Array(16);

    // Allocate reusable transform array.
    this.transforms = [];
    for (let i = 0; i < this.boneCount; i++) {
      this.transforms.push({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    }

    // Initialize to bind-pose skin matrices.
    this.computeSkinMatrices();
  }

  /**
   * Returns bone world positions (3 floats per bone) in NORMALIZED vertex
   * space (the same space as the rendered mesh vertices). This applies the
   * model's normalization matrix T to the raw skeleton world positions so a
   * skeleton overlay aligns with the mesh. Callers still apply the entity's
   * world transform (position + yaw + scale) to get world-space positions.
   */
  getBoneWorldPositions(): Float32Array {
    const worldMats = this.skeleton.getWorldMatrices();
    const out = new Float32Array(this.boneCount * 3);
    // The normalization matrix T maps skeleton space → normalized vertex space.
    // Bone world positions are in skeleton space; apply T to get vertex space.
    const T = this.norm;
    if (T) {
      for (let i = 0; i < this.boneCount; i++) {
        // Column-major mat4 * vec4: translation = columns 3 (indices 12,13,14).
        const wx = worldMats[i][12];
        const wy = worldMats[i][13];
        const wz = worldMats[i][14];
        // T * [wx, wy, wz, 1] — column-major multiply.
        out[i * 3]     = T[0] * wx + T[4] * wy + T[8]  * wz + T[12];
        out[i * 3 + 1] = T[1] * wx + T[5] * wy + T[9]  * wz + T[13];
        out[i * 3 + 2] = T[2] * wx + T[6] * wy + T[10] * wz + T[14];
      }
    } else {
      for (let i = 0; i < this.boneCount; i++) {
        out[i * 3] = worldMats[i][12];
        out[i * 3 + 1] = worldMats[i][13];
        out[i * 3 + 2] = worldMats[i][14];
      }
    }
    return out;
  }

  /** Returns parent index for each bone (-1 for root bones). */
  getBoneParents(): Int32Array {
    const bones = this.skeleton.data.bones;
    const out = new Int32Array(this.boneCount);
    for (let i = 0; i < this.boneCount; i++) {
      out[i] = bones[i].parentIndex;
    }
    return out;
  }

  /**
   * Read the animator's flattened local transforms into the BoneTransform[]
   * that Skeleton.computeSkinMatrices expects, then conjugate by the
   * normalization matrix.
   * @returns The flat skin matrices buffer (boneCount * 16 floats).
   */
  computeSkinMatrices(): Float32Array {
    const pos = this.animator.getLocalPosFlat();
    const rot = this.animator.getLocalRotFlat();
    const scl = this.animator.getLocalScaleFlat();

    for (let i = 0; i < this.boneCount; i++) {
      const t = this.transforms[i];
      t.position[0] = pos[i * 4];
      t.position[1] = pos[i * 4 + 1];
      t.position[2] = pos[i * 4 + 2];
      t.rotation[0] = rot[i * 4];
      t.rotation[1] = rot[i * 4 + 1];
      t.rotation[2] = rot[i * 4 + 2];
      t.rotation[3] = rot[i * 4 + 3];
      t.scale[0] = scl[i * 4];
      t.scale[1] = scl[i * 4 + 1];
      t.scale[2] = scl[i * 4 + 2];
    }

    // Compute skin matrices: world * inverseBind.
    const matrices = this.skeleton.computeSkinMatrices(this.transforms);

    // Conjugate by normalization: skinMatrices[i] = T * m * T^-1.
    if (this.norm && this.normInv) {
      const T = this.norm;
      const Tinv = this.normInv;
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

    return this.skinMatrices;
  }

  dispose(): void {
    // SkeletonAnimator + Skeleton hold no GPU resources; nothing to free.
  }
}
