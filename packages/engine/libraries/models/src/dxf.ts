// ============================================================================
// dxf.ts — AutoCAD DXF parser (ASCII), mesh-producing entities only
//
// Handles: 3DFACE, POLYLINE polyface meshes (VERTEX flags 64/128), LWPOLYLINE
// (planar fan), and MESH (AcDbSubDMesh vertex/face lists). LINE/ARC/CIRCLE/
// SPLINE/HATCH/dimension entities are skipped — DXF is a drafting format and
// most files are 2D; this extracts whatever 3D surface geometry exists.
// ============================================================================

import { assertCount, MAX_VERTEX_COUNT } from "@downdraft/engine";
import type { MeshData, ModelData } from "./types";

interface Group { code: number; value: string }

export function parseDXF(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const raw = text.split(/\r?\n/);
  const groups: Group[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    groups.push({ code: parseInt(raw[i].trim(), 10), value: raw[i + 1] });
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const warnings: string[] = [];
  let sawMesh = false;

  const pushVertex = (x: number, y: number, z: number): number => {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    return idx;
  };

  let i = 0;
  const nextGroup = (): Group | null => (i < groups.length ? groups[i++] : null);

  while (i < groups.length) {
    const g = groups[i];
    i++;
    if (g.code !== 0) continue;
    const entity = g.value.trim().toUpperCase();

    if (entity === "3DFACE") {
      const v: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 4 corners xyz
      while (i < groups.length && groups[i].code !== 0) {
        const h = groups[i++];
        const corner = Math.floor((h.code % 10));
        if (h.code >= 10 && h.code <= 13) v[corner * 3] = parseFloat(h.value) || 0;
        else if (h.code >= 20 && h.code <= 23) v[corner * 3 + 1] = parseFloat(h.value) || 0;
        else if (h.code >= 30 && h.code <= 33) v[corner * 3 + 2] = parseFloat(h.value) || 0;
      }
      const i0 = pushVertex(v[0], v[1], v[2]);
      const i1 = pushVertex(v[3], v[4], v[5]);
      const i2 = pushVertex(v[6], v[7], v[8]);
      const i3 = pushVertex(v[9], v[10], v[11]);
      indices.push(i0, i1, i2);
      // Quad when the 4th corner differs from the 3rd.
      if (v[9] !== v[6] || v[10] !== v[7] || v[11] !== v[8]) {
        indices.push(i0, i2, i3);
      }
      sawMesh = true;
    } else if (entity === "POLYLINE") {
      let flags = 0;
      while (i < groups.length && groups[i].code !== 0) {
        const h = groups[i++];
        if (h.code === 70) flags = parseInt(h.value, 10) || 0;
      }
      // Consume VERTEX records until SEQEND.
      const verts: number[] = []; // local vertex indices (into positions/3)
      const faces: number[][] = [];
      while (i < groups.length) {
        const h = groups[i];
        if (h.code === 0 && h.value.trim() === "SEQEND") { i++; break; }
        if (h.code !== 0) { i++; continue; }
        if (h.value.trim() !== "VERTEX") break;
        {
          i++;
          let vflags = 0, x = 0, y = 0, z = 0;
          const f: number[] = [0, 0, 0, 0];
          while (i < groups.length && groups[i].code !== 0) {
            const vg = groups[i++];
            if (vg.code === 70) vflags = parseInt(vg.value, 10) || 0;
            else if (vg.code === 10) x = parseFloat(vg.value) || 0;
            else if (vg.code === 20) y = parseFloat(vg.value) || 0;
            else if (vg.code === 30) z = parseFloat(vg.value) || 0;
            else if (vg.code >= 71 && vg.code <= 74) f[vg.code - 71] = Math.abs(parseInt(vg.value, 10) || 0);
          }
          if (vflags & 128) {
            faces.push(f.filter((v) => v > 0).map((v) => v - 1)); // 1-based
          } else if (vflags & 64 || flags & 64 || flags & 16) {
            verts.push(pushVertex(x, y, z));
          }
          continue;
        }
        if (h.code === 0) break;
        i++;
      }
      // Emit polyface triangles (face indices are local vertex numbers).
      for (const f of faces) {
        if (f.length >= 3) {
          for (let j = 1; j < f.length - 1; j++) {
            indices.push(verts[f[0]] ?? 0, verts[f[j]] ?? 0, verts[f[j + 1]] ?? 0);
          }
          sawMesh = true;
        }
      }
      // Polygon mesh (flag 16/8 without face records) — grid of verts only;
      // tessellate as a quad strip grid is ambiguous without M×N dims, skip.
    } else if (entity === "LWPOLYLINE") {
      const xs: number[] = [], ys: number[] = [];
      let elevation = 0, closed = false;
      while (i < groups.length && groups[i].code !== 0) {
        const h = groups[i++];
        if (h.code === 10) xs.push(parseFloat(h.value) || 0);
        else if (h.code === 20) ys.push(parseFloat(h.value) || 0);
        else if (h.code === 38) elevation = parseFloat(h.value) || 0;
        else if (h.code === 70) closed = (parseInt(h.value, 10) & 1) !== 0;
      }
      const n = Math.min(xs.length, ys.length);
      if (closed && n >= 3) {
        const base = positions.length / 3;
        for (let j = 0; j < n; j++) pushVertex(xs[j], ys[j], elevation);
        for (let j = 1; j < n - 1; j++) indices.push(base, base + j, base + j + 1);
        sawMesh = true;
      }
    } else if (entity === "MESH") {
      // AcDbSubDMesh: 91 vertex count + 10/20/30 coords; 92 face-list size +
      // 90 face count + 90×count indices.
      const verts: number[] = [];
      const faces: number[][] = [];
      let mode: "none" | "verts" | "faces" | "skip" = "none";
      let vertsExpected = 0, vertsRead = 0;
      let facesTotal = 0, facesRead = 0;
      let curFace: number[] | null = null;
      let curX = 0, curY = 0, pendingX = false, pendingY = false;
      while (i < groups.length && groups[i].code !== 0) {
        const h = groups[i++];
        if (h.code === 91 && mode !== "faces") { mode = "verts"; vertsExpected = parseInt(h.value, 10) || 0; continue; }
        if (h.code === 92) { mode = "faces"; facesTotal = parseInt(h.value, 10) || 0; continue; }
        if (h.code === 95 || h.code === 90 && mode === "skip") { mode = "skip"; continue; }
        if (mode === "verts") {
          if (h.code === 10) { curX = parseFloat(h.value) || 0; pendingX = true; }
          else if (h.code === 20) { curY = parseFloat(h.value) || 0; pendingY = true; }
          else if (h.code === 30 && pendingX && pendingY) {
            verts.push(pushVertex(curX, curY, parseFloat(h.value) || 0));
            pendingX = pendingY = false;
            vertsRead++;
          }
        } else if (mode === "faces" && h.code === 90) {
          if (!curFace) {
            const k = parseInt(h.value, 10) || 0;
            curFace = [];
            (curFace as any)._need = k;
          } else {
            curFace.push(parseInt(h.value, 10) || 0);
            if (curFace.length === (curFace as any)._need) {
              faces.push(curFace);
              curFace = null;
              facesRead++;
            }
          }
        }
        if (facesTotal > 0 && facesRead >= facesTotal) break;
      }
      for (const f of faces) {
        for (let j = 1; j < f.length - 1; j++) {
          indices.push(verts[f[0]] ?? 0, verts[f[j]] ?? 0, verts[f[j + 1]] ?? 0);
        }
      }
      if (verts.length > 0) sawMesh = true;
      void vertsExpected;
    }
  }

  const vertexCount = positions.length / 3;
  if (!sawMesh || vertexCount === 0) {
    warnings.push("no 3D mesh entities found (DXF may be a 2D drawing)");
    throw new Error("DXF: " + warnings[0]);
  }
  assertCount("dxf vertices", vertexCount, MAX_VERTEX_COUNT);

  // Compute flat-ish smooth normals later via normalize; emit zero normals.
  const vertices = new Float32Array(vertexCount * 6);
  for (let v = 0; v < vertexCount; v++) {
    vertices[v * 6] = positions[v * 3];
    vertices[v * 6 + 1] = positions[v * 3 + 1];
    vertices[v * 6 + 2] = positions[v * 3 + 2];
  }

  const mesh: MeshData = {
    vertices,
    indices: indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    vertexCount,
    indexCount: indices.length,
    uvs: null,
    colors: null,
  };

  const model: ModelData = { meshes: [mesh], name, format: "dxf" };
  if (warnings.length > 0) model.warnings = warnings;
  return model;
}
