// ============================================================================
// ParticleSystem — fixed-pool particle system for explosion visuals.
//
// Particles are simulated on the CPU (in the worker) and transferred to the
// renderer via the SharedArrayBuffer. The renderer draws them as a point-list
// or instanced quad pipeline on top of the grid layers.
//
// The pool is fixed-size (no per-frame allocation). Dead particles are marked
// inactive and their slots are reused. This keeps memory stable and avoids
// GC pressure in the hot loop.
// ============================================================================

export const PARTICLE_TYPES = {
  PROJECTILE: 0,  // flying debris — moves with velocity, leaves trail
  CIRCLE: 1,      // expanding blast ring — grows in size, fades
  SLUG: 2,        // slow-moving glowing ember
} as const;

// Particle data layout (for SAB transfer). Each particle = 8 floats (32 bytes):
//   [x, y, vx, vy, color, size, life/maxLife, type+active]
export const PARTICLE_FLOATS = 8;
export const PARTICLE_BYTES = PARTICLE_FLOATS * 4;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;   // packed RGBA u32
  size: number;    // radius in cells
  life: number;    // current life in frames
  maxLife: number; // max life in frames
  type: number;    // PARTICLE_TYPES
  active: boolean;
}

export class ParticleSystem {
  private particles: Particle[];
  private count = 0; // active count
  readonly maxParticles: number;

  constructor(max: number = 512) {
    this.maxParticles = max;
    this.particles = new Array(max);
    for (let i = 0; i < max; i++) {
      this.particles[i] = {
        x: 0, y: 0, vx: 0, vy: 0,
        color: 0, size: 0, life: 0, maxLife: 0,
        type: 0, active: false,
      };
    }
  }

  /** Current active particle count. */
  get activeCount(): number {
    return this.count;
  }

  /**
   * Spawn a particle. If the pool is full, the oldest particle is replaced.
   */
  spawn(
    x: number, y: number,
    type: number,
    color: number,
    size: number,
    vx: number, vy: number,
    maxLife: number,
  ): void {
    // Find an inactive slot
    let slot = -1;
    for (let i = 0; i < this.maxParticles; i++) {
      if (!this.particles[i].active) { slot = i; break; }
    }
    if (slot < 0) {
      // Pool full — replace the oldest active particle
      let oldestLife = Infinity;
      for (let i = 0; i < this.maxParticles; i++) {
        const p = this.particles[i];
        if (p.life > oldestLife) { oldestLife = p.life; slot = i; }
      }
      if (slot < 0) slot = 0; // shouldn't happen but safety
    }

    const p = this.particles[slot];
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.color = color;
    p.size = size;
    p.life = 0;
    p.maxLife = maxLife;
    p.type = type;
    p.active = true;
    this.count++;
  }

  /**
   * Advance particle physics and cull dead particles.
   * Called once per frame after the main simulation step.
   */
  update(): void {
    let active = 0;
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      // Advance physics
      p.x += p.vx;
      p.y += p.vy;

      // Type-specific behavior
      switch (p.type) {
        case PARTICLE_TYPES.PROJECTILE:
          // Decelerate (air resistance)
          p.vx *= 0.92;
          p.vy *= 0.92;
          // Gravity pulls projectiles down
          p.vy += 0.15;
          break;
        case PARTICLE_TYPES.CIRCLE:
          // Expanding ring — grow size, no velocity decay
          p.size += 0.3;
          p.vx *= 0.95;
          p.vy *= 0.95;
          break;
        case PARTICLE_TYPES.SLUG:
          // Slow ember — gentle deceleration
          p.vx *= 0.96;
          p.vy *= 0.96;
          p.vy -= 0.05; // slight upward drift (hot)
          break;
      }

      // Age
      p.life++;
      if (p.life >= p.maxLife) {
        p.active = false;
      } else {
        active++;
      }
    }
    this.count = active;
  }

  /**
   * Write particle data to a Float32Array for SAB transfer.
   * Returns the number of particles written.
   */
  writeToBuffer(buf: Float32Array, offset: number): number {
    let written = 0;
    let fi = offset;
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      buf[fi++] = p.x;
      buf[fi++] = p.y;
      buf[fi++] = p.vx;
      buf[fi++] = p.vy;
      buf[fi++] = p.color;
      buf[fi++] = p.size;
      buf[fi++] = p.life / p.maxLife; // normalized life (0→1)
      buf[fi++] = p.type;
      written++;
      if (written >= this.maxParticles) break;
    }
    return written;
  }

  /** Clear all particles. */
  clear(): void {
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles[i].active = false;
    }
    this.count = 0;
  }

  /** Get a particle by index (for testing). */
  getParticle(i: number): Particle | null {
    if (i < 0 || i >= this.maxParticles) return null;
    const p = this.particles[i];
    return p.active ? p : null;
  }
}
