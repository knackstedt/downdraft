// ============================================================================
// CharacterMotor3D — shared 3D character movement kernel
//
// Generalized from the andrews-sandbox moveLoop and to-the-ocean
// player-manager. Computes desired per-tick movement deltas; collision
// resolution is left to the game's physics backend (e.g. a Rapier character
// controller) or a grid/terrain query.
//
// Conventions: yaw is radians, 0 faces -Z (matches getMoveForward below).
// `facing` is the model yaw — atan2(-dx, -dz) of the movement direction.
// ============================================================================

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CharacterMotor3DConfig {
  /** Walk speed (units/sec). */
  walkSpeed: number;
  /** Run speed while input.run is held. Default: walkSpeed. */
  runSpeed?: number;
  /** Free-fly (noclip/freecam) speed. Default: walkSpeed. */
  flySpeed?: number;
  /** Upward launch velocity on jump (units/sec). */
  jumpForce?: number;
  /** Downward acceleration (units/sec²). */
  gravity?: number;
  /** Normalize diagonal WASD so W+D isn't √2× faster. Default: true. */
  normalizeInput?: boolean;
  /** How the model yaw turns toward the movement direction. Default: rate 8 rad/s. */
  turn?: {
    /** "rate" = shortest-arc clamp at rate rad/s; "exp" = exponential ease (rate ≈ 10/s). */
    mode?: "rate" | "exp";
    rate?: number;
    /** Model facing convention: atan2(-dx,-dz) (default, model faces -Z at
     *  yaw 0) vs atan2(dx,-dz) when true (tto convention). */
    flip?: boolean;
  };
  /** Reset vy to 0 while grounded (before jump/gravity). Prevents unbounded
   *  gravity accumulation that causes ground clipping when the downstream
   *  collision resolver trusts the delta. Default: false. */
  resetVyWhenGrounded?: boolean;
  /** Flat ground-plane fallback (e.g. seabed). The delta is clamped so the
   *  character never passes below it. */
  groundHeight?: number;
  /** Horizontal speed while in water. Default: walkSpeed. */
  swimSpeed?: number;
  /** Swimming. When env.inWater is set, vertical movement uses these. */
  swim?: {
    /** Upward accel while input.jump held (units/sec²). */
    floatForce: number;
    /** Downward accel while input.dive held (units/sec²). */
    diveForce: number;
    /** Passive sink rate while no vertical input (units/sec²). */
    sinkRate: number;
    /** Vertical velocity damping per tick. */
    drag: number;
    /** Max |vy| while swimming. */
    maxVertSpeed: number;
    /** Stop floating up this far below the water surface. Default: 0.3. */
    surfaceOffset?: number;
  };
}

export interface Motor3DInput {
  /** -1..1 — forward/back (W=+1, S=-1). */
  fwd: number;
  /** -1..1 — strafe right/left (D=+1, A=-1). */
  strafe: number;
  jump?: boolean;
  /** Run on land / dive in water. */
  run?: boolean;
  /** Explicit dive-in-water input (defaults to `run` while swimming). */
  dive?: boolean;
  /** Fly-mode vertical (space/C). */
  up?: boolean;
  down?: boolean;
  /** Extra speed multiplier (e.g. modifier keys). Default: 1. */
  speedMul?: number;
}

export interface Motor3DState {
  /** Vertical velocity — persisted between ticks. */
  vy: number;
  /** Set by the game's collision resolver each tick. */
  grounded: boolean;
  /** Model yaw — eased toward the movement direction. */
  facing: number;
}

export interface Motor3DEnv {
  inWater?: boolean;
  /** Water surface height — required when inWater + swim config. */
  waterHeight?: number;
  /** Current position Y — required for the groundHeight clamp and the
   *  swim surface clamp. */
  posY?: number;
  /** Gate for ground-jump launches (e.g. disabled while piloting).
   *  Default: true. Does not affect swim-float. */
  jumpAllowed?: boolean;
}

