// ============================================================================
// FBX Blend Shapes Interpreter — morph targets from Geometry shapes
// ============================================================================
// Extracts morph target data from FBX blend shape deformers. FBX stores blend
// shapes in two possible structures:
//
// Structure 1 (modern, used by m10_morph):
//   Deformer (skin) → Deformer (blendshape, has DeformPercent/FullWeights)
//   → Geometry (morph target, has Indexes + Vertices = delta positions)
//
// Structure 2 (classic, with BlendShapeChannel):
//   BlendShape → BlendShapeChannel → SubDeformer (Geometry.Shape, has Shapes)
//
// Reference: Babylon.js `interpreter/blendShapes.ts` (272 lines).
//

import type { MorphTargetData } from "../../types";
import type { FBXNode } from "../types";
import { childNode, findNodesInTree, propArray } from "../types";
import type { FBXConnectionGraph } from "./connections";
import { buildObjectIdMap, getObjectId, getObjectName } from "./connections";
import type { DiagnosticsCollector } from "./diagnostics";

/** Per-geometry morph targets. */
export interface GeometryMorphData {
  morphTargets: MorphTargetData[];
  morphTargetNames: string[];
}

/**
 * Parse blend shape / morph target data from the FBX tree.
 *
 * @returns Map of geometry ID → morph target data.
 */
export function parseBlendShapes(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  diag: DiagnosticsCollector,
): Map<string, GeometryMorphData> {
  const result = new Map<string, GeometryMorphData>();
  const objectIdMap = buildObjectIdMap(nodes);

  // Find all Deformer nodes
  const deformerNodes = findNodesInTree(nodes, "Deformer");
  if (deformerNodes.length === 0) return result;

  // Find BlendShapeChannel and SubDeformer nodes (classic structure)
  const blendShapeChannels = findNodesInTree(nodes, "BlendShapeChannel");
  const subDeformerNodes = findNodesInTree(nodes, "SubDeformer");

  // Try classic structure first (BlendShapeChannel → SubDeformer with Shapes)
  if (blendShapeChannels.length > 0 && subDeformerNodes.length > 0) {
    parseClassicBlendShapes(nodes, graph, objectIdMap, result, diag);
  }

  // Try modern structure (Deformer with DeformPercent → Geometry with Indexes)
  if (result.size === 0) {
    parseModernBlendShapes(nodes, graph, objectIdMap, result, diag);
  }

  if (result.size > 0) {
    diag.debug("blend-shapes", `Parsed ${result.size} geometries with morph targets`);
  }

  return result;
}

/**
 * Parse classic blend shapes (BlendShapeChannel → SubDeformer with Shapes).
 */
function parseClassicBlendShapes(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  objectIdMap: Map<string, FBXNode>,
  result: Map<string, GeometryMorphData>,
  diag: DiagnosticsCollector,
): void {
  // Find SubDeformer nodes that have Shapes (morph target delta data)
  const shapeNodes = new Map<string, FBXNode>();
  for (const node of findNodesInTree(nodes, "SubDeformer")) {
    const hasShapes = node.children.some((c) => c.name === "Shapes");
    if (hasShapes) {
      const id = getObjectId(node, `shape_${shapeNodes.size}`);
      shapeNodes.set(id, node);
    }
  }

  if (shapeNodes.size === 0) return;

  // Build BlendShapeChannel → SubDeformer (shape) connections
  const channelToShape = new Map<string, string>();
  for (const [shapeId] of shapeNodes.entries()) {
    for (const conn of graph.getConnectionsFromChild(shapeId)) {
      if (conn.type === "OO") {
        channelToShape.set(conn.parentId, shapeId);
      }
    }
  }

  // Build BlendShapeChannel name map
  const channelIdToName = new Map<string, string>();
  for (const channelNode of findNodesInTree(nodes, "BlendShapeChannel")) {
    const id = getObjectId(channelNode, `channel_${channelIdToName.size}`);
    const name = getObjectName(channelNode, `morph_${channelIdToName.size}`);
    channelIdToName.set(id, name);
  }

  for (const [shapeId, shapeNode] of shapeNodes.entries()) {
    // Find the BlendShapeChannel that owns this shape
    let channelId: string | undefined;
    for (const [chId, shId] of channelToShape.entries()) {
      if (shId === shapeId) {
        channelId = chId;
        break;
      }
    }
    if (!channelId) continue;

    // Find the BlendShape → Geometry chain
    let blendShapeId: string | undefined;
    for (const conn of graph.getConnectionsFromChild(channelId)) {
      if (conn.type === "OO") {
        const node = objectIdMap.get(conn.parentId);
        if (node && node.name === "BlendShape") {
          blendShapeId = conn.parentId;
          break;
        }
      }
    }
    if (!blendShapeId) continue;

    const geometryId = findConnectedGeometry(blendShapeId, graph, objectIdMap);
    if (!geometryId) continue;

    const morphTarget = extractMorphTargetFromSubDeformer(shapeNode, channelIdToName.get(channelId) ?? `morph_${result.size}`);
    if (!morphTarget) continue;

    addMorphToResult(result, geometryId, morphTarget);
  }
}

