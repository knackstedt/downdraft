import { GRID_H, GRID_W, MAX_MAGNETS } from "../shared/constants";
import { Material, MATERIALS } from "./materials";

const W = GRID_W;
const H = GRID_H;

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

export class SandWorld {
  grid = new Uint32Array(W * H);
  next = new Uint32Array(W * H);
  frame = 0;
  magnets: { x: number; y: number }[] = [];
  wind = { x: 0, y: 0 };
  fireMap = new Uint8Array(W * H);
  explosionMap = new Uint32Array(W * H);

  constructor() {
    // Initial floor
    for (let x = 0; x < W; x++) {
      for (let y = H - 4; y < H; y++) {
        this.grid[y * W + x] = pack({ mat: Material.Stone, lifetime: 0, flags: 0 });
      }
    }
  }

  getCell(x: number, y: number): Cell {
    if (x < 0 || x >= W || y < 0 || y >= H) return { mat: Material.Empty, lifetime: 0, flags: 0 };
    return unpack(this.grid[y * W + x]);
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    this.grid[y * W + x] = pack(cell);
  }

  paintMaterial(cx: number, cy: number, mat: number, radius: number): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        const c = this.getCell(x, y);
        if (c.mat === Material.Stone) continue; // don't overwrite stone with paint
        this.setCell(x, y, { mat, lifetime: 0, flags: 0 });
      }
    }
  }

  ignite(cx: number, cy: number, radius: number): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        const c = this.getCell(x, y);
        const def = MATERIALS[c.mat as Material];
        if (def?.flammable) {
          this.setCell(x, y, { mat: Material.Fire, lifetime: def.burnTime, flags: 1 });
        } else if (c.mat === Material.Gunpowder) {
          this.explosionMap[y * W + x] = 1;
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

  step(): void {
    this.frame++;
    this.next.fill(0);
    this.fireMap.fill(0);
    this.explosionMap.fill(0);

    // First pass: apply fire ignition/explosion requests from previous frame
    // (handled in separate structures; here we just propagate)

    // Move particles: bottom-to-top, left-to-right
    for (let y = H - 1; y >= 0; y--) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const cell = unpack(this.grid[idx]);
        if (cell.mat === Material.Empty) continue;

        if (this.next[idx] !== 0) {
          // something already claimed this spot (from below/diagonal), so this cell must have already moved
          continue;
        }

        const dest = this.chooseMove(cell, x, y);
        if (dest) {
          this.next[dest.y * W + dest.x] = pack({ ...cell, lifetime: this.updateLifetime(cell) });
        } else {
          this.next[idx] = pack({ ...cell, lifetime: this.updateLifetime(cell) });
        }
      }
    }

    // Swap
    const tmp = this.grid;
    this.grid = this.next;
    this.next = tmp;

    // Post-step: combustion and explosions
    this.applyCombustion();
    this.applyExplosions();

    // Age out fire/smoke/steam
    for (let i = 0; i < W * H; i++) {
      const c = unpack(this.grid[i]);
      if (c.lifetime > 0) {
        c.lifetime--;
        if (c.lifetime === 0) {
          if (c.mat === Material.Fire) c.mat = Material.Smoke;
          else if (c.mat === Material.Smoke || c.mat === Material.Steam) c.mat = Material.Empty;
          else if (c.mat === Material.Wood || c.mat === Material.Plant || c.mat === Material.Oil) {
            c.mat = Material.Smoke;
            c.lifetime = 60;
          }
        }
      }
      this.grid[i] = pack(c);
    }
  }

  private chooseMove(cell: Cell, x: number, y: number): { x: number; y: number } | null {
    const mat = cell.mat as Material;
    const def = MATERIALS[mat];
    if (!def || def.gravityDir === 0) return null;

    let dy = def.gravityDir;
    let dx = 0;

    // Magnetism for iron
    if (mat === Material.Iron && this.magnets.length > 0) {
      const target = this.nearestMagnet(x, y);
      const sign = Math.sign(target.x - x);
      dx = sign;
    }

    // Wind affects gasses and light particles
    if (def.gas && this.wind.x !== 0) {
      dx += Math.sign(this.wind.x);
    }

    if (mat === Material.Water || mat === Material.Oil || mat === Material.Lava) {
      return this.tryFallOrSlide(cell, x, y, dy, true);
    }
    if (def.gas) {
      return this.tryFallOrSlide(cell, x, y, dy, true);
    }
    return this.tryFallOrSlide(cell, x, y, dy, false);
  }

  private tryFallOrSlide(cell: Cell, x: number, y: number, dy: number, slide: boolean): { x: number; y: number } | null {
    const targets: { x: number; y: number }[] = [];

    // Direct up/down
    targets.push({ x, y: y + dy });

    const alt = this.frame % 2 === 0 ? -1 : 1;
    // Diagonal first direction
    targets.push({ x: x + alt, y: y + dy });
    // Diagonal second direction
    targets.push({ x: x - alt, y: y + dy });

    // For liquids/gasses, also try horizontal on the same row if blocked above/below
    if (slide) {
      targets.push({ x: x + alt, y });
      targets.push({ x: x - alt, y });
    }

    for (const t of targets) {
      if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) continue;
      if (this.next[t.y * W + t.x] === 0 && this.grid[t.y * W + t.x] === 0) {
        return t;
      }
    }
    return null;
  }

  private nearestMagnet(x: number, y: number): { x: number; y: number } {
    let best = this.magnets[0];
    let bestD = Infinity;
    for (const m of this.magnets) {
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private updateLifetime(cell: Cell): number {
    return cell.lifetime;
  }

  private applyCombustion(): void {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = this.getCell(x, y);
        if (c.mat !== Material.Fire && c.mat !== Material.Lava) continue;
        const radius = c.mat === Material.Lava ? 1 : 1;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            const n = this.getCell(nx, ny);
            const def = MATERIALS[n.mat as Material];
            if (def?.flammable && Math.random() < 0.05) {
              this.setCell(nx, ny, { mat: Material.Fire, lifetime: def.burnTime, flags: 1 });
            } else if (n.mat === Material.Gunpowder && c.mat === Material.Fire) {
              this.explosionMap[ny * W + nx] = 1;
            }
          }
        }
      }
    }
  }

  private applyExplosions(): void {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (this.explosionMap[y * W + x] === 0) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (Math.random() < 0.7) {
              this.setCell(nx, ny, { mat: Material.Fire, lifetime: 30, flags: 1 });
            }
          }
        }
      }
    }
  }
}
