// ============================================================================
// @andrews-sandbox/module-physics-props — per-prop physics controls + fun mode.
// Provides a controller for adjusting mass, bounciness, friction, gravity scale
// on individual props, and applying global fun modes.
// ============================================================================

import { FunMode } from "@sandbox/shared/types";

/** Minimal sim worker interface for physics commands. */
export interface PhysicsSimApi {
  sendCommand(cmd: { type: "setFunMode"; mode: FunMode }): void;
  sendCommand(cmd: { type: "updatePropPhysics"; entityId: number; mass?: number; restitution?: number; friction?: number; gravityScale?: number }): void;
  sendCommand(cmd: { type: "applyImpulse"; entityId: number; impulse: [number, number, number] }): void;
  sendCommand(cmd: any): void;
}

export interface PropPhysicsState {
  mass: number;
  restitution: number;
  friction: number;
  gravityScale: number;
}

export class PhysicsPropsController {
  private sim: PhysicsSimApi;
  private currentFunMode = FunMode.Normal;

  constructor(sim: PhysicsSimApi) {
    this.sim = sim;
  }

  /** Set the global fun mode. */
  setFunMode(mode: FunMode): void {
    this.currentFunMode = mode;
    this.sim.sendCommand({ type: "setFunMode", mode });
  }

  getFunMode(): FunMode {
    return this.currentFunMode;
  }

  /** Update physics properties on a specific prop. */
  updatePropPhysics(
    entityId: number,
    props: Partial<PropPhysicsState>,
  ): void {
    this.sim.sendCommand({
      type: "updatePropPhysics",
      entityId,
      mass: props.mass,
      restitution: props.restitution,
      friction: props.friction,
      gravityScale: props.gravityScale,
    });
  }

  /** Apply an impulse to a prop (e.g. for weapon knockback). */
  applyImpulse(entityId: number, impulse: [number, number, number]): void {
    this.sim.sendCommand({ type: "applyImpulse", entityId, impulse });
  }

  /** Get the physics parameters for a given fun mode. */
  static getFunModeParams(mode: FunMode): {
    gravityScale: number;
    restitution: number;
    friction: number;
  } {
    switch (mode) {
      case FunMode.Moon:
        return { gravityScale: 0.16, restitution: 0.3, friction: 0.5 };
      case FunMode.ZeroG:
        return { gravityScale: 0, restitution: 0.3, friction: 0.5 };
      case FunMode.Bouncy:
        return { gravityScale: 1.0, restitution: 0.95, friction: 0.1 };
      case FunMode.Squishy:
        // Bouncy-ish so props actually bounce (and trigger squish on impact),
        // but a touch less extreme than Bouncy so stacks still settle.
        return { gravityScale: 1.0, restitution: 0.7, friction: 0.3 };
      case FunMode.Normal:
      default:
        return { gravityScale: 1.0, restitution: 0.3, friction: 0.5 };
    }
  }
}
