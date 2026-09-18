import type { ExtractedMesh } from "./types";
import type { DensityField } from "./types";

export interface DeformationConfig {
  radius: number;
  strength: number;
  falloff: number;
}

// applyDeformation is algorithm-agnostic — it wraps a density field function.
// Re-exported from MC plugin for convenience.
export { applyDeformation, applyMultipleDeformations } from "@downdraft/engine/libraries/marching-cubes";

/**
 * Deform a surface nets mesh by displacing vertices within a spherical region.
 * Unlike MC's deformChunk (which uses 3-float stride), surface nets vertices
 * use 9-float stride (pos.xyz, normal.xyz, color.rgb).
 */
export function deformChunk(
  mesh: ExtractedMesh,
  deformPos: [number, number, number],
  config: DeformationConfig,
): ExtractedMesh {
  const [dx, dy, dz] = deformPos;
  const r = config.radius;
  const strength = config.strength;
  const falloff = config.falloff;

  const verts = new Float32Array(mesh.verts);
  const vertexCount = verts.length / 9;

  for (let i = 0; i < vertexCount; i++) {
    const offset = i * 9;
    const vx = verts[offset];
    const vy = verts[offset + 1];
    const vz = verts[offset + 2];
    const distSq = (vx - dx) ** 2 + (vy - dy) ** 2 + (vz - dz) ** 2;
    if (distSq > r * r) continue;
    const dist = Math.sqrt(distSq);
    const t = 1 - (dist / r) ** falloff;
    verts[offset + 1] += strength * t;
  }

  return { verts, indices: mesh.indices, useUint32: mesh.useUint32 };
}
