import { assertFinite, assertPositive, MAX_DECOMPRESS_SIZE, MAX_NODE_DEPTH } from "@downdraft/core";
import { decompressSync } from "fflate";
import type { AnimationChannel, AnimationData, BoneData, MaterialData, MeshData, ModelData, ModelNode } from "./types";

/** Invert a 4×4 column-major matrix via adjugate / determinant. */
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

interface FBXNode {
  name: string;
  properties: FBXProperty[];
  children: FBXNode[];
}

type FBXProperty =
  | { type: "Y"; value: number }
  | { type: "C"; value: boolean }
  | { type: "I"; value: number }
  | { type: "F"; value: number }
  | { type: "D"; value: number }
  | { type: "L"; value: number }
  | { type: "R"; value: Uint8Array }
  | { type: "S"; value: string }
  | { type: "f" | "i" | "d" | "l" | "b"; value: number[]; encoding: number };

const FBX_HEADER_MAGIC = "Kaydara FBX Binary  \x00";

function parseFBXNode(
  view: DataView,
  offset: number,
  endOffset: number,
  version: number,
): { node: FBXNode | null; nextOffset: number } | null {
  // FBX 7500+ uses uint64 header fields (8+8+8+1 = 25 bytes)
  // FBX < 7500 uses uint32 header fields (4+4+4+1 = 13 bytes)
  const is64Bit = version >= 7500;
  const headerSize = is64Bit ? 25 : 13;

  if (offset + headerSize > view.byteLength) return null;

  let nodeEndOffset: number;
  let numProperties: number;
  let propertyListLen: number;
  let nameLen: number;

  if (is64Bit) {
    // Read uint64 as two uint32; high 32 bits should be 0 for normal-sized files
    nodeEndOffset = view.getUint32(offset, true);
    numProperties = view.getUint32(offset + 8, true);
    propertyListLen = view.getUint32(offset + 16, true);
    nameLen = view.getUint8(offset + 24);
  } else {
    nodeEndOffset = view.getUint32(offset, true);
    numProperties = view.getUint32(offset + 4, true);
    propertyListLen = view.getUint32(offset + 8, true);
    nameLen = view.getUint8(offset + 12);
  }

  // Null record: all header fields are 0
  if (nodeEndOffset === 0 && numProperties === 0 && propertyListLen === 0 && nameLen === 0) {
    return { node: null, nextOffset: offset + headerSize };
  }
  if (nodeEndOffset > view.byteLength) return null;

  // For nodes with endOffset=0, use parent's endOffset as the boundary
  const effectiveEndOffset = nodeEndOffset === 0 ? endOffset : nodeEndOffset;

  let pos = offset + headerSize + nameLen;
  const name = new TextDecoder().decode(new Uint8Array(view.buffer, pos - nameLen, nameLen));

  const properties: FBXProperty[] = [];
  const propEnd = pos + propertyListLen;

  for (let i = 0; i < numProperties && pos < propEnd; i++) {
    const prop = parseFBXProperty(view, pos);
    if (prop === null) break;
    properties.push(prop.property);
    pos = prop.nextOffset;
  }

  pos = propEnd;

  const children: FBXNode[] = [];
  while (pos < effectiveEndOffset) {
    const child = parseFBXNode(view, pos, effectiveEndOffset, version);
    if (child === null) break;
    if (child.node === null) {
      pos = child.nextOffset;
      break;
    }
    children.push(child.node);
    pos = child.nextOffset;
  }

  return {
    node: { name, properties, children },
    nextOffset: effectiveEndOffset,
  };
}

function parseFBXProperty(
  view: DataView,
  offset: number,
): { property: FBXProperty; nextOffset: number } | null {
  const typeCode = String.fromCharCode(view.getUint8(offset));

  switch (typeCode) {
    case "Y": {
      const value = view.getInt16(offset + 1, true);
      return { property: { type: "Y", value }, nextOffset: offset + 3 };
    }
    case "C": {
      const value = view.getUint8(offset + 1) !== 0;
      return { property: { type: "C", value }, nextOffset: offset + 2 };
    }
    case "I": {
      const value = view.getInt32(offset + 1, true);
      return { property: { type: "I", value }, nextOffset: offset + 5 };
    }
    case "F": {
      const value = view.getFloat32(offset + 1, true);
      return { property: { type: "F", value }, nextOffset: offset + 5 };
    }
    case "D": {
      const value = view.getFloat64(offset + 1, true);
      return { property: { type: "D", value }, nextOffset: offset + 9 };
    }
    case "L": {
      const value = Number(view.getBigInt64(offset + 1, true));
      return { property: { type: "L", value }, nextOffset: offset + 9 };
    }
    case "R": {
      const length = view.getUint32(offset + 1, true);
      const value = new Uint8Array(view.buffer, offset + 5, length);
      return { property: { type: "R", value }, nextOffset: offset + 5 + length };
    }
    case "S": {
      const length = view.getUint32(offset + 1, true);
      const raw = new TextDecoder().decode(
        new Uint8Array(view.buffer, offset + 5, length),
      );
      // FBX strings contain null terminators and \x00\x01 namespace separators
      // Strip everything from the first null byte onward
      const nullIdx = raw.indexOf("\x00");
      let value = nullIdx >= 0 ? raw.substring(0, nullIdx) : raw;
      // Normalize Mixamo namespace variant: mixamorig7: → mixamorig:
      if (value.startsWith("mixamorig7:")) {
        value = "mixamorig:" + value.substring(11);
      }
      return { property: { type: "S", value }, nextOffset: offset + 5 + length };
    }
    case "f":
    case "i":
    case "d":
    case "l":
    case "b": {
      const arrayLength = view.getUint32(offset + 1, true);
      const encoding = view.getUint32(offset + 5, true);
      const compLength = view.getUint32(offset + 9, true);
      const dataStart = offset + 13;

      // Validate arrayLength is finite and positive before use
      assertFinite("fbx arrayLength", arrayLength);
      assertPositive("fbx arrayLength", arrayLength);

      let values: number[];

      if (encoding === 1) {
        if (arrayLength > MAX_DECOMPRESS_SIZE) {
          throw new RangeError(
            `fbx: decompressed array length ${arrayLength} exceeds max ${MAX_DECOMPRESS_SIZE}`,
          );
        }
        const compressed = new Uint8Array(view.buffer, dataStart, compLength);
        const decompressed = decompressSync(compressed);
        values = readFBXArray(decompressed, typeCode, arrayLength);
      } else {
        const raw = new Uint8Array(view.buffer, dataStart, compLength);
        values = readFBXArray(raw, typeCode, arrayLength);
      }

      return {
        property: { type: typeCode as any, value: values, encoding },
        nextOffset: dataStart + compLength,
      };
    }
    default:
      return null;
  }
}

