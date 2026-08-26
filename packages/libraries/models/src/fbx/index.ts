// ============================================================================
// FBX Parser Entry Point — parseFBX(data, name): ModelData
// ============================================================================
// Orchestrates the full FBX parsing pipeline:
//   1. Detect format (binary vs ASCII)
//   2. Parse binary → FBXNode[] tree
//   3. Build connection graph (single source of truth)
//   4. Run interpreters: global-settings, materials, nodes, skeleton,
//      geometry, animation, blend-shapes
//   5. Assemble ModelData
//
// This is the only file that loader.ts and index.ts import from.
//

import type { MaterialData, MeshData, ModelData, ModelNode, MorphTargetData } from "../types";
import { parseAnimations } from "./interpreter/animation";
import { parseBlendShapes } from "./interpreter/blend-shapes";
import { FBXConnectionGraph, getObjectId } from "./interpreter/connections";
import { DiagnosticsCollector } from "./interpreter/diagnostics";
import { parseGeometry } from "./interpreter/geometry";
import { parseGlobalSettings } from "./interpreter/global-settings";
import { parseMaterials } from "./interpreter/materials";
import { parseNodeHierarchy } from "./interpreter/nodes";
import { parseSkinData, type GeometrySkinData } from "./interpreter/skeleton";
import { parseFBXBinary } from "./parsers/binary-parser";
import type { FBXNode } from "./types";
import { findNodesInTree } from "./types";

/**
 * Parse an FBX file (binary or ASCII) into ModelData.
 *
 * Binary FBX is the primary path. ASCII FBX falls back to a minimal parser
 * (vertices/faces/normals only) — the full ASCII parser is deferred.
 */
export function parseFBX(data: ArrayBuffer, name: string): ModelData {
  const view = new DataView(data);
  const headerStr = new TextDecoder().decode(new Uint8Array(data, 0, 21));

  if (!headerStr.startsWith("Kaydara FBX Binary")) {
    return parseFBXASCII(data, name);
  }

  const diag = new DiagnosticsCollector(false);

  // 1. Parse binary → FBXNode[]
  const { nodes } = parseFBXBinary(data);

  // 2. Build connection graph
  const graph = new FBXConnectionGraph(nodes);

  // 3. Parse global settings
  const settings = parseGlobalSettings(nodes, diag);

  // 4. Parse materials + textures
  const { materials, materialTextures } = parseMaterials(nodes, graph, diag);

  // Build material colors array (for geometry vertex colors)
  const materialColors: [number, number, number][] = materials
    ? materials.map((m) => [m.baseColor[0], m.baseColor[1], m.baseColor[2]])
    : [];
  const hasTextures = new Set<number>();
  for (const [idx, tex] of materialTextures) {
    if (tex.textureData || tex.textureUri) hasTextures.add(idx);
  }

  // Build per-geometry material index remapping.
  // FBX's LayerElementMaterial indices are LOCAL to the model's connected
  // materials, not global material array indices. A model with one material
  // connected (e.g. "hair color" at global index 1) has LayerElementMaterial
  // index 0 referring to that material, not global index 0. Without this
  // remapping, meshes would use the wrong material (e.g. a palette texture
  // instead of a solid hair color).
  const materialRemap = buildMaterialRemap(nodes, graph, materials);

  // 5. Parse node hierarchy (needed for skin data)
  const nodesResult = parseNodeHierarchy(nodes, graph, diag);

  // 6. Parse skin/deformer data
  const skinResult = nodesResult
    ? parseSkinData(nodes, graph, nodesResult, diag)
    : null;

  // 7. Parse geometry (with skin data if available)
  const { meshes, geoIdToMeshIndices } = parseGeometry(
    nodes,
    { colors: materialColors, hasTextures },
    skinResult?.geometrySkins ?? new Map<string, GeometrySkinData>(),
    diag,
    materialRemap,
  );

  // 8. Link meshes to model nodes via Geometry→Model connections
  if (nodesResult) {
    linkMeshesToNodes(nodes, graph, geoIdToMeshIndices, nodesResult);
  }

  // 9. Parse animations
  const animations = parseAnimations(nodes, graph, diag);
  const animResult = animations.length > 0 ? animations : undefined;

  // 10. Parse blend shapes (morph targets)
  const morphData = parseBlendShapes(nodes, graph, diag);
  let morphTargetNames: string[] | undefined;
  if (morphData.size > 0) {
    // Apply morph targets to meshes
    applyMorphTargets(meshes, geoIdToMeshIndices, morphData);
    // Collect all morph target names
    const allNames: string[] = [];
    for (const geoData of morphData.values()) {
      allNames.push(...geoData.morphTargetNames);
    }
    if (allNames.length > 0) morphTargetNames = allNames;
  }

  // 11. Assemble ModelData
  const result: ModelData = {
    meshes,
    name,
    format: "fbx",
    materials,
    animations: animResult,
    nodes: nodesResult,
    sourceUpAxis: settings.upAxis,
    sourceUnits: settings.units,
    sourceUnitScaleFactor: settings.unitScaleFactor,
    morphTargetNames,
  };

  if (skinResult) {
    result.skin = {
      bones: skinResult.bones,
      boneNameToIndex: skinResult.boneNameToIndex,
    };
  }

  // Collect warnings
  if (diag.hasWarnings()) {
    result.warnings = diag.getWarningMessages();
  }

  return result;
}

