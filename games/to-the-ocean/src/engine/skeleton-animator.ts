// Re-export SkeletonAnimator from @downdraft/core with game-specific update logic
import { SkeletonAnimator as CoreSkeletonAnimator, type AnimState, type SkinData } from "@downdraft/core";
import type { AnimationData } from "@downdraft/library-models";

export type { AnimationData, AnimState, SkinData };

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

export class SkeletonAnimator extends CoreSkeletonAnimator {
  update(dt: number, playerFlags: number, velocity: number): void {
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
      const isMoving = this.getCurrentState() === "Walk" || this.getCurrentState() === "Run";
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
    if (desiredState === "Swim" && !this.hasAnimation("Swim")) {
      desiredState = "Idle";
    }

    this.setAnimationState(desiredState);
    this.tick(dt);
  }
}
