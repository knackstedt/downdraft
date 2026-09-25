// ============================================================================
// off.ts — Object File Format (.off) parser
//
// Handles the common Geomview variants: OFF, COFF (vertex colors), NOFF
// (vertex normals), CNOFF, 4OFF (homogeneous coords), STOFF (texcoords).
// Faces are n-gons, fan-triangulated. Missing normals are generated smooth.
// ============================================================================

import { assertCount, MAX_FACE_COUNT, MAX_VERTEX_COUNT } from "@downdraft/engine";
import type { MeshData, ModelData } from "./types";

export function parseOFF(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const rawLines = text.split("\n");
  const lines: string[] = [];
  for (const raw of rawLines) {
    const t = raw.replace(/#.*/, "").trim();
    if (t.length > 0) lines.push(t);
  }
  if (lines.length < 2) throw new Error("OFF: file too short");

  let li = 1;
  // First line: variant keyword (OFF/COFF/NOFF/CNOFF/4OFF/STOFF/…), possibly
  // followed by the counts on the same line.
  const m = lines[0].match(/^([A-Za-z0-9]*OFF)\s*(.*)$/i);
  if (!m) throw new Error(`OFF: bad magic "${lines[0]}"`);
  const keyword = m[1].toUpperCase();
  const countsLine = m[2].trim() || lines[li++];
  const hasColor = keyword.includes("C");
  const hasNormal = keyword.includes("N");
  const has4 = keyword.includes("4");
  const hasST = keyword.includes("ST");

  const [nv, nf] = countsLine.split(/\s+/).map(Number);
  assertCount("off vertices", nv, MAX_VERTEX_COUNT);
  assertCount("off faces", nf, MAX_FACE_COUNT);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];

  for (let i = 0; i < nv; i++) {
    const parts = (lines[li++] ?? "").split(/\s+/).map(Number);
    let p = 0;
    let x = parts[p++] ?? 0, y = parts[p++] ?? 0, z = parts[p++] ?? 0;
    if (has4) {
      const w = parts[p++] ?? 1;
      if (w !== 0) { x /= w; y /= w; z /= w; }
    }
    positions.push(x, y, z);
    if (hasST) { uvs.push(parts[p++] ?? 0, parts[p++] ?? 0); }
    if (hasNormal) { normals.push(parts[p++] ?? 0, parts[p++] ?? 0, parts[p++] ?? 0); }
    if (hasColor) {
      // 3 or 4 components; may be 0-255 or 0-1.
      const c = [parts[p++] ?? 1, parts[p++] ?? 1, parts[p++] ?? 1, parts[p] ?? 1];
      const scale = c.some((v) => v > 1) ? 1 / 255 : 1;
      colors.push(c[0] * scale, c[1] * scale, c[2] * scale, c[3] * scale);
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < nf; i++) {
    const parts = (lines[li++] ?? "").split(/\s+/).map(Number);
    const n = parts[0];
    for (let j = 1; j < n - 1; j++) {
      indices.push(parts[1], parts[j + 1], parts[j + 2]);
    }
  }

  const vertexCount = nv;
  const useNormals = hasNormal && normals.length === nv * 3;

  // Interleaved pos+normal (6 floats/vertex)
  const vertices = new Float32Array(vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 6] = positions[i * 3];
    vertices[i * 6 + 1] = positions[i * 3 + 1];
    vertices[i * 6 + 2] = positions[i * 3 + 2];
    vertices[i * 6 + 3] = useNormals ? normals[i * 3] : 0;
    vertices[i * 6 + 4] = useNormals ? normals[i * 3 + 1] : 0;
    vertices[i * 6 + 5] = useNormals ? normals[i * 3 + 2] : 0;
  }

  const mesh: MeshData = {
    vertices,
    indices: indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    vertexCount,
    indexCount: indices.length,
    uvs: uvs.length === nv * 2 ? new Float32Array(uvs) : null,
    colors: colors.length > 0 ? new Float32Array(colors) : null,
  };

  return { meshes: [mesh], name, format: "off" };
}
