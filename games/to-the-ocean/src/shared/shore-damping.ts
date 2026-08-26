// ============================================================================
// Shore Damping — game-specific shore source collection
// Math functions (shoreDamping, shoreDisplacement, waterCutout) live in
// @downdraft/library-water. This file keeps only collectShoreSources, which
// depends on game-specific SimEntity and island blob generation.
// ============================================================================

import type { ShoreSource } from "@downdraft/library-water";
export type { ShoreSource };

    import { SimEntity } from "../simulation/simulation";
    import { generateIslandBlobs } from "./terrain";
    import { EntityType } from "./types";

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
