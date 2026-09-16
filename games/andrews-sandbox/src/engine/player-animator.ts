// ============================================================================
// Player Animator — drives the rigged player model with a full
// Idle/Walk/Run/Jump state machine + procedural idle + foot IK, and produces
// the final skin matrices (world * inverseBind, conjugated by the model's
// normalization matrix) that the ModelRenderer's updateSkinMatrices() expects.
//
// Now a thin adapter over @downdraft/library-character: LocomotionAnimator
// provides the hysteresis state machine, CharacterAnimator provides the
// skin-matrix pipeline + normalization conjugation.
// ============================================================================

import type { SkinData } from "@downdraft/core";
import { CharacterAnimator, LocomotionAnimator } from "@downdraft/library-character";
import type { ModelData } from "@downdraft/library-models";
import { PoseState } from "@sandbox/shared/types";

export class SandboxPlayerAnimator extends LocomotionAnimator {
  constructor(skin: SkinData) {
    super(skin, { air: "Jump" });
  }

  /**
   * Update the animation state from player physics, then advance the skeleton.
   * @param _pose Current pose (Standing/Crouching/Prone) — reserved for future
   *   crouch-walk clips.
   */
  update(dt: number, grounded: boolean, velocity: number, _pose: PoseState): void {
    this.updateLocomotion(dt, { grounded, speed: velocity });
  }
}

export class PlayerAnimator extends CharacterAnimator {
  private locomotion: SandboxPlayerAnimator;

  constructor(modelData: ModelData) {
    if (!modelData.skin) throw new Error("[PlayerAnimator] Model has no skin data");
    const locomotion = new SandboxPlayerAnimator(modelData.skin);
    super(modelData, locomotion);
    this.locomotion = locomotion;
  }

  /** Get the underlying animator (for the preview's idle rendering). */
  getAnimator(): SandboxPlayerAnimator { return this.locomotion; }

  /**
   * Advance the animation and compute the final skin matrices.
   * @param _firstPerson Reserved — first-person head-hiding is not yet wired.
   * @returns The flat skin matrices buffer (boneCount * 16 floats).
   */
  update(
    dt: number,
    grounded: boolean,
    velocity: number,
    pose: PoseState,
    _firstPerson: boolean,
  ): Float32Array {
    this.locomotion.update(dt, grounded, velocity, pose);
    return this.computeSkinMatrices();
  }
}
