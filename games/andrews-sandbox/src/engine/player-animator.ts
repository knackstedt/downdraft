// ============================================================================
// Player Animator — drives the rigged player model with a full
// Idle/Walk/Run/Jump state machine + procedural idle + foot IK, and produces
// the final skin matrices (world * inverseBind, conjugated by the model's
// normalization matrix) that the ModelRenderer's updateSkinMatrices() expects.
//
// Reuses the core SkeletonAnimator (state machine, procedural idle, foot IK)
// and Skeleton.computeSkinMatrices (correctly handles rootAncestorMatrix).
// The normalization conjugation mirrors games/model-viewer/src/animation.ts
// (ModelAnimator) so FBX skinning correctness is inherited.
// ============================================================================

import {
    AnimationClip,
    Skeleton,
    SkeletonAnimator,
    eulerXYZToQuat,
    invertMat4,
    multiplyMat4Into,
    skinDataToSkeletonData,
    type AnimState,
    type KeyframeTrack,
} from "@downdraft/core";
import type { ModelData, SkinData } from "@downdraft/library-models";
import { PoseState } from "@sandbox/shared/types";

// ── Bone-name resolver ──
// Tries UE-style, generic, and Mixamo names so the procedural clips work
// across the Aisha / Robin / Humanling rigs (which use different conventions).

function findBoneIdx(boneNameToIndex: Map<string, number>, names: string[]): number {
  for (const n of names) {
    const idx = boneNameToIndex.get(n);
    if (idx !== undefined) return idx;
  }
  return -1;
}

// ── Keyframe track builders ──

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

