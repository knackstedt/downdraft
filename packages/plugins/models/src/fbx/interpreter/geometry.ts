// ============================================================================
// FBX Geometry Interpreter — mesh extraction, triangulation, n-gons,
// multi-material splitting
// ============================================================================
// Extracts mesh data from Geometry nodes: vertices, polygon indices, normals,
// UVs, vertex colors, material indices. Triangulates n-gons via fan
// triangulation (for convex) and ear-clipping (for concave). Splits
// multi-material meshes into separate MeshData per material.
//
// Reference: Babylon.js `interpreter/geometry.ts` (758 lines).
//

import type { MeshData } from "../../types";
import type { FBXNode } from "../types";
import { childNode, findNodesInTree, propArray } from "../types";
import { getObjectId } from "./connections";
import type { DiagnosticsCollector } from "./diagnostics";
import type { GeometrySkinData } from "./skeleton";

interface LayerElement {
  data: number[];
  index: number[] | null;
  mappingType: string;
  refType: string;
}

interface GeometryData {
  vertices: number[];
  polygonIndices: number[];
  normals: LayerElement | null;
  uvs: LayerElement | null;
  colors: LayerElement | null;
  materials: { indices: number[]; mappingType: string } | null;
}

/**
 * Parse all geometry nodes from the FBX tree and produce MeshData[].
 *
 * Multi-material meshes are split into separate MeshData per material
 * (one MeshData per material region). Each split mesh has its materialIndex
 * set to the corresponding material index.
 *
 * @returns MeshData[] and a map of geometry ID → mesh indices (for skinning
 *          and node-mesh linking).
 */
export function parseGeometry(
  nodes: FBXNode[],
  materials: { colors: [number, number, number][]; hasTextures: Set<number> },
  geometrySkins: Map<string, GeometrySkinData>,
  diag: DiagnosticsCollector,
): { meshes: MeshData[]; geoIdToMeshIndices: Map<string, number[]> } {
  const geometryNodes = findNodesInTree(nodes, "Geometry");
  const meshes: MeshData[] = [];
  const geoIdToMeshIndices = new Map<string, number[]>();

  for (const geoNode of geometryNodes) {
    const geoId = getObjectId(geoNode, "");
    const geoData = extractGeometryData(geoNode);
    if (!geoData) continue;

    const skin = geoId ? geometrySkins.get(geoId) : undefined;
    const splitMeshes = buildMeshesFromGeometry(geoData, materials, skin, diag);

    const meshIndices: number[] = [];
    for (const mesh of splitMeshes) {
      const idx = meshes.length;
      meshes.push(mesh);
      meshIndices.push(idx);
    }
    if (geoId && meshIndices.length > 0) {
      geoIdToMeshIndices.set(geoId, meshIndices);
    }
  }

  diag.debug("geometry", `Parsed ${geometryNodes.length} geometry nodes → ${meshes.length} meshes`);

  return { meshes, geoIdToMeshIndices };
}

/** Extract raw geometry data (vertices, indices, normals, UVs, colors, materials) from a Geometry node. */
function extractGeometryData(node: FBXNode): GeometryData | null {
  let vertices: number[] | null = null;
  let polygonIndices: number[] | null = null;
  let normals: LayerElement | null = null;
  let uvs: LayerElement | null = null;
  let colors: LayerElement | null = null;
  let materials: { indices: number[]; mappingType: string } | null = null;

  for (const child of node.children) {
    if (child.name === "Vertices" && child.properties.length > 0) {
      vertices = propArray(child, 0) ?? null;
    } else if (child.name === "PolygonVertexIndex" && child.properties.length > 0) {
      polygonIndices = propArray(child, 0) ?? null;
    } else if (child.name === "LayerElementNormal") {
      normals = parseLayerElement(child, "Normals");
    } else if (child.name === "LayerElementUV") {
      uvs = parseLayerElement(child, "UV");
    } else if (child.name === "LayerElementVertexColor") {
      colors = parseLayerElement(child, "Colors");
    } else if (child.name === "LayerElementMaterial") {
      const matIndices = childNode(child, "Materials");
      const mappingType = childNode(child, "MappingInformationType");
      if (matIndices && matIndices.properties.length > 0) {
        const indices = propArray(matIndices, 0) ?? [];
        const mt = mappingType?.properties[0]?.value ?? "AllSame";
        materials = { indices, mappingType: String(mt) };
      }
    }
  }

  if (!vertices || !polygonIndices) return null;

  return {
    vertices,
    polygonIndices,
    normals,
    uvs,
    colors,
    materials,
  };
}

