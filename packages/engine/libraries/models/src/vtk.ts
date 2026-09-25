// ============================================================================
// vtk.ts — VTK legacy format (.vtk) parser, ASCII POLYDATA
//
// Supports the classic serial format: POINTS, POLYGONS/LINES/VERTICES plus
// POINT_DATA attributes (NORMALS, TEXTURE_COORDINATES, COLOR_SCALARS,
// SCALARS+LOOKUP_TABLE). Binary legacy files and STRUCTURED/UNSTRUCTURED/
// FIELD datasets are reported as warnings — the modern XML VTK family
// (.vtp/.vtu/.vti) is a different container entirely.
// ============================================================================

import { assertCount, MAX_FACE_COUNT, MAX_VERTEX_COUNT } from "@downdraft/engine";
import type { MeshData, ModelData } from "./types";

export function parseVTK(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");
  const warnings: string[] = [];

  if (!lines[0]?.startsWith("# vtk DataFile")) {
    throw new Error("VTK: not a legacy vtk file");
  }
  const encoding = (lines[2] ?? "").trim().toUpperCase();
  if (encoding === "BINARY") {
    throw new Error("VTK: binary legacy files are not supported (ASCII only)");
  }
  const datasetLine = (lines[3] ?? "").trim().toUpperCase();
  const dataset = datasetLine.replace(/^DATASET\s+/, "");
  if (dataset !== "POLYDATA") {
    warnings.push(`VTK dataset ${dataset} — only POLYDATA geometry is loaded`);
    if (dataset !== "UNSTRUCTURED_GRID") {
      throw new Error(`VTK: unsupported dataset ${dataset}`);
    }
  }

  // Tokenize the body after the DATASET line — VTK ASCII is whitespace-
  // separated with keywords interleaved.
  const body = lines.slice(4).join("\n");
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);
  let ti = 0;

  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  let pointDataCount = 0;
  let colorComps = 0;
  let scalarLookup: { name: string; table: Float32Array; scalarName: string; values: Float32Array } | null = null;
  let pendingScalars: { name: string; values: Float32Array } | null = null;
  const pendingCells: number[][] = [];

  // VTK cell type → surface triangles (vertex order per the VTK spec).
  const tri = (c: number[], ...ts: number[]) => {
    for (let i = 0; i + 2 < ts.length; i += 3) indices.push(c[ts[i]], c[ts[i + 1]], c[ts[i + 2]]);
  };
  function emitCell(type: number, c: number[]): void {
    switch (type) {
      case 5: tri(c, 0, 1, 2); break; // TRIANGLE
      case 9: tri(c, 0, 1, 2, 0, 2, 3); break; // QUAD
      case 10: tri(c, 0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3); break; // TETRA
      case 12: // HEXAHEDRON
        tri(c, 0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
               1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0);
        break;
      case 13: // WEDGE
        tri(c, 0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0);
        break;
      case 14: // PYRAMID
        tri(c, 0, 1, 2, 0, 2, 3, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4);
        break;
      default: break; // vertex/line/unknown cells aren't meshes
    }
  }

  while (ti < tokens.length) {
    const kw = tokens[ti++].toUpperCase();
    if (kw === "POINTS") {
      const n = parseInt(tokens[ti++], 10);
      ti++; // datatype token
      assertCount("vtk points", n, MAX_VERTEX_COUNT);
      for (let i = 0; i < n * 3; i++) positions.push(parseFloat(tokens[ti++]));
    } else if (kw === "POLYGONS" || kw === "TRIANGLE_STRIPS") {
      const n = parseInt(tokens[ti++], 10);
      ti++; // total index count
      assertCount("vtk polygons", n, MAX_FACE_COUNT);
      if (kw === "POLYGONS") {
        for (let i = 0; i < n; i++) {
          const k = parseInt(tokens[ti++], 10);
          const face: number[] = [];
          for (let j = 0; j < k; j++) face.push(parseInt(tokens[ti++], 10));
          for (let j = 1; j < k - 1; j++) {
            indices.push(face[0], face[j], face[j + 1]);
          }
        }
      } else {
        // Triangle strips → triangle list.
        for (let i = 0; i < n; i++) {
          const k = parseInt(tokens[ti++], 10);
          const strip: number[] = [];
          for (let j = 0; j < k; j++) strip.push(parseInt(tokens[ti++], 10));
          for (let j = 0; j + 2 < k; j++) {
            if (j % 2 === 0) indices.push(strip[j], strip[j + 1], strip[j + 2]);
            else indices.push(strip[j + 1], strip[j], strip[j + 2]);
          }
        }
      }
    } else if (kw === "VERTICES" || kw === "LINES") {
      // Point/line cells — not renderable as triangles; skip.
      const n = parseInt(tokens[ti++], 10);
      const total = parseInt(tokens[ti++], 10);
      ti += total;
      if (n > 0) warnings.push(`VTK ${kw.toLowerCase()} skipped (points/lines aren't meshes)`);
    } else if (kw === "CELLS") {
      // UNSTRUCTURED_GRID cell connectivity — collect raw index lists;
      // CELL_TYPES (next section) decides how each becomes triangles.
      const n = parseInt(tokens[ti++], 10);
      ti++; // total index count
      assertCount("vtk cells", n, MAX_FACE_COUNT);
      for (let i = 0; i < n; i++) {
        const k = parseInt(tokens[ti++], 10);
        const cell: number[] = [];
        for (let j = 0; j < k; j++) cell.push(parseInt(tokens[ti++], 10));
        pendingCells.push(cell);
      }
    } else if (kw === "CELL_TYPES") {
      const n = parseInt(tokens[ti++], 10);
      for (let i = 0; i < n; i++) {
        const type = parseInt(tokens[ti++], 10);
        const cell = pendingCells[i] ?? [];
        emitCell(type, cell);
      }
      pendingCells.length = 0;
    } else if (kw === "POINT_DATA" || kw === "CELL_DATA") {
      pointDataCount = parseInt(tokens[ti++], 10);
      if (kw === "CELL_DATA") break; // cell attributes don't map to vertices
    } else if (kw === "NORMALS") {
      ti++; // name
      ti++; // datatype
      for (let i = 0; i < pointDataCount * 3; i++) normals.push(parseFloat(tokens[ti++]));
    } else if (kw === "TEXTURE_COORDINATES") {
      ti++; // name
      const dim = parseInt(tokens[ti++], 10);
      ti++; // datatype
      for (let i = 0; i < pointDataCount; i++) {
        uvs.push(parseFloat(tokens[ti++]));
        uvs.push(dim >= 2 ? parseFloat(tokens[ti++]) : 0);
        if (dim >= 3) ti++;
      }
    } else if (kw === "COLOR_SCALARS") {
      ti++; // name
      colorComps = parseInt(tokens[ti++], 10);
      for (let i = 0; i < pointDataCount; i++) {
        const c = [0, 0, 0, 1];
        for (let j = 0; j < colorComps; j++) c[j] = parseFloat(tokens[ti++]);
        colors.push(c[0], c[1], c[2], c[3]);
      }
    } else if (kw === "SCALARS") {
      const scalarName = tokens[ti++];
      ti++; // datatype
      if (tokens[ti] === "1") ti++; // optional numComp
      // Next keyword is usually LOOKUP_TABLE
      if (tokens[ti]?.toUpperCase() === "LOOKUP_TABLE") {
        ti++;
        const tableName = tokens[ti++];
        pendingScalars = { name: scalarName, values: new Float32Array(pointDataCount) };
        for (let i = 0; i < pointDataCount; i++) pendingScalars.values[i] = parseFloat(tokens[ti++]);
        scalarLookup = { name: tableName, table: new Float32Array(0), scalarName, values: pendingScalars.values };
      } else {
        for (let i = 0; i < pointDataCount; i++) ti++;
      }
    } else if (kw === "LOOKUP_TABLE") {
      ti++; // name
      const n = parseInt(tokens[ti++], 10);
      const table = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) table[i] = parseFloat(tokens[ti++]);
      if (scalarLookup && pendingScalars) {
        scalarLookup.table = table;
        // Apply table: scalar value [0,1] → rgba
        for (let i = 0; i < pointDataCount; i++) {
          const t = Math.max(0, Math.min(1, pendingScalars.values[i]));
          const idx = Math.min(n - 1, Math.floor(t * (n - 1) + 0.5)) * 4;
          colors.push(table[idx], table[idx + 1], table[idx + 2], table[idx + 3]);
        }
      }
    } else {
      // Unknown keyword — stop scanning; trailing sections (VECTORS,
      // TENSORS, FIELD) are skipped to avoid misreading counts.
      break;
    }
  }

  const vertexCount = positions.length / 3;
  if (vertexCount === 0) throw new Error("VTK: no POINTS section");

  const hasNormals = normals.length === vertexCount * 3;
  const vertices = new Float32Array(vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 6] = positions[i * 3];
    vertices[i * 6 + 1] = positions[i * 3 + 1];
    vertices[i * 6 + 2] = positions[i * 3 + 2];
    vertices[i * 6 + 3] = hasNormals ? normals[i * 3] : 0;
    vertices[i * 6 + 4] = hasNormals ? normals[i * 3 + 1] : 0;
    vertices[i * 6 + 5] = hasNormals ? normals[i * 3 + 2] : 0;
  }

  const mesh: MeshData = {
    vertices,
    indices: indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    vertexCount,
    indexCount: indices.length,
    uvs: uvs.length === vertexCount * 2 ? new Float32Array(uvs) : null,
    colors: colors.length === vertexCount * 4 ? new Float32Array(colors) : null,
  };

  const model: ModelData = { meshes: [mesh], name, format: "vtk" };
  if (warnings.length > 0) model.warnings = warnings;
  return model;
}
