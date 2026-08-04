import type { MaterialData, MeshData, ModelData } from "./types";

// 3DS chunk IDs
const CHUNK_MAIN = 0x4d4d;
const CHUNK_EDIT = 0x3d3d;
const CHUNK_OBJECT = 0x4000;
const CHUNK_TRIMESH = 0x4100;
const CHUNK_VERTICES = 0x4110;
const CHUNK_FACES = 0x4120;
const CHUNK_MAPPING = 0x4140;
const CHUNK_MATERIAL = 0xafff;
const CHUNK_MAT_NAME = 0xa000;
const CHUNK_MAT_TEXMAP = 0xa200;
const CHUNK_MAT_MAPFILE = 0xa300;
const CHUNK_MAT_DIFFUSE = 0xa020;
const CHUNK_MAT_SHININESS = 0xa040;
const CHUNK_MAT_SHIN_STRENGTH = 0xa041;
const CHUNK_FACE_MATERIAL = 0x4130;

interface FaceMaterial {
  materialName: string;
  faceIndices: number[];
}

function readString(view: DataView, offset: number): [string, number] {
  const bytes: number[] = [];
  let pos = offset;
  while (pos < view.byteLength && view.getUint8(pos) !== 0) {
    bytes.push(view.getUint8(pos));
    pos++;
  }
  pos++; // skip null terminator
  const str = new TextDecoder().decode(new Uint8Array(bytes));
  return [str, pos - offset];
}

function readChunkHeader(view: DataView, offset: number): [number, number] {
  const id = view.getUint16(offset, true);
  const size = view.getUint32(offset + 2, true);
  return [id, size];
}

interface ParsedMesh {
  name: string;
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
  uvs: Float32Array | null;
  faceMaterials: FaceMaterial[];
}

function parseTriMesh(view: DataView, chunkStart: number, chunkEnd: number, name: string): ParsedMesh {
  let offset = chunkStart;

  let positions: number[] = [];
  let indices: number[] = [];
  let uvs: number[] = [];
  let faceMaterials: FaceMaterial[] = [];

  while (offset < chunkEnd) {
    const [id, size] = readChunkHeader(view, offset);
    const childEnd = offset + size;

    if (id === CHUNK_VERTICES) {
      const count = view.getUint16(offset + 6, true);
      positions = [];
      let pos = offset + 8;
      for (let i = 0; i < count; i++) {
        const x = view.getFloat32(pos, true);
        const y = view.getFloat32(pos + 4, true);
        const z = view.getFloat32(pos + 8, true);
        // 3DS uses Z-up, convert to Y-up
        positions.push(x, z, -y);
        pos += 12;
      }
    } else if (id === CHUNK_FACES) {
      const count = view.getUint16(offset + 6, true);
      indices = [];
      let pos = offset + 8;
      for (let i = 0; i < count; i++) {
        const a = view.getUint16(pos, true);
        const b = view.getUint16(pos + 2, true);
        const c = view.getUint16(pos + 4, true);
        // Skip face flags (2 bytes)
        indices.push(a, b, c);
        pos += 8;
      }

      // Check for face material sub-chunks
      let subOffset = pos;
      while (subOffset < childEnd) {
        const [subId, subSize] = readChunkHeader(view, subOffset);
        const subChildEnd = subOffset + subSize;

        if (subId === CHUNK_FACE_MATERIAL) {
          const [matName, nameLen] = readString(view, subOffset + 6);
          const numFaces = view.getUint16(subOffset + 6 + nameLen, true);
          const faceIdx: number[] = [];
          let fPos = subOffset + 6 + nameLen + 2;
          for (let f = 0; f < numFaces; f++) {
            faceIdx.push(view.getUint16(fPos, true));
            fPos += 2;
          }
          faceMaterials.push({ materialName: matName, faceIndices: faceIdx });
        }

        subOffset = subChildEnd;
      }
    } else if (id === CHUNK_MAPPING) {
      const count = view.getUint16(offset + 6, true);
      uvs = [];
      let pos = offset + 8;
      for (let i = 0; i < count; i++) {
        const u = view.getFloat32(pos, true);
        const v = view.getFloat32(pos + 4, true);
        uvs.push(u, 1.0 - v); // Flip V
        pos += 8;
      }
    }

    offset = childEnd;
  }

  const vertexCount = positions.length / 3;
  const indexCount = indices.length;

  // Build interleaved vertices (pos + normal = 6 floats)
  // 3DS doesn't store normals, so we compute them
  const vertices = new Float32Array(vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 6] = positions[i * 3];
    vertices[i * 6 + 1] = positions[i * 3 + 1];
    vertices[i * 6 + 2] = positions[i * 3 + 2];
    // normals will be filled below
  }

  // Compute face normals and assign to vertices
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < indexCount; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

    normals[a * 3] += nx / len; normals[a * 3 + 1] += ny / len; normals[a * 3 + 2] += nz / len;
    normals[b * 3] += nx / len; normals[b * 3 + 1] += ny / len; normals[b * 3 + 2] += nz / len;
    normals[c * 3] += nx / len; normals[c * 3 + 1] += ny / len; normals[c * 3 + 2] += nz / len;
  }

  for (let i = 0; i < vertexCount; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    vertices[i * 6 + 3] = nx / len;
    vertices[i * 6 + 4] = ny / len;
    vertices[i * 6 + 5] = nz / len;
  }

  const indexArray = indexCount > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  const uvArray = uvs.length > 0 ? new Float32Array(uvs) : null;

  return {
    name,
    vertices,
    indices: indexArray,
    vertexCount,
    indexCount,
    uvs: uvArray,
    faceMaterials,
  };
}