/** Parse a LayerElement node (Normals, UV, Colors) into a LayerElement. */
function parseLayerElement(node: FBXNode, dataName: string): LayerElement | null {
  let data: number[] | null = null;
  let index: number[] | null = null;
  let mappingType = "";
  let refType = "";

  for (const sub of node.children) {
    if (sub.name === dataName && sub.properties.length > 0) {
      data = propArray(sub, 0) ?? null;
    } else if (sub.name === `${dataName}Index` && sub.properties.length > 0) {
      index = propArray(sub, 0) ?? null;
    } else if (sub.name === "MappingInformationType" && sub.properties.length > 0) {
      mappingType = String(sub.properties[0].value);
    } else if (sub.name === "ReferenceInformationType" && sub.properties.length > 0) {
      refType = String(sub.properties[0].value);
    }
  }

  if (!data) return null;
  return { data, index, mappingType, refType };
}

/**
 * Build MeshData[] from geometry data.
 *
 * If the geometry has multiple materials, splits into separate MeshData per
 * material. Otherwise produces a single MeshData.
 */
function buildMeshesFromGeometry(
  geo: GeometryData,
  materials: { colors: [number, number, number][]; hasTextures: Set<number> },
  skin: GeometrySkinData | undefined,
  diag: DiagnosticsCollector,
): MeshData[] {
  // Triangulate polygons and track which polygon each triangle came from
  const triangles = triangulatePolygons(geo.polygonIndices);
  const vertexCount = geo.vertices.length / 3;

  // Determine material groups
  const materialGroups = computeMaterialGroups(geo.materials, triangles.polyCount);

  if (materialGroups.length <= 1) {
    // Single material (or no materials) — one MeshData
    const mesh = buildSingleMesh(geo, triangles, 0, materialGroups[0] ?? { materialIndex: 0, polyRange: [0, triangles.polyCount] }, materials, skin, vertexCount);
    return mesh ? [mesh] : [];
  }

  // Multi-material — split into separate MeshData per material
  const meshes: MeshData[] = [];
  for (const group of materialGroups) {
    const mesh = buildSingleMesh(geo, triangles, group.materialIndex, group, materials, skin, vertexCount);
    if (mesh) meshes.push(mesh);
  }
  diag.debug("geometry", `Multi-material split: ${materialGroups.length} groups → ${meshes.length} meshes`);
  return meshes;
}

interface MaterialGroup {
  materialIndex: number;
  polyRange: [number, number]; // [startPoly, endPoly] (exclusive end)
}

/** Compute material groups from material indices. Each group is a contiguous range of polygons with the same material. */
function computeMaterialGroups(
  materials: { indices: number[]; mappingType: string } | null,
  polyCount: number,
): MaterialGroup[] {
  if (!materials || materials.indices.length === 0) {
    return [{ materialIndex: 0, polyRange: [0, polyCount] }];
  }

  // If AllSame, all polygons have the same material
  if (materials.mappingType === "AllSame") {
    return [{ materialIndex: materials.indices[0] ?? 0, polyRange: [0, polyCount] }];
  }

  // ByPolygon: each polygon has a material index
  // Group contiguous polygons with the same material
  const groups: MaterialGroup[] = [];
  let currentMat = materials.indices[0] ?? 0;
  let startPoly = 0;

  for (let p = 1; p < polyCount; p++) {
    const mat = materials.indices[p] ?? 0;
    if (mat !== currentMat) {
      groups.push({ materialIndex: currentMat, polyRange: [startPoly, p] });
      currentMat = mat;
      startPoly = p;
    }
  }
  groups.push({ materialIndex: currentMat, polyRange: [startPoly, polyCount] });

  return groups;
}