/**
 * Parse modern blend shapes (Deformer with DeformPercent → Geometry with Indexes).
 *
 * Structure:
 *   Deformer (skin, no Indexes) → Geometry (base mesh)
 *   Deformer (blendshape, has DeformPercent/FullWeights) → Deformer (skin)
 *   Geometry (morph target, has Indexes + Vertices) → Deformer (blendshape)
 */
function parseModernBlendShapes(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  objectIdMap: Map<string, FBXNode>,
  result: Map<string, GeometryMorphData>,
  diag: DiagnosticsCollector,
): void {
  // Find blendshape deformer nodes (have DeformPercent or FullWeights)
  const blendShapeDeformers: { id: string; node: FBXNode; fullWeights: number[] }[] = [];
  for (const node of findNodesInTree(nodes, "Deformer")) {
    const hasDeformPercent = node.children.some((c) => c.name === "DeformPercent");
    const fullWeightsNode = childNode(node, "FullWeights");
    const fullWeights = propArray(fullWeightsNode, 0) ?? [];
    if (hasDeformPercent || fullWeights.length > 0) {
      const id = getObjectId(node, `bs_${blendShapeDeformers.length}`);
      blendShapeDeformers.push({ id, node, fullWeights });
    }
  }

  if (blendShapeDeformers.length === 0) return;

  for (let _i = 0, _it = blendShapeDeformers, _n = _it.length; _i < _n; _i++) { const bs = _it[_i];
    // Find the skin deformer connected to this blendshape deformer (either direction)
    let skinDeformerId: string | undefined;
    for (const conn of graph.getConnectionsFromChild(bs.id)) {
      if (conn.type !== "OO") continue;
      const node = objectIdMap.get(conn.parentId);
      if (node && node.name === "Deformer") { skinDeformerId = conn.parentId; break; }
    }
    if (!skinDeformerId) {
      for (const conn of graph.getConnectionsToParent(bs.id)) {
        if (conn.type !== "OO") continue;
        const node = objectIdMap.get(conn.childId);
        if (node && node.name === "Deformer") { skinDeformerId = conn.childId; break; }
      }
    }
    if (!skinDeformerId) continue;

    // Find the base geometry connected to the skin deformer
    const baseGeometryId = findConnectedGeometry(skinDeformerId, graph, objectIdMap);
    if (!baseGeometryId) continue;

    // Find morph target Geometry nodes connected to the blendshape deformer
    const morphGeometries: { id: string; node: FBXNode }[] = [];
    // Check parents (morph geometry is parent of blendshape)
    for (const conn of graph.getConnectionsFromChild(bs.id)) {
      if (conn.type !== "OO") continue;
      const node = objectIdMap.get(conn.parentId);
      if (node && node.name === "Geometry" && node.children.some((c) => c.name === "Indexes")) {
        morphGeometries.push({ id: conn.parentId, node });
      }
    }
    // Check children (morph geometry is child of blendshape)
    for (const conn of graph.getConnectionsToParent(bs.id)) {
      if (conn.type !== "OO") continue;
      const node = objectIdMap.get(conn.childId);
      if (node && node.name === "Geometry" && node.children.some((c) => c.name === "Indexes")) {
        morphGeometries.push({ id: conn.childId, node });
      }
    }

    // Extract morph targets from the morph geometry nodes
    for (let i = 0; i < morphGeometries.length; i++) {
      const { node: morphGeoNode } = morphGeometries[i];
      const morphName = getObjectName(morphGeoNode, `morph_${i}`);
      const morphTarget = extractMorphTargetFromGeometry(morphGeoNode, morphName);
      if (!morphTarget) continue;

      addMorphToResult(result, baseGeometryId, morphTarget);
    }
  }
}