function readFBXArray(data: Uint8Array, typeCode: string, count: number): number[] {
  const result: number[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  switch (typeCode) {
    case "f": {
      for (let i = 0; i < count; i++) result.push(view.getFloat32(i * 4, true));
      break;
    }
    case "i": {
      for (let i = 0; i < count; i++) result.push(view.getInt32(i * 4, true));
      break;
    }
    case "d": {
      for (let i = 0; i < count; i++) result.push(view.getFloat64(i * 8, true));
      break;
    }
    case "l": {
      for (let i = 0; i < count; i++) result.push(Number(view.getBigInt64(i * 8, true)));
      break;
    }
    case "b": {
      for (let i = 0; i < count; i++) result.push(data[i] !== 0 ? 1 : 0);
      break;
    }
  }

  return result;
}

function findNodesByName(node: FBXNode, name: string, results: FBXNode[] = [], depth = 0): FBXNode[] {
  if (depth > MAX_NODE_DEPTH) return results;
  if (node.name === name) results.push(node);
  for (let i = 0; i < node.children.length; i++) {
    findNodesByName(node.children[i], name, results, depth + 1);
  }
  return results;
}

function findMaterials(node: FBXNode, materialColors: [number, number, number][], materialNames: string[], depth = 0): void {
  if (depth > MAX_NODE_DEPTH) return;
  if (node.name === "Material") {
    let color: [number, number, number] = [1, 1, 1];
    let matName = "material";
    for (let i = 0; i < node.properties.length; i++) {
      if (node.properties[i].type === "S") {
        matName = String(node.properties[i].value);
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.name === "Properties70") {
        for (let j = 0; j < child.children.length; j++) {
          const p = child.children[j];
          if (p.name === "P" && p.properties.length >= 5) {
            const propName = String(p.properties[0].value);
            if (propName === "DiffuseColor" || propName === "Diffuse") {
              color = [
                p.properties[4].value as number,
                p.properties[5].value as number,
                p.properties[6].value as number,
              ];
            }
          }
        }
      }
    }
    materialColors.push(color);
    materialNames.push(matName);
  }
  for (let i = 0; i < node.children.length; i++) {
    findMaterials(node.children[i], materialColors, materialNames, depth + 1);
  }
}

function findGeometryNodes(
  node: FBXNode,
  meshes: MeshData[],
  materialColors?: [number, number, number][],
  geometrySkins?: Map<string, { vertexBones: Map<number, { boneIdx: number; weight: number }[]> }>,
  geoIdToMeshIndex?: Map<string, number>,
  depth = 0,
): void {
  if (depth > MAX_NODE_DEPTH) return;
  if (node.name === "Geometry") {
    const geoId = node.properties.length > 0 ? String(node.properties[0].value) : "";
    const skin = geoId ? geometrySkins?.get(geoId) : undefined;
    const mesh = extractFBXGeometry(node, materialColors, skin);
    if (mesh) {
      const meshIndex = meshes.length;
      meshes.push(mesh);
      if (geoId && geoIdToMeshIndex) {
        geoIdToMeshIndex.set(geoId, meshIndex);
      }
    }
  }
  for (let i = 0; i < node.children.length; i++) {
    findGeometryNodes(node.children[i], meshes, materialColors, geometrySkins, geoIdToMeshIndex, depth + 1);
  }
}

function extractFBXGeometry(
  node: FBXNode,
  materialColors?: [number, number, number][],
  geometrySkin?: { vertexBones: Map<number, { boneIdx: number; weight: number }[]> },
): MeshData | null {
  let vertices: number[] | null = null;
  let polygonIndices: number[] | null = null;
  let normals: number[] | null = null;
  let normalMappingType = "";
  let normalRefType = "";
  let normalsIndex: number[] | null = null;
  let uvData: number[] | null = null;
  let uvIndex: number[] | null = null;
  let uvMappingType = "";
  let uvRefType = "";
  let materialIndices: number[] | null = null;
  let materialMappingType = "";

  function findUVNode(n: FBXNode): void {
    if (uvData) return;
    if (n.name === "LayerElementUV") {
      for (let i = 0; i < n.children.length; i++) {
        const sub = n.children[i];
        if (sub.name === "UV" && sub.properties.length > 0) {
          const prop = sub.properties[0];
          if (typeof prop.value === "object" && Array.isArray(prop.value)) {
            uvData = prop.value as number[];
          }
        } else if (sub.name === "UVIndex" && sub.properties.length > 0) {
          const prop = sub.properties[0];
          if (typeof prop.value === "object" && Array.isArray(prop.value)) {
            uvIndex = prop.value as number[];
          }
        } else if (sub.name === "MappingInformationType" && sub.properties.length > 0) {
          uvMappingType = String(sub.properties[0].value);
        } else if (sub.name === "ReferenceInformationType" && sub.properties.length > 0) {
          uvRefType = String(sub.properties[0].value);
        }
      }
      return;
    }
    for (let i = 0; i < n.children.length; i++) {
      findUVNode(n.children[i]);
      if (uvData) return;
    }
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.name === "Vertices" && child.properties.length > 0) {
      const prop = child.properties[0];
      if (typeof prop.value === "object" && Array.isArray(prop.value)) {
        vertices = prop.value as number[];
      }
    } else if (child.name === "PolygonVertexIndex" && child.properties.length > 0) {
      const prop = child.properties[0];
      if (typeof prop.value === "object" && Array.isArray(prop.value)) {
        polygonIndices = prop.value as number[];
      }
    } else if (child.name === "LayerElementNormal") {
      for (let j = 0; j < child.children.length; j++) {
        const sub = child.children[j];
        if (sub.name === "Normals" && sub.properties.length > 0) {
          const prop = sub.properties[0];
          if (typeof prop.value === "object" && Array.isArray(prop.value)) {
            normals = prop.value as number[];
          }
        } else if (sub.name === "NormalsIndex" && sub.properties.length > 0) {
          const prop = sub.properties[0];
          if (typeof prop.value === "object" && Array.isArray(prop.value)) {
            normalsIndex = prop.value as number[];
          }
        } else if (sub.name === "MappingInformationType" && sub.properties.length > 0) {
          normalMappingType = String(sub.properties[0].value);
        } else if (sub.name === "ReferenceInformationType" && sub.properties.length > 0) {
          normalRefType = String(sub.properties[0].value);
        }
      }
    } else if (child.name === "LayerElementMaterial") {
      for (let j = 0; j < child.children.length; j++) {
        const sub = child.children[j];
        if (sub.name === "Materials" && sub.properties.length > 0) {
          const prop = sub.properties[0];
          if (typeof prop.value === "object" && Array.isArray(prop.value)) {
            materialIndices = prop.value as number[];
          }
        } else if (sub.name === "MappingInformationType" && sub.properties.length > 0) {
          materialMappingType = String(sub.properties[0].value);
        }
      }
    }
  }

  findUVNode(node);

  if (!vertices || !polygonIndices) return null;

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
        triIndices.push(polygonIndices[polyStart], polygonIndices[polyStart + 1], endIdx);
        triCornerIndices.push(polyStart, polyStart + 1, polyStart + 2);
        triPolyIdx.push(polyIdx);
      } else if (polyLen === 4) {
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

  const vertexCount = vertices.length / 3;
  const uvDataArr = uvData as number[] | null;
  const hasUVs = !!(uvDataArr && uvDataArr.length > 0);

  // Normal lookup: handles both per-vertex (ByVertexPoint) and per-corner (ByPolygonVertex) mapping.
  // Default to ByPolygonVertex when mapping type is unspecified (most common in FBX exports).
  const isPerCornerNormal = normalMappingType === "" ||
    normalMappingType === "ByPolygonVertex" || normalMappingType === "ByPolygon";

  function getNormal(cornerIdx: number, vertexIdx: number, out: [number, number, number]): void {
    if (normals) {
      let srcIdx: number;
      if (isPerCornerNormal) {
        srcIdx = (normalRefType === "IndexToDirect" && normalsIndex ? (normalsIndex[cornerIdx] ?? 0) : cornerIdx) * 3;
      } else {
        srcIdx = (normalRefType === "IndexToDirect" && normalsIndex ? (normalsIndex[vertexIdx] ?? 0) : vertexIdx) * 3;
      }
      out[0] = normals[srcIdx] ?? 0;
      out[1] = normals[srcIdx + 1] ?? 0;
      out[2] = normals[srcIdx + 2] ?? 0;
    } else {
      out[0] = 0; out[1] = 1; out[2] = 0;
    }
  }

  // UV lookup: handles both per-vertex and per-corner mapping.
  // FBX UVs use OpenGL convention (V=0 at bottom); WebGPU expects V=0 at top.
  function getUV(cornerIdx: number, vertexIdx: number, out: [number, number]): void {
    if (!hasUVs) { out[0] = 0; out[1] = 0; return; }
    let srcIdx: number;
    if (uvMappingType === "ByVertexPoint" || uvMappingType === "ByVertice") {
      srcIdx = (uvRefType === "IndexToDirect" && uvIndex ? (uvIndex[vertexIdx] ?? 0) : vertexIdx) * 2;
    } else {
      srcIdx = (uvRefType === "IndexToDirect" && uvIndex ? (uvIndex[cornerIdx] ?? 0) : cornerIdx) * 2;
    }
    out[0] = uvDataArr![srcIdx] ?? 0;
    out[1] = 1.0 - (uvDataArr![srcIdx + 1] ?? 0);
  }

  // Always split vertices per-corner to correctly handle per-corner normals and UVs.
  // Vertices with same position, normal, UV, and material are merged via remap.
  const hasMaterials = !!(materialIndices && materialColors && materialColors.length > 0);
  const hasColors = !!(materialColors && materialColors.length > 0);

  const newVerts: number[] = [];
  const newUVs: number[] = [];
  const newColors: number[] = [];
  const newIndices: number[] = [];

  const remap: Map<number, { newIdx: number; matIdx: number; nx: number; ny: number; nz: number; u: number; v: number }[]> = new Map();

  const tmpNormal: [number, number, number] = [0, 1, 0];
  const tmpUV: [number, number] = [0, 0];

  for (let tri = 0; tri < triIndices.length; tri += 3) {
    const pIdx = triPolyIdx[tri / 3];
    const matIdx = hasMaterials ? (materialIndices![pIdx] ?? 0) : 0;
    const color = hasColors ? (materialColors![matIdx] ?? [1, 1, 1]) : [1, 1, 1];

    for (let vi = 0; vi < 3; vi++) {
      const origIdx = triIndices[tri + vi];
      const cornerIdx = triCornerIndices[tri + vi];

      getNormal(cornerIdx, origIdx, tmpNormal);
      getUV(cornerIdx, origIdx, tmpUV);
      const nx = tmpNormal[0], ny = tmpNormal[1], nz = tmpNormal[2];
      const u = tmpUV[0], v = tmpUV[1];

      const existing = remap.get(origIdx);
      let newIdx = -1;
      if (existing) {
        for (let e = 0; e < existing.length; e++) {
          const entry = existing[e];
          if (entry.matIdx === matIdx && entry.nx === nx && entry.ny === ny && entry.nz === nz &&
              entry.u === u && entry.v === v) {
            newIdx = entry.newIdx;
            break;
          }
        }
      }

      if (newIdx === -1) {
        newIdx = newVerts.length / 6;
        newVerts.push(
          vertices[origIdx * 3], vertices[origIdx * 3 + 1], vertices[origIdx * 3 + 2],
          nx, ny, nz,
        );
        newUVs.push(u, v);
        newColors.push(color[0], color[1], color[2]);

        if (!existing) remap.set(origIdx, []);
        remap.get(origIdx)!.push({ newIdx, matIdx, nx, ny, nz, u, v });
      }

      newIndices.push(newIdx);
    }
  }

  const finalVertArray = new Float32Array(newVerts);
  const finalUvArray = hasUVs ? new Float32Array(newUVs) : null;
  const finalColorArray = new Float32Array(newColors);
  const finalTriIndices = newIndices;
  const finalVertexCount = newVerts.length / 6;

  const idxArray = finalTriIndices.length > 65535
    ? new Uint32Array(finalTriIndices)
    : new Uint16Array(finalTriIndices);

  // Build skinning data (joints + weights) if skin data is available for this geometry
  let joints: Uint8Array | undefined;
  let weights: Float32Array | undefined;
  if (geometrySkin) {
    joints = new Uint8Array(finalVertexCount * 4);
    weights = new Float32Array(finalVertexCount * 4);
    // Build newIdx -> origIdx mapping from remap and assign bone weights
    for (const [origIdx, entries] of remap) {
      const boneList = geometrySkin.vertexBones.get(origIdx);
      if (!boneList) continue;
      // Sort by weight descending, take top 4
      const sorted = boneList.slice().sort((a, b) => b.weight - a.weight);
      const count = Math.min(4, sorted.length);
      for (let e = 0; e < entries.length; e++) {
        const newIdx = entries[e].newIdx;
        let totalWeight = 0;
        for (let b = 0; b < count; b++) {
          joints[newIdx * 4 + b] = sorted[b].boneIdx;
          weights[newIdx * 4 + b] = sorted[b].weight;
          totalWeight += sorted[b].weight;
        }
        // Normalize weights so they sum to 1
        if (totalWeight > 0) {
          for (let b = 0; b < 4; b++) {
            weights[newIdx * 4 + b] /= totalWeight;
          }
        }
      }
    }
  }

  // Determine the primary material index for this geometry.
  // If all polygons use the same material, use it. Otherwise use the first.
  let meshMaterialIndex: number | undefined = undefined;
  if (hasMaterials && materialIndices && materialIndices.length > 0) {
    meshMaterialIndex = materialIndices[0];
  }

  return {
    vertices: finalVertArray,
    indices: idxArray,
    vertexCount: finalVertexCount,
    indexCount: finalTriIndices.length,
    uvs: finalUvArray,
    colors: finalColorArray,
    joints,
    weights,
    materialIndex: meshMaterialIndex,
  };
}

