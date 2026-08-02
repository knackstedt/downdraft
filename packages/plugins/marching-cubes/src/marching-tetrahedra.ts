import type { ExtractMeshOptions } from "./generator.ts";
import type { ExtractedMesh, VoxelField } from "./types.ts";

const CORNER_OFFSET = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
];

// 5-tet decomposition of a cube — two alternating configs for crack-free
// tiling between adjacent cubes (toggled by (x+y+z)&1).
// Derived from d3x0r's MarchingTetrahedra2, remapped to engine corner order.
const TET_TABLE_A = [
  [0, 4, 3, 1],
  [5, 1, 6, 4],
  [2, 6, 1, 3],
  [7, 6, 3, 4],
  [3, 6, 1, 4],
];

const TET_TABLE_B = [
  [1, 0, 2, 5],
  [4, 5, 7, 0],
  [3, 2, 0, 7],
  [6, 5, 2, 7],
  [0, 7, 2, 5],
];

// Edges of a tetrahedron (local corner indices 0-3)
const TET_EDGE_CORNERS = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];

// Triangle lookup for 16 tetrahedra cases (4-bit: bit i = corner i inside)
// Edges: e0=0-1, e1=0-2, e2=0-3, e3=1-2, e4=1-3, e5=2-3
// Winding: normals point outward (from inside/solid toward outside/empty)
const MT_TRI_TABLE: Int8Array = new Int8Array([
  -1,-1,-1,-1,-1,-1,
   2, 0, 1,-1,-1,-1,
   0, 4, 3,-1,-1,-1,
   1, 2, 4, 1, 4, 3,
   3, 5, 1,-1,-1,-1,
   0, 3, 5, 0, 5, 2,
   1, 0, 4, 1, 4, 5,
   2, 4, 5,-1,-1,-1,
   5, 4, 2,-1,-1,-1,
   4, 0, 1, 5, 4, 1,
   5, 3, 0, 2, 5, 0,
   1, 5, 3,-1,-1,-1,
   4, 2, 1, 3, 4, 1,
   3, 4, 0,-1,-1,-1,
   1, 0, 2,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,
]);

const SCRATCH_D = new Float32Array(8);
const SCRATCH_TET_D = new Float32Array(4);
const SCRATCH_EDGE_VERTS = new Float32Array(6 * 3);

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

