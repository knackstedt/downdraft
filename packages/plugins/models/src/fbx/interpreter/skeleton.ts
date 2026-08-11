// ============================================================================
// FBX Skeleton Interpreter — bone hierarchy, inverse bind matrices, skin data
// ============================================================================
// Extracts skin/deformer data from Deformer nodes. Classifies deformers as
// Skin (container) or Cluster (per-bone data with indexes/weights/transform).
// Builds BoneData[] with inverse bind matrices and rest transforms.
//
// Reference: Babylon.js `interpreter/skeleton.ts` (705 lines) + `rig.ts` (331).
//

import type { BoneData } from "../../types";
import type { FBXNode } from "../types";
import { childNode, findNodesInTree, propArray } from "../types";
import type { FBXConnectionGraph } from "./connections";
import { buildObjectIdMap, getObjectId, getObjectName } from "./connections";
import type { DiagnosticsCollector } from "./diagnostics";
import { normalizeNodeName } from "./nodes";

/** Per-vertex bone weights for a single geometry. */
export interface GeometrySkinData {
  vertexBones: Map<number, { boneIdx: number; weight: number }[]>;
}

/** Result of skin parsing: per-geometry skin data + the full SkinData. */
export interface SkinParseResult {
  geometrySkins: Map<string, GeometrySkinData>;
  bones: BoneData[];
  boneNameToIndex: Map<string, number>;
}

/**
 * Parse skin/deformer data from the FBX tree.
 *
 * Uses pre-built OO connection maps for O(1) lookups instead of linear-scanning
 * all connections per cluster (which is O(n×m) and hangs on large files).
 *
 * @param nodes The full FBX node tree.
 * @param graph The connection graph.
 * @param modelNodes The parsed ModelNode[] hierarchy (for bone rest transforms).
 * @param diag Diagnostics collector.
 * @returns Skin data, or null if no deformers.
 */
