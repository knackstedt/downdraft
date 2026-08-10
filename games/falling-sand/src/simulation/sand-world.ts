import { MAX_MAGNETS } from "../shared/constants";
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
const SHADE_MASK = 0x03;   // bits 0-1 — shade index (0-3)

function randomShade(): number {
  return Math.floor(Math.random() * 4);
}

function initialLifetime(mat: number): number {
  const def = MATERIALS[mat as Material];
  if (!def) return 0;
  if (mat === Material.Fire) return def.burnTime;
  if (mat === Material.Smoke) return 120;
  if (mat === Material.Steam) return 120;
  return 0;
}

export class SandWorld {
  W: number;
  H: number;
  grid: Uint32Array;
  frame = 0;
  magnets: { x: number; y: number }[] = [];
  wind = { x: 0, y: 0 };
  horizontalImpulseChance = 0.02;
  horizontalImpulseStrength = 1;

  constructor(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.grid = new Uint32Array(w * h);
    // Stone floor
    for (let x = 0; x < w; x++) {
      for (let y = h - 4; y < h; y++) {
        this.grid[y * w + x] = pack({ mat: Material.Stone, lifetime: 0, flags: 0 });
      }
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
        if (c.mat === Material.Stone) continue;
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
          this.setCell(x, y, { mat: Material.Fire, lifetime: def.burnTime, flags: randomShade() });
        }
      }
    }
  }

  setMagnet(x: number, y: number, active: boolean): void {
    if (active) {
      if (this.magnets.length < MAX_MAGNETS) this.magnets.push({ x, y });
    } else {
      this.magnets = [];
    }
  }

  // ===========================================================================
  // Main step
  // ===========================================================================

  step(): void {
    this.frame++;
    const W = this.W, H = this.H;

    // Clear update flags but preserve shade bits (0-1)
    for (let i = 0; i < W * H; i++) {
      this.grid[i] &= ~((0xff & ~SHADE_MASK) << 16);
    }

    this.applyReactions();

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

    const dy = def.gravityDir;
    const isLiquid = def.liquid;
    const isGas = def.gas;

    let magDx = 0, magDy = 0;
    if (mat === Material.Iron && this.magnets.length > 0) {
      const target = this.nearestMagnet(x, y);
      magDx = Math.sign(target.x - x);
      magDy = Math.sign(target.y - y);
    }

    if (mat === Material.Iron && magDy !== 0) {
      if (this.trySwap(x, y, x, y + magDy)) return;
      if (magDx !== 0 && this.trySwap(x, y, x + magDx, y + magDy)) return;
    }

    // --- Edge friction ---
    // Particles on the outside of a mass (missing horizontal neighbors) have
    // a chance to "stick" and not fall this tick. Interior particles (both
    // sides occupied) always fall. This creates fluid pouring behavior where
    // the core flows through while edges lag behind.
    const hasLeft = x > 0 && this.grid[y * W + (x - 1)] !== 0;
    const hasRight = x < W - 1 && this.grid[y * W + (x + 1)] !== 0;
    const isExterior = !hasLeft || !hasRight;

    // Exterior particles have a chance to skip falling (friction).
    // Denser materials (higher gravity) have less friction — they push through.
    if (isExterior && !isGas) {
      const frictionChance = 0.3 / Math.max(1, def.gravity);
      if (Math.random() < frictionChance) return;
    }

    // --- Gas flicker: random chance to not move at all ---
    // Prevents gasses from rising in uniform horizontal lines. Each particle
    // has a chance to "flicker" in place, creating organic, non-uniform spread.
    if (isGas) {
      const flickerChance = mat === Material.Fire ? 0.35 : 0.25;
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
          const belowDef = MATERIALS[belowCell.mat as Material];
          if (belowDef?.gas && !(belowCell.flags & FLAG_UPDATED)) {
            // Liquid sinks down, gas rises up
            this.grid[below * W + x] = pack({ ...cell, flags: cell.flags | FLAG_UPDATED });
            this.grid[idx] = pack({ ...belowCell, flags: belowCell.flags | FLAG_UPDATED });
            return;
          }
        }
      }
    }
  }

  private trySwap(x: number, y: number, nx: number, ny: number): boolean {
    const W = this.W, H = this.H;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return false;
    const destIdx = ny * W + nx;
    if (this.grid[destIdx] !== 0) return false;

    const srcIdx = y * W + x;
    const packed = this.grid[srcIdx];
    this.grid[destIdx] = pack({ ...unpack(packed), flags: unpack(packed).flags | FLAG_UPDATED });
    this.grid[srcIdx] = 0;
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

  private nearestMagnet(x: number, y: number): { x: number; y: number } {
    let best = this.magnets[0];
    let bestD = Infinity;
    for (const m of this.magnets) {
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  private applyReactions(): void {
    const W = this.W, H = this.H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const cell = unpack(this.grid[idx]);
        if (cell.mat === Material.Empty) continue;

        if (cell.mat === Material.Water) {
          const lavaN = this.findNeighbor(x, y, Material.Lava);
          if (lavaN) {
            this.grid[idx] = pack({ mat: Material.Steam, lifetime: 120, flags: randomShade() });
            this.grid[lavaN.y * W + lavaN.x] = pack({ mat: Material.Stone, lifetime: 0, flags: randomShade() });
            continue;
          }
          if (this.findNeighbor(x, y, Material.Plant) && Math.random() < 0.02) {
            this.grid[idx] = pack({ mat: Material.Plant, lifetime: 0, flags: randomShade() });
            continue;
          }
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
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = this.getCell(x, y);
        if (c.mat !== Material.Fire && c.mat !== Material.Lava) continue;
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
            const chance = c.mat === Material.Lava ? 0.1 : 0.08;
            if (Math.random() < chance) {
              this.setCell(nx, ny, { mat: Material.Fire, lifetime: def.burnTime, flags: randomShade() });
            }
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
        } else if (c.mat === Material.Smoke) {
          if (Math.random() < 0.8) c.lifetime--;
        } else if (c.mat === Material.Steam) {
          if (Math.random() < 0.75) c.lifetime--;
        } else {
          c.lifetime--;
        }
        if (c.lifetime === 0) {
          if (c.mat === Material.Fire) {
            c.mat = Material.Smoke;
            c.lifetime = 120;
          } else if (c.mat === Material.Smoke) {
            // Expired smoke → truly empty (clear all flags so packed value is 0)
            this.grid[i] = 0;
            continue;
          } else if (c.mat === Material.Steam) {
            if (Math.random() < 0.7) {
              c.mat = Material.Water;
              c.lifetime = 0;
            } else {
              // Expired steam → truly empty
              this.grid[i] = 0;
              continue;
            }
          } else if (c.mat === Material.Wood || c.mat === Material.Plant || c.mat === Material.Oil || c.mat === Material.Flesh) {
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
