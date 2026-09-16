// Re-export SkeletonAnimator built on @downdraft/library-character's
// LocomotionAnimator — the shared Idle/Walk/Run hysteresis state machine —
// with tto's flag-driven input decode (swim override, jump air-states).
import { type AnimState, type SkinData } from "@downdraft/core";
import { LocomotionAnimator } from "@downdraft/library-character";
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

export class SkeletonAnimator extends LocomotionAnimator {
  constructor(skin: SkinData) {
    super(skin, {
      // Split airtime by speed (holdAirState off — tto re-evaluates each
      // frame rather than latching the takeoff state).
      air: (speed) => (speed > 0.5 ? "JumpStart" : speed < -0.5 ? "JumpEnd" : "JumpLoop"),
      holdAirState: false,
    });
  }

  update(dt: number, playerFlags: number, velocity: number): void {
    this.updateLocomotion(dt, {
      grounded: (playerFlags & PLR_FLAG.GROUNDED) !== 0,
      speed: velocity,
      override: (playerFlags & PLR_FLAG.SWIMMING) !== 0 ? "Swim" : null,
    });
  }
}
