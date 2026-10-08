// ============================================================================
// Locomotion animator — Idle/Walk/Run/airborne state machine with hysteresis
//
// Two games hand-rolled this on top of SkeletonAnimator:
//  - andrews-sandbox: walk/run thresholds + a held in-air state ("Jump")
//  - to-the-ocean:    same thresholds + flag-driven swim override and a
//                     per-speed air-state split (JumpStart/JumpLoop/JumpEnd)
//
// Hysteresis matters: once in Run the state holds until speed drops below
// runExit (not runEnter), otherwise velocity jitter near a threshold flickers
// the pose every frame. Missing clips fall back to the idle state, which the
// SkeletonAnimator renders via its procedural idle.
// ============================================================================

import { SkeletonAnimator, type AnimState, type SkinData } from "@downdraft/engine";

export interface LocomotionThresholds {
  /** Speed above which Walk engages (default 0.8). */
  walkEnter?: number;
  /** Speed below which Walk disengages (default 0.3). */
  walkExit?: number;
  /** Speed above which Run engages (default 3.5). */
  runEnter?: number;
  /** Speed below which Run disengages (default 2.5). */
  runExit?: number;
}

export interface LocomotionConfig {
  /** State names (defaults: "Idle" / "Walk" / "Run"). */
  states?: { idle?: AnimState; walk?: AnimState; run?: AnimState };
  thresholds?: LocomotionThresholds;
  /**
   * Airborne state: a constant state name (e.g. "Jump"), or a function of the
   * input `speed` for games that split airtime (e.g. JumpStart/JumpLoop/
   * JumpEnd). Absent = stay on the current state while airborne.
   */
  air?: AnimState | ((speed: number) => AnimState);
  /**
   * Hold the air state chosen at takeoff until landing (default true).
   * Prevents mid-air state churn when speed changes mid-jump.
   */
  holdAirState?: boolean;
  /**
   * Per-transition crossfade overrides (seconds), keyed `"from->to"` with
   * `"*"` wildcards (e.g. `"Swim->Jump"`, `"Swim->*"`, `"*->Swim"`). More
   * specific keys win; absent = the animator's default blend duration.
   * Useful for softening jarring swaps like Swim→Jump on a pool vault.
   */
  transitionFades?: Record<string, number>;
}

export interface LocomotionInput {
  grounded: boolean;
  /** Horizontal speed — drives Walk/Run selection and the `air` fn. */
  speed: number;
  /**
   * State that overrides locomotion entirely when set (e.g. "Swim",
   * "Climb"). Missing clips fall back to idle like any other state.
   */
  override?: AnimState | null;
}

export class LocomotionAnimator extends SkeletonAnimator {
  private inAirState: AnimState | null = null;
  private readonly cfg: Required<LocomotionThresholds> & {
    idle: AnimState;
    walk: AnimState;
    run: AnimState;
    air?: AnimState | ((speed: number) => AnimState);
    holdAirState: boolean;
    transitionFades?: Record<string, number>;
  };

  constructor(skin: SkinData, config: LocomotionConfig = {}) {
    super(skin);
    const t = config.thresholds ?? {};
    this.cfg = {
      idle: config.states?.idle ?? "Idle",
      walk: config.states?.walk ?? "Walk",
      run: config.states?.run ?? "Run",
      walkEnter: t.walkEnter ?? 0.8,
      walkExit: t.walkExit ?? 0.3,
      runEnter: t.runEnter ?? 3.5,
      runExit: t.runExit ?? 2.5,
      air: config.air,
      holdAirState: config.holdAirState ?? true,
      transitionFades: config.transitionFades,
    };
  }

  /**
   * Pick the animation state from the locomotion input, then advance the
   * skeleton by `dt` seconds. Named `updateLocomotion` (not `update`) so
   * game-specific subclasses can keep their own `update(dt, flags, speed)`
   * signatures that decode game state into a LocomotionInput.
   */
  updateLocomotion(dt: number, input: LocomotionInput): void {
    const c = this.cfg;
    let desired: AnimState;

    if (input.override) {
      this.inAirState = null;
      desired = input.override;
    } else if (!input.grounded) {
      // In the air: pick an air state and (optionally) hold it until grounded.
      if (c.air !== undefined) {
        if (this.inAirState === null || !c.holdAirState) {
          this.inAirState = typeof c.air === "function" ? c.air(input.speed) : c.air;
        }
        desired = this.inAirState!;
      } else {
        desired = this.getCurrentState();
      }
    } else {
      this.inAirState = null;
      const cur = this.getCurrentState();
      if (input.speed > c.runEnter) desired = c.run;
      else if (cur === c.run && input.speed > c.runExit) desired = c.run;
      else if (input.speed > c.walkEnter) desired = c.walk;
      else if (cur === c.walk && input.speed > c.walkExit) desired = c.walk;
      else desired = c.idle;
    }

    // Fall back to idle when the clip isn't registered (e.g. a rig with no
    // leg bones has no Walk/Run clips; a missing Swim falls back to Idle).
    if (desired !== c.idle && !this.hasAnimation(desired)) {
      desired = c.idle;
    }

    const fade = c.transitionFades?.[`${this.getCurrentState()}->${desired}`]
      ?? c.transitionFades?.[`*->${desired}`]
      ?? c.transitionFades?.[`${this.getCurrentState()}->*`];
    this.setAnimationState(desired, fade);
    this.tick(dt);
  }
}
