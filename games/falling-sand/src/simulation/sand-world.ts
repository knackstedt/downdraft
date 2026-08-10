import { DEFAULT_GRAVITY, DEFAULT_TEMP, FIELD } from "../shared/sim-buffer";
import { Material, MATERIALS } from "./materials";

export interface Cell {
  mat: number;
  lifetime: number;
  flags: number;
}

function pack(cell: Cell): number {
  return (cell.mat & 0xff) | ((cell.lifetime & 0xff) << 8) | ((cell.flags & 0xff) << 16);
}

function unpack(v: number): Cell {
  return {
    mat: v & 0xff,
    lifetime: (v >> 8) & 0xff,
    flags: (v >> 16) & 0xff,
  };
}

const FLAG_UPDATED = 0x04; // bit 2 — cell was updated this frame
const FLAG_SPARK = 0x08;   // bit 3 — this fire is a spark (expires to empty, not smoke)
const SHADE_MASK = 0x03;   // bits 0-1 — shade index (0-3)

function randomShade(): number {
  return Math.floor(Math.random() * 4);
}

function initialLifetime(mat: number): number {
  const def = MATERIALS[mat];
  if (!def) return 0;
  if (mat === Material.Fire) return def.burnTime;
  if (mat === Material.FuseFire) return def.burnTime;
  if (mat === Material.Smoke) return 120;
  if (mat === Material.Steam) return 120;
  if (mat === Material.GasVapor) return 200;
  if (mat === Material.Plasma) return 30;
  if (mat === Material.Fireflies) return 255;
  if (mat === Material.Nanobots) return 255;
  if (mat === Material.Hydrogen) return 200;
  if (mat === Material.MagicPowder) return 60; // decays like fire
  if (def.burnTime > 0 && def.flammable) return 0; // burnTime used when ignited, not on placement
  return 0;
}

export class SandWorld {
  W: number;
  H: number;
  grid: Uint32Array;
  // Per-cell physics fields: 4 bytes per cell [gravity:u8, temp:u8, windX:i8, windY:i8]
  fields: Uint8Array;
  frame = 0;
  // Global impulse settings (not spatial)
  horizontalImpulseChance = 0.02;
  horizontalImpulseStrength = 1;

  constructor(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.grid = new Uint32Array(w * h);
    this.fields = new Uint8Array(w * h * 4);
    // Initialize fields to defaults
    for (let i = 0; i < w * h * 4; i += 4) {
      this.fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
      this.fields[i + FIELD.TEMP] = DEFAULT_TEMP;
    }
    // Stone floor
    for (let x = 0; x < w; x++) {
      for (let y = h - 4; y < h; y++) {
        this.grid[y * w + x] = pack({ mat: Material.Stone, lifetime: 0, flags: 0 });
      }
    }
  }

  // --- Field accessors ---
  // gravity: u8 0-255, 128 = 1.0×. Returns multiplier 0-2.
  getGravity(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 1.0;
    return this.fields[(y * this.W + x) * 4 + FIELD.GRAVITY] / 128;
  }

  // temp: u8 0-255, 128 = 1.0. Returns 0-2.
  getTemperature(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 1.0;
    return this.fields[(y * this.W + x) * 4 + FIELD.TEMP] / 128;
  }

  // wind: i8 -128 to 127. Returns -5 to ~5.
  getWindX(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return (this.fields[(y * this.W + x) * 4 + FIELD.WIND_X] << 24) >> 24; // sign-extend i8
  }

  getWindY(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return (this.fields[(y * this.W + x) * 4 + FIELD.WIND_Y] << 24) >> 24;
  }