export function parseSkinData(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  modelNodes: { name: string; nodeIndex?: number; translation?: [number, number, number]; rotation?: [number, number, number, number]; scale?: [number, number, number] }[],
  diag: DiagnosticsCollector,
): SkinParseResult | null {
  const deformerNodes = findNodesInTree(nodes, "Deformer");
  if (deformerNodes.length === 0) return null;

  const objectIdMap = buildObjectIdMap(nodes);

  // ── Build OO connection lookup maps (O(1) instead of O(n) per query) ──────
  // For each object ID, store its OO parents and children.
  const ooParents = new Map<string, string[]>();
  const ooChildren = new Map<string, string[]>();
  for (const conn of graph.connections) {
    if (conn.type !== "OO") continue;
    let p = ooParents.get(conn.childId);
    if (!p) { p = []; ooParents.set(conn.childId, p); }
    p.push(conn.parentId);
    let c = ooChildren.get(conn.parentId);
    if (!c) { c = []; ooChildren.set(conn.parentId, c); }
    c.push(conn.childId);
  }

  /** Get all OO parents of an object. */
  const getOOParents = (id: string): string[] => ooParents.get(id) ?? [];
  /** Get all OO children of an object. */
  const getOOChildren = (id: string): string[] => ooChildren.get(id) ?? [];

  /** Find a connected node of a specific type (checks both directions). */
  const findConnectedOfType = (id: string, typeName: string): string | undefined => {
    for (const pid of getOOParents(id)) {
      const node = objectIdMap.get(pid);
      if (node && node.name === typeName) return pid;
    }
    for (const cid of getOOChildren(id)) {
      const node = objectIdMap.get(cid);
      if (node && node.name === typeName) return cid;
    }
    return undefined;
  };

  // ── Classify deformers: Cluster (has Indexes) vs Skin (container) ─────────
  const skinDeformerIds = new Set<string>();
  const clusterNodes = new Map<string, FBXNode>();
  for (let i = 0; i < deformerNodes.length; i++) {
    const node = deformerNodes[i];
    const id = getObjectId(node, `deformer_${i}`);
    const hasIndexes = node.children.some((c) => c.name === "Indexes");
    if (hasIndexes) {
      clusterNodes.set(id, node);
    } else {
      skinDeformerIds.add(id);
    }
  }

  if (clusterNodes.size === 0) return null;

  // ── Build bone list from clusters ─────────────────────────────────────────
  const bones: BoneData[] = [];
  const boneNameToIndex = new Map<string, number>();
  const boneIdToIndex = new Map<string, number>();
  const clusterToBoneModelId = new Map<string, string>();

  // Pre-build modelNode ID → index map for O(1) lookup.
  // We use the FBX object ID (not name) because multiple model nodes can
  // share the same name (e.g., 439 model nodes, 54 unique bone names).
  const modelNodeIdToIdx = new Map<string, number>();
  const objectsNode = nodes.find((n) => n.name === "Objects");
  if (objectsNode) {
    const modelNodesRaw = findNodesInTree([objectsNode], "Model");
    for (let i = 0; i < modelNodesRaw.length; i++) {
      const id = getObjectId(modelNodesRaw[i], `model_${i}`);
      modelNodeIdToIdx.set(id, i);
    }
  }

  for (const [clusterId, clusterNode] of clusterNodes) {
    // Find the Model node connected to this cluster (via OO connection, either direction)
    const boneModelId = findConnectedOfType(clusterId, "Model");
    if (!boneModelId) {
      diag.warn("skeleton", `Cluster ${clusterId} has no connected Model node, skipping`);
      continue;
    }
    const boneModelNode = objectIdMap.get(boneModelId)!;
    clusterToBoneModelId.set(clusterId, boneModelId);

    // Deduplicate: if this bone model node was already seen (multiple meshes
    // share the same skeleton), reuse the existing bone index instead of
    // creating a duplicate. This is critical for models like Aisha where
    // 700+ meshes each have their own skin deformer referencing the same
    // 54 bone model nodes — without dedup, we'd get 3,467 duplicate bones.
    const existingIdx = boneIdToIndex.get(boneModelId);
    if (existingIdx !== undefined) continue;

    const rawName = getObjectName(boneModelNode, `bone_${bones.length}`);
    const boneName = normalizeNodeName(rawName);

    // Extract inverse bind matrix from the cluster.
    // FBX clusters have:
    //   Transform:     the transform from mesh space to bone space (rarely used)
    //   TransformLink: the bone's WORLD transform at bind time
    // The inverse bind matrix (IBM) = inverse(TransformLink).
    // FBX stores matrices in column-major layout (translation at [12,13,14]),
    // matching WebGPU — no transpose needed.
    const transform = propArray(childNode(clusterNode, "Transform"), 0);
    const transformLink = propArray(childNode(clusterNode, "TransformLink"), 0);
    let inverseBindMatrix: Float32Array;
    if (transformLink && transformLink.length === 16) {
      inverseBindMatrix = invertMat4CM(new Float32Array(transformLink));
    } else if (transform && transform.length === 16) {
      inverseBindMatrix = new Float32Array(transform);
    } else {
      inverseBindMatrix = new Float32Array(16);
    }

    // Find bone rest transform from the model node hierarchy (O(1) lookup by ID)
    const modelNodeIdx = modelNodeIdToIdx.get(boneModelId) ?? -1;
    const restTranslation = modelNodeIdx >= 0 ? (modelNodes[modelNodeIdx].translation ?? [0, 0, 0]) : [0, 0, 0];
    const restRotation = modelNodeIdx >= 0 ? (modelNodes[modelNodeIdx].rotation ?? [0, 0, 0, 1]) : [0, 0, 0, 1] as [number, number, number, number];
    const restScale = modelNodeIdx >= 0 ? (modelNodes[modelNodeIdx].scale ?? [1, 1, 1]) : [1, 1, 1] as [number, number, number];

    // Find parent bone: look up the bone's model parent in the hierarchy,
    // then check if that parent model is also a bone (in boneIdToIndex).
    let parentIndex = -1;
    const parentId = graph.getHierarchyParent(boneModelId);
    if (parentId && boneIdToIndex.has(parentId)) {
      parentIndex = boneIdToIndex.get(parentId)!;
    }

    const boneIdx = bones.length;
    bones.push({
      name: boneName,
      nodeIndex: modelNodeIdx >= 0 ? modelNodeIdx : 0,
      parentIndex,
      inverseBindMatrix,
      restTranslation: restTranslation as [number, number, number],
      restRotation: restRotation as [number, number, number, number],
      restScale: restScale as [number, number, number],
    });
    boneNameToIndex.set(boneName, boneIdx);
    boneIdToIndex.set(boneModelId, boneIdx);
  }

  // ── Fix parent indices + compute root ancestor matrices (second pass) ──────
  // The first pass processes clusters in arbitrary order, so a bone's parent
  // may not have been seen yet. Now that all bone model IDs are in
  // boneIdToIndex, re-resolve every bone's parent.
  //
  // For root bones (parentIndex < 0), the bone's FBX model node may still have
  // non-bone ancestors (e.g., spine_03 → spine_02 → spine_01, where spine_02
  // and spine_01 are not bones). The TransformLink includes those ancestors'
  // world transforms, but computeSkinMatrices only uses the bone's local rest
  // transform for roots. We compute the composed ancestor world transform and
  // store it as rootAncestorMatrix so the animator can apply it.
  const boneIdxToModelId = new Map<number, string>();
  for (const [modelId, idx] of boneIdToIndex) {
    boneIdxToModelId.set(idx, modelId);
  }

  // Build model node ID → ModelNode map (for rest transforms of non-bone ancestors)
  const modelNodeIdToNode = new Map<string, { translation?: [number, number, number]; rotation?: [number, number, number, number]; scale?: [number, number, number] }>();
  for (const [id, idx] of modelNodeIdToIdx) {
    if (idx < modelNodes.length) {
      modelNodeIdToNode.set(id, modelNodes[idx]);
    }
  }

  let rootCount = 0;
  for (let i = 0; i < bones.length; i++) {
    const modelId = boneIdxToModelId.get(i);
    if (!modelId) continue;

    // Walk up the hierarchy to find the nearest BONE ancestor.
    // Non-bone model nodes (e.g., spine_02 between spine_03 and spine_01)
    // are collected into an intermediate transform chain.
    const intermediateLocals: { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] }[] = [];
    let currentParentId = graph.getHierarchyParent(modelId);
    let boneParentIdx = -1;

    while (currentParentId) {
      if (boneIdToIndex.has(currentParentId)) {
        boneParentIdx = boneIdToIndex.get(currentParentId)!;
        break;
      }
      // Non-bone ancestor: collect its local transform
      const ancestorNode = modelNodeIdToNode.get(currentParentId);
      if (ancestorNode) {
        intermediateLocals.push({
          t: ancestorNode.translation ?? [0, 0, 0],
          r: ancestorNode.rotation ?? [0, 0, 0, 1],
          s: ancestorNode.scale ?? [1, 1, 1],
        });
      }
      currentParentId = graph.getHierarchyParent(currentParentId);
    }

    bones[i].parentIndex = boneParentIdx;

    if (boneParentIdx < 0) {
      rootCount++;
    }

    // If there are non-bone intermediates between this bone and its bone parent,
    // compose their transforms into a matrix that will be applied in
    // computeSkinMatrices. For root bones, this is the ancestor world transform.
    // For child bones with intermediates, we store it as rootAncestorMatrix
    // and apply it as: world = intermediateWorld * local (instead of parent * local).
    if (intermediateLocals.length > 0) {
      // Compose from topmost ancestor down: world = top * ... * closest_intermediate
      // intermediateLocals[0] is the closest parent, last is the topmost.
      let mat = new Float32Array(16);
      const top = intermediateLocals[intermediateLocals.length - 1];
      composeMat4Local(top.t, top.r, top.s, mat);
      for (let a = intermediateLocals.length - 2; a >= 0; a--) {
        const localMat = new Float32Array(16);
        composeMat4Local(intermediateLocals[a].t, intermediateLocals[a].r, intermediateLocals[a].s, localMat);
        const product = multiplyMat4CM(mat, localMat);
        mat.set(product);
      }
      bones[i].rootAncestorMatrix = mat;
    }
  }
  diag.debug("skeleton", `Parent fixup: ${rootCount} root bones, ${bones.length - rootCount} child bones`);

  // ── Build per-geometry skin data ──────────────────────────────────────────
  // For each Skin deformer, find its geometry and collect vertex→bone weights
  // from all clusters under that skin.
  const geometrySkins = new Map<string, GeometrySkinData>();

  // Pre-build skinId → clusterIds[] map (O(1) per skin instead of O(n×m))
  const skinToClusters = new Map<string, string[]>();
  for (const [clusterId] of clusterNodes) {
    // A cluster is connected to a skin if the skin is an OO parent or child
    for (const pid of getOOParents(clusterId)) {
      if (skinDeformerIds.has(pid)) {
        let list = skinToClusters.get(pid);
        if (!list) { list = []; skinToClusters.set(pid, list); }
        list.push(clusterId);
      }
    }
    for (const cid of getOOChildren(clusterId)) {
      if (skinDeformerIds.has(cid)) {
        let list = skinToClusters.get(cid);
        if (!list) { list = []; skinToClusters.set(cid, list); }
        list.push(clusterId);
      }
    }
  }

  for (const skinId of skinDeformerIds) {
    // Find the geometry connected to this skin (either direction, O(1))
    const geometryId = findConnectedOfType(skinId, "Geometry");
    if (!geometryId) continue;

    // Get all clusters connected to this skin (O(1) from pre-built map)
    const clusters = skinToClusters.get(skinId) ?? [];
    const vertexBones = new Map<number, { boneIdx: number; weight: number }[]>();

    for (const clusterId of clusters) {
      const clusterNode = clusterNodes.get(clusterId);
      if (!clusterNode) continue;

      const boneModelId = clusterToBoneModelId.get(clusterId);
      if (!boneModelId) continue;
      const boneIdx = boneIdToIndex.get(boneModelId);
      if (boneIdx === undefined) continue;

      const indexes = propArray(childNode(clusterNode, "Indexes"), 0) ?? [];
      const weights = propArray(childNode(clusterNode, "Weights"), 0) ?? [];

      for (let v = 0; v < indexes.length; v++) {
        const vertexIdx = indexes[v];
        const weight = weights[v] ?? 0;
        if (weight === 0) continue;
        let bones = vertexBones.get(vertexIdx);
        if (!bones) {
          bones = [];
          vertexBones.set(vertexIdx, bones);
        }
        bones.push({ boneIdx, weight });
      }
    }

    if (vertexBones.size > 0) {
      geometrySkins.set(geometryId, { vertexBones });
    }
  }

  // ── Topological sort: ensure parents come before children ─────────────────
  // computeSkinMatrices processes bones in index order and reads the parent's
  // world matrix, which must already be computed. If a bone's parentIndex >
  // its own index, the parent's world matrix is stale (zero or previous frame),
  // breaking the rigging. We reorder the bones array via BFS from roots and
  // remap all index references (parentIndex, boneNameToIndex, and joint indices
  // in geometrySkins).
  const oldToNew = new Int32Array(bones.length);
  oldToNew.fill(-1);
  const newBones: BoneData[] = [];
  // Find root bones (parentIndex < 0) and BFS down the hierarchy.
  const childMap = new Map<number, number[]>();
  for (let i = 0; i < bones.length; i++) {
    const p = bones[i].parentIndex;
    if (p >= 0) {
      let list = childMap.get(p);
      if (!list) { list = []; childMap.set(p, list); }
      list.push(i);
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].parentIndex < 0) queue.push(i);
  }
  while (queue.length > 0) {
    const oldIdx = queue.shift()!;
    const newIdx = newBones.length;
    oldToNew[oldIdx] = newIdx;
    newBones.push(bones[oldIdx]);
    const children = childMap.get(oldIdx);
    if (children) for (const c of children) queue.push(c);
  }
  // Safety: if any bones weren't reached (cycle or disconnected), append them.
  for (let i = 0; i < bones.length; i++) {
    if (oldToNew[i] < 0) {
      oldToNew[i] = newBones.length;
      newBones.push(bones[i]);
    }
  }

  // Remap parentIndex in the reordered bones.
  for (let i = 0; i < newBones.length; i++) {
    const p = newBones[i].parentIndex;
    newBones[i] = { ...newBones[i], parentIndex: p >= 0 ? oldToNew[p] : -1 };
  }

  // Remap boneNameToIndex values.
  const newBoneNameToIndex = new Map<string, number>();
  for (const [name, oldIdx] of boneNameToIndex) {
    newBoneNameToIndex.set(name, oldToNew[oldIdx]);
  }

  // Remap joint indices in geometrySkins so mesh joint arrays match the new
  // bone order. Without this, meshes would reference the wrong bones.
  for (const geoSkin of geometrySkins.values()) {
    for (const boneList of geoSkin.vertexBones.values()) {
      for (const entry of boneList) {
        entry.boneIdx = oldToNew[entry.boneIdx];
      }
    }
  }

  diag.debug("skeleton", `Parsed ${newBones.length} bones, ${geometrySkins.size} skinned geometries (topologically sorted)`);

  return { geometrySkins, bones: newBones, boneNameToIndex: newBoneNameToIndex };
}