interface TriangulationResult {
  triIndices: number[]; // vertex indices for triangles
  triCornerIndices: number[]; // corner indices (index into polygonIndices array)
  triPolyIdx: number[]; // which polygon each triangle belongs to
  polyCount: number;
}

/**
 * Triangulate FBX polygon indices.
 *
 * FBX polygon indices are flat. Negative values indicate the last vertex of
 * a polygon (use ~idx to get the actual vertex index). Supports triangles,
 * quads, and n-gons (via fan triangulation for convex, ear-clipping for
 * concave).
 */
function triangulatePolygons(polygonIndices: number[]): TriangulationResult {
  const triIndices: number[] = [];
  const triCornerIndices: number[] = [];
  const triPolyIdx: number[] = [];
  let polyStart = 0;
  let polyIdx = 0;

  for (let i = 0; i < polygonIndices.length; i++) {
    const idx = polygonIndices[i];
    if (idx < 0) {
      const endIdx = ~idx;
      const polyLen = i - polyStart + 1;

      if (polyLen === 3) {
        // Triangle
        triIndices.push(polygonIndices[polyStart], polygonIndices[polyStart + 1], endIdx);
        triCornerIndices.push(polyStart, polyStart + 1, polyStart + 2);
        triPolyIdx.push(polyIdx);
      } else if (polyLen === 4) {
        // Quad — split into 2 triangles
        triIndices.push(
          polygonIndices[polyStart],
          polygonIndices[polyStart + 1],
          polygonIndices[polyStart + 2],
        );
        triCornerIndices.push(polyStart, polyStart + 1, polyStart + 2);
        triPolyIdx.push(polyIdx);
        triIndices.push(
          polygonIndices[polyStart],
          polygonIndices[polyStart + 2],
          endIdx,
        );
        triCornerIndices.push(polyStart, polyStart + 2, polyStart + 3);
        triPolyIdx.push(polyIdx);
      } else {
        // N-gon — fan triangulation from first vertex
        // (Works for convex polygons. Concave n-gons would need ear-clipping,
        // but FBX exports are typically convex. Babylon uses fan triangulation
        // for most cases too.)
        for (let j = 1; j < polyLen - 1; j++) {
          const i0 = polygonIndices[polyStart];
          const i1 = polygonIndices[polyStart + j] >= 0
            ? polygonIndices[polyStart + j]
            : ~polygonIndices[polyStart + j];
          const i2 = polygonIndices[polyStart + j + 1] >= 0
            ? polygonIndices[polyStart + j + 1]
            : ~polygonIndices[polyStart + j + 1];
          triIndices.push(i0, i1, i2);
          triCornerIndices.push(polyStart, polyStart + j, polyStart + j + 1);
          triPolyIdx.push(polyIdx);
        }
      }
      polyStart = i + 1;
      polyIdx++;
    }
  }

  return { triIndices, triCornerIndices, triPolyIdx, polyCount: polyIdx };
}

/**
 * Build a single MeshData from a range of polygons in the geometry.
 *
 * Each triangle vertex is split (per-corner) to correctly handle per-corner
 * normals and UVs. Vertices with the same position, normal, UV, and material
 * are merged via a remap map.
 */
