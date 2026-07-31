import type { MeshData, ModelData } from "./types.ts";

function isBinarySTL(data: ArrayBuffer): boolean {
  // Binary STL: 80-byte header + 4-byte face count + face data
  // ASCII STL starts with "solid" but some binary files also start with "solid"
  // Check: if file size matches binary format, it's binary
  if (data.byteLength < 84) return false;

  const view = new DataView(data);
  const numFaces = view.getUint32(80, true);
  const expectedSize = 84 + numFaces * 50; // 50 bytes per triangle

  // If size matches binary format, it's binary
  if (expectedSize === data.byteLength) return true;

  // Also check if it doesn't start with "solid" (ASCII check)
  const header = new TextDecoder().decode(new Uint8Array(data, 0, 5));
  if (header !== "solid") return true;

  // Fallback: check for "facet" keyword in first 512 bytes (ASCII indicator)
  const checkLen = Math.min(512, data.byteLength);
  const text = new TextDecoder().decode(new Uint8Array(data, 0, checkLen));
  return !text.includes("facet");
}

function parseBinarySTL(data: ArrayBuffer, name: string): ModelData {
  const view = new DataView(data);
  const numFaces = view.getUint32(80, true);

  const vertices: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const vertexMap = new Map<string, number>();

  let offset = 84;
  for (let i = 0; i < numFaces; i++) {
    // 12 bytes normal, then 3 * 12 bytes vertices, then 2 bytes attribute
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);

    for (let v = 0; v < 3; v++) {
      const voff = offset + 12 + v * 12;
      const px = view.getFloat32(voff, true);
      const py = view.getFloat32(voff + 4, true);
      const pz = view.getFloat32(voff + 8, true);

      const key = `${px},${py},${pz}`;
      let idx = vertexMap.get(key);
      if (idx === undefined) {
        idx = vertices.length / 6;
        vertices.push(px, py, pz, nx, ny, nz);
        normals.push(nx, ny, nz);
        vertexMap.set(key, idx);
      }
      indices.push(idx);
    }

    offset += 50; // 12 normal + 36 vertices + 2 attribute
  }

  const vertArray = new Float32Array(vertices);
  const idxArray = indices.length > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  const mesh: MeshData = {
    vertices: vertArray,
    indices: idxArray,
    vertexCount: vertices.length / 6,
    indexCount: indices.length,
    uvs: null,
    colors: null,
  };

  return { meshes: [mesh], name, format: "stl" };
}

function parseASCIISTL(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");

  const vertices: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<string, number>();

  let currentNormal: [number, number, number] = [0, 1, 0];
  let faceVerts: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith("facet normal")) {
      const parts = trimmed.split(/\s+/);
      currentNormal = [parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4])];
      faceVerts = [];
    } else if (trimmed.startsWith("vertex")) {
      const parts = trimmed.split(/\s+/);
      const px = parseFloat(parts[1]);
      const py = parseFloat(parts[2]);
      const pz = parseFloat(parts[3]);

      const key = `${px},${py},${pz}`;
      let idx = vertexMap.get(key);
      if (idx === undefined) {
        idx = vertices.length / 6;
        vertices.push(px, py, pz, currentNormal[0], currentNormal[1], currentNormal[2]);
        vertexMap.set(key, idx);
      }
      faceVerts.push(idx);
    } else if (trimmed === "endfacet") {
      // Triangulate face (usually 3 verts, but handle n-gons)
      if (faceVerts.length >= 3) {
        for (let j = 1; j < faceVerts.length - 1; j++) {
          indices.push(faceVerts[0], faceVerts[j], faceVerts[j + 1]);
        }
      }
      faceVerts = [];
    }
  }

  const vertArray = new Float32Array(vertices);
  const idxArray = indices.length > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  const mesh: MeshData = {
    vertices: vertArray,
    indices: idxArray,
    vertexCount: vertices.length / 6,
    indexCount: indices.length,
    uvs: null,
    colors: null,
  };

  return { meshes: [mesh], name, format: "stl" };
}

export function parseSTL(data: ArrayBuffer, name: string): ModelData {
  if (isBinarySTL(data)) {
    return parseBinarySTL(data, name);
  }
  return parseASCIISTL(data, name);
}