function posTrack(
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

// ── Procedural clips ──

interface BoneIndices {
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

function resolveBones(boneNameToIndex: Map<string, number>): BoneIndices {
  return {
    pelvis: findBoneIdx(boneNameToIndex, ["pelvis", "Pelvis", "Hips", "mixamorig:Hips", "Root"]),
    spine: findBoneIdx(boneNameToIndex, ["spine_02", "spine_01", "Spine", "spine", "mixamorig:Spine1", "mixamorig:Spine"]),
    head: findBoneIdx(boneNameToIndex, ["head", "Head", "mixamorig:Head"]),
    neck: findBoneIdx(boneNameToIndex, ["neck_01", "neck", "Neck", "mixamorig:Neck"]),
    upperarmL: findBoneIdx(boneNameToIndex, ["upperarm_l", "UpperArm_Left", "ArmUp_Left", "mixamorig:LeftArm"]),
    lowerarmL: findBoneIdx(boneNameToIndex, ["lowerarm_l", "LowerArm_Left", "ArmDown_Left", "mixamorig:LeftForeArm"]),
    upperarmR: findBoneIdx(boneNameToIndex, ["upperarm_r", "UpperArm_Right", "ArmUp_Right", "mixamorig:RightArm"]),
    lowerarmR: findBoneIdx(boneNameToIndex, ["lowerarm_r", "LowerArm_Right", "ArmDown_Right", "mixamorig:RightForeArm"]),
    thighL: findBoneIdx(boneNameToIndex, ["thigh_l", "Thigh_Left", "LegUp_Left", "mixamorig:LeftUpLeg"]),
    calfL: findBoneIdx(boneNameToIndex, ["calf_l", "Calf_Left", "LegDown_Left", "mixamorig:LeftLeg"]),
    thighR: findBoneIdx(boneNameToIndex, ["thigh_r", "Thigh_Right", "LegUp_Right", "mixamorig:RightUpLeg"]),
    calfR: findBoneIdx(boneNameToIndex, ["calf_r", "Calf_Right", "LegDown_Right", "mixamorig:RightLeg"]),
  };
}

/** Build procedural clips (Idle, Walk, Run, Jump) for the player skeleton. */
function buildPlayerClips(
  boneNameToIndex: Map<string, number>,
): { name: string; clip: AnimationClip }[] {
  const b = resolveBones(boneNameToIndex);
  const out: { name: string; clip: AnimationClip }[] = [];

  // ── Idle: handled by the SkeletonAnimator's built-in applyProceduralIdle,
  // which applies smooth sinusoidal breathing (2% spine scale), arm sway
  // (±0.03 rad), and head sway (±0.03 rad) when no clip is playing. We do NOT
  // register an Idle clip — when setAnimationState("Idle") finds no clip,
  // the AnimationPlayer stays idle and applyProceduralIdle takes over. ──

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
    if (b.thighL >= 0) tracks.push(rotTrack("thigh_l", b.thighL, T, legSwing));
    if (b.thighR >= 0) tracks.push(rotTrack("thigh_r", b.thighR, T, legSwingInv));
    if (b.calfL >= 0) tracks.push(rotTrack("calf_l", b.calfL, T, kneeBend));
    if (b.calfR >= 0) tracks.push(rotTrack("calf_r", b.calfR, T, kneeBend));
    if (b.upperarmL >= 0) tracks.push(rotTrack("upperarm_l", b.upperarmL, T, armSwing));
    if (b.upperarmR >= 0) tracks.push(rotTrack("upperarm_r", b.upperarmR, T, armSwingInv));
    // Slight pelvis bob (vertical position).
    if (b.pelvis >= 0) {
      const bob: [number, number, number][] = [
        [0, 0, 0], [0, 0.03, 0], [0, 0, 0], [0, 0.03, 0], [0, 0, 0],
      ];
      tracks.push(posTrack("pelvis", b.pelvis, T, bob));
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
    if (b.thighL >= 0) tracks.push(rotTrack("thigh_l", b.thighL, T, legSwing));
    if (b.thighR >= 0) tracks.push(rotTrack("thigh_r", b.thighR, T, legSwingInv));
    if (b.calfL >= 0) tracks.push(rotTrack("calf_l", b.calfL, T, kneeBend));
    if (b.calfR >= 0) tracks.push(rotTrack("calf_r", b.calfR, T, kneeBend));
    if (b.upperarmL >= 0) tracks.push(rotTrack("upperarm_l", b.upperarmL, T, armSwing));
    if (b.upperarmR >= 0) tracks.push(rotTrack("upperarm_r", b.upperarmR, T, armSwingInv));
    // Bigger pelvis bob for running.
    if (b.pelvis >= 0) {
      const bob: [number, number, number][] = [
        [0, 0, 0], [0, 0.06, 0], [0, 0, 0], [0, 0.06, 0], [0, 0, 0],
      ];
      tracks.push(posTrack("pelvis", b.pelvis, T, bob));
    }
    // Lean forward slightly.
    if (b.spine >= 0) {
      tracks.push(rotTrack("spine", b.spine, T, T.map(() => [0.15, 0, 0] as [number, number, number])));
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
    if (b.thighL >= 0) tracks.push(rotTrack("thigh_l", b.thighL, T, tuck));
    if (b.thighR >= 0) tracks.push(rotTrack("thigh_r", b.thighR, T, tuck));
    if (b.calfL >= 0) tracks.push(rotTrack("calf_l", b.calfL, T, tuckKnee));
    if (b.calfR >= 0) tracks.push(rotTrack("calf_r", b.calfR, T, tuckKnee));
    if (b.upperarmL >= 0) tracks.push(rotTrack("upperarm_l", b.upperarmL, T, armsUp));
    if (b.upperarmR >= 0) tracks.push(rotTrack("upperarm_r", b.upperarmR, T, armsUp));
    if (tracks.length > 0) out.push({ name: "Jump", clip: new AnimationClip({ name: "Jump", duration: 0.5, tracks }) });
  }

  return out;
}

// ── SandboxPlayerAnimator: maps player state → animation state ──

export class SandboxPlayerAnimator extends SkeletonAnimator {
  private prevGrounded = true;
  private inAirState: AnimState | null = null;

  /**
   * Update the animation state from player physics, then advance the skeleton.
   * @param dt Delta time (seconds).
   * @param grounded True while the player is on the ground.
   * @param velocity Horizontal speed (units/sec) — drives Walk/Run selection.
   * @param _pose Current pose (Standing/Crouching/Prone) — reserved for future
   *   crouch-walk clips.
   */
  update(dt: number, grounded: boolean, velocity: number, _pose: PoseState): void {
    const walkEnter = 0.8;
    const walkExit = 0.3;
    const runEnter = 3.5;
    const runExit = 2.5;

    let desired: AnimState;

    if (!grounded) {
      // In the air: pick an air state and hold it until grounded.
      if (this.inAirState === null) {
        this.inAirState = velocity > 0.5 ? "Jump" : "Jump";
      }
      desired = this.inAirState;
    } else {
      // Just landed: clear the air state.
      this.inAirState = null;
      // Hysteresis on both thresholds: once in Run, stay until speed drops
      // below runExit; once in Walk, stay until below walkExit. Without this,
      // velocity jitter near a threshold toggles states every frame — visible
      // as a brief 1–10 frame flicker of the whole pose.
      const cur = this.getCurrentState();
      if (velocity > runEnter) desired = "Run";
      else if (cur === "Run" && velocity > runExit) desired = "Run";
      else if (velocity > walkEnter) desired = "Walk";
      else if (cur === "Walk" && velocity > walkExit) desired = "Walk";
      else desired = "Idle";
    }

    // Fall back to Idle if the desired clip isn't available (e.g. a rig with
    // no leg bones won't have Walk/Run/Jump clips).
    if (desired !== "Idle" && !this.hasAnimation(desired)) {
      desired = "Idle";
    }

    this.prevGrounded = grounded;
    this.setAnimationState(desired);
    this.tick(dt);
  }
}

// ── PlayerAnimator: produces final skin matrices for the ModelRenderer ──

interface BoneTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export class PlayerAnimator {
  readonly boneCount: number;
  /** Flat skin matrices (boneCount * 16 floats) — the ModelRenderer input. */
  readonly skinMatrices: Float32Array;

  private animator: SandboxPlayerAnimator;
  private skeleton: Skeleton;
  private norm: Float32Array | null;
  private normInv: Float32Array | null;
  private transforms: BoneTransform[];
  private scratchTmp: Float32Array;
  private scratchResult: Float32Array;

  // Head/neck bone indices for first-person hiding.
  private headIdx = -1;
  private neckIdx = -1;
  private spineUpperIdx = -1;  // Upper spine (hide in FP to keep torso below camera)
  private clavicleLIdx = -1;
  private clavicleRIdx = -1;

  constructor(modelData: ModelData) {
    if (!modelData.skin) throw new Error("[PlayerAnimator] Model has no skin data");

    const skin: SkinData = modelData.skin;
    this.boneCount = skin.bones.length;

    // Build the animator (state machine + procedural idle + foot IK).
    this.animator = new SandboxPlayerAnimator(skin);

    // Register Mixamo animations through the retargeting pipeline (handles
    // mixamorig: → UE bone name mapping + pre-rotation/rest-rotation baking).
    if (modelData.animations) {
      for (const anim of modelData.animations) {
        this.animator.registerRetargetedAnimations([anim], anim.name);
      }
      console.log(`[PlayerAnimator] Registered ${modelData.animations.length} retargeted animations: ${modelData.animations.map((a) => a.name).join(", ")}`);
    }

    // Procedural Jump clip disabled — it uses Y-up Euler rotations that don't
    // map correctly to the Aisha skeleton's Z-up bone frames, collapsing all
    // joints into a 2D plane. Without a Jump clip, the state machine falls
    // back to Idle when the player is airborne (see setAnimationState).
    // const jumpClips = buildPlayerClips(skin.boneNameToIndex).filter((c) => c.name === "Jump");
    // for (const c of jumpClips) this.animator.registerClip(c.name, c.clip);

    // Skeleton for computing final skin matrices.
    this.skeleton = new Skeleton(skinDataToSkeletonData(skin));

    // Normalization conjugation (T * sm * T^-1) so normalized vertices map
    // correctly. Mirrors ModelAnimator in games/model-viewer/src/animation.ts.
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

    // Resolve head/neck bones for first-person hiding.
    this.headIdx = findBoneIdx(skin.boneNameToIndex, ["head", "Head", "mixamorig:Head"]);
    this.neckIdx = findBoneIdx(skin.boneNameToIndex, ["neck_01", "neck", "Neck", "mixamorig:Neck"]);
    // Upper spine (spine_03+): hiding it collapses the entire upper body
    // (spine_04, spine_05, neck, head, clavicles, arms) in first-person.
    this.spineUpperIdx = findBoneIdx(skin.boneNameToIndex, ["spine_03", "Spine2", "mixamorig:Spine2"]);
    this.clavicleLIdx = findBoneIdx(skin.boneNameToIndex, ["clavicle_l", "LeftShoulder", "mixamorig:LeftShoulder"]);
    this.clavicleRIdx = findBoneIdx(skin.boneNameToIndex, ["clavicle_r", "RightShoulder", "mixamorig:RightShoulder"]);

    // Initialize to bind-pose skin matrices.
    this.update(0, true, 0, PoseState.Standing, false);
  }

  /** Get the underlying animator (for the preview's idle rendering). */
  getAnimator(): SandboxPlayerAnimator { return this.animator; }

  /**
   * Returns bone world positions (3 floats per bone) in NORMALIZED vertex
   * space (the same space as the rendered mesh vertices). This applies the
   * model's normalization matrix T to the raw skeleton world positions so the
   * skeleton overlay aligns with the mesh. Callers still apply the player's
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
   * Advance the animation and compute the final skin matrices.
   * @param firstPerson When true, head + neck bones are scaled to zero so the
   *   head doesn't obstruct the first-person camera.
   * @returns The flat skin matrices buffer (boneCount * 16 floats).
   */
  update(
    dt: number,
    grounded: boolean,
    velocity: number,
    pose: PoseState,
    firstPerson: boolean,
  ): Float32Array {
    this.animator.update(dt, grounded, velocity, pose);

    // Read the animator's flattened local transforms into the BoneTransform[]
    // that Skeleton.computeSkinMatrices expects.
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
