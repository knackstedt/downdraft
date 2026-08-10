import { Material, MATERIALS } from "./materials";

export const SHADES_PER_MATERIAL = 4;

// Per-material shade variation factors. Most materials use the default
// [0.82, 0.91, 1.0, 1.08], but water and sand use subtler variation
// since they cover large areas where high variation looks noisy.
// Fire uses a deep-red shift: some particles are darker and redder.
const DEFAULT_SHADES = [0.82, 0.91, 1.0, 1.08];
const SUBTLE_SHADES = [0.93, 0.97, 1.0, 1.03];

// Fire shades: [deep red, red-orange, base orange, bright yellow-orange]
// Each entry is [rMul, gMul, bMul] applied to the base color.
const FIRE_SHADES: [number, number, number][] = [
  [0.85, 0.35, 0.10], // deep red
  [0.95, 0.50, 0.15], // red-orange
  [1.0, 1.0, 1.0],    // base (orange)
  [1.05, 1.15, 0.60], // bright yellow-orange
];

function shadeFactorsFor(mat: Material): number[] {
  if (mat === Material.Water || mat === Material.Sand) return SUBTLE_SHADES;
  return DEFAULT_SHADES;
}

function isFireShaded(mat: Material): boolean {
  return mat === Material.Fire;
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.floor(v)));
}

export function buildPalette(): Uint8Array {
  const colors = new Uint8Array(16 * SHADES_PER_MATERIAL * 4);
  for (let mat = 0; mat < 16; mat++) {
    const m = mat as Material;
    const c = MATERIALS[m]?.color ?? [0, 0, 0, 0];
    const factors = shadeFactorsFor(m);
    for (let shade = 0; shade < SHADES_PER_MATERIAL; shade++) {
      const idx = (mat * SHADES_PER_MATERIAL + shade) * 4;
      if (isFireShaded(m)) {
        const [rMul, gMul, bMul] = FIRE_SHADES[shade];
        colors[idx + 0] = clamp8(c[0] * 255 * rMul);
        colors[idx + 1] = clamp8(c[1] * 255 * gMul);
        colors[idx + 2] = clamp8(c[2] * 255 * bMul);
        colors[idx + 3] = clamp8(c[3] * 255);
      } else {
        const f = factors[shade];
        colors[idx + 0] = clamp8(c[0] * 255 * f);
        colors[idx + 1] = clamp8(c[1] * 255 * f);
        colors[idx + 2] = clamp8(c[2] * 255 * f);
        colors[idx + 3] = clamp8(c[3] * 255);
      }
    }
  }
  return colors;
}
