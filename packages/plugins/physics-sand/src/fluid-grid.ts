// ============================================================================
// FluidGrid — coarse-grid pressure/velocity fluid simulation.
//
// Replaces the per-cell wind field system with a proper fluid dynamics
// simulation at 1/4 resolution. Each coarse cell covers 4×4 fine cells.
//
// The simulation runs a simplified Navier-Stokes step each frame:
//   1. Pressure relaxation — pressure diffuses to neighbors
//   2. Velocity from pressure gradient — velX/velY derived from pressure diffs
//   3. Velocity damping — velocities decay slightly each frame
//
// This enables sustained airflow (fans), pressure equalization (gas flows
// from high to low pressure), and realistic explosion shockwaves.
//
// Per-cell wind is sampled from the coarse grid via bilinear interpolation
// in tryMove(), replacing the old per-cell WIND_X/WIND_Y fields.
//
// Inspired by the Dan-Ball dust2.js fluid simulation, which uses a similar
// coarse-grid pressure/velocity approach at 1/4 particle resolution.
// ============================================================================

const COARSE_SCALE = 4; // each coarse cell = 4×4 fine cells

export class FluidGrid {
  // Coarse grid dimensions
  readonly cw: number;
  readonly ch: number;

  // Pressure + velocity fields (Float32Array for performance)
  pressure: Float32Array;
  velX: Float32Array;
  velY: Float32Array;

  // Double-buffered temp arrays for relaxation steps
  private pressureNext: Float32Array;
  private velXNext: Float32Array;
  private velYNext: Float32Array;

  // Solid mask — coarse cells blocked by walls/stone don't participate.
  // 1 = solid (blocked), 0 = fluid (participates).
  private solid: Uint8Array;

  // Dirty flag — skip the step() entirely when no impulses or pressure exists.
  private dirty = false;

  constructor(fineW: number, fineH: number) {
    this.cw = Math.ceil(fineW / COARSE_SCALE);
    this.ch = Math.ceil(fineH / COARSE_SCALE);
    const n = this.cw * this.ch;
    this.pressure = new Float32Array(n);
    this.velX = new Float32Array(n);
    this.velY = new Float32Array(n);
    this.pressureNext = new Float32Array(n);
    this.velXNext = new Float32Array(n);
    this.velYNext = new Float32Array(n);
    this.solid = new Uint8Array(n);
  }

  /** Mark a fine-grid cell as solid (wall/stone). Blocks fluid flow. */
  setSolid(fineX: number, fineY: number): void {
    const cx = (fineX / COARSE_SCALE) | 0;
    const cy = (fineY / COARSE_SCALE) | 0;
    if (cx >= 0 && cx < this.cw && cy >= 0 && cy < this.ch) {
      this.solid[cy * this.cw + cx] = 1;
    }
  }

  /** Clear the solid flag for a fine-grid cell. */
  clearSolid(fineX: number, fineY: number): void {
    const cx = (fineX / COARSE_SCALE) | 0;
    const cy = (fineY / COARSE_SCALE) | 0;
    if (cx >= 0 && cx < this.cw && cy >= 0 && cy < this.ch) {
      this.solid[cy * this.cw + cx] = 0;
    }
  }