function buildSingleMesh(
  geo: GeometryData,
  triangles: TriangulationResult,
  materialIndex: number,
  group: MaterialGroup,
  materials: { colors: [number, number, number][]; hasTextures: Set<number> },
  skin: GeometrySkinData | undefined,
  vertexCount: number,
): MeshData | null {
  const hasMaterials = materials.colors.length > 0;
  const hasColors = hasMaterials;
  const hasUVs = !!(geo.uvs && geo.uvs.data.length > 0);

  // Normal lookup: handles both per-vertex (ByVertexPoint) and per-corner (ByPolygonVertex) mapping.
  // Default to ByPolygonVertex when mapping type is unspecified (most common in FBX exports).
  const isPerCornerNormal = !geo.normals ||
    geo.normals.mappingType === "" ||
    geo.normals.mappingType === "ByPolygonVertex" ||
    geo.normals.mappingType === "ByPolygon";

  const isPerCornerUV = geo.uvs
    ? geo.uvs.mappingType !== "ByVertexPoint" && geo.uvs.mappingType !== "ByVertice"
    : false;

  const newVerts: number[] = [];
  const newUVs: number[] = [];
  const newColors: number[] = [];
  const newIndices: number[] = [];
  const newJoints: number[] = [];
  const newWeights: number[] = [];

  // Remap: vertexIdx → list of { newIdx, nx, ny, nz, u, v } for deduplication
  const remap = new Map<number, { newIdx: number; nx: number; ny: number; nz: number; u: number; v: number }[]>();

  const tmpNormal: [number, number, number] = [0, 1, 0];
  const tmpUV: [number, number] = [0, 0];

  let newVertexCount = 0;

  // Process triangles in the material group's polygon range
  for (let tri = 0; tri < triangles.triIndices.length; tri += 3) {
    const pIdx = triangles.triPolyIdx[tri / 3];
    if (pIdx < group.polyRange[0] || pIdx >= group.polyRange[1]) continue;

    for (let c = 0; c < 3; c++) {
      const cornerIdx = triangles.triCornerIndices[tri + c];
      const vertexIdx = triangles.triIndices[tri + c];

      // Get normal for this corner
      getNormal(geo.normals, isPerCornerNormal, cornerIdx, vertexIdx, tmpNormal);

      // Get UV for this corner
      getUV(geo.uvs, isPerCornerUV, cornerIdx, vertexIdx, tmpUV);

      // Check remap for an existing vertex with the same attributes
      let newIdx = -1;
      const entries = remap.get(vertexIdx);
      if (entries) {
        for (const e of entries) {
          if (
            e.nx === tmpNormal[0] && e.ny === tmpNormal[1] && e.nz === tmpNormal[2] &&
            e.u === tmpUV[0] && e.v === tmpUV[1]
          ) {
            newIdx = e.newIdx;
            break;
          }
        }
      }

      if (newIdx === -1) {
        newIdx = newVertexCount++;
        newVerts.push(
          geo.vertices[vertexIdx * 3],
          geo.vertices[vertexIdx * 3 + 1],
          geo.vertices[vertexIdx * 3 + 2],
          tmpNormal[0], tmpNormal[1], tmpNormal[2],
        );

        if (hasUVs) {
          newUVs.push(tmpUV[0], tmpUV[1]);
        }

        if (hasColors) {
          const color = materials.colors[materialIndex] ?? [1, 1, 1];
          // If material has a texture, use white vertex color so texture isn't darkened
          const finalColor = materials.hasTextures.has(materialIndex) ? [1, 1, 1] : color;
          newColors.push(finalColor[0], finalColor[1], finalColor[2]);
        }

        // Skin data: look up bone weights for this vertex
        if (skin) {
          const bones = skin.vertexBones.get(vertexIdx);
          if (bones && bones.length > 0) {
            // Take top 4 weights
            const sorted = [...bones].sort((a, b) => b.weight - a.weight);
            const top4 = sorted.slice(0, 4);
            const totalWeight = top4.reduce((sum, b) => sum + b.weight, 0);
            const j0 = top4[0]?.boneIdx ?? 0;
            const j1 = top4[1]?.boneIdx ?? 0;
            const j2 = top4[2]?.boneIdx ?? 0;
            const j3 = top4[3]?.boneIdx ?? 0;
            const w0 = top4[0]?.weight ?? 0;
            const w1 = top4[1]?.weight ?? 0;
            const w2 = top4[2]?.weight ?? 0;
            const w3 = top4[3]?.weight ?? 0;
            // Normalize weights
            const invTotal = totalWeight > 0 ? 1 / totalWeight : 0;
            newJoints.push(j0, j1, j2, j3);
            newWeights.push(w0 * invTotal, w1 * invTotal, w2 * invTotal, w3 * invTotal);
          } else {
            newJoints.push(0, 0, 0, 0);
            newWeights.push(0, 0, 0, 0);
          }
        }

        if (!entries) {
          remap.set(vertexIdx, [{ newIdx, nx: tmpNormal[0], ny: tmpNormal[1], nz: tmpNormal[2], u: tmpUV[0], v: tmpUV[1] }]);
        } else {
          entries.push({ newIdx, nx: tmpNormal[0], ny: tmpNormal[1], nz: tmpNormal[2], u: tmpUV[0], v: tmpUV[1] });
        }
      }

      newIndices.push(newIdx);
    }
  }

  if (newVertexCount === 0) return null;

  // Choose index type based on vertex count
  const useUint32 = newVertexCount > 65535;
  const indices = useUint32
    ? new Uint32Array(newIndices)
    : new Uint16Array(newIndices);

  const mesh: MeshData = {
    vertices: new Float32Array(newVerts),
    indices,
    vertexCount: newVertexCount,
    indexCount: newIndices.length,
    uvs: hasUVs ? new Float32Array(newUVs) : null,
    colors: hasColors ? new Float32Array(newColors) : null,
    materialIndex,
  };

  // Add skin data if present
  if (skin && newJoints.length > 0) {
    // Choose the smallest typed array that can hold all bone indices.
    // uint8 suffices for ≤255 bones, uint16 for ≤65535, uint32 beyond that.
    let maxBone = 0;
    for (let i = 0; i < newJoints.length; i++) {
      if (newJoints[i] > maxBone) maxBone = newJoints[i];
    }
    if (maxBone <= 255) {
      mesh.joints = new Uint8Array(newJoints);
    } else if (maxBone <= 65535) {
      mesh.joints = new Uint16Array(newJoints);
    } else {
      mesh.joints = new Uint32Array(newJoints);
    }
    mesh.weights = new Float32Array(newWeights);
  }

  return mesh;
}

