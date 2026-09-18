import type { ExtractedMesh, ExtractMeshOptions, VoxelField } from "./types";

// Cube corner offsets (same convention as MC plugin)
const CORNER_OFFSET = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
];

// 12 edges of a cube, defined by corner index pairs
const EDGE_VERTS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],  // bottom face
  [4, 5], [5, 6], [6, 7], [7, 4],  // top face
  [0, 4], [1, 5], [2, 6], [3, 7],  // vertical
];

const SCRATCH_D = new Float32Array(8);

function ensureCapacity(arr: Float32Array, needed: number): Float32Array {
  if (arr.length >= needed) return arr;
  let n = arr.length;
  while (n < needed) n *= 2;
  const r = new Float32Array(n);
  r.set(arr);
  return r;
}

function ensureCapacityU32(arr: Uint32Array, needed: number): Uint32Array {
  if (arr.length >= needed) return arr;
  let n = arr.length;
  while (n < needed) n *= 2;
  const r = new Uint32Array(n);
  r.set(arr);
  return r;
}

function ensureCapacityU16(arr: Uint16Array, needed: number): Uint16Array {
  if (arr.length >= needed) return arr;
  let n = arr.length;
  while (n < needed) n *= 2;
  const r = new Uint16Array(n);
  r.set(arr);
  return r;
}

/**
 * Surface Nets isosurface extraction.
 *
 * Places one vertex per boundary voxel at the centroid of edge-surface
 * intersections. Connects adjacent boundary voxels with quads (triangulated
 * into 2 triangles each) formed around shared grid edges. Produces smoother
 * surfaces with ~3-6x fewer vertices than Marching Cubes.
 *
 * Output format is identical to MC: Float32Array with 9 floats per vertex
 * (pos.xyz, normal.xyz, color.rgb) and Uint16/Uint32 index array.
 */