/**
 * Link meshes to model nodes via Geometry→Model OO connections.
 * Updates ModelNode.mesh (first split) and ModelNode.meshes (all splits) for
 * each node that has a connected geometry. Multi-material geometries are split
 * into one MeshData per material by the geometry interpreter; all splits are
 * linked here so renderers can draw the full geometry, not just the first
 * material region.
 */
function linkMeshesToNodes(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  geoIdToMeshIndices: Map<string, number[]>,
  modelNodes: ModelNode[],
): void {
  const objectsNode = nodes.find((n) => n.name === "Objects");
  if (!objectsNode) return;

  // Find Model nodes and build ID → index map
  const modelNodesRaw = findNodesInTree([objectsNode], "Model");
  const modelIdToNodeIndex = new Map<string, number>();
  for (let i = 0; i < modelNodesRaw.length; i++) {
    const id = getObjectId(modelNodesRaw[i], `model_${i}`);
    modelIdToNodeIndex.set(id, i);
  }

  // Find Geometry→Model connections and set ModelNode.mesh + ModelNode.meshes.
  for (const conn of graph.connections) {
    if (conn.type !== "OO") continue;
    const meshIndices = geoIdToMeshIndices.get(conn.childId);
    if (!meshIndices || meshIndices.length === 0) continue;
    const nodeIdx = modelIdToNodeIndex.get(conn.parentId);
    if (nodeIdx === undefined) continue;
    // Link the first mesh (primary) plus all material splits (the node owns
    // every split produced from its geometry).
    if (modelNodes[nodeIdx].mesh === undefined) {
      modelNodes[nodeIdx].mesh = meshIndices[0];
      modelNodes[nodeIdx].meshes = meshIndices.slice();
    }
  }
}

/**
 * Build a per-geometry material index remapping (local → global).
 *
 * FBX's LayerElementMaterial indices are LOCAL to the model's connected
 * materials — index 0 means "the first material connected to this model,"
 * not "material 0 in the global array." Without remapping, a model whose
 * only material is at global index 2 would incorrectly use global index 0.
 *
 * This function:
 *  1. Maps Material node IDs → global array indices (parser order).
 *  2. For each Model node, collects its connected Material node IDs (in
 *     connection order) and maps local indices → global indices.
 *  3. For each Geometry node, finds its parent Model and inherits the
 *     model's remapping. Geometries with no parent model fall back to
 *     identity (local = global).
 *
 * @returns Map<geoId, Map<localMatIdx, globalMatIdx>>
 */
function buildMaterialRemap(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  materials: MaterialData[] | undefined,
): Map<string, Map<number, number>> {
  const remap = new Map<string, Map<number, number>>();
  if (!materials || materials.length === 0) return remap;

  const objectsNode = nodes.find((n) => n.name === "Objects");
  if (!objectsNode) return remap;

  // 1. Material node ID → global index
  const materialNodes = findNodesInTree([objectsNode], "Material");
  const matIdToGlobal = new Map<string, number>();
  for (let i = 0; i < materialNodes.length; i++) {
    const id = getObjectId(materialNodes[i], `mat_${i}`);
    matIdToGlobal.set(id, i);
  }

  // 2. For each Model, build local → global material index map
  const modelNodes = findNodesInTree([objectsNode], "Model");
  const modelMatRemap = new Map<string, Map<number, number>>();
  for (const modelNode of modelNodes) {
    const modelId = getObjectId(modelNode, "");
    if (!modelId) continue;

    // Collect Material connections (both OO and OP) in connection order.
    // The LayerElementMaterial local index refers to this order.
    const conns = graph.getConnectionsToParent(modelId);
    const globalIndices: number[] = [];
    for (const conn of conns) {
      const globalIdx = matIdToGlobal.get(conn.childId);
      if (globalIdx !== undefined) {
        globalIndices.push(globalIdx);
      }
    }

    if (globalIndices.length > 0) {
      const localToGlobal = new Map<number, number>();
      for (let i = 0; i < globalIndices.length; i++) {
        localToGlobal.set(i, globalIndices[i]);
      }
      modelMatRemap.set(modelId, localToGlobal);
    }
  }

  // 3. For each Geometry, find its parent Model and inherit the remapping
  const geometryNodes = findNodesInTree([objectsNode], "Geometry");
  for (const geoNode of geometryNodes) {
    const geoId = getObjectId(geoNode, "");
    if (!geoId) continue;

    // Find parent model via Geometry→Model OO connection
    const parentId = graph.getHierarchyParent(geoId);
    if (parentId) {
      const modelRemap = modelMatRemap.get(parentId);
      if (modelRemap) {
        remap.set(geoId, modelRemap);
      }
    }
  }

  return remap;
}

