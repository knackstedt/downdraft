// ============================================================================
// Shore Damping — shared utility for flattening water near islands
// Used by both physics (BuoyancySystem, PlayerManager) and rendering (WGSL).
// Returns 0.0 inside islands (flat water), 1.0 far from shore (full waves).
// Also provides shoreDisplacement — ring waves traveling inward toward shore,
// with shoaling (amplitude increases as waves approach the beach).
// ============================================================================

import { SimEntity } from "../simulation/Simulation";
import { generateIslandBlobs } from "./terrain";
import { EntityType } from "./types";

export interface ShoreSource {
  x: number;
  z: number;
  radius: number;       // damping radius (0 = skip for damping/displacement)
  cutoutRadius: number; // cutout radius (0 = no cutout)
}

// Extract island/port positions + radii from the entity array.
// Called once per tick, results passed to sampleShoreDamping.
// Height multiplier threshold: only peak blobs (heightMul > this) create cutouts.
// Beach blobs have heightMul ≈ 0, so beaches keep their water.
const CUTOUT_HEIGHT_THRESHOLD = 0.1;

// Extract island/port shore sources from the entity array.
// For islands, pushes one damping source (full island radius) plus one cutout
// source per peak blob (heightMul > threshold). Beach blobs get no cutout.
export function collectShoreSources(
  entities: SimEntity[],
  count: number,
  out: ShoreSource[],
): number {
  let n = 0;
  const maxOut = out.length;
  for (let i = 0; i < count; i++) {
    const ent = entities[i];
    if (!ent) continue;
    if (ent.type !== EntityType.Island && ent.type !== EntityType.Port) continue;

    if (ent.type === EntityType.Port) {
      if (n >= maxOut) break;
      out[n].x = ent.position.x;
      out[n].z = ent.position.z;
      out[n].radius = ent.scale;
      // Cutout water in the dock area (scale * 0.25) for shoreline blend
      out[n].cutoutRadius = ent.scale * 0.25;
      n++;
      continue;
    }

    // Island: push one damping source with full island radius
    if (n >= maxOut) break;
    out[n].x = ent.position.x;
    out[n].z = ent.position.z;
    out[n].radius = ent.scale;
    out[n].cutoutRadius = 0;
    n++;

    // Push one cutout source per peak blob
    const blobs = generateIslandBlobs(ent.chunkX, ent.chunkZ);
    const islandR = ent.scale;
    for (let b = 0; b < blobs.length; b++) {
      if (n >= maxOut) break;
      const blob = blobs[b];
      if (blob.heightMul <= CUTOUT_HEIGHT_THRESHOLD) continue;
      out[n].x = blob.x * islandR + ent.position.x;
      out[n].z = blob.z * islandR + ent.position.z;
      out[n].radius = 0; // no damping effect (skip in damping/displacement)
      out[n].cutoutRadius = blob.radius * islandR;
      n++;
    }
  }
  return n;
}

// Compute shore damping factor at a world position.
// 0.0 = fully flat (inside island), 1.0 = full waves (far from shore).
// Must match the WGSL shoreDamping function in WaterSystem.ts.
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
    if (r < 0.001) continue; // skip cutout-only sources
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

// Shore ring wave displacement — waves traveling inward toward shore.
// Includes shoaling: amplitude grows as waves approach the beach (decreasing depth).
// Must match the WGSL shoreDisplacement function in WaterSystem.ts.
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
    if (r < 0.001) continue; // skip cutout-only sources
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
    // Shoaling: waves get taller as they approach shore (closer to flatR = bigger)
    const shoal = 1.0 - rampUp * 0.6; // 1.0 at beach, 0.4 at dampR
    const waveAmp = 0.5 * shoal;
    const ringH = Math.sin(ringDist * k + time * 0.35) * waveAmp;
    const distFade = Math.exp(-Math.max(ringDist - (dampR - r), 0.0) * 0.08);
    totalH += ringH * distFade * outerFade;
  }
  return totalH;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Check if a world position is inside any water cutout zone.
// Returns true where water should be discarded (inside peak blob areas).
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