export function extractMeshFromField(
  field: VoxelField,
  options: ExtractMeshOptions = {},
): ExtractedMesh {
  const iso = field.isoLevel;
  const vs = field.voxelSize;
  const dimYDimZ = field.dimY * field.dimZ;
  const dimZ = field.dimZ;
  const ox = field.originX, oy = field.originY, oz = field.originZ;
  const colorFn = options.colorFn;
  const flipDown = options.flipDownNormals !== false;
  const smooth = options.smooth !== false;

  const xStart = options.x0 !== undefined ? Math.max(0, options.x0) : 0;
  const yStart = options.y0 !== undefined ? Math.max(0, options.y0) : 0;
  const zStart = options.z0 !== undefined ? Math.max(0, options.z0) : 0;
  const xEnd = options.x1 !== undefined ? Math.min(field.dimX - 1, options.x1) : field.dimX - 1;
  const yEnd = options.y1 !== undefined ? Math.min(field.dimY - 1, options.y1) : field.dimY - 1;
  const zEnd = options.z1 !== undefined ? Math.min(field.dimZ - 1, options.z1) : field.dimZ - 1;

  // Sub-region extraction uses a 2-voxel border in the materialized field.
  // Vertex placement covers [xStart, xEnd] inclusive — the sub-region plus
  // the +1 border cell (needed for seam-closing quads). The +1 border vertex
  // has valid corner data because the materialized field extends 2 voxels
  // beyond the chunk on each side.
  // Full-field extraction uses original bounds to avoid false boundary cells
  // from OOB corners (sampleDensity returns -1.0 for out-of-bounds).
  const hasSubRegion = options.x0 !== undefined || options.y0 !== undefined ||
                       options.z0 !== undefined || options.x1 !== undefined ||
                       options.y1 !== undefined || options.z1 !== undefined;

  // Exclusive upper bounds for Pass 1 vertex placement loop.
  // Full-field: xLoopEnd = xEnd (matches original x < xEnd behavior)
  // Sub-region: xLoopEnd = xEnd + 1 (includes +1 border cell, x <= xEnd)
  const xLoopEnd = hasSubRegion ? xEnd + 1 : xEnd;
  const yLoopEnd = hasSubRegion ? yEnd + 1 : yEnd;
  const zLoopEnd = hasSubRegion ? zEnd + 1 : zEnd;

  // Vertex index map: -1 = not a boundary cell, >=0 = vertex index
  const totalCells = field.dimX * dimYDimZ;
  const vertexMap = new Int32Array(totalCells).fill(-1);

  // Growable output arrays
  let verts: Float32Array = new Float32Array(65536);
  let vertCount = 0;
  let indices32: Uint32Array = new Uint32Array(32768);
  let indices16: Uint16Array = new Uint16Array(32768);
  let indexCount = 0;
  let useUint32 = false;

  // Helper: sample density at a grid corner, returning -1.0 for out-of-bounds
  function sampleDensity(gx: number, gy: number, gz: number): number {
    if (gx < 0 || gx >= field.dimX || gy < 0 || gy >= field.dimY || gz < 0 || gz >= field.dimZ) {
      return -1.0;
    }
    return field.data[gx * dimYDimZ + gy * dimZ + gz];
  }

  // Helper: get vertex index from cell coordinates
  function getVertexIdx(gx: number, gy: number, gz: number): number {
    if (gx < 0 || gx >= field.dimX || gy < 0 || gy >= field.dimY || gz < 0 || gz >= field.dimZ) {
      return -1;
    }
    return vertexMap[gx * dimYDimZ + gy * dimZ + gz];
  }

  // Helper: emit a triangle
  function emitTri(a: number, b: number, c: number): void {
    if (!useUint32 && a + 2 > 65535) {
      useUint32 = true;
      if (indexCount > indices32.length) {
        indices32 = ensureCapacityU32(indices32, indexCount);
      }
      for (let ci = 0; ci < indexCount; ci++) {
        indices32[ci] = indices16[ci];
      }
    }
    if (useUint32) {
      if (indexCount + 3 > indices32.length) {
        indices32 = ensureCapacityU32(indices32, indexCount + 3);
      }
      indices32[indexCount++] = a;
      indices32[indexCount++] = b;
      indices32[indexCount++] = c;
    } else {
      if (indexCount + 3 > indices16.length) {
        indices16 = ensureCapacityU16(indices16, indexCount + 3);
      }
      indices16[indexCount++] = a;
      indices16[indexCount++] = b;
      indices16[indexCount++] = c;
    }
  }

  // ============================================================
  // Pass 1: Identify boundary cells, compute vertices + normals
  // Vertex placement covers [xStart, xEndV] inclusive — the sub-region
  // plus the +X/+Y/+Z border cells (needed for chunk seam quads).
  // ============================================================
  for (let x = xStart; x < xLoopEnd; x++) {
    for (let y = yStart; y < yLoopEnd; y++) {
      for (let z = zStart; z < zLoopEnd; z++) {
        // Sample 8 corner densities
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const co = CORNER_OFFSET[c];
          const val = sampleDensity(x + co[0], y + co[1], z + co[2]);
          SCRATCH_D[c] = val;
          if (val < iso) cubeIndex |= (1 << c);
        }

        // Skip non-boundary cells
        if (cubeIndex === 0 || cubeIndex === 255) continue;

        // Compute centroid of edge-surface intersections
        let cx = 0, cy = 0, cz = 0, crossingCount = 0;
        for (let e = 0; e < 12; e++) {
          const [c0, c1] = EDGE_VERTS[e];
          const inside0 = SCRATCH_D[c0] >= iso;
          const inside1 = SCRATCH_D[c1] >= iso;
          if (inside0 === inside1) continue;

          const d0 = SCRATCH_D[c0], d1 = SCRATCH_D[c1];
          const co0 = CORNER_OFFSET[c0], co1 = CORNER_OFFSET[c1];
          const p0x = (x + co0[0]) * vs + ox;
          const p0y = (y + co0[1]) * vs + oy;
          const p0z = (z + co0[2]) * vs + oz;
          const p1x = (x + co1[0]) * vs + ox;
          const p1y = (y + co1[1]) * vs + oy;
          const p1z = (z + co1[2]) * vs + oz;

          let t: number;
          if (Math.abs(iso - d0) < 1e-10) t = 0;
          else if (Math.abs(iso - d1) < 1e-10) t = 1;
          else if (Math.abs(d0 - d1) < 1e-10) t = 0;
          else t = (iso - d0) / (d1 - d0);

          cx += p0x + t * (p1x - p0x);
          cy += p0y + t * (p1y - p0y);
          cz += p0z + t * (p1z - p0z);
          crossingCount++;
        }

        if (crossingCount === 0) continue;

        let vx: number, vy: number, vz: number;
        if (smooth) {
          const invCount = 1 / crossingCount;
          vx = cx * invCount;
          vy = cy * invCount;
          vz = cz * invCount;
        } else {
          // Low-poly mode: snap to voxel grid center
          vx = (x + 0.5) * vs + ox;
          vy = (y + 0.5) * vs + oy;
          vz = (z + 0.5) * vs + oz;
        }

        // Compute normal from density gradient (8-corner finite difference)
        // Gradient points from low density (empty) to high density (solid).
        // Normal points outward (solid→empty) = -gradient.
        const d = SCRATCH_D;
        const gx = (d[1] + d[2] + d[5] + d[6]) * 0.25 - (d[0] + d[3] + d[4] + d[7]) * 0.25;
        const gy = (d[4] + d[5] + d[6] + d[7]) * 0.25 - (d[0] + d[1] + d[2] + d[3]) * 0.25;
        const gz = (d[2] + d[3] + d[6] + d[7]) * 0.25 - (d[0] + d[1] + d[4] + d[5]) * 0.25;
        let nx = -gx, ny = -gy, nz = -gz;
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
        else { nx = 0; ny = 1; nz = 0; }
        if (flipDown && ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

        // Apply color callback
        const col = colorFn
          ? colorFn(vx, vy, vz, nx, ny, nz, field)
          : [1, 1, 1] as [number, number, number];

        // Store vertex
        if (vertCount + 9 > verts.length) {
          verts = ensureCapacity(verts, vertCount + 9);
        }
        const vi = vertCount / 9;
        verts[vertCount++] = vx; verts[vertCount++] = vy; verts[vertCount++] = vz;
        verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
        verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];

        vertexMap[x * dimYDimZ + y * dimZ + z] = vi;
      }
    }
  }

  // ============================================================
  // Pass 2: Generate quads from grid edges
  // For each axis-aligned edge, check the 4 surrounding cells.
  // If all 4 are boundary cells, emit a quad (2 triangles).
  // ============================================================

  // X-edges at (x, y, z): 4 cells = (x,y,z), (x,y-1,z), (x,y-1,z-1), (x,y,z-1)
  // Face normal from winding: +X. Flip if vertex normals point -X.
  // x range: [xStart, xEnd) — +X face X-edges handled by neighbor
  // y range: [yStart+1, yLoopEnd) — extended to cover +Y border
  // z range: [zStart+1, zLoopEnd) — extended to cover +Z border
  for (let x = xStart; x < xEnd; x++) {
    for (let y = yStart + 1; y < yLoopEnd; y++) {
      for (let z = zStart + 1; z < zLoopEnd; z++) {
        const v0 = getVertexIdx(x, y, z);
        if (v0 < 0) continue;
        const v1 = getVertexIdx(x, y - 1, z);
        if (v1 < 0) continue;
        const v2 = getVertexIdx(x, y - 1, z - 1);
        if (v2 < 0) continue;
        const v3 = getVertexIdx(x, y, z - 1);
        if (v3 < 0) continue;
        // Check winding vs vertex normals (face normal = +X)
        const avgNx = (verts[v0 * 9 + 3] + verts[v1 * 9 + 3]) * 0.5;
        if (avgNx < 0) { emitTri(v0, v3, v2); emitTri(v0, v2, v1); }
        else { emitTri(v0, v1, v2); emitTri(v0, v2, v3); }
      }
    }
  }

  // Y-edges at (x, y, z): 4 cells = (x,y,z), (x-1,y,z), (x-1,y,z-1), (x,y,z-1)
  // Face normal from winding: -Y. Flip if vertex normals point +Y.
  // x range: [xStart+1, xLoopEnd) — extended to cover +X border
  // y range: [yStart, yEnd) — +Y face Y-edges handled by neighbor
  // z range: [zStart+1, zLoopEnd) — extended to cover +Z border
  for (let x = xStart + 1; x < xLoopEnd; x++) {
    for (let y = yStart; y < yEnd; y++) {
      for (let z = zStart + 1; z < zLoopEnd; z++) {
        const v0 = getVertexIdx(x, y, z);
        if (v0 < 0) continue;
        const v1 = getVertexIdx(x - 1, y, z);
        if (v1 < 0) continue;
        const v2 = getVertexIdx(x - 1, y, z - 1);
        if (v2 < 0) continue;
        const v3 = getVertexIdx(x, y, z - 1);
        if (v3 < 0) continue;
        // Check winding vs vertex normals (face normal = -Y)
        const avgNy = (verts[v0 * 9 + 4] + verts[v1 * 9 + 4]) * 0.5;
        if (avgNy > 0) { emitTri(v0, v3, v2); emitTri(v0, v2, v1); }
        else { emitTri(v0, v1, v2); emitTri(v0, v2, v3); }
      }
    }
  }

  // Z-edges at (x, y, z): 4 cells = (x,y,z), (x-1,y,z), (x-1,y-1,z), (x,y-1,z)
  // Face normal from winding: +Z. Flip if vertex normals point -Z.
  // x range: [xStart+1, xLoopEnd) — extended to cover +X border
  // y range: [yStart+1, yLoopEnd) — extended to cover +Y border
  // z range: [zStart, zEnd) — +Z face Z-edges handled by neighbor
  for (let x = xStart + 1; x < xLoopEnd; x++) {
    for (let y = yStart + 1; y < yLoopEnd; y++) {
      for (let z = zStart; z < zEnd; z++) {
        const v0 = getVertexIdx(x, y, z);
        if (v0 < 0) continue;
        const v1 = getVertexIdx(x - 1, y, z);
        if (v1 < 0) continue;
        const v2 = getVertexIdx(x - 1, y - 1, z);
        if (v2 < 0) continue;
        const v3 = getVertexIdx(x, y - 1, z);
        if (v3 < 0) continue;
        // Check winding vs vertex normals (face normal = +Z)
        const avgNz = (verts[v0 * 9 + 5] + verts[v1 * 9 + 5]) * 0.5;
        if (avgNz < 0) { emitTri(v0, v3, v2); emitTri(v0, v2, v1); }
        else { emitTri(v0, v1, v2); emitTri(v0, v2, v3); }
      }
    }
  }

  const finalVerts = verts.subarray(0, vertCount);
  const finalIndices = useUint32
    ? indices32.subarray(0, indexCount)
    : indices16.subarray(0, indexCount);

  return {
    verts: finalVerts,
    indices: finalIndices as Uint16Array | Uint32Array,
    useUint32,
  };
}