/** Apply morph target data to meshes based on geometry ID mapping. */
function applyMorphTargets(
  meshes: MeshData[],
  geoIdToMeshIndices: Map<string, number[]>,
  morphData: Map<string, { morphTargets: MorphTargetData[]; morphTargetNames: string[] }>,
): void {
  for (const [geoId, geoMorphData] of morphData) {
    const meshIndices = geoIdToMeshIndices.get(geoId);
    if (!meshIndices || meshIndices.length === 0) continue;
    // Apply to the first mesh (morph targets are per-geometry, not per-material-split)
    const mesh = meshes[meshIndices[0]];
    if (mesh) {
      mesh.morphTargets = geoMorphData.morphTargets;
      mesh.morphTargetNames = geoMorphData.morphTargetNames;
    }
  }
}

// ── ASCII fallback (minimal — vertices/faces/normals only) ─────────────────
// The full ASCII parser is deferred. All repo FBX files are binary.

function parseFBXASCII(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");

  const positions: number[][] = [];
  const faces: number[][] = [];
  let normals: number[] | null = null;
  let asciiUpAxis: "y" | "z" = "y";
  let asciiUnitScale: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("Vertices:")) {
      const arrayStr = trimmed.substring(trimmed.indexOf("{") + 1, trimmed.lastIndexOf("}"));
      const nums = arrayStr.split(",").map((s) => parseFloat(s.trim()));
      for (let i = 0; i < nums.length; i += 3) {
        positions.push([nums[i], nums[i + 1], nums[i + 2]]);
      }
    } else if (trimmed.startsWith("PolygonVertexIndex:")) {
      const arrayStr = trimmed.substring(trimmed.indexOf("{") + 1, trimmed.lastIndexOf("}"));
      const nums = arrayStr.split(",").map((s) => parseInt(s.trim()));
      faces.push(nums);
    } else if (trimmed.startsWith("Normals:")) {
      const arrayStr = trimmed.substring(trimmed.indexOf("{") + 1, trimmed.lastIndexOf("}"));
      normals = arrayStr.split(",").map((s) => parseFloat(s.trim()));
    } else if (trimmed.startsWith("UpAxis:")) {
      const val = parseInt(trimmed.substring(trimmed.indexOf(":") + 1).trim());
      if (val === 2) asciiUpAxis = "z";
    } else if (trimmed.startsWith("UnitScaleFactor:")) {
      asciiUnitScale = parseFloat(trimmed.substring(trimmed.indexOf(":") + 1).trim());
    }
  }

  if (positions.length === 0) {
    return { meshes: [], name, format: "fbx" };
  }

  const triIndices: number[] = [];
  let polyStart = 0;
  const polyIndices = faces.flat();

  for (let i = 0; i < polyIndices.length; i++) {
    const idx = polyIndices[i];
    if (idx < 0) {
      const endIdx = ~idx;
      const polyLen = i - polyStart + 1;
      if (polyLen === 3) {
        triIndices.push(polyIndices[polyStart], polyIndices[polyStart + 1], endIdx);
      } else if (polyLen === 4) {
        triIndices.push(
          polyIndices[polyStart],
          polyIndices[polyStart + 1],
          polyIndices[polyStart + 2],
        );
        triIndices.push(polyIndices[polyStart], polyIndices[polyStart + 2], endIdx);
      } else {
        for (let j = 1; j < polyLen - 1; j++) {
          triIndices.push(
            polyIndices[polyStart],
            polyIndices[polyStart + j] >= 0 ? polyIndices[polyStart + j] : ~polyIndices[polyStart + j],
            polyIndices[polyStart + j + 1] >= 0 ? polyIndices[polyStart + j + 1] : ~polyIndices[polyStart + j + 1],
          );
        }
      }
      polyStart = i + 1;
    }
  }

  const vertexCount = positions.length;
  const vertArray = new Float32Array(vertexCount * 6);

  for (let i = 0; i < vertexCount; i++) {
    vertArray[i * 6] = positions[i][0];
    vertArray[i * 6 + 1] = positions[i][1];
    vertArray[i * 6 + 2] = positions[i][2];
    if (normals && normals.length >= (i + 1) * 3) {
      vertArray[i * 6 + 3] = normals[i * 3];
      vertArray[i * 6 + 4] = normals[i * 3 + 1];
      vertArray[i * 6 + 5] = normals[i * 3 + 2];
    } else {
      vertArray[i * 6 + 3] = 0;
      vertArray[i * 6 + 4] = 1;
      vertArray[i * 6 + 5] = 0;
    }
  }

  const indexCount = triIndices.length;
  const useUint32 = vertexCount > 65535;
  const indices = useUint32
    ? new Uint32Array(triIndices)
    : new Uint16Array(triIndices);

  return {
    meshes: [{
      vertices: vertArray,
      indices,
      vertexCount,
      indexCount,
      uvs: null,
      colors: null,
    }],
    name,
    format: "fbx",
    sourceUpAxis: asciiUpAxis,
    sourceUnitScaleFactor: asciiUnitScale,
  };
}
