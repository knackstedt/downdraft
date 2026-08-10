import { Material, MATERIALS, MAX_MATERIAL } from "./materials";

export const SHADES_PER_MATERIAL = 4;
export const PALETTE_SIZE = MAX_MATERIAL;

const DEFAULT_SHADES = [0.82, 0.91, 1.0, 1.08];
const SUBTLE_SHADES = [0.93, 0.97, 1.0, 1.03];
// Fireflies: dramatic brightness range for visible flickering (dark → bright)
const FIREFLY_SHADES = [0.15, 0.5, 1.0, 1.6];

const FIRE_SHADES: [number, number, number][] = [
  [0.75, 0.15, 0.05],
  [0.90, 0.30, 0.08],
  [1.0, 0.55, 0.12],
  [1.1, 0.85, 0.25],
];

function shadeFactorsFor(mat: number): number[] {
  if (mat === Material.Water || mat === Material.Sand || mat === Material.Snow ||
      mat === Material.Salt || mat === Material.Flour) return SUBTLE_SHADES;
  if (mat === Material.Fireflies) return FIREFLY_SHADES;
  return DEFAULT_SHADES;
}

function isFireShaded(mat: number): boolean {
  return mat === Material.Fire || mat === Material.Lava || mat === Material.Plasma ||
         mat === Material.MoltenSalt;
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.floor(v)));
}

export function buildPalette(): Uint8Array {
  const colors = new Uint8Array(PALETTE_SIZE * SHADES_PER_MATERIAL * 4);
  for (let mat = 0; mat < PALETTE_SIZE; mat++) {
    const m = MATERIALS[mat];
    const c = m?.color ?? [0, 0, 0, 0];
    const factors = shadeFactorsFor(mat);
    for (let shade = 0; shade < SHADES_PER_MATERIAL; shade++) {
      const idx = (mat * SHADES_PER_MATERIAL + shade) * 4;
      if (isFireShaded(mat)) {
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

export function buildMaterialProps(): Uint8Array {
  const props = new Uint8Array(PALETTE_SIZE * 4);
  for (let mat = 0; mat < PALETTE_SIZE; mat++) {
    const def = MATERIALS[mat];
    props[mat * 4 + 0] = clamp8((def?.albedo ?? 0) * 255);
    props[mat * 4 + 1] = clamp8((def?.reflectivity ?? 0) * 255);
    props[mat * 4 + 2] = clamp8((def?.brightness ?? 1) * 255);
    props[mat * 4 + 3] = 0;
  }
  return props;
}
