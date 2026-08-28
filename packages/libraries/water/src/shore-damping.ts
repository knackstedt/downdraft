// ============================================================================
// Shore Damping — shared utility for flattening water near terrain regions
// Returns 0.0 inside terrain (flat water), 1.0 far from shore (full waves).
// Also provides shoreDisplacement — ring waves traveling inward toward shore.
// ============================================================================

export interface ShoreSource {
  x: number;
  z: number;
  radius: number;       // damping radius (0 = skip for damping/displacement)
  cutoutRadius: number; // cutout radius (0 = no cutout)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function shoreDamping(
  x: number,
  z: number,
  sources: ShoreSource[],
  count: number,
): number {
  let damping = 1.0;
  for (let i = 0; i < count; i++) {
    const src = sources[i];
    const r = src.radius;
    if (r < 0.001) continue;
    const dx = x - src.x;
    const dz = z - src.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const flatR = r * 1.0;
    const dampR = r * 1.2 + 8.0;
    const t = smoothstep(flatR, dampR, dist);
    if (t < damping) damping = t;
  }
  return damping;
}

export function shoreDisplacement(
  x: number,
  z: number,
  time: number,
  sources: ShoreSource[],
  count: number,
): number {
  let totalH = 0.0;
  for (let i = 0; i < count; i++) {
    const src = sources[i];
    const r = src.radius;
    if (r < 0.001) continue;
    const dx = x - src.x;
    const dz = z - src.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const flatR = r * 1.0;
    const dampR = r * 1.2 + 8.0;
    const rampUp = smoothstep(flatR, dampR, dist);
    if (rampUp < 0.001) continue;

    const bandEnd = dampR + 20.0;
    const fadeW = 8.0;
    const outerFade = 1.0 - smoothstep(bandEnd - fadeW, bandEnd, dist);
    if (outerFade < 0.001) continue;

    const ringDist = dist - r;
    const k = 0.2;
    const shoal = 1.0 - rampUp * 0.6;
    const waveAmp = 0.5 * shoal;
    const ringH = Math.sin(ringDist * k + time * 0.35) * waveAmp;
    const distFade = Math.exp(-Math.max(ringDist - (dampR - r), 0.0) * 0.08);
    totalH += ringH * distFade * outerFade;
  }
  return totalH;
}

export function waterCutout(
  x: number,
  z: number,
  sources: ShoreSource[],
  count: number,
): boolean {
  for (let i = 0; i < count; i++) {
    const src = sources[i];
    if (src.cutoutRadius < 0.001) continue;
    const dx = x - src.x;
    const dz = z - src.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < src.cutoutRadius) return true;
  }
  return false;
}