/** Find a Geometry node connected to a deformer (either direction). */
function findConnectedGeometry(
  deformerId: string,
  graph: FBXConnectionGraph,
  objectIdMap: Map<string, FBXNode>,
): string | undefined {
  // Check parents (deformer is child)
  for (const conn of graph.getConnectionsFromChild(deformerId)) {
    if (conn.type !== "OO") continue;
    const node = objectIdMap.get(conn.parentId);
    if (node && node.name === "Geometry") return conn.parentId;
  }
  // Check children (deformer is parent)
  for (const conn of graph.getConnectionsToParent(deformerId)) {
    if (conn.type !== "OO") continue;
    const node = objectIdMap.get(conn.childId);
    if (node && node.name === "Geometry") return conn.childId;
  }
  return undefined;
}

/** Add a morph target to the result map for a geometry. */
function addMorphToResult(
  result: Map<string, GeometryMorphData>,
  geometryId: string,
  morphTarget: MorphTargetData,
): void {
  let geoData = result.get(geometryId);
  if (!geoData) {
    geoData = { morphTargets: [], morphTargetNames: [] };
    result.set(geometryId, geoData);
  }
  geoData.morphTargets.push(morphTarget);
  geoData.morphTargetNames.push(morphTarget.name);
}

/** Extract a MorphTargetData from a SubDeformer (shape) node (classic structure). */
function extractMorphTargetFromSubDeformer(node: FBXNode, name: string): MorphTargetData | null {
  const shapes = childNode(node, "Shapes");
  if (!shapes || shapes.properties.length === 0) return null;

  const deltaPositions = propArray(shapes, 0);
  if (!deltaPositions || deltaPositions.length === 0) return null;

  const normalsNode = childNode(node, "Normals");
  let deltaNormals: Float32Array | undefined;
  if (normalsNode && normalsNode.properties.length > 0) {
    const normals = propArray(normalsNode, 0);
    if (normals && normals.length > 0) {
      deltaNormals = new Float32Array(normals);
    }
  }

  return {
    name,
    deltaPositions: new Float32Array(deltaPositions),
    deltaNormals,
  };
}

/** Extract a MorphTargetData from a Geometry node (modern structure).
 * The Geometry node has Indexes (affected vertex indices) and Vertices (delta positions for those vertices). */
function extractMorphTargetFromGeometry(node: FBXNode, name: string): MorphTargetData | null {
  const indexes = propArray(childNode(node, "Indexes"), 0);
  const vertices = propArray(childNode(node, "Vertices"), 0);
  if (!indexes || !vertices || indexes.length === 0 || vertices.length === 0) return null;

  // The Vertices array contains delta positions for the vertices listed in Indexes.
  // We need to expand to a full-size array (indexed by original vertex index).
  const maxIdx = Math.max(...indexes);
  const fullDeltas = new Float32Array((maxIdx + 1) * 3);
  for (let i = 0; i < indexes.length; i++) {
    const vi = indexes[i];
    fullDeltas[vi * 3] = vertices[i * 3] ?? 0;
    fullDeltas[vi * 3 + 1] = vertices[i * 3 + 1] ?? 0;
    fullDeltas[vi * 3 + 2] = vertices[i * 3 + 2] ?? 0;
  }

  // Check for delta normals
  const normalsNode = childNode(node, "Normals");
  let deltaNormals: Float32Array | undefined;
  if (normalsNode && normalsNode.properties.length > 0) {
    const normals = propArray(normalsNode, 0);
    if (normals && normals.length === vertices.length) {
      const fullNormals = new Float32Array((maxIdx + 1) * 3);
      for (let i = 0; i < indexes.length; i++) {
        const vi = indexes[i];
        fullNormals[vi * 3] = normals[i * 3] ?? 0;
        fullNormals[vi * 3 + 1] = normals[i * 3 + 1] ?? 0;
        fullNormals[vi * 3 + 2] = normals[i * 3 + 2] ?? 0;
      }
      deltaNormals = fullNormals;
    }
  }

  return {
    name,
    deltaPositions: fullDeltas,
    deltaNormals,
  };
}
