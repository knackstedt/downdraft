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
    /** Launch speed for vaulting out of the liquid over the rim: while holding
     *  jump in the shallow band near the surface and pressing a move key with
     *  env.swimNearEdge set, the swimmer pops out instead of clamping at the
     *  surface. Scaled per-tick by env.swimVaultMul (0 = this liquid can't be
     *  climbed out of). Default 0 = vaulting disabled. */
    vaultForce?: number;
    /** How far below waterHeight the feet can be for a vault to trigger.
     *  Must exceed the game's wet-probe depth or the env's inWater flag drops
     *  before the vault window opens. Default: 0.55. */
    vaultDepth?: number;
    /** Min seconds between vaults — stops held keys from re-launching the
     *  moment the swimmer falls back in (the "bouncing off the surface"
     *  effect). Default: 0.5. */
    vaultCooldown?: number;
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
  /** Internal: remaining seconds before another vault can launch. Managed by
   *  the motor; callers should leave it alone. */
  vaultCooldown?: number;
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
  /** Per-tick liquid modifiers — scale the swim config for thick/hazardous
   *  liquids. All default to 1; a ~0 swimForceMul is a liquid the character
   *  effectively can't swim in (quicksand). */
  swimForceMul?: number;
  /** Scales swim.sinkRate — quicksand-like liquids pull down fast. Default: 1. */
  swimSinkMul?: number;
  /** Scales swim.maxVertSpeed. Default: 1. */
  swimVertMul?: number;
  /** Scales swim.vaultForce; 0 = can't vault out of this liquid. Default: 1. */
  swimVaultMul?: number;
  /** Game-computed: close enough to the liquid body's edge to climb over the
   *  rim. Suppresses mid-pool vaults. Default: true. */
  swimNearEdge?: boolean;
  /** Game-computed: unit XZ direction toward the nearest climbable edge. When
   *  set, a vault only fires if the player's move input points at the edge
   *  (dot > 0.35) — pressing away from the rim just bobs. When unset, any
   *  horizontal input satisfies the check. */
  swimEdgeDir?: [number, number];
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
      const forceMul = env.swimForceMul ?? 1;
      const maxVert = swim.maxVertSpeed * (env.swimVertMul ?? 1);
      state.vaultCooldown = Math.max(0, (state.vaultCooldown ?? 0) - dt);
      if (Math.abs(state.vy) > maxVert) {
        // Overspeed — a vault launch or a plunge from height. Decay
        // ballistically back toward swim speeds; liquid forces re-engage once
        // inside the cap, so a vault keeps its arc while still submerged
        // instead of being crushed by drag on the next tick.
        state.vy -= Math.sign(state.vy) * Math.min(Math.abs(state.vy) - maxVert, gravity * dt);
      } else {
        if (isFloating) state.vy += swim.floatForce * forceMul * dt;
        else if (isDiving) state.vy -= swim.diveForce * forceMul * dt;
        else state.vy -= swim.sinkRate * (env.swimSinkMul ?? 1) * dt;
        state.vy *= swim.drag;
        state.vy = Math.max(-maxVert, Math.min(maxVert, state.vy));
      }
      dy = state.vy * dt;
      if (env.waterHeight !== undefined && env.posY !== undefined) {
        const vault = (swim.vaultForce ?? 0) * (env.swimVaultMul ?? 1);
        const edgeDir = env.swimEdgeDir;
        let towardEdge = input.fwd !== 0 || input.strafe !== 0;
        if (edgeDir && towardEdge) {
          const b = headingBasis(yaw);
          const mvx = input.fwd * b.fwd[0] + input.strafe * b.right[0];
          const mvz = input.fwd * b.fwd[1] + input.strafe * b.right[1];
          towardEdge = mvx * edgeDir[0] + mvz * edgeDir[1] > 0.35;
        }
        // Vault out over the rim: holding jump in the shallow band while
        // pressing toward the edge launches past the surface instead of
        // clamping. vy>=0 + the cooldown stop a descending swimmer from
        // re-triggering it; the env's inWater flag drops as the feet clear
        // the surface, handing the launch to the ballistic branch.
        if (isFloating && vault > 0 && (env.swimNearEdge ?? true) && towardEdge
            && state.vy >= 0 && (state.vaultCooldown ?? 0) <= 0
            && env.posY > env.waterHeight - (swim.vaultDepth ?? 0.55)) {
          state.vy = vault;
          state.vaultCooldown = swim.vaultCooldown ?? 0.5;
          state.grounded = false;
          dy = state.vy * dt;
        } else if (isFloating) {
          // Ease to a stop at the surface line — an asymptotic approach
          // instead of overshooting into the dry branch every other tick
          // (the old hard clamp made the swimmer bob visibly at the line).
          const cap = Math.max(0, env.waterHeight - surfaceOffset - env.posY) * 6;
          if (state.vy > cap) {
            state.vy = cap;
            dy = state.vy * dt;
          }
        }
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
