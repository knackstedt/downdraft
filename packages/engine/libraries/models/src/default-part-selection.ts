// ============================================================================
// Default part selection for rigged character packs.
//
// Character-pack FBX/GLB exports (Modular Characters, Quaternius-style kits,
// etc.) ship every outfit/body variant as a separate mesh node — f_hair,
// f_hair.002, f_hair.003 … Rendering them all superimposes every variant and
// produces visual noise (and inflated bounds). When a model is skinned, the
// default "outfit" is the first mesh-bearing node of each name-prefix group —
// the trailing Blender ".NNN" suffix marks variants.
//
// Unskinned models return null from both helpers: their mesh list is the
// asset, not a variant catalog, so callers render every mesh.
// ============================================================================

import type { ModelData } from "./types";

/**
 * Node indices of the default outfit: the first mesh-bearing node per
 * name-prefix group. Returns null for unskinned models or models whose node
 * tree carries no meshes.
 */
export function defaultCharacterParts(model: ModelData): Set<number> | null {
  if (!model.skin || !model.nodes) return null;
  const groups = new Map<string, number>();
  for (let i = 0; i < model.nodes.length; i++) {
    const node = model.nodes[i];
    const hasMesh = node.mesh !== undefined && node.mesh < model.meshes.length;
    const meshCount = node.meshes
      ? node.meshes.filter((mi) => mi < model.meshes.length).length
      : (hasMesh ? 1 : 0);
    if (meshCount === 0) continue;
    const prefix = (node.name || `node_${i}`).replace(/\.\d+$/, "");
    if (!groups.has(prefix)) groups.set(prefix, i);
  }
  return groups.size > 0 ? new Set(groups.values()) : null;
}

/**
 * Mesh indices covered by defaultCharacterParts — a node's primary mesh plus
 * its multi-material splits (node.meshes). Returns null under the same
 * conditions.
 */
export function defaultCharacterMeshIndices(model: ModelData): Set<number> | null {
  const parts = defaultCharacterParts(model);
  if (!parts || !model.nodes) return null;
  const indices = new Set<number>();
  parts.forEach((ni) => {
    const node = model.nodes![ni];
    if (node.meshes) {
      node.meshes.forEach((mi) => { if (mi < model.meshes.length) indices.add(mi); });
    } else if (node.mesh !== undefined && node.mesh < model.meshes.length) {
      indices.add(node.mesh);
    }
  });
  return indices.size > 0 ? indices : null;
}