// ============================================================================
// FBX Animation Parsing
// ============================================================================

interface FBXAnimCurve {
  id: string;
  name: string;
  keyTime: number[];
  keyValue: number[];
}

interface FBXAnimCurveNode {
  id: string;
  name: string;
  property: string;
  curveIds: string[];
  curveAxes: string[]; // "X", "Y", or "Z" for each curve in curveIds
}

interface FBXAnimLayer {
  id: string;
  name: string;
  curveNodeIds: string[];
}

interface FBXAnimStack {
  id: string;
  name: string;
  layerIds: string[];
  localStop: number;
}

function parseFBXAnimations(nodes: FBXNode[]): AnimationData[] {
  // Collect all objects by ID
  const objectsNode = nodes.find(n => n.name === "Objects");
  if (!objectsNode) return [];

  const curves = new Map<string, FBXAnimCurve>();
  const curveNodes = new Map<string, FBXAnimCurveNode>();
  const layers = new Map<string, FBXAnimLayer>();
  const stacks: FBXAnimStack[] = [];

  // Connections node
  const connectionsNode = nodes.find(n => n.name === "Connections");
  const connections: { childId: string; parentId: string; property?: string }[] = [];
  if (connectionsNode) {
    for (let i = 0; i < connectionsNode.children.length; i++) {
      const c = connectionsNode.children[i];
      if (c.name === "C" && c.properties.length >= 3) {
        const childId = String(c.properties[1].value);
        const parentId = String(c.properties[2].value);
        const property = c.properties.length >= 4 ? String(c.properties[3].value) : undefined;
        connections.push({ childId, parentId, property });
      }
    }
  }

  // Parse AnimationCurve nodes
  const curveNodesList = findNodesByName(objectsNode, "AnimationCurve");
  for (let i = 0; i < curveNodesList.length; i++) {
    const node = curveNodesList[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `curve_${i}`;
    let keyTime: number[] = [];
    let keyValue: number[] = [];

    for (let j = 0; j < node.children.length; j++) {
      const child = node.children[j];
      if (child.name === "KeyTime" && child.properties.length > 0) {
        const prop = child.properties[0];
        if (Array.isArray(prop.value)) keyTime = prop.value as number[];
      } else if (child.name === "KeyValueFloat" && child.properties.length > 0) {
        const prop = child.properties[0];
        if (Array.isArray(prop.value)) keyValue = prop.value as number[];
      }
    }

    curves.set(id, { id, name: `curve_${i}`, keyTime, keyValue });
  }

  // Parse AnimationCurveNode nodes
  const curveNodeList = findNodesByName(objectsNode, "AnimationCurveNode");
  for (let i = 0; i < curveNodeList.length; i++) {
    const node = curveNodeList[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `curveNode_${i}`;
    let propertyName = "";

    // FBX 7400+: type is encoded in the second property (e.g. "T\x00\x01AnimCurveNode")
    // FBX < 7400: type is in a child node named "PropertyName"
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      const typeStr = String(node.properties[1].value);
      if (typeStr.startsWith("T")) propertyName = "Lcl Translation";
      else if (typeStr.startsWith("R")) propertyName = "Lcl Rotation";
      else if (typeStr.startsWith("S")) propertyName = "Lcl Scaling";
    }

    // Fallback: look for PropertyName child (older FBX formats)
    if (!propertyName) {
      for (let j = 0; j < node.children.length; j++) {
        const child = node.children[j];
        if (child.name === "PropertyName" && child.properties.length > 0) {
          propertyName = String(child.properties[0].value);
        }
      }
    }

    // Find connected curves and extract axis from connection property (e.g. "d|X")
    const connectedCurveIds: string[] = [];
    const connectedCurveAxes: string[] = [];
    for (let c = 0; c < connections.length; c++) {
      if (connections[c].parentId === id) {
        if (curves.has(connections[c].childId)) {
          connectedCurveIds.push(connections[c].childId);
          // Extract axis from connection property like "d|X", "d|Y", "d|Z"
          const connProp = connections[c].property;
          let axis = "X";
          if (connProp) {
            if (connProp.includes("|Y") || connProp.endsWith("Y")) axis = "Y";
            else if (connProp.includes("|Z") || connProp.endsWith("Z")) axis = "Z";
          }
          connectedCurveAxes.push(axis);
        }
      }
    }

    curveNodes.set(id, { id, name: `curveNode_${i}`, property: propertyName, curveIds: connectedCurveIds, curveAxes: connectedCurveAxes });
  }

  // Parse AnimationLayer nodes
  const layerList = findNodesByName(objectsNode, "AnimationLayer");
  for (let i = 0; i < layerList.length; i++) {
    const node = layerList[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `layer_${i}`;

    // Find connected curve nodes
    const connectedCurveNodeIds: string[] = [];
    for (let c = 0; c < connections.length; c++) {
      if (connections[c].parentId === id) {
        if (curveNodes.has(connections[c].childId)) {
          connectedCurveNodeIds.push(connections[c].childId);
        }
      }
    }

    layers.set(id, { id, name: `layer_${i}`, curveNodeIds: connectedCurveNodeIds });
  }

  // Parse AnimationStack nodes
  const stackList = findNodesByName(objectsNode, "AnimationStack");
  for (let i = 0; i < stackList.length; i++) {
    const node = stackList[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `stack_${i}`;
    let stackName = `animation_${i}`;
    let localStop = 0;

    // Get name from properties (second property is usually the name)
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      stackName = String(node.properties[1].value);
    }

    // Find LocalStop time
    for (let j = 0; j < node.children.length; j++) {
      const child = node.children[j];
      if (child.name === "LocalStop" && child.properties.length > 0) {
        localStop = child.properties[0].value as number;
      }
    }

    // Find connected layers
    const connectedLayerIds: string[] = [];
    for (let c = 0; c < connections.length; c++) {
      if (connections[c].parentId === id) {
        if (layers.has(connections[c].childId)) {
          connectedLayerIds.push(connections[c].childId);
        }
      }
    }

    stacks.push({ id, name: stackName, layerIds: connectedLayerIds, localStop });
  }

  // Build node name mapping from connections (curveNode -> model node)
  const modelNodes = findNodesByName(objectsNode, "Model");
  const modelIdToName = new Map<string, string>();
  for (let i = 0; i < modelNodes.length; i++) {
    const node = modelNodes[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `model_${i}`;
    let modelName = `node_${i}`;
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      modelName = String(node.properties[1].value);
    }
    modelIdToName.set(id, modelName);
  }

  // Extract static Lcl Rotation and PreRotation from each Model node (Mixamo rest pose)
  // The full rest rotation of a bone is: PreRotation * LclRotation
  const sourceRestRotations = new Map<string, [number, number, number, number]>();
  const sourcePreRotations = new Map<string, [number, number, number, number]>();
  for (let i = 0; i < modelNodes.length; i++) {
    const node = modelNodes[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `model_${i}`;
    let modelName = `node_${i}`;
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      modelName = String(node.properties[1].value);
    }
    // Strip "Model" suffix
    if (modelName.endsWith("Model")) modelName = modelName.slice(0, -5);

    let preRot: [number, number, number, number] | null = null;
    let lclRot: [number, number, number, number] | null = null;

    for (let j = 0; j < node.children.length; j++) {
      const child = node.children[j];
      if (child.name === "Properties70") {
        for (let k = 0; k < child.children.length; k++) {
          const p = child.children[k];
          if (p.name === "P" && p.properties.length >= 7) {
            const propName = String(p.properties[0].value);
            if (propName === "Lcl Rotation" || propName === "PreRotation") {
              const ex = (p.properties[4].value as number) * Math.PI / 180;
              const ey = (p.properties[5].value as number) * Math.PI / 180;
              const ez = (p.properties[6].value as number) * Math.PI / 180;
              const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
              const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
              const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
              // FBX default rotation order is 0 = XYZ extrinsic = ZYX intrinsic
              // q = qz * qy * qx (ZYX intrinsic)
              const q: [number, number, number, number] = [
                sx * cy * cz - cx * sy * sz,
                cx * sy * cz + sx * cy * sz,
                cx * cy * sz - sx * sy * cz,
                cx * cy * cz + sx * sy * sz,
              ];
              // Store in FBX Y-up coordinate space (UpAxis=1).
              // Transform to root-local space is applied in SkeletonAnimator via (x,y,z,w)→(x,-z,y,w)
              const qConv: [number, number, number, number] = [q[0], q[1], q[2], q[3]];
              if (propName === "PreRotation") preRot = qConv;
              else lclRot = qConv;
            }
          }
        }
      }
    }

    // Store PreRotation separately (needed to reconstruct full animated rotation)
    if (preRot) {
      sourcePreRotations.set(modelName, preRot);
    }
    // Store full rest rotation (PreRotation * LclRotation) for retargeting
    if (lclRot && preRot) {
      // q = preRot * lclRot
      const ax = preRot[0], ay = preRot[1], az = preRot[2], aw = preRot[3];
      const bx = lclRot[0], by = lclRot[1], bz = lclRot[2], bw = lclRot[3];
      sourceRestRotations.set(modelName, [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
      ]);
    } else if (lclRot) {
      sourceRestRotations.set(modelName, lclRot);
    } else if (preRot) {
      sourceRestRotations.set(modelName, preRot);
    }
  }

  console.log(`[FBX] Extracted ${sourceRestRotations.size} source rest rotations, first 3:`, [...sourceRestRotations.entries()].slice(0, 3).map(e => e[0]));

  // Map curve nodes to model nodes via connections
  const curveNodeToModel = new Map<string, string>();
  for (let c = 0; c < connections.length; c++) {
    const conn = connections[c];
    if (curveNodes.has(conn.childId) && modelIdToName.has(conn.parentId)) {
      curveNodeToModel.set(conn.childId, modelIdToName.get(conn.parentId)!);
    }
  }

  // Build AnimationData
  const animations: AnimationData[] = [];
  const FBX_TIME_FACTOR = 46186158000; // FBX time units per second

  for (let s = 0; s < stacks.length; s++) {
    const stack = stacks[s];
    const channels: AnimationChannel[] = [];
    let maxTime = 0;

    // FBX stores translation as 3 separate curve nodes (X, Y, Z) each with 1 curve
    // Group curve nodes by target model node + property type
    const groupedChannels = new Map<string, {
      targetNode: string;
      path: string;
      curves: { axis: string; times: number[]; values: number[] }[];
    }>();

    for (let l = 0; l < stack.layerIds.length; l++) {
      const layer = layers.get(stack.layerIds[l]);
      if (!layer) continue;

      for (let cn = 0; cn < layer.curveNodeIds.length; cn++) {
        const curveNode = curveNodes.get(layer.curveNodeIds[cn]);
        if (!curveNode) continue;

        const targetNode = curveNodeToModel.get(curveNode.id);
        if (!targetNode) continue;

        // Determine path from property name
        let path: "translation" | "rotation" | "scale" = "translation";
        const propLower = curveNode.property.toLowerCase();
        if (propLower.includes("lcl translation") || propLower.includes("translation")) {
          path = "translation";
        } else if (propLower.includes("lcl rotation") || propLower.includes("rotation")) {
          path = "rotation";
        } else if (propLower.includes("lcl scaling") || propLower.includes("scaling") || propLower.includes("scale")) {
          path = "scale";
        }

        // Get the curve data — a curve node may have multiple curves (one per axis)
        if (curveNode.curveIds.length === 0) continue;

        for (let ci = 0; ci < curveNode.curveIds.length; ci++) {
          const curve = curves.get(curveNode.curveIds[ci]);
          if (!curve || curve.keyTime.length === 0) continue;

          // Convert FBX time to seconds
          const times: number[] = [];
          for (let t = 0; t < curve.keyTime.length; t++) {
            const timeSec = curve.keyTime[t] / FBX_TIME_FACTOR;
            times.push(timeSec);
            if (timeSec > maxTime) maxTime = timeSec;
          }

          // Determine axis from connection property (stored in curveAxes)
          const axis = curveNode.curveAxes[ci] || "X";

          const key = `${targetNode}:${path}`;
          if (!groupedChannels.has(key)) {
            groupedChannels.set(key, { targetNode, path, curves: [] });
          }
          groupedChannels.get(key)!.curves.push({ axis, times, values: curve.keyValue });
        }
      }
    }

    // Build merged channels
    for (const [, group] of groupedChannels) {
      // Merge axis curves into a single channel
      // Find the longest time array (they should all be the same length)
      let maxLen = 0;
      let refTimes: number[] = [];
      for (let c = 0; c < group.curves.length; c++) {
        if (group.curves[c].times.length > maxLen) {
          maxLen = group.curves[c].times.length;
          refTimes = group.curves[c].times;
        }
      }

      if (maxLen === 0) continue;

      // Build merged values: for each keyframe, [x, y, z]
      // For rotation, we build Euler values first (stride 3), then convert to quaternions (stride 4)
      const eulerStride = 3;
      const eulerValues = new Float32Array(maxLen * eulerStride);

      for (let c = 0; c < group.curves.length; c++) {
        const curve = group.curves[c];
        const axisIdx = curve.axis === "X" ? 0 : curve.axis === "Y" ? 1 : 2;
        for (let t = 0; t < curve.times.length; t++) {
          eulerValues[t * eulerStride + axisIdx] = curve.values[t];
        }
      }

      // For rotation, convert Euler degrees to quaternion
      if (group.path === "rotation") {
        const quatValues = new Float32Array(maxLen * 4);
        for (let t = 0; t < maxLen; t++) {
          const ex = eulerValues[t * 3] * Math.PI / 180;
          const ey = eulerValues[t * 3 + 1] * Math.PI / 180;
          const ez = eulerValues[t * 3 + 2] * Math.PI / 180;
          const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
          const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
          const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
          // FBX default rotation order is 0 = XYZ extrinsic = ZYX intrinsic
          // q = qz * qy * qx (ZYX intrinsic)
          quatValues[t * 4] = sx * cy * cz - cx * sy * sz;
          quatValues[t * 4 + 1] = cx * sy * cz + sx * cy * sz;
          quatValues[t * 4 + 2] = cx * cy * sz - sx * sy * cz;
          quatValues[t * 4 + 3] = cx * cy * cz + sx * sy * sz;
        }
        channels.push({
          targetNode: group.targetNode,
          path: "rotation",
          keyframeTimes: new Float32Array(refTimes),
          keyframeValues: quatValues,
          interpolation: "LINEAR",
        });
      } else {
        channels.push({
          targetNode: group.targetNode,
          path: group.path as "translation" | "scale",
          keyframeTimes: new Float32Array(refTimes),
          keyframeValues: eulerValues,
          interpolation: "LINEAR",
        });
      }
    }

    if (channels.length > 0) {
      animations.push({
        name: stack.name,
        duration: maxTime,
        channels,
        sourceRestRotations,
        sourcePreRotations,
      });
    }
  }

  return animations;
}

// Parse node hierarchy
function parseFBXNodes(nodes: FBXNode[]): ModelNode[] | undefined {
  const objectsNode = nodes.find(n => n.name === "Objects");
  if (!objectsNode) return undefined;

  const modelNodes = findNodesByName(objectsNode, "Model");
  if (modelNodes.length === 0) return undefined;

  // Build connections map (only "OO" = Object-Object parent-child links;
  // "OP" = Object-Property connections are NOT hierarchy links and would
  // overwrite correct parents if included). Don't overwrite existing entries:
  // a child may have both a bone→parentBone OO link and a bone→sceneRoot OO
  // link; the first (bone→parentBone) is the correct hierarchy parent.
  const connectionsNode = nodes.find(n => n.name === "Connections");
  const childToParent = new Map<string, string>();
  if (connectionsNode) {
    let cCount = 0;
    let skipped = 0;
    for (let i = 0; i < connectionsNode.children.length; i++) {
      const c = connectionsNode.children[i];
      if (c.name === "C" && c.properties.length >= 3) {
        const connType = String(c.properties[0].value);
        if (connType !== "OO") continue;
        cCount++;
        const childId = String(c.properties[1].value);
        const parentId = String(c.properties[2].value);
        if (childToParent.has(childId)) {
          skipped++;
        } else {
          childToParent.set(childId, parentId);
        }
      }
    }
    console.log(`[FBX-Debug] Connections: ${cCount} OO entries, ${childToParent.size} in map, ${skipped} duplicates skipped, ${connectionsNode.children.length} total children`);
  } else {
    console.log(`[FBX-Debug] No Connections node found! Top-level names: ${nodes.map(n => n.name).join(', ')}`);
  }

  const result: ModelNode[] = [];
  const idToIndex = new Map<string, number>();

  for (let i = 0; i < modelNodes.length; i++) {
    const node = modelNodes[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `model_${i}`;
    let nodeName = `node_${i}`;
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      nodeName = String(node.properties[1].value);
    }

    let translation: [number, number, number] | undefined;
    let lclRotation: [number, number, number, number] | undefined;
    let preRotation: [number, number, number, number] | undefined;
    let scale: [number, number, number] | undefined;

    for (let j = 0; j < node.children.length; j++) {
      const child = node.children[j];
      if (child.name === "Properties70") {
        for (let k = 0; k < child.children.length; k++) {
          const p = child.children[k];
          if (p.name === "P" && p.properties.length >= 5) {
            const propName = String(p.properties[0].value);
            if (propName === "Lcl Translation") {
              translation = [p.properties[4].value as number, p.properties[5].value as number, p.properties[6].value as number];
            } else if (propName === "Lcl Rotation") {
              const ex = (p.properties[4].value as number) * Math.PI / 180;
              const ey = (p.properties[5].value as number) * Math.PI / 180;
              const ez = (p.properties[6].value as number) * Math.PI / 180;
              const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
              const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
              const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
              // FBX default rotation order is 0 = XYZ extrinsic = ZYX intrinsic
              lclRotation = [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
            } else if (propName === "PreRotation") {
              const ex = (p.properties[4].value as number) * Math.PI / 180;
              const ey = (p.properties[5].value as number) * Math.PI / 180;
              const ez = (p.properties[6].value as number) * Math.PI / 180;
              const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
              const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
              const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
              preRotation = [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
            } else if (propName === "Lcl Scaling") {
              scale = [p.properties[4].value as number, p.properties[5].value as number, p.properties[6].value as number];
            }
          }
        }
      }
    }

    // Combine PreRotation * LclRotation (order-independent of FBX property order)
    let rotation: [number, number, number, number] | undefined;
    if (preRotation && lclRotation) {
      const ax = preRotation[0], ay = preRotation[1], az = preRotation[2], aw = preRotation[3];
      const bx = lclRotation[0], by = lclRotation[1], bz = lclRotation[2], bw = lclRotation[3];
      rotation = [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
      ];
    } else if (preRotation) {
      rotation = preRotation;
    } else if (lclRotation) {
      rotation = lclRotation;
    }

    idToIndex.set(id, i);
    result.push({
      name: nodeName,
      translation,
      rotation,
      scale,
      nodeIndex: i,
    });
  }

  // Build children indices
  let matchedChildren = 0;
  let unmatchedChildren = 0;
  for (let i = 0; i < modelNodes.length; i++) {
    const id = modelNodes[i].properties.length > 0 ? String(modelNodes[i].properties[0].value) : `model_${i}`;
    const parentId = childToParent.get(id);
    if (parentId && idToIndex.has(parentId)) {
      const parentIdx = idToIndex.get(parentId)!;
      if (!result[parentIdx].children) result[parentIdx].children = [];
      result[parentIdx].children!.push(i);
      matchedChildren++;
    } else {
      unmatchedChildren++;
      if (unmatchedChildren <= 3) {
        console.log(`[FBX-Debug] Node ${i} id=${id} name=${result[i].name}: parentId=${parentId ?? 'none'}, inIdToIndex=${parentId ? idToIndex.has(parentId) : 'N/A'}`);
      }
    }
  }
  console.log(`[FBX-Debug] Children: ${matchedChildren} matched, ${unmatchedChildren} unmatched, ${idToIndex.size} model IDs`);

  return result;
}

// ============================================================================
// FBX Skin/Deformer Parsing
// ============================================================================

interface FBXClusterData {
  boneId: string;
  indexes: number[];
  weights: number[];
  transform: number[]; // 16 doubles, row-major (inverse bind matrix)
}

function parseFBXSkinData(
  nodes: FBXNode[],
  modelIdToName: Map<string, string>,
  modelIdToIndex: Map<string, number>,
  modelNodes: ModelNode[],
): {
  geometrySkins: Map<string, { vertexBones: Map<number, { boneIdx: number; weight: number }[]> }>;
  bones: BoneData[];
  boneNameToIndex: Map<string, number>;
} | null {
  const objectsNode = nodes.find(n => n.name === "Objects");
  if (!objectsNode) return null;

  const deformerNodes = findNodesByName(objectsNode, "Deformer");
  if (deformerNodes.length === 0) return null;

  // Build full connections (both directions)
  const connectionsNode = nodes.find(n => n.name === "Connections");
  const childToParent = new Map<string, string>();
  const parentToChildren = new Map<string, string[]>();
  if (connectionsNode) {
    for (let i = 0; i < connectionsNode.children.length; i++) {
      const c = connectionsNode.children[i];
      if (c.name === "C" && c.properties.length >= 3) {
        const childId = String(c.properties[1].value);
        const parentId = String(c.properties[2].value);
        childToParent.set(childId, parentId);
        if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
        parentToChildren.get(parentId)!.push(childId);
      }
    }
  }

  // Classify deformers: Cluster (has Indexes/Weights) vs Skin (everything else)
  const skinDeformerIds = new Set<string>();
  const clusterNodes = new Map<string, FBXNode>();
  for (let i = 0; i < deformerNodes.length; i++) {
    const node = deformerNodes[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `deformer_${i}`;
    let hasIndexes = false;
    for (let j = 0; j < node.children.length; j++) {
      if (node.children[j].name === "Indexes") { hasIndexes = true; break; }
    }
    if (hasIndexes) {
      clusterNodes.set(id, node);
    } else {
      skinDeformerIds.add(id);
    }
  }

  if (clusterNodes.size === 0) return null;

  // Map each cluster to its bone Model node ID
  const clusterToBone = new Map<string, string>();
  for (const [clusterId, _] of clusterNodes) {
    // Standard: cluster is child of bone model (childId=cluster, parentId=bone)
    const parentId = childToParent.get(clusterId);
    if (parentId && modelIdToName.has(parentId)) {
      clusterToBone.set(clusterId, parentId);
      continue;
    }
    // Reverse: bone is child of cluster
    const children = parentToChildren.get(clusterId);
    if (children) {
      for (let c = 0; c < children.length; c++) {
        if (modelIdToName.has(children[c])) {
          clusterToBone.set(clusterId, children[c]);
          break;
        }
      }
    }
  }

  // Build ordered bone list
  const boneIds: string[] = [];
  const boneIdSet = new Set<string>();
  for (const [_, boneId] of clusterToBone) {
    if (!boneIdSet.has(boneId)) {
      boneIdSet.add(boneId);
      boneIds.push(boneId);
    }
  }

  const boneNameToIndex = new Map<string, number>();
  const bones: BoneData[] = [];
  for (let i = 0; i < boneIds.length; i++) {
    const boneId = boneIds[i];
    const boneName = modelIdToName.get(boneId) ?? `bone_${i}`;
    const nodeIdx = modelIdToIndex.get(boneId) ?? -1;
    boneNameToIndex.set(boneName, i);
    const modelNode = nodeIdx >= 0 ? modelNodes[nodeIdx] : undefined;
    bones.push({
      name: boneName,
      nodeIndex: nodeIdx,
      parentIndex: -1,
      inverseBindMatrix: new Float32Array(16),
      restTranslation: modelNode?.translation ?? [0, 0, 0],
      restRotation: modelNode?.rotation ?? [0, 0, 0, 1],
      restScale: modelNode?.scale ?? [1, 1, 1],
    });
  }

  // Build parent-child relationships from model node hierarchy
  const modelNodeToBoneIdx = new Map<number, number>();
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].nodeIndex >= 0) modelNodeToBoneIdx.set(bones[i].nodeIndex, i);
  }
  for (let i = 0; i < modelNodes.length; i++) {
    const node = modelNodes[i];
    if (!node.children) continue;
    for (let c = 0; c < node.children.length; c++) {
      const childBoneIdx = modelNodeToBoneIdx.get(node.children[c]);
      if (childBoneIdx !== undefined) {
        bones[childBoneIdx].parentIndex = modelNodeToBoneIdx.get(i) ?? -1;
      }
    }
  }

  // Parse cluster data and build per-geometry vertex bone assignments
  const geometrySkins = new Map<string, { vertexBones: Map<number, { boneIdx: number; weight: number }[]> }>();

  for (const [clusterId, clusterNode] of clusterNodes) {
    const boneId = clusterToBone.get(clusterId);
    if (!boneId) continue;
    const boneName = modelIdToName.get(boneId);
    if (!boneName) continue;
    const boneIdx = boneNameToIndex.get(boneName);
    if (boneIdx === undefined) continue;

    let indexes: number[] = [];
    let weights: number[] = [];
    let transform: number[] = [];
    let transformLink: number[] = [];
    for (let j = 0; j < clusterNode.children.length; j++) {
      const child = clusterNode.children[j];
      if (child.name === "Indexes" && child.properties.length > 0 && Array.isArray(child.properties[0].value)) {
        indexes = child.properties[0].value as number[];
      } else if (child.name === "Weights" && child.properties.length > 0 && Array.isArray(child.properties[0].value)) {
        weights = child.properties[0].value as number[];
      } else if (child.name === "Transform" && child.properties.length > 0 && Array.isArray(child.properties[0].value)) {
        transform = child.properties[0].value as number[];
      } else if (child.name === "TransformLink" && child.properties.length > 0 && Array.isArray(child.properties[0].value)) {
        transformLink = child.properties[0].value as number[];
      }
    }

    // The cluster's TransformLink is the bone's WORLD transform at bind time.
    // The inverse bind matrix (IBM) = inverse(TransformLink).
    // FBX stores matrices in column-major layout (translation at [12,13,14]),
    // matching WebGPU — no transpose needed.
    if (transformLink.length === 16) {
      bones[boneIdx].inverseBindMatrix = invertMat4CM(new Float32Array(transformLink));
    } else if (transform.length === 16) {
      // Fallback: some FBX files only have Transform (the mesh node's transform,
      // which is the inverse of the bone world transform). Copy directly since
      // FBX matrices are already column-major.
      bones[boneIdx].inverseBindMatrix = new Float32Array(transform);
    }

    // Find geometry: cluster -> skin -> geometry
    const skinId = childToParent.get(clusterId);
    if (!skinId) continue;
    const geometryId = childToParent.get(skinId);
    if (!geometryId) continue;

    if (!geometrySkins.has(geometryId)) {
      geometrySkins.set(geometryId, { vertexBones: new Map() });
    }
    const geoSkin = geometrySkins.get(geometryId)!;
    for (let v = 0; v < indexes.length; v++) {
      const vertIdx = indexes[v];
      const weight = weights[v];
      if (!geoSkin.vertexBones.has(vertIdx)) {
        geoSkin.vertexBones.set(vertIdx, []);
      }
      geoSkin.vertexBones.get(vertIdx)!.push({ boneIdx, weight });
    }
  }

  if (bones.length === 0 || geometrySkins.size === 0) return null;
  return { geometrySkins, bones, boneNameToIndex };
}

interface FBXTextureInfo {
  textureData?: Uint8Array;
  textureUri?: string;
}

function findFBXTextures(nodes: FBXNode[]): Map<number, FBXTextureInfo> {
  // Returns a map of material index -> texture info (embedded data and/or filename)
  // Search all nodes recursively (like findMaterials does), not just inside Objects
  const videoNodes: FBXNode[] = [];
  const textureNodesAll: FBXNode[] = [];
  const materialNodesAll: FBXNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    findNodesByName(nodes[i], "Video", videoNodes);
    findNodesByName(nodes[i], "Texture", textureNodesAll);
    findNodesByName(nodes[i], "Material", materialNodesAll);
  }

  const connectionsNode = nodes.find((n) => n.name === "Connections");
  if (!connectionsNode) return new Map();

  // Collect Video nodes: extract embedded Content (raw image bytes) AND filename
  const videoInfo = new Map<string, { data?: Uint8Array; filename?: string }>();
  for (let i = 0; i < videoNodes.length; i++) {
    const node = videoNodes[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `video_${i}`;
    let data: Uint8Array | undefined;
    let filename: string | undefined;

    for (let j = 0; j < node.children.length; j++) {
      const child = node.children[j];
      const childNameLower = child.name.toLowerCase();
      if (childNameLower === "content" && child.properties.length > 0) {
        const prop = child.properties[0];
        if (prop.type === "R" && prop.value instanceof Uint8Array && prop.value.length > 0) {
          data = prop.value;
        }
      } else if (childNameLower === "filename" && child.properties.length > 0) {
        filename = String(child.properties[0].value);
      } else if (childNameLower === "relativefilename" && child.properties.length > 0 && !filename) {
        filename = String(child.properties[0].value);
      }
    }

    // Also check the Video node's own properties for a filename (e.g. "Atlas.png")
    if (!filename && node.properties.length >= 2) {
      for (let p = 0; p < node.properties.length; p++) {
        if (node.properties[p].type === "S") {
          const val = String(node.properties[p].value);
          if (val.match(/\.(png|jpg|jpeg|tga|bmp|webp)$/i)) {
            filename = val;
            break;
          }
        }
      }
    }

    if (data || filename) {
      videoInfo.set(id, { data, filename });
    }
  }

  if (videoInfo.size === 0) return new Map();

  // Parse connections
  const connections: { childId: string; parentId: string; property: string }[] = [];
  for (let i = 0; i < connectionsNode.children.length; i++) {
    const c = connectionsNode.children[i];
    if (c.name === "C" && c.properties.length >= 3) {
      const childId = String(c.properties[1].value);
      const parentId = String(c.properties[2].value);
      const property = c.properties.length >= 4 ? String(c.properties[3].value) : "";
      connections.push({ childId, parentId, property });
    }
  }

  // Map Texture node IDs to Video node IDs (OO connection: texture -> video)
  // In FBX, the connection can be either direction: Texture->Video or Video->Texture
  const textureToVideo = new Map<string, string>();
  for (let i = 0; i < textureNodesAll.length; i++) {
    const texId = textureNodesAll[i].properties.length > 0 ? String(textureNodesAll[i].properties[0].value) : `tex_${i}`;
    for (let j = 0; j < connections.length; j++) {
      if (connections[j].childId === texId && videoInfo.has(connections[j].parentId)) {
        textureToVideo.set(texId, connections[j].parentId);
        break;
      }
      if (connections[j].parentId === texId && videoInfo.has(connections[j].childId)) {
        textureToVideo.set(texId, connections[j].childId);
        break;
      }
    }
  }

  // Map Material node IDs to texture info via OP connections
  const result = new Map<number, FBXTextureInfo>();

  for (let i = 0; i < materialNodesAll.length; i++) {
    const matId = materialNodesAll[i].properties.length > 0 ? String(materialNodesAll[i].properties[0].value) : `mat_${i}`;

    for (let j = 0; j < connections.length; j++) {
      const conn = connections[j];
      if (conn.parentId !== matId) continue;
      if (!textureToVideo.has(conn.childId)) continue;

      const propLower = conn.property.toLowerCase();
      if (propLower.includes("diffuse") || conn.property === "") {
        const videoId = textureToVideo.get(conn.childId)!;
        const info = videoInfo.get(videoId);
        if (info) {
          const texInfo: FBXTextureInfo = {};
          if (info.data) {
            texInfo.textureData = info.data;
          }
          if (info.filename) {
            const basename = info.filename.replace(/[\\/]/g, "/").split("/").pop() ?? info.filename;
            texInfo.textureUri = basename;
          }
          result.set(i, texInfo);
          break;
        }
      }
    }
  }

  console.log(`[FBX] Textures: ${videoNodes.length} video, ${textureNodesAll.length} texture, ${materialNodesAll.length} material -> ${result.size} mappings`);
  return result;
}

/**
 * Parse the UpAxis from the FBX GlobalSettings.
 *
 * FBX UpAxis values:
 *   0 = Y-up (Maya default, X-right, Z-forward)
 *   1 = Y-up (3ds Max, X-forward, Z-right) — still Y-up
 *   2 = Z-up (Blender / Maya Z-up, X-right, Y-forward)
 *
 * Returns "y" or "z". The normalization layer (not the parser) applies the
 * coordinate-system conversion to avoid double-converting.
 */
function parseFBXUpAxis(nodes: FBXNode[]): "y" | "z" {
  // GlobalSettings is a top-level node, not under Objects.
  const globalSettings = nodes.find(n => n.name === "GlobalSettings");
  if (!globalSettings) return "y"; // default Y-up

  for (const child of globalSettings.children) {
    if (child.name === "Properties70") {
      for (const p of child.children) {
        if (p.name === "P" && p.properties.length >= 5) {
          const propName = String(p.properties[0].value);
          if (propName === "UpAxis") {
            const val = p.properties[4].value as number;
            console.log(`[FBX] UpAxis = ${val}`);
            return val === 2 ? "z" : "y";
          }
        }
      }
    }
  }
  return "y"; // default Y-up
}

/**
 * Parse the UnitScaleFactor from the FBX GlobalSettings.
 *
 * FBX stores UnitScaleFactor as units-per-centimeter.
 * Common values:
 *   1.0   → centimeters (Maya default)
 *   0.1   → millimeters
 *   2.54  → inches
 *   100   → meters
 *
 * Returns the raw factor (units per cm). The normalization layer converts
 * this to a meters multiplier: metersPerUnit = factor * 0.01.
 */
function parseFBXUnitScale(nodes: FBXNode[]): number | undefined {
  const globalSettings = nodes.find(n => n.name === "GlobalSettings");
  if (!globalSettings) return undefined;

  for (const child of globalSettings.children) {
    if (child.name === "Properties70") {
      for (const p of child.children) {
        if (p.name === "P" && p.properties.length >= 5) {
          const propName = String(p.properties[0].value);
          if (propName === "UnitScaleFactor") {
            const val = p.properties[4].value as number;
            console.log(`[FBX] UnitScaleFactor = ${val}`);
            return val;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Classify a raw FBX UnitScaleFactor (units per cm) into our UnitSystem enum.
 * Falls back to "units" if the value doesn't match a known unit.
 */
function classifyFBXUnits(unitScaleFactor: number | undefined): "meters" | "centimeters" | "inches" | "millimeters" | "units" {
  if (unitScaleFactor === undefined) return "centimeters"; // FBX default is cm
  // Allow small floating-point tolerance
  if (Math.abs(unitScaleFactor - 1) < 0.001) return "centimeters";
  if (Math.abs(unitScaleFactor - 0.1) < 0.001) return "millimeters";
  if (Math.abs(unitScaleFactor - 2.54) < 0.01) return "inches";
  if (Math.abs(unitScaleFactor - 100) < 0.1) return "meters";
  return "units";
}

export function parseFBX(data: ArrayBuffer, name: string): ModelData {
  const view = new DataView(data);
  const headerStr = new TextDecoder().decode(new Uint8Array(data, 0, 21));

  if (!headerStr.startsWith("Kaydara FBX Binary")) {
    return parseFBXASCII(data, name);
  }

  const version = view.getUint32(23, true);

  const nodes: FBXNode[] = [];
  let offset = 27;

  while (offset < data.byteLength) {
    const node = parseFBXNode(view, offset, data.byteLength, version);
    if (node === null) break;
    if (node.node === null) {
      offset = node.nextOffset;
      break;
    }
    nodes.push(node.node);
    offset = node.nextOffset;
  }

  // Parse materials
  const materialColors: [number, number, number][] = [];
  const materialNames: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    findMaterials(nodes[i], materialColors, materialNames);
  }

  // Extract textures (embedded data and/or filenames)
  const materialTextures = findFBXTextures(nodes);

  const materials: MaterialData[] | undefined = materialColors.length > 0
    ? materialColors.map((color, i) => ({
        name: materialNames[i] ?? `material_${i}`,
        baseColor: [color[0], color[1], color[2], 1],
        metallic: 0,
        roughness: 1,
        textureData: materialTextures.get(i)?.textureData
          ? (materialTextures.get(i)!.textureData!.slice().buffer as ArrayBuffer)
          : null,
        textureUri: materialTextures.get(i)?.textureUri,
      }))
    : undefined;

  // For materials with textures, set vertex color to white so texture isn't darkened
  for (let i = 0; i < materialColors.length; i++) {
    if (materialTextures.has(i)) {
      materialColors[i] = [1, 1, 1];
    }
  }

  // Parse node hierarchy first (needed for skin data)
  const nodesResult = parseFBXNodes(nodes);

  // Build model ID -> name and ID -> index mappings for skin parsing
  const objectsNode = nodes.find(n => n.name === "Objects");
  const modelNodesRaw = objectsNode ? findNodesByName(objectsNode, "Model") : [];
  const modelIdToName = new Map<string, string>();
  const modelIdToIndex = new Map<string, number>();
  for (let i = 0; i < modelNodesRaw.length; i++) {
    const node = modelNodesRaw[i];
    const id = node.properties.length > 0 ? String(node.properties[0].value) : `model_${i}`;
    let modelName = `node_${i}`;
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      modelName = String(node.properties[1].value);
    }
    modelIdToName.set(id, modelName);
    modelIdToIndex.set(id, i);
  }

  // Parse skin/deformer data
  const skinData = nodesResult
    ? parseFBXSkinData(nodes, modelIdToName, modelIdToIndex, nodesResult)
    : null;

  // Parse geometry (with skin data if available)
  const meshes: MeshData[] = [];
  const geoIdToMeshIndex = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    findGeometryNodes(nodes[i], meshes, materialColors, skinData?.geometrySkins, geoIdToMeshIndex);
  }

  // Link meshes to model nodes via Geometry→Model connections
  if (nodesResult) {
    const connectionsNode = nodes.find(n => n.name === "Connections");
    if (connectionsNode) {
      // Build model ID → node index map (same as in parseFBXNodes)
      const modelIdToNodeIndex = new Map<string, number>();
      for (let i = 0; i < nodesResult.length; i++) {
        // The nodeIndex field matches the array index
        modelIdToNodeIndex.set(String(modelNodesRaw[i].properties[0].value), i);
      }
      // Find Geometry→Model connections and set ModelNode.mesh
      for (let i = 0; i < connectionsNode.children.length; i++) {
        const c = connectionsNode.children[i];
        if (c.name === "C" && c.properties.length >= 3) {
          const childId = String(c.properties[1].value);
          const parentId = String(c.properties[2].value);
          const meshIdx = geoIdToMeshIndex.get(childId);
          const nodeIdx = modelIdToNodeIndex.get(parentId);
          if (meshIdx !== undefined && nodeIdx !== undefined) {
            nodesResult[nodeIdx].mesh = meshIdx;
          }
        }
      }
    }
  }

  // Parse UpAxis and UnitScaleFactor from GlobalSettings. Stored on ModelData
  // as sourceUpAxis / sourceUnits / sourceUnitScaleFactor for the normalization
  // layer to apply. The parser does NOT convert vertices — that's the
  // normalizer's job, which respects sidecar overrides.
  const sourceUpAxis = parseFBXUpAxis(nodes);
  const rawUnitScale = parseFBXUnitScale(nodes);
  const sourceUnits = classifyFBXUnits(rawUnitScale);

  // Parse animations
  const animations = parseFBXAnimations(nodes);
  const animResult = animations.length > 0 ? animations : undefined;

  const result: ModelData = {
    meshes,
    name,
    format: "fbx",
    materials,
    animations: animResult,
    nodes: nodesResult,
    sourceUpAxis,
    sourceUnits,
    sourceUnitScaleFactor: rawUnitScale,
  };
  if (skinData) {
    result.skin = { bones: skinData.bones, boneNameToIndex: skinData.boneNameToIndex };
  }
  return result;
}

// ============================================================================
// FBX ASCII fallback (minimal — extracts vertices and faces only)
// ============================================================================

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

  const idxArray = triIndices.length > 65535
    ? new Uint32Array(triIndices)
    : new Uint16Array(triIndices);

  return {
    meshes: [{
      vertices: vertArray,
      indices: idxArray,
      vertexCount,
      indexCount: triIndices.length,
      uvs: null,
      colors: null,
    }],
    name,
    format: "fbx",
    sourceUpAxis: asciiUpAxis,
    sourceUnits: classifyFBXUnits(asciiUnitScale),
    sourceUnitScaleFactor: asciiUnitScale,
  };
}