  // --- Field painting ---
  paintField(cx: number, cy: number, fieldType: number, value: number, radius: number): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        if (x < 0 || x >= this.W || y < 0 || y >= this.H) continue;
        this.fields[(y * this.W + x) * 4 + fieldType] = value & 0xff;
      }
    }
  }

  paintFieldLine(x0: number, y0: number, x1: number, y1: number, fieldType: number, value: number, radius: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (true) {
      this.paintField(x, y, fieldType, value, radius);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  getCell(x: number, y: number): Cell {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return { mat: Material.Empty, lifetime: 0, flags: 0 };
    return unpack(this.grid[y * this.W + x]);
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    this.grid[y * this.W + x] = pack(cell);
  }

  paintMaterial(cx: number, cy: number, mat: number, radius: number): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        const c = this.getCell(x, y);
        if (c.mat === Material.Stone || c.mat === Material.Wall) continue;
        this.setCell(x, y, { mat, lifetime: initialLifetime(mat), flags: randomShade() });
      }
    }
  }

  paintLine(x0: number, y0: number, x1: number, y1: number, mat: number, radius: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (true) {
      this.paintMaterial(x, y, mat, radius);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  igniteLine(x0: number, y0: number, x1: number, y1: number, radius: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (true) {
      this.ignite(x, y, radius);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  ignite(cx: number, cy: number, radius: number): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        const c = this.getCell(x, y);
        const def = MATERIALS[c.mat as Material];
        if (def?.flammable) {
          // Fuse gets FuseFire (yellow, stays put, deterministic spread)
          if (c.mat === Material.Fuse) {
            this.setCell(x, y, { mat: Material.FuseFire, lifetime: 15, flags: randomShade() });
          } else {
            this.setCell(x, y, { mat: Material.Fire, lifetime: 30, flags: randomShade() });
          }
        }
      }
    }
  }

  // ===========================================================================
  // Main step
  // ===========================================================================

  step(): void {
    this.frame++;
    const W = this.W, H = this.H;

    // Clear FLAG_UPDATED but preserve shade bits (0-1) and FLAG_SPARK (bit 3)
    for (let i = 0; i < W * H; i++) {
      this.grid[i] &= ~((0xff & ~(SHADE_MASK | FLAG_SPARK)) << 16);
    }

    this.applyReactions();
    this.applySpecialReactions();

    const leftToRight = this.frame % 2 === 0;
    for (let y = H - 1; y >= 0; y--) {
      if (leftToRight) {
        for (let x = 0; x < W; x++) this.tryMove(x, y);
      } else {
        for (let x = W - 1; x >= 0; x--) this.tryMove(x, y);
      }
    }

    this.applyCombustion();
    this.applyAging();
    this.decayWind();
  }

  private tryMove(x: number, y: number): void {
    const W = this.W, H = this.H;
    const idx = y * W + x;
    const packed = this.grid[idx];
    if (packed === 0) return;

    const cell = unpack(packed);
    if (cell.mat === Material.Empty) return;
    if (cell.flags & FLAG_UPDATED) return;

    const def = MATERIALS[cell.mat as Material];
    if (!def) return;
    const mat = cell.mat;

    if (def.gravityDir === 0) return;

    // FuseFire stays put so it can deterministically spread to adjacent fuse
    // cells. Without this, the fire gas floats away before it can propagate.
    if (mat === Material.FuseFire) return;

    // Read per-cell physics fields
    const gravity = this.getGravity(x, y);
    const temp = this.getTemperature(x, y);
    const windX = this.getWindX(x, y);
    const windY = this.getWindY(x, y);

    // Apply gravity multiplier — at 0 gravity, nothing falls
    if (gravity <= 0) return;

    const dy = def.gravityDir;
    const isLiquid = def.liquid;
    const isGas = def.gas;

    // --- Wind: apply horizontal/vertical force from per-cell wind field ---
    if (windX !== 0 || windY !== 0) {
      const wdx = windX > 0 ? 1 : windX < 0 ? -1 : 0;
      const wdy = windY > 0 ? 1 : windY < 0 ? -1 : 0;
      // Scale chance with wind magnitude: 30 = 100% move chance.
      // Strong impulses (100+) reliably push particles every frame.
      const windChance = Math.min(1, (Math.abs(windX) + Math.abs(windY)) / 30);
      if (Math.random() < windChance) {
        // Strong wind can shove into occupied cells (displace liquids/gases)
        const windMag = Math.abs(windX) + Math.abs(windY);
        if (windMag >= 50) {
          if (this.tryShove(x, y, x + wdx, y + wdy)) return;
        } else {
          if (this.trySwap(x, y, x + wdx, y + wdy)) return;
        }
      }
    }

    // --- Edge friction ---
    const hasLeft = x > 0 && this.grid[y * W + (x - 1)] !== 0;
    const hasRight = x < W - 1 && this.grid[y * W + (x + 1)] !== 0;
    const isExterior = !hasLeft || !hasRight;

    // Honey: very thick — high friction, barely flows
    if (mat === Material.Honey && isExterior && Math.random() < 0.7) return;

    // Exterior particles have a chance to skip falling (friction).
    if (isExterior && !isGas) {
      const frictionChance = 0.3 / Math.max(1, def.gravity);
      if (Math.random() < frictionChance) return;
    }

    // --- Gas flicker: random chance to not move at all ---
    // Prevents gasses from rising in uniform horizontal lines. Each particle
    // has a chance to "flicker" in place, creating organic, non-uniform spread.
    if (isGas) {
      const flickerChance = (mat === Material.Fire || mat === Material.FuseFire) ? 0.35 : 0.25;
      if (Math.random() < flickerChance) return;
    }

    // --- Density-scaled horizontal impulse ---
    // Lighter materials (low gravity) get more impulse; denser materials get less.
    // Sand (gravity 1) → full impulse, Water (gravity 2) → half, Lava (gravity 3) → third
    // Gasses (fire/smoke/steam) also get impulse so they drift sideways while rising.
    if (this.horizontalImpulseChance > 0) {
      const scaledChance = this.horizontalImpulseChance / Math.max(1, def.gravity);
      if (Math.random() < scaledChance) {
        const nudgeDir = Math.random() < 0.5 ? -1 : 1;
        const nudge = nudgeDir * Math.max(1, Math.round(this.horizontalImpulseStrength));
        if (this.trySwap(x, y, x + nudge, y + dy)) return;
      }
    }

    // 1. Try gravity direction
    if (this.trySwap(x, y, x, y + dy)) return;

    // Rubber: bouncy — try to bounce upward when blocked from below
    if (mat === Material.Rubber) {
      // Check if we're resting on something (can't fall)
      const belowY = y + dy;
      const blocked = belowY < 0 || belowY >= H || this.grid[belowY * W + x] !== 0;
      if (blocked) {
        // Bounce: try to move up or sideways
        if (Math.random() < 0.5) {
          if (this.trySwap(x, y, x, y - dy)) return;
        }
        const bounceDir = Math.random() < 0.5 ? -1 : 1;
        if (this.trySwap(x, y, x + bounceDir * 2, y)) return;
        if (this.trySwap(x, y, x + bounceDir, y)) return;
      }
    }

    const dir = Math.random() < 0.5 ? -1 : 1;
    if (this.trySwap(x, y, x + dir, y + dy)) return;
    if (this.trySwap(x, y, x - dir, y + dy)) return;

    if (isLiquid) {
      const flowDir = Math.random() < 0.5 ? -1 : 1;
      if (this.tryFlow(x, y, flowDir, 5)) return;
      if (this.tryFlow(x, y, -flowDir, 5)) return;
    }

    // Gas: wider horizontal drift (up to 3 cells) for organic spread
    if (isGas) {
      const driftDir = Math.random() < 0.5 ? -1 : 1;
      if (this.tryFlow(x, y, driftDir, 3)) return;
      if (this.tryFlow(x, y, -driftDir, 3)) return;
    }

    // 5. Liquids: sink through gas below (heavy liquid displaces light gas upward)
    if (isLiquid && dy > 0) {
      const below = y + 1;
      if (below < H) {
        const belowPacked = this.grid[below * W + x];
        if (belowPacked !== 0) {
          const belowCell = unpack(belowPacked);
          const belowDef = MATERIALS[belowCell.mat];
          if (belowDef?.gas && !(belowCell.flags & FLAG_UPDATED)) {
            this.grid[below * W + x] = pack({ ...cell, flags: cell.flags | FLAG_UPDATED });
            this.grid[idx] = pack({ ...belowCell, flags: belowCell.flags | FLAG_UPDATED });
            return;
          }
          // Dense liquids sink through less-dense liquids (density = gravity).
          // Mercury (gravity 4) sinks through water (2), brine (2.5), honey (1.5),
          // lava (3), molten salt (3), etc.
          if (belowDef?.liquid && def.gravity > belowDef.gravity && !(belowCell.flags & FLAG_UPDATED)) {
            this.grid[below * W + x] = pack({ ...cell, flags: cell.flags | FLAG_UPDATED });
            this.grid[idx] = pack({ ...belowCell, flags: belowCell.flags | FLAG_UPDATED });
            return;
          }
        }
      }
    }

    // Glitter: suspends in water (tries to float up when in water)
    if (mat === Material.Glitter) {
      const below = y + 1 < H ? unpack(this.grid[(y + 1) * W + x]) : null;
      if (below && below.mat === Material.Water) {
        // Stay suspended — don't sink further
        if (Math.random() < 0.8) return;
      }
    }
  }

  private trySwap(x: number, y: number, nx: number, ny: number): boolean {
    const W = this.W, H = this.H;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
    const destIdx = ny * W + nx;
    const srcIdx = y * W + x;
    const srcPacked = this.grid[srcIdx];
    const srcCell = unpack(srcPacked);
    const srcDef = MATERIALS[srcCell.mat as Material];

    const destPacked = this.grid[destIdx];
    if (destPacked === 0) {
      // Empty: simple move
      this.grid[destIdx] = pack({ ...srcCell, flags: srcCell.flags | FLAG_UPDATED });
      this.grid[srcIdx] = 0;
      return true;
    }

    // Gas-to-gas displacement: a lighter gas (higher gravity for upward, i.e.
    // rises faster) can push through a slower gas. This lets fire (gravity 4)
    // rise through smoke (gravity 2) so they separate instead of mixing.
    if (srcDef?.gas) {
      const destCell = unpack(destPacked);
      const destDef = MATERIALS[destCell.mat as Material];
      if (destDef?.gas && srcDef.gravity > destDef.gravity) {
        // Swap: source moves to dest, dest moves to source
        this.grid[destIdx] = pack({ ...srcCell, flags: srcCell.flags | FLAG_UPDATED });
        this.grid[srcIdx] = pack({ ...destCell, flags: destCell.flags | FLAG_UPDATED });
        return true;
      }
    }

    return false;
  }

  /**
   * Like trySwap, but can also displace liquids/gases: if the destination is
   * occupied by a liquid or gas, the two cells swap (the pushed particle moves
   * into the source cell). Solids and walls block the shove. Used by strong
   * wind/impulse forces to push particles through dense media.
   */
  private tryShove(x: number, y: number, nx: number, ny: number): boolean {
    const W = this.W, H = this.H;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
    const destIdx = ny * W + nx;
    const srcIdx = y * W + x;
    const destPacked = this.grid[destIdx];
    // Empty destination: normal swap
    if (destPacked === 0) {
      const packed = this.grid[srcIdx];
      this.grid[destIdx] = pack({ ...unpack(packed), flags: unpack(packed).flags | FLAG_UPDATED });
      this.grid[srcIdx] = 0;
      return true;
    }
    // Occupied: only displace liquids/gases (not solids, walls, or already-updated cells)
    const destCell = unpack(destPacked);
    const destDef = MATERIALS[destCell.mat as Material];
    if (!destDef || !destDef.liquid && !destDef.gas) return false;
    if (destCell.flags & FLAG_UPDATED) return false;
    const srcPacked = this.grid[srcIdx];
    const srcCell = unpack(srcPacked);
    // Swap the two cells
    this.grid[destIdx] = pack({ ...srcCell, flags: srcCell.flags | FLAG_UPDATED });
    this.grid[srcIdx] = pack({ ...destCell, flags: destCell.flags | FLAG_UPDATED });
    return true;
  }

  private tryFlow(x: number, y: number, dir: number, maxSteps: number): boolean {
    const W = this.W, H = this.H;
    for (let step = 1; step <= maxSteps; step++) {
      const nx = x + dir * step;
      if (nx < 0 || nx >= W) return false;
      const destIdx = y * W + nx;
      if (this.grid[destIdx] !== 0) return false;

      const belowY = y + 1;
      if (belowY < H) {
        const belowIdx = belowY * W + nx;
        if (this.grid[belowIdx] === 0) {
          const srcIdx = y * W + x;
          const packed = this.grid[srcIdx];
          this.grid[belowIdx] = pack({ ...unpack(packed), flags: unpack(packed).flags | FLAG_UPDATED });
          this.grid[srcIdx] = 0;
          return true;
        }
      }

      if (step === maxSteps) {
        const srcIdx = y * W + x;
        const packed = this.grid[srcIdx];
        this.grid[destIdx] = pack({ ...unpack(packed), flags: unpack(packed).flags | FLAG_UPDATED });
        this.grid[srcIdx] = 0;
        return true;
      }
    }
    return false;
  }

  private applyReactions(): void {
    const W = this.W, H = this.H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const cell = unpack(this.grid[idx]);
        if (cell.mat === Material.Empty) continue;

        const temp = this.getTemperature(x, y);

        if (cell.mat === Material.Water) {
          const lavaN = this.findNeighbor(x, y, Material.Lava);
          if (lavaN) {
            this.grid[idx] = pack({ mat: Material.Steam, lifetime: 120, flags: randomShade() });
            this.grid[lavaN.y * W + lavaN.x] = pack({ mat: Material.Stone, lifetime: 0, flags: randomShade() });
            continue;
          }
          // High temperature: water evaporates into steam
          if (temp > 1.5 && Math.random() < (temp - 1.5) * 0.02) {
            this.grid[idx] = pack({ mat: Material.Steam, lifetime: 120, flags: randomShade() });
            continue;
          }
          if (this.findNeighbor(x, y, Material.Plant) && Math.random() < 0.02) {
            this.grid[idx] = pack({ mat: Material.Plant, lifetime: 0, flags: randomShade() });
            continue;
          }
        }

        // Low temperature: fire/fusefire dies faster
        if ((cell.mat === Material.Fire || cell.mat === Material.FuseFire) && temp < 0.5) {
          if (Math.random() < (0.5 - temp) * 0.1) {
            this.grid[idx] = pack({ mat: Material.Smoke, lifetime: 60, flags: randomShade() });
            continue;
          }
        }
      }
    }
  }

  // ===========================================================================
  // Special reactions for new materials
  // ===========================================================================

  private applySpecialReactions(): void {
    const W = this.W, H = this.H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const cell = unpack(this.grid[idx]);
        if (cell.mat === Material.Empty) continue;
        const mat = cell.mat;
        const temp = this.getTemperature(x, y);

        // --- Antimatter: eliminates any normal neighbor, small explosion ---
        if (mat === Material.Antimatter) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const n = unpack(this.grid[ny * W + nx]);
              if (n.mat !== Material.Empty && n.mat !== Material.Antimatter && n.mat !== Material.Wall) {
                // Annihilate both
                this.grid[ny * W + nx] = 0;
                this.grid[idx] = 0;
                // Create fire explosion
                this.explode(x, y, 3);
                break;
              }
            }
          }
          continue;
        }

        // --- Plasma: damages everything around, decays quickly ---
        if (mat === Material.Plasma) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const n = unpack(this.grid[ny * W + nx]);
              if (n.mat !== Material.Empty && n.mat !== Material.Plasma && n.mat !== Material.Wall) {
                if (Math.random() < 0.3) {
                  this.grid[ny * W + nx] = pack({ mat: Material.Fire, lifetime: 10, flags: randomShade() });
                }
              }
            }
          }
          continue;
        }

        // --- Mystery (???): oscillating reaction ---
        // Changes color/behavior in a sine wave pattern based on frame count
        if (mat === Material.Mystery) {
          const phase = Math.sin(this.frame * 0.1 + x * 0.3 + y * 0.2);
          if (phase > 0.9 && Math.random() < 0.1) {
            // Emit plasma occasionally
            const above = y > 0 ? this.grid[(y - 1) * W + x] : 1;
            if (above === 0) {
              this.grid[(y - 1) * W + x] = pack({ mat: Material.Plasma, lifetime: 20, flags: randomShade() });
            }
          }
          if (phase < -0.9 && Math.random() < 0.05) {
            // Absorb nearby particles
            const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
            const [dx, dy] = dirs[Math.floor(Math.random() * 4)];
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              const n = unpack(this.grid[ny * W + nx]);
              if (n.mat !== Material.Empty && n.mat !== Material.Wall && n.mat !== Material.Mystery) {
                this.grid[ny * W + nx] = 0;
              }
            }
          }
          continue;
        }

        // --- Gasoline: slowly vaporizes into gas vapor ---
        if (mat === Material.Gasoline) {
          if (Math.random() < 0.005) {
            const above = y > 0 ? this.grid[(y - 1) * W + x] : 1;
            if (above === 0) {
              this.grid[(y - 1) * W + x] = pack({ mat: Material.GasVapor, lifetime: 200, flags: randomShade() });
              // Small chance to consume the gasoline
              if (Math.random() < 0.3) this.grid[idx] = 0;
            }
          }
          continue;
        }

        // --- Salt + Water → Brine ---
        if (mat === Material.Salt) {
          const waterN = this.findNeighbor(x, y, Material.Water);
          if (waterN && Math.random() < 0.1) {
            this.grid[idx] = pack({ mat: Material.Brine, lifetime: 0, flags: randomShade() });
            this.grid[waterN.y * W + waterN.x] = pack({ mat: Material.Brine, lifetime: 0, flags: randomShade() });
            continue;
          }
          // Salt dissolves snow: 1 salt grain melts up to 10 snow cells nearby
          const snowN = this.findNeighbor(x, y, Material.Snow);
          if (snowN) {
            // Remove the salt grain
            this.grid[idx] = 0;
            // Dissolve up to 10 snow cells in a radius
            let dissolved = 0;
            for (let ry = y - 3; ry <= y + 3 && dissolved < 10; ry++) {
              for (let rx = x - 3; rx <= x + 3 && dissolved < 10; rx++) {
                if (rx < 0 || rx >= W || ry < 0 || ry >= H) continue;
                const ridx = ry * W + rx;
                if (unpack(this.grid[ridx]).mat === Material.Snow) {
                  this.grid[ridx] = pack({ mat: Material.Water, lifetime: 0, flags: randomShade() });
                  dissolved++;
                }
              }
            }
            continue;
          }
          // High temp: salt → molten salt (destructive liquid)
          if (temp > 1.8 && Math.random() < 0.02) {
            this.grid[idx] = pack({ mat: Material.MoltenSalt, lifetime: 0, flags: randomShade() });
            continue;
          }
        }

        // --- Molten Salt: destroys neighbors, cools to salt in low temp ---
        if (mat === Material.MoltenSalt) {
          if (temp < 0.5 && Math.random() < 0.05) {
            this.grid[idx] = pack({ mat: Material.Salt, lifetime: 0, flags: randomShade() });
            continue;
          }
          // Contact with water → violent impulse explosion (steam pressure, not destruction)
          const waterN = this.findNeighbor(x, y, Material.Water);
          if (waterN) {
            this.applyImpulse(x, y, 6, 100);
            // Convert water to steam, molten salt cools to salt
            this.grid[waterN.y * W + waterN.x] = pack({ mat: Material.Steam, lifetime: 80, flags: randomShade() });
            if (Math.random() < 0.3) {
              this.grid[idx] = pack({ mat: Material.Salt, lifetime: 0, flags: randomShade() });
            }
            continue;
          }
          // Contact with dry ice → violent impulse explosion (thermal shock)
          const dryIceN = this.findNeighbor(x, y, Material.DryIce);
          if (dryIceN) {
            this.applyImpulse(x, y, 6, 100);
            // Consume the dry ice, cool molten salt to salt
            this.grid[dryIceN.y * W + dryIceN.x] = 0;
            if (Math.random() < 0.5) {
              this.grid[idx] = pack({ mat: Material.Salt, lifetime: 0, flags: randomShade() });
            }
            continue;
          }
          // Ignite flammable neighbors on contact (molten salt is very hot)
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const n = unpack(this.grid[ny * W + nx]);
              const ndef = MATERIALS[n.mat as Material];
              if (ndef?.flammable && Math.random() < 0.15) {
                this.grid[ny * W + nx] = pack({ mat: Material.Fire, lifetime: 30, flags: randomShade() });
              }
            }
          }
          continue;
        }

        // --- Concrete Powder + Water → Concrete ---
        if (mat === Material.ConcretePowder) {
          const waterN = this.findNeighbor(x, y, Material.Water);
          if (waterN && Math.random() < 0.2) {
            this.grid[idx] = pack({ mat: Material.Concrete, lifetime: 0, flags: randomShade() });
            // Consume the water
            this.grid[waterN.y * W + waterN.x] = 0;
            continue;
          }
        }

        // --- Dry Ice: sublimates into CO2 gas (smoke-like, no water) ---
        if (mat === Material.DryIce) {
          if (Math.random() < 0.02) {
            const above = y > 0 ? this.grid[(y - 1) * W + x] : 1;
            if (above === 0) {
              this.grid[(y - 1) * W + x] = pack({ mat: Material.Smoke, lifetime: 60, flags: randomShade() });
              if (Math.random() < 0.5) this.grid[idx] = 0;
            }
          }
          continue;
        }

        // --- Liquid Nitrogen: cools neighbors, evaporates ---
        if (mat === Material.LiquidNitrogen) {
          // Cool down nearby fire/lava
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const n = unpack(this.grid[ny * W + nx]);
              if (n.mat === Material.Fire || n.mat === Material.FuseFire || n.mat === Material.Lava || n.mat === Material.Plasma) {
                this.grid[ny * W + nx] = n.mat === Material.Lava
                  ? pack({ mat: Material.Stone, lifetime: 0, flags: randomShade() })
                  : 0;
              }
            }
          }
          if (Math.random() < 0.01) {
            this.grid[idx] = pack({ mat: Material.Steam, lifetime: 40, flags: randomShade() });
          }
          continue;
        }

        // --- Seed: grows into tree on dirt ---
        if (mat === Material.Seed) {
          const below = y + 1 < H ? unpack(this.grid[(y + 1) * W + x]) : null;
          if (below && (below.mat === Material.Dirt || below.mat === Material.Grass)) {
            if (Math.random() < 0.05) {
              this.growTree(x, y);
              continue;
            }
          }
          continue;
        }

        // --- Grass: spreads on top of dirt ---
        if (mat === Material.Grass) {
          const below = y + 1 < H ? unpack(this.grid[(y + 1) * W + x]) : null;
          if (below && below.mat === Material.Dirt) {
            // Spread sideways on dirt surface
            if (Math.random() < 0.02) {
              const dir = Math.random() < 0.5 ? -1 : 1;
              const nx = x + dir;
              if (nx >= 0 && nx < W) {
              const belowN = y + 1 < H ? unpack(this.grid[(y + 1) * W + nx]) : null;
                if (belowN && belowN.mat === Material.Dirt && this.grid[y * W + nx] === 0) {
                  this.grid[y * W + nx] = pack({ mat: Material.Grass, lifetime: 0, flags: randomShade() });
                }
              }
            }
          }
          continue;
        }

        // --- Nanobots: randomly move around and slowly eat through materials ---
        if (mat === Material.Nanobots) {
          // Pick a random direction to move/eat
          const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
          const [dx, dy] = dirs[Math.floor(Math.random() * 8)];
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const target = this.grid[ny * W + nx];
            const n = unpack(target);
            if (n.mat === Material.Empty) {
              // Move into empty space
              this.grid[ny * W + nx] = pack({ mat, lifetime: cell.lifetime, flags: cell.flags | FLAG_UPDATED });
              this.grid[idx] = 0;
            } else if (n.mat !== Material.Nanobots && n.mat !== Material.Wall &&
                       n.mat !== Material.Antimatter) {
              // Eat through the material — slowly destroy it (5% chance per frame)
              if (Math.random() < 0.05) {
                this.grid[ny * W + nx] = 0;
              }
            }
          }
          continue;
        }

        // --- Magic Powder: random color flicker, explodes on flesh, decays like fire ---
        if (mat === Material.MagicPowder) {
          // Random shade flicker each frame (independent per particle, no spatial pattern)
          if (Math.random() < 0.5) {
            const newShade = Math.floor(Math.random() * 4);
            this.grid[idx] = pack({ mat, lifetime: cell.lifetime, flags: (cell.flags & ~SHADE_MASK) | newShade | FLAG_UPDATED });
          }
          // Explodes on contact with flesh
          const fleshN = this.findNeighbor(x, y, Material.Flesh);
          if (fleshN && Math.random() < 0.3) {
            this.explode(x, y, 4);
            continue;
          }
          // Emit fireflies in a random direction (not always upward)
          if (Math.random() < 0.02) {
            const dx = Math.floor(Math.random() * 3) - 1;
            const dy = Math.floor(Math.random() * 3) - 1;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H && this.grid[ny * W + nx] === 0) {
              this.grid[ny * W + nx] = pack({ mat: Material.Fireflies, lifetime: 255, flags: randomShade() });
            }
          }
          continue;
        }

        // --- Popcorn: pops like fireworks near fire/lava/molten salt or high heat ---
        if (mat === Material.Popcorn) {
          const fireN = this.findNeighbor(x, y, Material.Fire) || this.findNeighbor(x, y, Material.FuseFire);
          const lavaN = this.findNeighbor(x, y, Material.Lava);
          const moltenSaltN = this.findNeighbor(x, y, Material.MoltenSalt);
          const hot = temp > 1.3;
          if ((fireN || lavaN || moltenSaltN || hot) && Math.random() < 0.3) {
            // Fireworks pop: radial impulse + scatter popcorn particles outward
            this.applyImpulse(x, y, 4, 60);
            // Scatter popcorn particles in random directions
            const dirs = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
            for (const [dx, dy] of dirs) {
              if (Math.random() < 0.6) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && nx < W && ny >= 0 && ny < H && this.grid[ny * W + nx] === 0) {
                  this.grid[ny * W + nx] = pack({ mat: Material.Popcorn, lifetime: 0, flags: randomShade() });
                }
              }
            }
            // The original kernel becomes popcorn (already is) — sometimes launches up
            if (Math.random() < 0.5 && y > 0 && this.grid[(y - 1) * W + x] === 0) {
              this.grid[(y - 1) * W + x] = pack({ mat: Material.Popcorn, lifetime: 0, flags: randomShade() });
            }
          }
          continue;
        }

        // --- Dynamite: detonated by fire or fuse ---
        if (mat === Material.Dynamite) {
          const fireN = this.findNeighbor(x, y, Material.Fire);
          const fuseN = this.findNeighbor(x, y, Material.Fuse);
          if ((fireN || fuseN) && Math.random() < 0.2) {
            this.explode(x, y, 6);
          }
          continue;
        }

        // --- C4: only detonates when a burning fuse is adjacent.
        // C4 itself burns like wax (flammable, slow burn) but does NOT explode from fire alone.
        // Chain-detonates all connected C4 via flood fill. ---
        if (mat === Material.C4) {
          // C4 only detonates when adjacent to FuseFire (fire from a burning fuse).
          // Regular fire does NOT trigger C4 — only fuse fire does.
          let fuseBurning = false;
          for (let dy = -1; dy <= 1 && !fuseBurning; dy++) {
            for (let dx = -1; dx <= 1 && !fuseBurning; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const n = unpack(this.grid[ny * W + nx]);
              if (n.mat === Material.FuseFire) { fuseBurning = true; break; }
            }
          }
          if (fuseBurning && Math.random() < 0.3) {
            this.detonateC4(x, y);
          }
          continue;
        }

        // --- Flour: dust explosion when suspended near fire ---
        if (mat === Material.Flour) {
          const fireN = this.findNeighbor(x, y, Material.Fire);
          if (fireN && Math.random() < 0.15) {
            this.explode(x, y, 3);
          }
          continue;
        }

        // --- Hydrogen: explodes near fire ---
        if (mat === Material.Hydrogen) {
          const fireN = this.findNeighbor(x, y, Material.Fire);
          if (fireN && Math.random() < 0.3) {
            this.explode(x, y, 4);
          }
          continue;
        }

        // --- Glitter: suspends in water, floats in air ---
        // (handled in tryMove via low gravity — no special reaction needed)

        // --- Fireflies: random flicker + organic flight, spread out (no buoyancy) ---
        if (mat === Material.Fireflies) {
          // Flicker: each firefly independently picks a random shade each frame.
          // Uses cell.lifetime as a per-particle phase seed so neighbors don't sync.
          if (Math.random() < 0.5) {
            const newShade = Math.floor(Math.random() * 4);
            this.grid[idx] = pack({ mat, lifetime: cell.lifetime, flags: (cell.flags & ~SHADE_MASK) | newShade | FLAG_UPDATED });
          }

          // Flight: pure random walk in all 8 directions + occasional darts.
          // No gravity/buoyancy — they spread out evenly in all directions.
          if (Math.random() < 0.7) {
            let dx: number, dy: number;
            if (Math.random() < 0.2) {
              // Dart: 2-3 cell jump for organic burst movement
              dx = Math.floor(Math.random() * 7) - 3;
              dy = Math.floor(Math.random() * 7) - 3;
            } else {
              // Normal: 1-cell step in any of 8 directions (uniform)
              dx = Math.floor(Math.random() * 3) - 1;
              dy = Math.floor(Math.random() * 3) - 1;
            }
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H && this.grid[ny * W + nx] === 0) {
              this.grid[ny * W + nx] = pack({ mat, lifetime: cell.lifetime, flags: cell.flags | FLAG_UPDATED });
              this.grid[idx] = 0;
            }
          }
          continue;
        }

        // --- Toast: made from bread near fire (future), burns like wood ---
        // --- Wax: slow burning (handled by combustion + aging) ---
        // --- Rubber: bouncy (handled in tryMove) ---
      }
    }
  }

  /**
   * Apply a radial impulse: immediately shoves particles outward from (cx, cy)
   * and sets per-cell wind fields for ongoing push. This pushes particles away
   * without destroying them. The wind decays each frame via decayWind().
   *
   * Immediate displacement: process rings from outermost to innermost so outer
   * particles move first, creating space for inner ones. Each particle is
   * shoved one cell radially outward (displacing liquids/gases via tryShove).
   *
   * Wind field: sets radial wind with linear falloff for continued push over
   * the next several frames.
   */
  private applyImpulse(cx: number, cy: number, radius: number, strength: number): void {
    const W = this.W, H = this.H;

    // --- Phase 1: Immediate radial displacement (outer ring → inner ring) ---
    // Process from the outermost ring inward so outer particles shove out first,
    // creating space for inner particles to follow.
    for (let ring = radius; ring >= 1; ring--) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        for (let x = cx - ring; x <= cx + ring; x++) {
          // Only process cells on the current ring boundary (skip inner cells)
          const dx = x - cx, dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (Math.round(dist) !== ring) continue;
          if (x < 0 || x >= W || y < 0 || y >= H) continue;

          const idx = y * W + x;
          const packed = this.grid[idx];
          if (packed === 0) continue;
          const cell = unpack(packed);
          if (cell.flags & FLAG_UPDATED) continue;
          // Don't move walls or static solids
          const def = MATERIALS[cell.mat as Material];
          if (!def || cell.mat === Material.Wall || cell.mat === Material.Stone) continue;

          // Shove one step radially outward
          const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
          const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
          this.tryShove(x, y, x + stepX, y + stepY);
        }
      }
    }

    // --- Phase 2: Set wind fields for ongoing push ---
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius || dist < 0.5) continue;
        // Falloff: strongest at center, weaker at edge
        const falloff = 1 - dist / radius;
        const mag = strength * falloff;
        const ux = dx / dist, uy = dy / dist;
        const fi = (y * W + x) * 4;
        // Add to existing wind (clamped to i8 range), sign-extended for proper arithmetic
        const curWx = (this.fields[fi + FIELD.WIND_X] << 24) >> 24;
        const curWy = (this.fields[fi + FIELD.WIND_Y] << 24) >> 24;
        const newWx = Math.max(-127, Math.min(127, Math.round(curWx + ux * mag)));
        const newWy = Math.max(-127, Math.min(127, Math.round(curWy + uy * mag)));
        this.fields[fi + FIELD.WIND_X] = newWx & 0xff;
        this.fields[fi + FIELD.WIND_Y] = newWy & 0xff;
      }
    }
  }

  /** Decay all wind fields toward 0 each frame so impulses fade over time. */
  private decayWind(): void {
    const W = this.W, H = this.H;
    for (let i = 0; i < W * H * 4; i += 4) {
      if (this.fields[i + FIELD.WIND_X] !== 0) {
        const v = (this.fields[i + FIELD.WIND_X] << 24) >> 24;
        // Decay by ~25% per frame, minimum step of 1
        const dec = Math.abs(v) >= 4 ? Math.trunc(v * 0.75) : v > 0 ? v - 1 : v < 0 ? v + 1 : 0;
        this.fields[i + FIELD.WIND_X] = dec & 0xff;
      }
      if (this.fields[i + FIELD.WIND_Y] !== 0) {
        const v = (this.fields[i + FIELD.WIND_Y] << 24) >> 24;
        const dec = Math.abs(v) >= 4 ? Math.trunc(v * 0.75) : v > 0 ? v - 1 : v < 0 ? v + 1 : 0;
        this.fields[i + FIELD.WIND_Y] = dec & 0xff;
      }
    }
  }

  /** Create an explosion: fire + smoke in a radius */
  private explode(cx: number, cy: number, radius: number): void {
    const W = this.W, H = this.H;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (dist > radius * radius) continue;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const c = unpack(this.grid[y * W + x]);
        if (c.mat === Material.Wall) continue;
        // Don't destroy C4 in the blast — let detonateC4 handle chain reactions
        if (c.mat === Material.C4) continue;
        if (dist < radius * radius * 0.3) {
          // Core: fire
          this.grid[y * W + x] = pack({ mat: Material.Fire, lifetime: 20, flags: randomShade() });
        } else {
          // Outer: smoke or empty
          if (Math.random() < 0.5) {
            this.grid[y * W + x] = pack({ mat: Material.Smoke, lifetime: 60, flags: randomShade() });
          } else {
            this.grid[y * W + x] = 0;
          }
        }
      }
    }
  }

  /** Detonate C4 at (cx, cy) and flood-fill all connected C4 for chain reaction */
  private detonateC4(cx: number, cy: number): void {
    const W = this.W, H = this.H;
    // Collect all connected C4 cells (8-connected flood fill)
    const stack: number[] = [cy * W + cx];
    const visited = new Set<number>();
    const c4Cells: number[] = [];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (visited.has(idx)) continue;
      visited.add(idx);
      const px = idx % W;
      const py = Math.floor(idx / W);
      const c = unpack(this.grid[idx]);
      if (c.mat !== Material.C4) continue;
      c4Cells.push(idx);
      // Check 8 neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          stack.push(ny * W + nx);
        }
      }
    }
    // Explode each C4 cell
    for (const idx of c4Cells) {
      const px = idx % W;
      const py = Math.floor(idx / W);
      this.explode(px, py, 8);
    }
  }

  /** Grow a tree from a seed at (x, y) on dirt */
  private growTree(x: number, y: number): void {
    const W = this.W, H = this.H;
    // Remove seed, place root
    this.grid[y * W + x] = pack({ mat: Material.Root, lifetime: 0, flags: randomShade() });
    // Grow trunk upward
    const trunkHeight = 8 + Math.floor(Math.random() * 8);
    let topY = y;
    for (let i = 1; i <= trunkHeight; i++) {
      const ty = y - i;
      if (ty < 0) break;
      if (this.grid[ty * W + x] !== 0) break;
      this.grid[ty * W + x] = pack({ mat: Material.TreeWood, lifetime: 0, flags: randomShade() });
      topY = ty;
    }
    // Grow leaves canopy
    const canopyRadius = 3 + Math.floor(Math.random() * 2);
    for (let dy = -canopyRadius; dy <= 0; dy++) {
      for (let dx = -canopyRadius; dx <= canopyRadius; dx++) {
        const lx = x + dx, ly = topY + dy - canopyRadius;
        if (lx < 0 || lx >= W || ly < 0 || ly >= H) continue;
        const dist = dx * dx + dy * dy;
        if (dist > canopyRadius * canopyRadius) continue;
        if (this.grid[ly * W + lx] !== 0) continue;
        if (Math.random() < 0.7) {
          this.grid[ly * W + lx] = pack({ mat: Material.Leaf, lifetime: 0, flags: randomShade() });
        }
      }
    }
  }

  private findNeighbor(x: number, y: number, mat: number): { x: number; y: number } | null {
    const W = this.W, H = this.H;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const c = unpack(this.grid[ny * W + nx]);
        if (c.mat === mat) return { x: nx, y: ny };
      }
    }
    return null;
  }

  private applyCombustion(): void {
    const W = this.W, H = this.H;
    // Snapshot which cells are fire/lava at the start of this pass.
    // Only these cells can spread fire — newly ignited cells wait until next frame.
    // This prevents instant cascade through fuse/gunpowder chains in a single pass.
    const fireSources = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const m = this.grid[i] & 0xff;
      if (m === Material.Fire || m === Material.FuseFire || m === Material.Lava) fireSources[i] = 1;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (!fireSources[idx]) continue;
        const c = this.getCell(x, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const n = this.getCell(nx, ny);
            const def = MATERIALS[n.mat as Material];
            if (!def?.flammable) continue;
            if (n.mat === Material.Gunpowder) {
              this.setCell(nx, ny, { mat: Material.Fire, lifetime: 15, flags: randomShade() });
              continue;
            }
            // Gas vapor and hydrogen: explosive
            if (n.mat === Material.GasVapor || n.mat === Material.Hydrogen) {
              this.setCell(nx, ny, { mat: Material.Fire, lifetime: 20, flags: randomShade() });
              this.explode(nx, ny, 3);
              continue;
            }
            // Flour: dust explosion
            if (n.mat === Material.Flour) {
              this.explode(nx, ny, 3);
              continue;
            }
            // Dynamite: chain detonate
            if (n.mat === Material.Dynamite) {
              this.explode(nx, ny, 6);
              continue;
            }
            const baseChance = c.mat === Material.Lava ? 0.1 : 0.08;
            // Rubber is hard to ignite — low continual burn/spread chance
            const matMult = n.mat === Material.Rubber ? 0.3 : 1.0;
            // Per-cell temperature scales fire spread rate
            const chance = baseChance * this.getTemperature(nx, ny) * matMult;
            if (Math.random() < chance) {
              // Fuse gets FuseFire (yellow, stays put, deterministic spread)
              if (n.mat === Material.Fuse) {
                this.setCell(nx, ny, { mat: Material.FuseFire, lifetime: 15, flags: randomShade() });
              } else {
                this.setCell(nx, ny, { mat: Material.Fire, lifetime: 30, flags: randomShade() });
              }
            }
          }
        }
      }
    }

    // --- Deterministic fuse burn ---
    // FuseFire deterministically ignites ALL adjacent fuse cells when its
    // lifetime drops to the threshold. The fire has a short lifetime
    // (FUSE_FIRE_LIFETIME) so the flame trail is brief. The burn speed is
    // controlled by the lifetime: each cell burns for FUSE_FIRE_LIFETIME frames
    // before passing the flame onward.
    //
    // FuseFire is a separate material (Material.FuseFire) so it's reliably
    // identified even at the end of the trail where all adjacent fuse has been
    // consumed. No flag bits needed.
    //
    // To prevent single-frame cascades, we use an ignitedFuse set.
    const FUSE_FIRE_LIFETIME = 15;
    const FUSE_SPREAD_THRESHOLD = 3;
    const ignitedFuse = new Set<number>();
    for (let i = 0; i < W * H; i++) {
      const c = unpack(this.grid[i]);
      if (c.mat !== Material.FuseFire) continue;
      if (c.lifetime > FUSE_SPREAD_THRESHOLD || c.lifetime === 0) continue;
      const x = i % W;
      const y = Math.floor(i / W);

      // Emit sparks: small fire particles that fly upward with random spread.
      // Sparks use Material.Fire (red) so they're visually distinct from the
      // yellow fuse fire and fly freely (FuseFire is anchored, Fire is not).
      for (let s = 0; s < 3; s++) {
        if (Math.random() < 0.5) {
          const sx = x + Math.floor(Math.random() * 3) - 1;
          const sy = y - 1 - Math.floor(Math.random() * 2); // 1-2 cells above
          if (sx >= 0 && sx < W && sy >= 0 && sy < H && this.grid[sy * W + sx] === 0) {
            // Sparks: very short lifetime, expire to empty (not smoke) so they
            // don't accumulate and suffocate the burn when going upward.
            this.grid[sy * W + sx] = pack({ mat: Material.Fire, lifetime: 6, flags: randomShade() | FLAG_SPARK });
            // Give the spark upward wind + random horizontal drift
            const fi = (sy * W + sx) * 4;
            const driftX = Math.floor(Math.random() * 7) - 3; // -3 to 3
            this.fields[fi + FIELD.WIND_X] = driftX & 0xff;
            this.fields[fi + FIELD.WIND_Y] = (-30) & 0xff; // strong upward
          }
        }
      }

      // Spread to adjacent fuse cells
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (ignitedFuse.has(ni)) continue;
          const n = unpack(this.grid[ni]);
          if (n.mat === Material.Fuse) {
            this.setCell(nx, ny, { mat: Material.FuseFire, lifetime: FUSE_FIRE_LIFETIME, flags: randomShade() });
            ignitedFuse.add(ni);
          }
        }
      }
    }
  }

  private applyAging(): void {
    const W = this.W, H = this.H;
    for (let i = 0; i < W * H; i++) {
      const packed = this.grid[i];
      if (packed === 0) continue;
      const c = unpack(packed);
      if (c.lifetime > 0) {
        // Randomized decay: fire/smoke/steam sometimes skip a tick so
        // individual particles last variable amounts of time.
        if (c.mat === Material.Fire) {
          if (Math.random() < 0.7) c.lifetime--;
        } else if (c.mat === Material.FuseFire) {
          // FuseFire decays deterministically for consistent burn speed
          c.lifetime--;
        } else if (c.mat === Material.Smoke) {
          if (Math.random() < 0.8) c.lifetime--;
        } else if (c.mat === Material.Steam) {
          if (Math.random() < 0.75) c.lifetime--;
        } else if (c.mat === Material.MagicPowder) {
          if (Math.random() < 0.7) c.lifetime--;
        } else {
          c.lifetime--;
        }
        if (c.lifetime === 0) {
          if (c.mat === Material.Fire) {
            // Sparks expire to empty, not smoke. Sparks are marked with
            // FLAG_SPARK (bit 3) to distinguish them from regular fire.
            if (c.flags & FLAG_SPARK) {
              this.grid[i] = 0;
              continue;
            }
            c.mat = Material.Smoke;
            c.lifetime = 120;
          } else if (c.mat === Material.FuseFire) {
            // FuseFire expires to empty (not smoke) — smoke would accumulate
            // below the rising fire and suffocate the burn trail.
            this.grid[i] = 0;
            continue;
          } else if (c.mat === Material.Smoke) {
            this.grid[i] = 0;
            continue;
          } else if (c.mat === Material.Steam) {
            if (Math.random() < 0.7) {
              c.mat = Material.Water;
              c.lifetime = 0;
            } else {
              this.grid[i] = 0;
              continue;
            }
          } else if (c.mat === Material.GasVapor) {
            // Expired vapor → empty
            this.grid[i] = 0;
            continue;
          } else if (c.mat === Material.Hydrogen) {
            this.grid[i] = 0;
            continue;
          } else if (c.mat === Material.Plasma) {
            // Plasma → fire then smoke
            c.mat = Material.Fire;
            c.lifetime = 15;
          } else if (c.mat === Material.Fireflies) {
            // Fireflies don't expire (lifetime stays at max)
            c.lifetime = 255;
          } else if (c.mat === Material.Nanobots) {
            c.lifetime = 255;
          } else if (c.mat === Material.Wood || c.mat === Material.Plant || c.mat === Material.Oil ||
                     c.mat === Material.Flesh || c.mat === Material.Leaf || c.mat === Material.TreeWood ||
                     c.mat === Material.Root || c.mat === Material.Grass || c.mat === Material.Toast ||
                     c.mat === Material.Plastic || c.mat === Material.Wax || c.mat === Material.Fuse ||
                     c.mat === Material.Rubber || c.mat === Material.C4 || c.mat === Material.Glitter ||
                     c.mat === Material.MagicPowder) {
            c.mat = Material.Smoke;
            c.lifetime = 60;
          }
        }
      }
      c.flags &= ~FLAG_UPDATED;
      this.grid[i] = pack(c);
    }
  }
}
