// ============================================================================
// Bake Node Transforms — bake glTF/FBX node hierarchy transforms into vertices
// ============================================================================
// The ModelRenderer only applies a single root-level transform (position,
// rotation, scale). Per-node transforms (translation, rotation, PreRotation,
// scale) in the node tree are never applied by the renderer — causing models
// with non-identity node transforms (e.g. PreRotation on mesh-bearing nodes)
// to render with wrong rotation/position.
//
// This function traverses the node tree, computes each node's world transform,
// and applies it to the associated mesh's vertices and normals. After baking,
// all meshes are in a consistent model-space coordinate system.
//
// Promoted from games/model-viewer/src/model-loader.ts to the engine so all
// games benefit from correct node-transform handling.
//

import type { ModelData, ModelNode } from "./types";

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qrotate(q: Quat, v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  // v + 2*cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const c1x = qy * vz - qz * vy + qw * vx;
  const c1y = qz * vx - qx * vz + qw * vy;
  const c1z = qx * vy - qy * vx + qw * vz;
  const c2x = qy * c1z - qz * c1y;
  const c2y = qz * c1x - qx * c1z;
  const c2z = qx * c1y - qy * c1x;
  return [vx + 2 * c2x, vy + 2 * c2y, vz + 2 * c2z];
}

interface WorldTransform {
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
}

function identityTransform(): WorldTransform {
  return { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function composeTransforms(parent: WorldTransform, node: ModelNode): WorldTransform {
  const localT: Vec3 = node.translation ?? [0, 0, 0];
  const localR: Quat = node.rotation ?? [0, 0, 0, 1];
  const localS: Vec3 = node.scale ?? [1, 1, 1];

  // worldTranslation = qrotate(parentR, localT * parentS) + parentT
  const scaledT: Vec3 = [localT[0] * parent.scale[0], localT[1] * parent.scale[1], localT[2] * parent.scale[2]];
  const rotatedT = qrotate(parent.rotation, scaledT);
  const worldT: Vec3 = [rotatedT[0] + parent.translation[0], rotatedT[1] + parent.translation[1], rotatedT[2] + parent.translation[2]];

  // worldRotation = parentR * localR
  const worldR = qmul(parent.rotation, localR);

  // worldScale = parentS * localS
  const worldS: Vec3 = [parent.scale[0] * localS[0], parent.scale[1] * localS[1], parent.scale[2] * localS[2]];

  return { translation: worldT, rotation: worldR, scale: worldS };
}

/**
 * Bake the node hierarchy transforms into mesh vertices.
 *
 * Traverses the node tree, computes each node's world transform, and applies
 * it to the associated mesh's vertices and normals. After baking, all meshes
 * are in a consistent model-space coordinate system and the node hierarchy
 * can be ignored by the renderer.
 *
 * This mutates `modelData.meshes[*].vertices` in place.
 */
export function bakeNodeTransforms(modelData: ModelData): void {
  if (!modelData.nodes || modelData.nodes.length === 0) return;

  // Compute world transforms for each node via DFS from root nodes.
  const worldTransforms: WorldTransform[] = modelData.nodes.map(() => identityTransform());

  // Find root nodes (nodes with no parent).
  const hasParent = new Set<number>();
  modelData.nodes.forEach((node) => {
    if (node.children) {
      node.children.forEach((childIdx) => {
        hasParent.add(childIdx);
      });
    }
  });
  const rootIndices: number[] = [];
  for (let i = 0; i < modelData.nodes.length; i++) {
    if (!hasParent.has(i)) rootIndices.push(i);
  }

  // DFS to compute world transforms.
  function traverse(nodeIdx: number, parentTransform: WorldTransform): void {
    const node = modelData.nodes![nodeIdx];
    const world = composeTransforms(parentTransform, node);
    worldTransforms[nodeIdx] = world;

    if (node.children) {
      node.children.forEach((childIdx) => {
        traverse(childIdx, world);
      });
    }
  }

  rootIndices.forEach((rootIdx) => {
    traverse(rootIdx, identityTransform());
  });

  // Apply world transforms to mesh vertices and normals.
  // Skip skinned meshes — their node hierarchy transforms are encoded in the
  // bone rest poses and applied via skin matrices at render time. Baking the
  // node transforms into skinned vertices would double-transform them.
  for (let i = 0; i < modelData.nodes.length; i++) {
    const node = modelData.nodes[i];
    // Bake every mesh owned by this node, including multi-material splits.
    const nodeMeshes = node.meshes ?? (node.mesh !== undefined ? [node.mesh] : []);
    if (nodeMeshes.length === 0) continue;

    const wt = worldTransforms[i];

    // Skip identity transforms (common for root nodes) to avoid unnecessary work.
    const isIdentity =
      wt.translation[0] === 0 && wt.translation[1] === 0 && wt.translation[2] === 0 &&
      wt.rotation[0] === 0 && wt.rotation[1] === 0 && wt.rotation[2] === 0 && wt.rotation[3] === 1 &&
      wt.scale[0] === 1 && wt.scale[1] === 1 && wt.scale[2] === 1;
    if (isIdentity) continue;

    for (let _i = 0, _it = nodeMeshes, _n = _it.length; _i < _n; _i++) { const meshIdx = _it[_i];
      if (meshIdx >= modelData.meshes.length) continue;
      const mesh = modelData.meshes[meshIdx];
      // Skip skinned meshes (see comment above).
      if (mesh.joints && mesh.weights && mesh.joints.length >= mesh.vertexCount * 4) continue;

      const verts = mesh.vertices;
      for (let v = 0; v < mesh.vertexCount; v++) {
        const px = verts[v * 6];
        const py = verts[v * 6 + 1];
        const pz = verts[v * 6 + 2];
        // Apply scale, then rotation, then translation.
        const scaled: Vec3 = [px * wt.scale[0], py * wt.scale[1], pz * wt.scale[2]];
        const rotated = qrotate(wt.rotation, scaled);
        verts[v * 6] = rotated[0] + wt.translation[0];
        verts[v * 6 + 1] = rotated[1] + wt.translation[1];
        verts[v * 6 + 2] = rotated[2] + wt.translation[2];

        // Transform normals (rotation only — no translation, and scale doesn't
        // affect direction for uniform scale; for non-uniform scale we'd need
        // inverse-transpose, but FBX character rigs typically use uniform scale).
        const nx = verts[v * 6 + 3];
        const ny = verts[v * 6 + 4];
        const nz = verts[v * 6 + 5];
        const rotatedN = qrotate(wt.rotation, [nx, ny, nz]);
        verts[v * 6 + 3] = rotatedN[0];
        verts[v * 6 + 4] = rotatedN[1];
        verts[v * 6 + 5] = rotatedN[2];
      }
    }
  }
}