  /**
   * Apply an impulse at a fine-grid position. Adds to the velocity field
   * with linear falloff from the center. Used for explosions, fans, etc.
   */
  applyImpulse(fineX: number, fineY: number, radius: number, strengthX: number, strengthY: number): void {
    const ccx = (fineX / COARSE_SCALE) | 0;
    const ccy = (fineY / COARSE_SCALE) | 0;
    const cr = Math.ceil(radius / COARSE_SCALE);
    const cr2 = cr * cr;
    for (let dy = -cr; dy <= cr; dy++) {
      const ny = ccy + dy;
      if (ny < 0 || ny >= this.ch) continue;
      for (let dx = -cr; dx <= cr; dx++) {
        const nx = ccx + dx;
        if (nx < 0 || nx >= this.cw) continue;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > cr2) continue;
        const falloff = 1 - Math.sqrt(dist2) / (cr + 1);
        const idx = ny * this.cw + nx;
        if (this.solid[idx]) continue;
        this.velX[idx] += strengthX * falloff;
        this.velY[idx] += strengthY * falloff;
        // Pressure impulse for shockwave effect
        this.pressure[idx] += Math.abs(strengthX + strengthY) * falloff * 0.3;
      }
    }
    this.dirty = true;
  }

  /**
   * Sample horizontal velocity at a fine-grid position using bilinear
   * interpolation. Returns a velocity in cells/frame units.
   */
  sampleVelX(fineX: number, fineY: number): number {
    const fx = fineX / COARSE_SCALE - 0.5;
    const fy = fineY / COARSE_SCALE - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const v00 = this.safeVelX(x0, y0);
    const v10 = this.safeVelX(x1, y0);
    const v01 = this.safeVelX(x0, y1);
    const v11 = this.safeVelX(x1, y1);
    return (1 - tx) * (1 - ty) * v00 + tx * (1 - ty) * v10 +
           (1 - tx) * ty * v01 + tx * ty * v11;
  }

  /** Sample vertical velocity at a fine-grid position. */
  sampleVelY(fineX: number, fineY: number): number {
    const fx = fineX / COARSE_SCALE - 0.5;
    const fy = fineY / COARSE_SCALE - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const v00 = this.safeVelY(x0, y0);
    const v10 = this.safeVelY(x1, y0);
    const v01 = this.safeVelY(x0, y1);
    const v11 = this.safeVelY(x1, y1);
    return (1 - tx) * (1 - ty) * v00 + tx * (1 - ty) * v10 +
           (1 - tx) * ty * v01 + tx * ty * v11;
  }

  /** Get the raw velocity magnitude at a coarse cell (for debugging/visualization). */
  getPressure(cx: number, cy: number): number {
    if (cx < 0 || cx >= this.cw || cy < 0 || cy >= this.ch) return 0;
    return this.pressure[cy * this.cw + cx];
  }

  /** Whether any fluid activity exists (for skipping the step when idle). */
  isActive(): boolean {
    return this.dirty;
  }

  /** Clear all fields (e.g. on world clear/resize). */
  clear(): void {
    this.pressure.fill(0);
    this.velX.fill(0);
    this.velY.fill(0);
    this.pressureNext.fill(0);
    this.velXNext.fill(0);
    this.velYNext.fill(0);
    this.solid.fill(0);
    this.dirty = false;
  }

  /**
   * Run one simulation step:
   *   1. Pressure relaxation (diffuse to neighbors)
   *   2. Velocity from pressure gradient
   *   3. Velocity damping
   *
   * Skipped entirely when no impulses have been applied and all fields are
   * near-zero (the dirty flag tracks this).
   */
  step(): void {
    if (!this.dirty) return;
    const cw = this.cw, ch = this.ch;
    const pressure = this.pressure;
    const velX = this.velX, velY = this.velY;
    const pressureNext = this.pressureNext;
    const velXNext = this.velXNext, velYNext = this.velYNext;
    const solid = this.solid;

    // --- 1. Pressure relaxation (diffuse) ---
    // Each cell's pressure moves toward the average of its neighbors.
    // This is a single Jacobi iteration — enough for visual fluid flow.
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const idx = y * cw + x;
        if (solid[idx]) { pressureNext[idx] = 0; continue; }
        let sum = pressure[idx] * 2; // self-weight
        let count = 2;
        if (x > 0 && !solid[idx - 1]) { sum += pressure[idx - 1]; count++; }
        if (x < cw - 1 && !solid[idx + 1]) { sum += pressure[idx + 1]; count++; }
        if (y > 0 && !solid[idx - cw]) { sum += pressure[idx - cw]; count++; }
        if (y < ch - 1 && !solid[idx + cw]) { sum += pressure[idx + cw]; count++; }
        pressureNext[idx] = sum / count;
      }
    }

    // --- 2. Velocity from pressure gradient ---
    // velX -= (P[x+1] - P[x-1]) * dt
    // velY -= (P[y+1] - P[y-1]) * dt
    // Pressure naturally pushes flow from high to low.
    const pressureGrad = 0.15;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const idx = y * cw + x;
        if (solid[idx]) { velXNext[idx] = 0; velYNext[idx] = 0; continue; }
        const pL = x > 0 && !solid[idx - 1] ? pressureNext[idx - 1] : pressureNext[idx];
        const pR = x < cw - 1 && !solid[idx + 1] ? pressureNext[idx + 1] : pressureNext[idx];
        const pU = y > 0 && !solid[idx - cw] ? pressureNext[idx - cw] : pressureNext[idx];
        const pD = y < ch - 1 && !solid[idx + cw] ? pressureNext[idx + cw] : pressureNext[idx];
        velXNext[idx] = velX[idx] - (pR - pL) * pressureGrad;
        velYNext[idx] = velY[idx] - (pD - pU) * pressureGrad;
      }
    }

    // --- 3. Damping + pressure decay ---
    // Velocities decay ~10% per frame. Pressure decays faster (it's a
    // transient impulse, not a sustained field). This prevents impulses
    // from persisting forever and keeps the sim stable.
    const velDamping = 0.9;
    const pressureDamping = 0.85;
    let anyActive = false;
    for (let i = 0; i < cw * ch; i++) {
      velX[i] = velXNext[i] * velDamping;
      velY[i] = velYNext[i] * velDamping;
      pressure[i] = pressureNext[i] * pressureDamping;
      if (Math.abs(velX[i]) > 0.01 || Math.abs(velY[i]) > 0.01 || Math.abs(pressure[i]) > 0.01) {
        anyActive = true;
      }
    }

    // Clear dirty flag if everything has decayed to near-zero.
    this.dirty = anyActive;
  }

  // --- Internal helpers ---

  private safeVelX(cx: number, cy: number): number {
    if (cx < 0 || cx >= this.cw || cy < 0 || cy >= this.ch) return 0;
    const idx = cy * this.cw + cx;
    return this.solid[idx] ? 0 : this.velX[idx];
  }

  private safeVelY(cx: number, cy: number): number {
    if (cx < 0 || cx >= this.cw || cy < 0 || cy >= this.ch) return 0;
    const idx = cy * this.cw + cx;
    return this.solid[idx] ? 0 : this.velY[idx];
  }
}