export interface Motor3DDelta {
  dx: number;
  dy: number;
  dz: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Horizontal forward/right basis for a yaw (0 faces -Z, +yaw turns right). */
export function headingBasis(yaw: number): { fwd: [number, number]; right: [number, number] } {
  return {
    fwd: [Math.sin(yaw), -Math.cos(yaw)],
    right: [Math.cos(yaw), Math.sin(yaw)],
  };
}

/** Shortest-arc signed angle difference a→b. */
export function angleDelta(a: number, b: number): number {
  let d = b - a;
  if (!Number.isFinite(d)) return 0;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

// ─── Motor ───────────────────────────────────────────────────────────────────

export interface CharacterMotor3D {
  /**
   * Ground/water-mode update. Mutates state.vy and state.facing; returns the
   * desired world-space delta for this tick (before collision resolution).
   */
  update(state: Motor3DState, input: Motor3DInput, yaw: number, env: Motor3DEnv, dt: number): Motor3DDelta;
  /** Free-fly move (noclip/freecam): heading-relative + explicit up/down. */
  fly(input: Motor3DInput, yaw: number, dt: number): Motor3DDelta;
}

export function createCharacterMotor3D(cfg: CharacterMotor3DConfig): CharacterMotor3D {
  const runSpeed = cfg.runSpeed ?? cfg.walkSpeed;
  const flySpeed = cfg.flySpeed ?? cfg.walkSpeed;
  const jumpForce = cfg.jumpForce ?? 0;
  const gravity = cfg.gravity ?? 0;
  const normalize = cfg.normalizeInput ?? true;
  const turnMode = cfg.turn?.mode ?? "rate";
  const turnRate = cfg.turn?.rate ?? 8.0;
  const swimSpeed = cfg.swimSpeed ?? cfg.walkSpeed;
  const surfaceOffset = cfg.swim?.surfaceOffset ?? 0.3;

  function horizontalDelta(input: Motor3DInput, yaw: number, speed: number, dt: number): { dx: number; dz: number } {
    let fx = input.fwd;
    let sx = input.strafe;
    const len = Math.hypot(fx, sx);
    if (len === 0) return { dx: 0, dz: 0 };
    if (normalize) { fx /= len; sx /= len; }
    const basis = headingBasis(yaw);
    const mul = speed * (input.speedMul ?? 1) * dt;
    return {
      dx: (fx * basis.fwd[0] + sx * basis.right[0]) * mul,
      dz: (fx * basis.fwd[1] + sx * basis.right[1]) * mul,
    };
  }

  function turnToward(state: Motor3DState, dx: number, dz: number, dt: number): void {
    if (dx === 0 && dz === 0) return;
    const target = Math.atan2(cfg.turn?.flip ? dx : -dx, -dz);
    const diff = angleDelta(state.facing, target);
    if (turnMode === "exp") {
      state.facing += diff * Math.min(1, dt * turnRate);
    } else {
      const step = turnRate * dt;
      state.facing = Math.abs(diff) <= step ? target : state.facing + Math.sign(diff) * step;
    }
  }

  function update(state: Motor3DState, input: Motor3DInput, yaw: number, env: Motor3DEnv, dt: number): Motor3DDelta {
    const inWater = env.inWater && cfg.swim !== undefined;
    const isRunning = !inWater && !!input.run;
    const isDiving = inWater && (input.dive ?? input.run);
    const isFloating = inWater && !!input.jump;

    // --- Vertical ---
    let dy = 0;
    if (inWater) {
      const swim = cfg.swim!;
      if (isFloating) state.vy += swim.floatForce * dt;
      else if (isDiving) state.vy -= swim.diveForce * dt;
      else state.vy -= swim.sinkRate * dt;
      state.vy *= swim.drag;
      state.vy = Math.max(-swim.maxVertSpeed, Math.min(swim.maxVertSpeed, state.vy));
      dy = state.vy * dt;
      // Stop at the water surface when floating up (don't launch out).
      if (isFloating && env.waterHeight !== undefined && env.posY !== undefined
          && env.posY + dy > env.waterHeight - surfaceOffset) {
        dy = env.waterHeight - surfaceOffset - env.posY;
        state.vy = 0;
      }
    } else {
      if (cfg.resetVyWhenGrounded && state.grounded) state.vy = 0;
      if (state.grounded && input.jump && (env.jumpAllowed ?? true)) {
        state.vy = jumpForce;
        state.grounded = false;
      }
      state.vy -= gravity * dt;
      dy = state.vy * dt;
      // Flat ground-plane fallback (seabed / terrain floor).
      if (cfg.groundHeight !== undefined && env.posY !== undefined
          && env.posY + dy < cfg.groundHeight) {
        dy = cfg.groundHeight - env.posY;
        state.vy = 0;
      }
    }

    // --- Horizontal ---
    const moveSpeed = inWater ? swimSpeed : isRunning ? runSpeed : cfg.walkSpeed;
    const { dx, dz } = horizontalDelta(input, yaw, moveSpeed, dt);
    turnToward(state, dx, dz, dt);

    return { dx, dy, dz };
  }

  function fly(input: Motor3DInput, yaw: number, dt: number): Motor3DDelta {
    const mul = input.speedMul ?? 1;
    const speed = flySpeed * mul;
    const { dx, dz } = horizontalDelta({ ...input, speedMul: 1 }, yaw, speed, dt);
    let dy = 0;
    if (input.up) dy += speed * dt;
    if (input.down) dy -= speed * dt;
    return { dx, dy, dz };
  }

  return { update, fly };
}