/** Invert a 4×4 column-major matrix. Returns identity if singular. */
function invertMat4CM(m: Float32Array): Float32Array {
  const a00 = m[0], a01 = m[4], a02 = m[8],  a03 = m[12];
  const a10 = m[1], a11 = m[5], a12 = m[9],  a13 = m[13];
  const a20 = m[2], a21 = m[6], a22 = m[10], a23 = m[14];
  const a30 = m[3], a31 = m[7], a32 = m[11], a33 = m[15];
  const b00 = a11*a22*a33 - a11*a23*a32 - a21*a12*a33 + a21*a13*a32 + a31*a12*a23 - a31*a13*a22;
  const b01 = -a10*a22*a33 + a10*a23*a32 + a20*a12*a33 - a20*a13*a32 - a30*a12*a23 + a30*a13*a22;
  const b02 = a10*a21*a33 - a10*a23*a31 - a20*a11*a33 + a20*a13*a31 + a30*a11*a23 - a30*a13*a21;
  const b03 = -a10*a21*a32 + a10*a22*a31 + a20*a11*a32 - a20*a12*a31 - a30*a11*a22 + a30*a12*a21;
  const b10 = -a01*a22*a33 + a01*a23*a32 + a21*a02*a33 - a21*a03*a32 - a31*a02*a23 + a31*a03*a22;
  const b11 = a00*a22*a33 - a00*a23*a32 - a20*a02*a33 + a20*a03*a32 + a30*a02*a23 - a30*a03*a22;
  const b12 = -a00*a21*a33 + a00*a23*a31 + a20*a01*a33 - a20*a03*a31 - a30*a01*a23 + a30*a03*a21;
  const b13 = a00*a21*a32 - a00*a22*a31 - a20*a01*a32 + a20*a02*a31 + a30*a01*a22 - a30*a02*a21;
  const b20 = a01*a12*a33 - a01*a13*a32 - a11*a02*a33 + a11*a03*a32 + a31*a02*a13 - a31*a03*a12;
  const b21 = -a00*a12*a33 + a00*a13*a32 + a10*a02*a33 - a10*a03*a32 - a30*a02*a13 + a30*a03*a12;
  const b22 = a00*a11*a33 - a00*a13*a31 - a10*a01*a33 + a10*a03*a31 + a30*a01*a13 - a30*a03*a11;
  const b23 = -a00*a11*a32 + a00*a12*a31 + a10*a01*a32 - a10*a02*a31 - a30*a01*a12 + a30*a02*a11;
  const b30 = -a01*a12*a23 + a01*a13*a22 + a11*a02*a23 - a11*a03*a22 - a21*a02*a13 + a21*a03*a12;
  const b31 = a00*a12*a23 - a00*a13*a22 - a10*a02*a23 + a10*a03*a22 + a20*a02*a13 - a20*a03*a12;
  const b32 = -a00*a11*a23 + a00*a13*a21 + a10*a01*a23 - a10*a03*a21 - a20*a01*a13 + a20*a03*a11;
  const b33 = a00*a11*a22 - a00*a12*a21 - a10*a01*a22 + a10*a02*a21 + a20*a01*a12 - a20*a02*a11;
  let det = a00*b00 + a01*b01 + a02*b02 + a03*b03;
  if (Math.abs(det) < 1e-12) return new Float32Array(16);
  det = 1 / det;
  const out = new Float32Array(16);
  out[0]=b00*det; out[1]=b01*det; out[2]=b02*det; out[3]=b03*det;
  out[4]=b10*det; out[5]=b11*det; out[6]=b12*det; out[7]=b13*det;
  out[8]=b20*det; out[9]=b21*det; out[10]=b22*det; out[11]=b23*det;
  out[12]=b30*det; out[13]=b31*det; out[14]=b32*det; out[15]=b33*det;
  return out;
}

/** Compose a TRS into a column-major 4×4 matrix (writes into `out`). */
function composeMat4Local(
  pos: [number, number, number],
  rot: [number, number, number, number],
  scale: [number, number, number],
  out: Float32Array,
): void {
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * scale[0];
  out[1] = (xy + wz) * scale[0];
  out[2] = (xz - wy) * scale[0];
  out[3] = 0;
  out[4] = (xy - wz) * scale[1];
  out[5] = (1 - (xx + zz)) * scale[1];
  out[6] = (yz + wx) * scale[1];
  out[7] = 0;
  out[8] = (xz + wy) * scale[2];
  out[9] = (yz - wx) * scale[2];
  out[10] = (1 - (xx + yy)) * scale[2];
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
}

/** Multiply two column-major 4×4 matrices: result = a * b. */
function multiplyMat4CM(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[j] * b[i * 4] +
        a[4 + j] * b[i * 4 + 1] +
        a[8 + j] * b[i * 4 + 2] +
        a[12 + j] * b[i * 4 + 3];
    }
  }
  return out;
}
