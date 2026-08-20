import { Material, packCell } from "@downdraft/library-sand";
import { CAULDRON_WALL_THICKNESS } from "../shared/constants";

/**
 * Initialize the cauldron grid: ring the perimeter with Wall cells, leave the
 * interior empty. The cauldron IS the sand grid — ingredients are painted into
 * the interior and physically mix using SandWorld physics + reactions.
 */
export function initCauldron(grid: Uint32Array, fields: Uint8Array, W: number, H: number): void {
  grid.fill(0);
  const t = CAULDRON_WALL_THICKNESS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Wall ring: top, bottom, left, right strips of thickness t
      const isWall = x < t || x >= W - t || y < t || y >= H - t;
      if (isWall) {
        grid[y * W + x] = packCell(Material.Wall, 0, Math.floor(Math.random() * 4));
      }
    }
  }
  // Initialize fields to defaults (gravity normal, temp normal)
  for (let i = 0; i < W * H * 4; i += 4) {
    fields[i + 0] = 128; // gravity
    fields[i + 1] = 128; // temp
    fields[i + 2] = 0;   // reserved (formerly windX)
    fields[i + 3] = 0;   // reserved (formerly windY)
  }
}

/**
 * Compute the mixture histogram: count of each material id in the cauldron
 * interior (excluding walls). Written to a 256-entry Uint32Array.
 */
export function computeHistogram(grid: Uint32Array, W: number, H: number, out: Uint32Array): void {
  out.fill(0);
  const t = CAULDRON_WALL_THICKNESS;
  for (let y = t; y < H - t; y++) {
    for (let x = t; x < W - t; x++) {
      const mat = grid[y * W + x] & 0xff;
      if (mat !== Material.Empty && mat !== Material.Wall) {
        out[mat]++;
      }
    }
  }
}