interface ParsedMaterial {
  name: string;
  diffuseColor: [number, number, number];
  shininess: number;
  shininessStrength: number;
  textureFile?: string;
}

function parseMaterial(view: DataView, chunkStart: number, chunkEnd: number): ParsedMaterial {
  let offset = chunkStart;
  const mat: ParsedMaterial = {
    name: "default",
    diffuseColor: [0.7, 0.7, 0.7],
    shininess: 0,
    shininessStrength: 0,
  };

  while (offset < chunkEnd) {
    const [id, size] = readChunkHeader(view, offset);
    const childEnd = offset + size;

    if (id === CHUNK_MAT_NAME) {
      const [name] = readString(view, offset + 6);
      mat.name = name;
    } else if (id === CHUNK_MAT_DIFFUSE) {
      // Color sub-chunk: skip header, read RGB floats
      const colorEnd = childEnd;
      let pos = offset + 6;
      // Skip past any sub-chunks to find the actual color data
      // Typically there's a 24-bit color sub-chunk (0x0011) or float color (0x0013)
      while (pos < colorEnd) {
        const [subId, subSize] = readChunkHeader(view, pos);
        if (subId === 0x0011) {
          // 24-bit color: 3 bytes
          const r = view.getUint8(pos + 6) / 255;
          const g = view.getUint8(pos + 7) / 255;
          const b = view.getUint8(pos + 8) / 255;
          mat.diffuseColor = [r, g, b];
          break;
        } else if (subId === 0x0013) {
          // Float color: 3 floats
          mat.diffuseColor = [
            view.getFloat32(pos + 6, true),
            view.getFloat32(pos + 10, true),
            view.getFloat32(pos + 14, true),
          ];
          break;
        }
        pos += subSize;
      }
    } else if (id === CHUNK_MAT_SHININESS) {
      let pos = offset + 6;
      while (pos < childEnd) {
        const [subId, subSize] = readChunkHeader(view, pos);
        if (subId === 0x0030) {
          mat.shininess = view.getFloat32(pos + 6, true) * 100;
          break;
        }
        pos += subSize;
      }
    } else if (id === CHUNK_MAT_SHIN_STRENGTH) {
      let pos = offset + 6;
      while (pos < childEnd) {
        const [subId, subSize] = readChunkHeader(view, pos);
        if (subId === 0x0030) {
          mat.shininessStrength = view.getFloat32(pos + 6, true);
          break;
        }
        pos += subSize;
      }
    } else if (id === CHUNK_MAT_TEXMAP) {
      let pos = offset + 6;
      while (pos < childEnd) {
        const [subId, subSize] = readChunkHeader(view, pos);
        if (subId === CHUNK_MAT_MAPFILE) {
          const [filename] = readString(view, pos + 6);
          mat.textureFile = filename;
          break;
        }
        pos += subSize;
      }
    }

    offset = childEnd;
  }

  return mat;
}

export function parse3DS(data: ArrayBuffer, name: string): ModelData {
  const view = new DataView(data);
  const meshes: ParsedMesh[] = [];
  const materials: ParsedMaterial[] = [];

  let offset = 0;

  // Find main chunk
  const [mainId, mainSize] = readChunkHeader(view, 0);
  if (mainId !== CHUNK_MAIN) {
    throw new Error("3DS: Invalid file, missing main chunk");
  }

  // Iterate through main chunk children
  offset = 6;
  while (offset < mainSize) {
    const [id, size] = readChunkHeader(view, offset);
    const childEnd = offset + size;

    if (id === CHUNK_EDIT) {
      let editOffset = offset + 6;

      while (editOffset < childEnd) {
        const [editId, editSize] = readChunkHeader(view, editOffset);
        const editChildEnd = editOffset + editSize;

        if (editId === CHUNK_OBJECT) {
          const [objName, nameLen] = readString(view, editOffset + 6);
          let objOffset = editOffset + 6 + nameLen;

          while (objOffset < editChildEnd) {
            const [objSubId, objSubSize] = readChunkHeader(view, objOffset);
            const objSubEnd = objOffset + objSubSize;

            if (objSubId === CHUNK_TRIMESH) {
              const mesh = parseTriMesh(view, objOffset + 6, objSubEnd, objName);
              meshes.push(mesh);
            }

            objOffset = objSubEnd;
          }
        } else if (editId === CHUNK_MATERIAL) {
          const mat = parseMaterial(view, editOffset + 6, editChildEnd);
          materials.push(mat);
        }

        editOffset = editChildEnd;
      }
    }

    offset = childEnd;
  }

  // Convert to ModelData
  const modelMeshes: MeshData[] = meshes.map((m) => ({
    vertices: m.vertices,
    indices: m.indices,
    vertexCount: m.vertexCount,
    indexCount: m.indexCount,
    uvs: m.uvs,
    colors: null,
  }));

  const modelMaterials: MaterialData[] | undefined = materials.length > 0
    ? materials.map((m) => ({
        name: m.name,
        baseColor: [m.diffuseColor[0], m.diffuseColor[1], m.diffuseColor[2], 1],
        metallic: 0,
        roughness: m.shininess > 0 ? Math.max(0.05, 1 - m.shininess / 100) : 1,
        textureUri: m.textureFile,
      }))
    : undefined;

  return {
    meshes: modelMeshes,
    name,
    format: "3ds",
    materials: modelMaterials,
  };
}
