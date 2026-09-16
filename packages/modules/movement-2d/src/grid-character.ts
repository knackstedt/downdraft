// ============================================================================
// GridCharacterController — shared 2D platformer physics for grid-based games
//
// Generalized from the falling-sand `player.ts` / mining-rpg `mining-player.ts`
// / overburden `blockhead.ts` copies. An AABB character moves through a grid
// world where cells may be solid, liquid, climbable, or damaging.
//
// The game supplies a `GridCharacterWorld` of cell predicates, so this works
// over any grid representation (Uint32 packed material ids, Uint16 block ids,
// foreground + background layers, etc.).
// ============================================================================

// ─── Public types ────────────────────────────────────────────────────────────

/** Player state mutated by update(). Games may extend with extra fields. */
export interface GridCharacterState {
  /** Center X in grid cell coords */
  x: number;
  /** Top-of-AABB Y in grid cell coords (Y increases downward) */
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  /** 1 = right, -1 = left */
  facing: number;
  /** Walk-cycle frame counter (increments while moving or airborne) */
  animFrame: number;
  health: number;
}

export interface GridCharacterInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  /** Free-fly cheat — requires `noclip` in config. */
  noclip?: boolean;
}

/** Cell predicates over the collision world. */
export interface GridCharacterWorld {
  /** Grid dimensions in cells. */
  w: number;
  h: number;
  /** Is the cell solid (blocks movement)? Out-of-bounds counts as solid. */
  isSolid(x: number, y: number): boolean;
  /** Is the cell a liquid? Default: never. */
  isLiquid?(x: number, y: number): boolean;
  /** Is the cell climbable (ladder/rope)? Requires `climb` config. */
  isClimbable?(x: number, y: number): boolean;
  /** Is the cell a "hard" solid (can never fall)? Used by `fallDamage` and
   *  `bury.crush` — landing/encasement on soft falling debris doesn't hurt.
   *  Default: same as isSolid. */
  isHardSolid?(x: number, y: number): boolean;
  /** Can this solid cell be cleared by the bury "wiggle" escape?
   *  Default: isSolid. Only consulted when `bury` is configured. */
  canWiggleClear?(x: number, y: number): boolean;
  /** Clear the cell (bury wiggle escape). Required when `bury` is configured. */
  clearCell?(x: number, y: number): void;
  /** Damage per tick while this cell overlaps the body. Default: 0.
   *  Return the damage amount; the cause is reported via onDamage. */
  damageAt?(x: number, y: number): { damage: number; cause?: unknown } | number;
}

/** Damage notification — lets games track death causes, sfx, etc. */
export type GridDamageKind = "contact" | "fall" | "crush";

export interface GridCharacterConfig {
  /** AABB size in cells. */
  width: number;
  height: number;
  /** Downward acceleration per tick. */
  gravity: number;
  /** Horizontal acceleration per tick while a direction is held. */
  moveAccel: number;
  /** Max horizontal speed (cells/tick). */
  maxSpeed: number;
  /** Velocity multiplier when no direction is held (0–1). */
  friction: number;
  /** Upward impulse on jump. */
  jumpForce: number;
  /** Terminal fall velocity. */
  maxFall: number;
  /** Max vertical move per collision sub-step. Default: no sub-stepping.
   *  Set < 1 when maxFall can exceed 1 cell/tick to prevent tunneling. */
  collisionStep?: number;
  /** Binary-search fine-snap on landing (needs collisionStep). Default: false. */
  fineSnap?: boolean;
  /** Suspend gravity while resting on the ground (kills 1-cell jitter).
   *  Default: false — gravity always applies and collision cancels it. */
  restOnGround?: boolean;
  /** Cells the character may step up when walking into a wall while grounded.
   *  Default: 0 (disabled). */
  stepUp?: number;
  /** Liquid swimming. Requires world.isLiquid. */
  swim?: {
    /** Cells of liquid overlap that count as "in liquid". Default: 2. */
    minCells?: number;
    buoyancyPerCell?: number;
    maxBuoyancy?: number;
    upAccel?: number;
    downAccel?: number;
    /** Velocity damping while in liquid. Default: 0.92. */
    damping?: number;
  };
  /** Climbing on climbable cells. Requires world.isClimbable. */
  climb?: {
    speed: number;
    /** Velocity damping while clinging with no vertical input. Default: 0.5. */
    clingDamp?: number;
    /** Jump may also dismount from a climbable. Default: true. */
    jumpDismount?: boolean;
  };
  /** Free-fly cheat mode via input.noclip. */
  noclip?: {
    speed: number;
    /** Called while noclipping (e.g. to refill oxygen). */
    onNoclipTick?(state: GridCharacterState): void;
  };
  /** Fall damage when landing on hard cells above a speed threshold. */
  fallDamage?: {
    /** Fall speed above which damage applies. */
    threshold: number;
    /** damage = (speed - threshold)² × scale. */
    scale: number;
    cause?: unknown;
  };
  /** Bury mechanics: restricted speed while partially covered by solids;
   *  crush damage while fully encased in hard solids; wiggle escape clears
   *  cells in the movement direction. */
  bury?: {
    /** Max horizontal speed while partially buried. */
    wiggleSpeed: number;
    /** Crush damage per tick while fully encased in hard solids. */
    crushDamage: number;
    /** Cells cleared per tick by wiggling. */
    maxClearPerTick: number;
    cause?: unknown;
  };
  /** Called whenever damage is applied (contact/fall/crush). */
  onDamage?(state: GridCharacterState, amount: number, kind: GridDamageKind, cause?: unknown): void;
  /**
   * Damage sink override. When provided, the controller routes damage through
   * this instead of clamping `state.health` itself — e.g. a `Vitals` instance
   * that tracks overkill/death/meters. The sink is responsible for mutating
   * `state.health`; `onDamage` still fires afterwards.
   */
  applyDamage?(state: GridCharacterState, amount: number, kind: GridDamageKind, cause?: unknown): void;
}

