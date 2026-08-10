import { Material, MATERIALS } from "./materials";

export function buildPalette(): Uint8Array {
  const colors = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const m = i as Material;
    const c = MATERIALS[m]?.color ?? [0, 0, 0, 0];
    colors[i * 4 + 0] = Math.floor(c[0] * 255);
    colors[i * 4 + 1] = Math.floor(c[1] * 255);
    colors[i * 4 + 2] = Math.floor(c[2] * 255);
    colors[i * 4 + 3] = Math.floor(c[3] * 255);
  }
  return colors;
}
