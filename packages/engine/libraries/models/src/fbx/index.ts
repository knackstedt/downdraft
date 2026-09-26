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
  for (const [idx, tex] of materialTextures.entries()) {
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
      skeletonUpAxis: settings.upAxis,
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
  for (let _i = 0, _it = graph.connections, _n = _it.length; _i < _n; _i++) { const conn = _it[_i];
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
  for (let _i = 0, _it = modelNodes, _n = _it.length; _i < _n; _i++) { const modelNode = _it[_i];
    const modelId = getObjectId(modelNode, "");
    if (!modelId) continue;

    // Collect Material connections (both OO and OP) in connection order.
    // The LayerElementMaterial local index refers to this order.
    const conns = graph.getConnectionsToParent(modelId);
    const globalIndices: number[] = [];
    conns.forEach((conn) => {
      const globalIdx = matIdToGlobal.get(conn.childId);
      if (globalIdx !== undefined) {
        globalIndices.push(globalIdx);
      }
    });

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
  for (let _i = 0, _it = geometryNodes, _n = _it.length; _i < _n; _i++) { const geoNode = _it[_i];
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
  for (const [geoId, geoMorphData] of morphData.entries()) {
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

// ── ASCII fallback (vertices/faces/normals/uvs — no materials or hierarchy) ─
// The full ASCII parser is deferred; this handles the common `Name: *N {
// a: n,n,... }` array blocks found in e.g. Kenney's ASCII FBX exports.

interface ASCIIGeometry {
  verts: number[] | null;
  pvi: number[] | null;
  normals: number[] | null;
  uvs: number[] | null;
  uvIndex: number[] | null;
}

/** Read an ASCII FBX numeric array. Handles both `Name: *N {` + `a: …` +
 * `}` block form and the inline `Name: n,n,n` form. */
function readASCIIArray(lines: string[], i: number): { nums: number[]; end: number } {
  const nums: number[] = [];
  const header = lines[i];
  const take = (s: string) => {
    for (const part of s.split(",")) {
      const v = parseFloat(part.trim());
      if (!Number.isNaN(v)) nums.push(v);
    }
  };
  const open = header.indexOf("{");
  if (open === -1) {
    take(header.substring(header.indexOf(":") + 1));
    return { nums, end: i };
  }
  const close = header.indexOf("}", open);
  if (close !== -1) { // `Name: *N { a: … }` complete on one line
    take(header.substring(open + 1, close).replace(/^a:/, ""));
    return { nums, end: i };
  }
  for (let j = i + 1; j < lines.length; j++) {
    let l = lines[j].trim();
    if (l.startsWith("}")) return { nums, end: j };
    if (l.startsWith("a:")) l = l.substring(2);
    take(l);
  }
  return { nums, end: lines.length - 1 };
}

function buildASCIIMesh(geo: ASCIIGeometry): MeshData | null {
  const v = geo.verts, pvi = geo.pvi;
  if (!v || !pvi || v.length < 3 || pvi.length === 0) return null;

  // PolygonVertexIndex: negative last index of each polygon is bitwise-NOT.
  // Emit one vertex per polygon corner (normals/uvs are per-polyvertex in
  // FBX, so corners can't be shared without a (pos,attr) key map — emitting
  // unshared keeps hard edges correct and the code simple).
  const cornerPos: number[] = [];
  const cornerSlot: number[] = [];
  const tris: number[] = [];
  const posAt = (k: number) => (pvi[k] < 0 ? ~pvi[k] : pvi[k]);
  let polyStart = 0;
  for (let k = 0; k < pvi.length; k++) {
    if (pvi[k] >= 0) continue;
    const len = k - polyStart + 1;
    for (let t = 1; t < len - 1; t++) {
      const base = cornerPos.length;
      cornerPos.push(posAt(polyStart), posAt(polyStart + t), posAt(polyStart + t + 1));
      cornerSlot.push(polyStart, polyStart + t, polyStart + t + 1);
      tris.push(base, base + 1, base + 2);
    }
    polyStart = k + 1;
  }
  if (tris.length === 0) return null;

  const nV = cornerPos.length;
  const nPos = v.length / 3;
  const nrm = geo.normals;
  const nPerPolyVert = !!nrm && nrm.length === pvi.length * 3;
  const nPerVert = !!nrm && nrm.length === nPos * 3;
  const uv = geo.uvs;
  const uvi = geo.uvIndex;
  const hasUv = !!uv && uv.length >= 2;
  // IndexToDirect: UVIndex[pviSlot] → uv pair. Direct: uv[pviSlot].
  const uvByIndex = hasUv && !!uvi && uvi.length === pvi.length;

  const vertArray = new Float32Array(nV * 6);
  const uvArray = hasUv ? new Float32Array(nV * 2) : null;
  for (let e = 0; e < nV; e++) {
    const p = cornerPos[e], s = cornerSlot[e];
    vertArray[e * 6] = v[p * 3]; vertArray[e * 6 + 1] = v[p * 3 + 1]; vertArray[e * 6 + 2] = v[p * 3 + 2];
    if (nrm && (nPerPolyVert || nPerVert)) {
      const ni = (nPerPolyVert ? s : p) * 3;
      vertArray[e * 6 + 3] = nrm[ni]; vertArray[e * 6 + 4] = nrm[ni + 1]; vertArray[e * 6 + 5] = nrm[ni + 2];
    } else {
      vertArray[e * 6 + 4] = 1; // placeholder up — flat-shaded below if absent
    }
    if (uvArray && uv) {
      const ui = uvByIndex && uvi ? uvi[s] : s;
      if (ui * 2 + 1 < uv.length) { uvArray[e * 2] = uv[ui * 2]; uvArray[e * 2 + 1] = uv[ui * 2 + 1]; }
    }
  }

  // No normals in the file → flat face normal per triangle.
  if (!nrm || (!nPerPolyVert && !nPerVert)) {
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 6, b = tris[t + 1] * 6, c = tris[t + 2] * 6;
      const ux = vertArray[b] - vertArray[a], uy = vertArray[b + 1] - vertArray[a + 1], uz = vertArray[b + 2] - vertArray[a + 2];
      const vx = vertArray[c] - vertArray[a], vy = vertArray[c + 1] - vertArray[a + 1], vz = vertArray[c + 2] - vertArray[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      [a, b, c].forEach((j) => { vertArray[j + 3] = nx; vertArray[j + 4] = ny; vertArray[j + 5] = nz; });
    }
  }

  const indices = nV > 65535 ? new Uint32Array(tris) : new Uint16Array(tris);
  return {
    vertices: vertArray,
    indices,
    vertexCount: nV,
    indexCount: tris.length,
    uvs: uvArray,
    colors: null,
  };
}

function parseFBXASCII(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");

  const meshes: MeshData[] = [];
  let geo: ASCIIGeometry | null = null;
  let depth = 0;
  let geoDepth = 0; // depth the Geometry node sits at — emit when we return to it
  let asciiUpAxis: "y" | "z" = "y";
  let asciiUnitScale: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("UpAxis:")) {
      if (parseInt(l.substring(l.indexOf(":") + 1).trim()) === 2) asciiUpAxis = "z";
    } else if (l.startsWith("UnitScaleFactor:")) {
      asciiUnitScale = parseFloat(l.substring(l.indexOf(":") + 1).trim());
    }

    if (!geo && /^Geometry:\s*[^,]+,\s*"Geometry::[^"]*",\s*"Mesh"/.test(l)) {
      geo = { verts: null, pvi: null, normals: null, uvs: null, uvIndex: null };
      geoDepth = depth;
    }
    if (geo) {
      if (l.startsWith("Vertices:")) { const r = readASCIIArray(lines, i); geo.verts = r.nums; i = r.end; continue; }
      if (l.startsWith("PolygonVertexIndex:")) { const r = readASCIIArray(lines, i); geo.pvi = r.nums; i = r.end; continue; }
      if (l.startsWith("Normals:")) { const r = readASCIIArray(lines, i); geo.normals = r.nums; i = r.end; continue; }
      if (l.startsWith("UV:")) { const r = readASCIIArray(lines, i); geo.uvs = geo.uvs ?? r.nums; i = r.end; continue; }
      if (l.startsWith("UVIndex:")) { const r = readASCIIArray(lines, i); geo.uvIndex = geo.uvIndex ?? r.nums; i = r.end; continue; }
    }
    depth += (l.match(/{/g) ?? []).length - (l.match(/}/g) ?? []).length;
    if (geo && depth === geoDepth) {
      const mesh = buildASCIIMesh(geo);
      if (mesh) meshes.push(mesh);
      geo = null;
    }
  }
  // File ended mid-block — emit whatever was collected.
  if (geo) {
    const mesh = buildASCIIMesh(geo);
    if (mesh) meshes.push(mesh);
  }

  return {
    meshes,
    name,
    format: "fbx",
    sourceUpAxis: asciiUpAxis,
    sourceUnitScaleFactor: asciiUnitScale,
  };
}