/** Per-call modifiers (e.g. biome gravity multipliers). */
export interface GridCharacterMods {
  gravityMul?: number;
  speedMul?: number;
  accelMul?: number;
}

export interface GridCharacterController {
  update(state: GridCharacterState, input: GridCharacterInput, world: GridCharacterWorld, mods?: GridCharacterMods): void;
  /** Count liquid cells overlapping the AABB (for oxygen/drowning checks). */
  countLiquid(world: GridCharacterWorld, px: number, py: number): number;
  /** Is the top row of the AABB submerged in liquid? */
  isHeadInLiquid(world: GridCharacterWorld, px: number, py: number): boolean;
  /** Count climbable cells overlapping the AABB. */
  countClimbable(world: GridCharacterWorld, px: number, py: number): number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export function createGridCharacterController(cfg: GridCharacterConfig): GridCharacterController {
  const W2 = cfg.width / 2;
  const H = cfg.height;
  const collisionStep = cfg.collisionStep ?? Infinity;
  const fineSnap = cfg.fineSnap ?? false;
  const restOnGround = cfg.restOnGround ?? false;
  const stepUp = cfg.stepUp ?? 0;

  const swimMin = cfg.swim?.minCells ?? 2;
  const swimBuoyPerCell = cfg.swim?.buoyancyPerCell ?? 0.008;
  const swimMaxBuoy = cfg.swim?.maxBuoyancy ?? 0.06;
  const swimUp = cfg.swim?.upAccel ?? 0.05;
  const swimDown = cfg.swim?.downAccel ?? 0.05;
  const swimDamp = cfg.swim?.damping ?? 0.92;

  const clingDamp = cfg.climb?.clingDamp ?? 0.5;
  const jumpDismount = cfg.climb?.jumpDismount ?? true;

  const isSolid = (world: GridCharacterWorld, x: number, y: number): boolean =>
    world.isSolid(x, y);
  const isHard = (world: GridCharacterWorld, x: number, y: number): boolean =>
    world.isHardSolid ? world.isHardSolid(x, y) : world.isSolid(x, y);

  /** AABB overlap test against the solid predicate. */
  function boxHits(world: GridCharacterWorld, px: number, py: number, test: (x: number, y: number) => boolean): boolean {
    const x0 = Math.floor(px - W2), x1 = Math.floor(px + W2);
    const y0 = Math.floor(py), y1 = Math.floor(py + H - 1);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (test(x, y)) return true;
    return false;
  }

  const hitsSolid = (world: GridCharacterWorld, px: number, py: number): boolean =>
    boxHits(world, px, py, (x, y) => isSolid(world, x, y));

  function countCells(world: GridCharacterWorld, px: number, py: number, test: (x: number, y: number) => boolean): { n: number; total: number } {
    const x0 = Math.floor(px - W2), x1 = Math.floor(px + W2);
    const y0 = Math.floor(py), y1 = Math.floor(py + H - 1);
    let n = 0, total = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        total++;
        if (test(x, y)) n++;
      }
    }
    return { n, total };
  }

  function countLiquid(world: GridCharacterWorld, px: number, py: number): number {
    if (!world.isLiquid) return 0;
    return countCells(world, px, py, (x, y) => world.isLiquid!(x, y)).n;
  }

  function isHeadInLiquid(world: GridCharacterWorld, px: number, py: number): boolean {
    if (!world.isLiquid) return false;
    const x0 = Math.floor(px - W2), x1 = Math.floor(px + W2);
    const y = Math.floor(py);
    for (let x = x0; x <= x1; x++) {
      if (world.isLiquid(x, y)) return true;
    }
    return false;
  }

  function countClimbable(world: GridCharacterWorld, px: number, py: number): number {
    if (!world.isClimbable) return 0;
    return countCells(world, px, py, (x, y) => world.isClimbable!(x, y)).n;
  }

  /** Clear solid cells overlapping the body so the player can wiggle out. */
  function wiggleClear(world: GridCharacterWorld, px: number, py: number, dirX: number, maxClear: number): number {
    const canClear = world.canWiggleClear ?? ((x, y) => world.isSolid(x, y));
    const clearCell = world.clearCell;
    if (!clearCell) return 0;
    const x0 = Math.floor(px - W2), x1 = Math.floor(px + W2);
    const y0 = Math.floor(py), y1 = Math.floor(py + H - 1);
    let cleared = 0;
    const xs = dirX > 0 ? [x1, x1 - 1, x0] : dirX < 0 ? [x0, x0 + 1, x1] : [x0, x1];
    for (const x of xs) {
      if (cleared >= maxClear) break;
      for (let y = y0; y <= y1; y++) {
        if (cleared >= maxClear) break;
        if (x < 0 || !canClear(x, y)) continue;
        clearCell(x, y);
        cleared++;
      }
    }
    return cleared;
  }

  function damage(p: GridCharacterState, amount: number, kind: GridDamageKind, cause?: unknown): void {
    if (amount <= 0) return;
    if (cfg.applyDamage) cfg.applyDamage(p, amount, kind, cause);
    else p.health = Math.max(0, p.health - amount);
    cfg.onDamage?.(p, amount, kind, cause);
  }

  function update(p: GridCharacterState, input: GridCharacterInput, world: GridCharacterWorld, mods?: GridCharacterMods): void {
    let px = p.x;
    let py = p.y;
    const gravityMul = mods?.gravityMul ?? 1;

    // --- Noclip (development cheat): free flight, no collision/damage ---
    if (cfg.noclip && input.noclip) {
      let vx = 0, vy = 0;
      if (input.left) { vx -= 1; p.facing = -1; }
      if (input.right) { vx += 1; p.facing = 1; }
      if (input.up || input.jump) vy -= 1;
      if (input.down) vy += 1;
      const len = Math.hypot(vx, vy);
      if (len > 0) {
        vx = (vx / len) * cfg.noclip.speed;
        vy = (vy / len) * cfg.noclip.speed;
      }
      px += vx;
      py += vy;
      px = Math.max(W2, Math.min(world.w - W2 - 1, px));
      py = Math.max(0, Math.min(world.h - H, py));
      p.vx = vx;
      p.vy = vy;
      p.onGround = false;
      p.animFrame++;
      cfg.noclip.onNoclipTick?.(p);
      p.x = px;
      p.y = py;
      return;
    }

    const liquidCount = cfg.swim ? countLiquid(world, px, py) : 0;
    const inLiquid = cfg.swim ? liquidCount >= swimMin : false;
    const buoyancy = inLiquid ? Math.min(swimMaxBuoy, liquidCount * swimBuoyPerCell) : 0;
    const onClimb = cfg.climb ? countClimbable(world, px, py) > 0 : false;

    // --- Buried state ---
    let partiallyBuried = false;
    if (cfg.bury) {
      const overlap = countCells(world, px, py, (x, y) => isSolid(world, x, y));
      const hard = countCells(world, px, py, (x, y) => isHard(world, x, y));
      const fullyBuried = hard.n >= hard.total;
      partiallyBuried = overlap.n > 0 && !fullyBuried;
      if (fullyBuried) damage(p, cfg.bury.crushDamage, "crush", cfg.bury.cause);
    }

    // --- Horizontal movement ---
    const accel = (mods?.accelMul ?? 1) * cfg.moveAccel;
    if (input.left) { p.vx -= accel; p.facing = -1; }
    if (input.right) { p.vx += accel; p.facing = 1; }
    if (!input.left && !input.right) p.vx *= cfg.friction;
    const speedCap = (partiallyBuried ? cfg.bury!.wiggleSpeed : cfg.maxSpeed) * (mods?.speedMul ?? 1);
    p.vx = Math.max(-speedCap, Math.min(speedCap, p.vx));

    // --- Jump / climb / swim / gravity ---
    if (input.jump && (p.onGround || (onClimb && jumpDismount))) {
      p.vy = -cfg.jumpForce;
      p.onGround = false;
    }
    if (onClimb) {
      if (input.up) p.vy = -cfg.climb!.speed;
      else if (input.down) p.vy = cfg.climb!.speed;
      else p.vy *= clingDamp;
    }
    if (inLiquid) {
      if (input.up) p.vy -= swimUp;
      if (input.down) p.vy += swimDown;
    }
    if (onClimb && !input.down) {
      // gravity suspended while clinging/climbing up
    } else if (restOnGround && p.onGround) {
      p.vy = 0;
    } else {
      p.vy += (cfg.gravity - buoyancy) * gravityMul;
    }
    if (inLiquid) p.vy *= swimDamp;
    p.vy = Math.min(cfg.maxFall, p.vy);

    // --- Move X with collision ---
    const newX = px + p.vx;
    if (!hitsSolid(world, newX, py)) {
      px = newX;
    } else if (partiallyBuried && Math.abs(p.vx) > 0.01) {
      const cleared = wiggleClear(world, px, py, p.vx > 0 ? 1 : -1, cfg.bury!.maxClearPerTick);
      if (cleared > 0 && !hitsSolid(world, newX, py)) px = newX;
      else p.vx = 0;
    } else {
      // Step up N cells while grounded
      let stepped = false;
      if (stepUp > 0 && p.onGround) {
        for (let s = 1; s <= stepUp; s++) {
          if (!hitsSolid(world, newX, py - s)) { px = newX; py -= s; stepped = true; break; }
        }
      }
      if (!stepped) p.vx = 0;
    }

    // Clamp X to world bounds
    if (px < W2) { px = W2; p.vx = 0; }
    if (px > world.w - W2 - 1) { px = world.w - W2 - 1; p.vx = 0; }

    // --- Move Y with collision ---
    const totalDy = p.vy;
    if (totalDy === 0) {
      // If we were on ground, verify the ground is still there.
      if (restOnGround && p.onGround) {
        const feetY = Math.floor(py + H);
        const fx0 = Math.floor(px - W2), fx1 = Math.floor(px + W2);
        let groundBelow = false;
        for (let x = fx0; x <= fx1; x++) {
          if (isSolid(world, x, feetY)) { groundBelow = true; break; }
        }
        p.onGround = groundBelow;
      } else if (!restOnGround) {
        p.onGround = false;
      }
    } else {
      const steps = Math.max(1, Math.ceil(Math.abs(totalDy) / collisionStep));
      const stepDy = totalDy / steps;
      p.onGround = false;
      for (let s = 0; s < steps; s++) {
        const newY = py + stepDy;
        if (!hitsSolid(world, px, newY)) {
          py = newY;
        } else {
          if (stepDy > 0) {
            p.onGround = true;
            const fallSpeed = p.vy;
            if (fineSnap) {
              // Binary-search the closest resting position.
              let lo = py, hi = newY;
              for (let i = 0; i < 5; i++) {
                const mid = (lo + hi) * 0.5;
                if (hitsSolid(world, px, mid)) hi = mid;
                else lo = mid;
              }
              py = lo;
            }
            if (cfg.fallDamage && fallSpeed > cfg.fallDamage.threshold) {
              const feetY = Math.floor(py + H);
              const fx0 = Math.floor(px - W2), fx1 = Math.floor(px + W2);
              let landedOnHard = false;
              for (let x = fx0; x <= fx1; x++) {
                if (isHard(world, x, feetY)) { landedOnHard = true; break; }
              }
              if (landedOnHard) {
                const excess = fallSpeed - cfg.fallDamage.threshold;
                damage(p, Math.round(excess * excess * cfg.fallDamage.scale), "fall", cfg.fallDamage.cause);
              }
            }
          }
          p.vy = 0;
          break;
        }
      }
    }

    // Clamp Y
    if (py < 0) { py = 0; p.vy = 0; }
    if (py > world.h - H) { py = world.h - H; p.vy = 0; p.onGround = true; }

    // Animation
    if (Math.abs(p.vx) > 0.01 || !p.onGround) p.animFrame++;
    else p.animFrame = 0;

    // --- Contact damage ---
    if (world.damageAt) {
      const cx = Math.floor(px);
      for (let dy = 0; dy < H; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          const gy = Math.floor(py) + dy;
          const d = world.damageAt(gx, gy);
          if (typeof d === "number") {
            if (d > 0) damage(p, d, "contact", undefined);
          } else if (d && d.damage > 0) {
            damage(p, d.damage, "contact", d.cause);
          }
        }
      }
    }

    p.x = px;
    p.y = py;
  }

  return { update, countLiquid, isHeadInLiquid, countClimbable };
}