export function extractMeshFromFieldTetra(
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

  let verts: Float32Array = new Float32Array(65536);
  let vertCount = 0;
  let indices32: Uint32Array = new Uint32Array(32768);
  let indices16: Uint16Array = new Uint16Array(32768);
  let indexCount = 0;
  let useUint32 = false;

  const xStart = options.x0 !== undefined ? Math.max(0, options.x0) : 0;
  const yStart = options.y0 !== undefined ? Math.max(0, options.y0) : 0;
  const zStart = options.z0 !== undefined ? Math.max(0, options.z0) : 0;
  const xEnd = options.x1 !== undefined ? Math.min(field.dimX - 1, options.x1) : field.dimX - 1;
  const yEnd = options.y1 !== undefined ? Math.min(field.dimY - 1, options.y1) : field.dimY - 1;
  const zEnd = options.z1 !== undefined ? Math.min(field.dimZ - 1, options.z1) : field.dimZ - 1;

  for (let x = xStart; x < xEnd; x++) {
    for (let y = yStart; y < yEnd; y++) {
      for (let z = zStart; z < zEnd; z++) {
        for (let c = 0; c < 8; c++) {
          const co = CORNER_OFFSET[c];
          const cx = x + co[0], cy = y + co[1], cz = z + co[2];
          if (cx < 0 || cx >= field.dimX || cy < 0 || cy >= field.dimY || cz < 0 || cz >= field.dimZ) {
            SCRATCH_D[c] = -1.0;
          } else {
            SCRATCH_D[c] = field.data[cx * dimYDimZ + cy * dimZ + cz];
          }
        }

        const tets = ((x + y + z) & 1) ? TET_TABLE_B : TET_TABLE_A;

        for (let ti = 0; ti < 5; ti++) {
          const tet = tets[ti];
          const d = SCRATCH_TET_D;
          d[0] = SCRATCH_D[tet[0]];
          d[1] = SCRATCH_D[tet[1]];
          d[2] = SCRATCH_D[tet[2]];
          d[3] = SCRATCH_D[tet[3]];

          let caseIdx = 0;
          for (let i = 0; i < 4; i++) {
            if (d[i] < iso) caseIdx |= (1 << i);
          }

          const triBase = caseIdx * 6;
          if (MT_TRI_TABLE[triBase] < 0) continue;

          const ev = SCRATCH_EDGE_VERTS;
          for (let e = 0; e < 6; e++) {
            const ec = TET_EDGE_CORNERS[e];
            const c0 = ec[0], c1 = ec[1];
            const inside0 = d[c0] >= iso;
            const inside1 = d[c1] >= iso;
            if (inside0 === inside1) continue;

            const cubeC0 = tet[c0], cubeC1 = tet[c1];
            const co0 = CORNER_OFFSET[cubeC0], co1 = CORNER_OFFSET[cubeC1];
            const p0x = (x + co0[0]) * vs + ox, p0y = (y + co0[1]) * vs + oy, p0z = (z + co0[2]) * vs + oz;
            const p1x = (x + co1[0]) * vs + ox, p1y = (y + co1[1]) * vs + oy, p1z = (z + co1[2]) * vs + oz;
            const d0 = d[c0], d1 = d[c1];

            let t: number;
            if (Math.abs(iso - d0) < 1e-10) t = 0;
            else if (Math.abs(iso - d1) < 1e-10) t = 1;
            else if (Math.abs(d0 - d1) < 1e-10) t = 0;
            else t = (iso - d0) / (d1 - d0);

            const eo = e * 3;
            ev[eo] = p0x + t * (p1x - p0x);
            ev[eo + 1] = p0y + t * (p1y - p0y);
            ev[eo + 2] = p0z + t * (p1z - p0z);
          }

          for (let t = 0; t < 6; t += 3) {
            const e0 = MT_TRI_TABLE[triBase + t];
            if (e0 < 0) break;
            const e1 = MT_TRI_TABLE[triBase + t + 1];
            const e2 = MT_TRI_TABLE[triBase + t + 2];

            const ev0o = e0 * 3, ev1o = e1 * 3, ev2o = e2 * 3;
            const v0x = ev[ev0o], v0y = ev[ev0o + 1], v0z = ev[ev0o + 2];
            const v1x = ev[ev1o], v1y = ev[ev1o + 1], v1z = ev[ev1o + 2];
            const v2x = ev[ev2o], v2y = ev[ev2o + 1], v2z = ev[ev2o + 2];

            const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
            const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
            else { nx = 0; ny = 1; nz = 0; }
            if (flipDown && ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

            const cx = (v0x + v1x + v2x) / 3;
            const cy = (v0y + v1y + v2y) / 3;
            const cz = (v0z + v1z + v2z) / 3;

            const col = colorFn ? colorFn(cx, cy, cz, nx, ny, nz, field) : [1, 1, 1] as [number, number, number];

            if (vertCount + 27 > verts.length) {
              verts = ensureCapacity(verts, vertCount + 27);
            }
            verts[vertCount++] = v0x; verts[vertCount++] = v0y; verts[vertCount++] = v0z;
            verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
            verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];
            verts[vertCount++] = v1x; verts[vertCount++] = v1y; verts[vertCount++] = v1z;
            verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
            verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];
            verts[vertCount++] = v2x; verts[vertCount++] = v2y; verts[vertCount++] = v2z;
            verts[vertCount++] = nx; verts[vertCount++] = ny; verts[vertCount++] = nz;
            verts[vertCount++] = col[0]; verts[vertCount++] = col[1]; verts[vertCount++] = col[2];

            const baseIdx = (vertCount - 27) / 9;

            if (!useUint32 && baseIdx + 2 > 65535) {
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
              indices32[indexCount++] = baseIdx;
              indices32[indexCount++] = baseIdx + 1;
              indices32[indexCount++] = baseIdx + 2;
            } else {
              if (indexCount + 3 > indices16.length) {
                indices16 = ensureCapacityU16(indices16, indexCount + 3);
              }
              indices16[indexCount++] = baseIdx;
              indices16[indexCount++] = baseIdx + 1;
              indices16[indexCount++] = baseIdx + 2;
            }
          }
        }
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