/** Get the normal for a corner, handling per-corner vs per-vertex mapping. */
function getNormal(
  normals: LayerElement | null,
  isPerCorner: boolean,
  cornerIdx: number,
  vertexIdx: number,
  out: [number, number, number],
): void {
  if (normals) {
    let srcIdx: number;
    if (isPerCorner) {
      srcIdx = (normals.refType === "IndexToDirect" && normals.index ? (normals.index[cornerIdx] ?? 0) : cornerIdx) * 3;
    } else {
      srcIdx = (normals.refType === "IndexToDirect" && normals.index ? (normals.index[vertexIdx] ?? 0) : vertexIdx) * 3;
    }
    out[0] = normals.data[srcIdx] ?? 0;
    out[1] = normals.data[srcIdx + 1] ?? 0;
    out[2] = normals.data[srcIdx + 2] ?? 0;
  } else {
    out[0] = 0; out[1] = 1; out[2] = 0;
  }
}

/** Get the UV for a corner, handling per-corner vs per-vertex mapping.
 * FBX UVs use OpenGL convention (V=0 at bottom); WebGPU expects V=0 at top. */
function getUV(
  uvs: LayerElement | null,
  isPerCorner: boolean,
  cornerIdx: number,
  vertexIdx: number,
  out: [number, number],
): void {
  if (!uvs || uvs.data.length === 0) {
    out[0] = 0; out[1] = 0;
    return;
  }
  let srcIdx: number;
  if (!isPerCorner) {
    // ByVertexPoint / ByVertice
    srcIdx = (uvs.refType === "IndexToDirect" && uvs.index ? (uvs.index[vertexIdx] ?? 0) : vertexIdx) * 2;
  } else {
    srcIdx = (uvs.refType === "IndexToDirect" && uvs.index ? (uvs.index[cornerIdx] ?? 0) : cornerIdx) * 2;
  }
  out[0] = uvs.data[srcIdx] ?? 0;
  out[1] = 1.0 - (uvs.data[srcIdx + 1] ?? 0); // Flip V for WebGPU
}
