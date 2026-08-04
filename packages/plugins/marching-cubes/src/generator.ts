import { EDGE_VERTS, MC_EDGE_TABLE, MC_TRI_TABLE } from "./tables";

export type DensityField = (x: number, y: number, z: number) => number;

export interface VoxelField {
  data: Float32Array;
  dimX: number;
  dimY: number;
  dimZ: number;
  voxelSize: number;
  isoLevel: number;
  originX: number;
  originY: number;
  originZ: number;
  radius: number;
}

export interface ExtractedMesh {
  verts: Float32Array;
  indices: Uint16Array | Uint32Array;
  useUint32: boolean;
}

export interface MCVertex {
  position: [number, number, number];
  normal: [number, number, number];
}

export interface MCMesh {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export interface MCChunkConfig {
  chunkSize: number;
  isoLevel: number;
  scale: number;
}

export const DEFAULT_MC_CONFIG: MCChunkConfig = {
  chunkSize: 32,
  isoLevel: 0.5,
  scale: 1.0,
};

export function generateChunk(
  originX: number,
  originY: number,
  originZ: number,
  densityField: DensityField,
  config: MCChunkConfig,
): MCMesh {
  const size = config.chunkSize;
  const isoLevel = config.isoLevel;
  const scale = config.scale;
  const verts: number[] = [];
  const norms: number[] = [];
  const indices: number[] = [];

  const corners = new Float32Array(8);
  const cornerPos: [number, number, number][] = [];

  for (let z = 0; z < size - 1; z++) {
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const wx = originX + x * scale;
        const wy = originY + y * scale;
        const wz = originZ + z * scale;

        cornerPos[0] = [wx, wy, wz];
        cornerPos[1] = [wx + scale, wy, wz];
        cornerPos[2] = [wx + scale, wy, wz + scale];
        cornerPos[3] = [wx, wy, wz + scale];
        cornerPos[4] = [wx, wy + scale, wz];
        cornerPos[5] = [wx + scale, wy + scale, wz];
        cornerPos[6] = [wx + scale, wy + scale, wz + scale];
        cornerPos[7] = [wx, wy + scale, wz + scale];

        for (let i = 0; i < 8; i++) {
          corners[i] = densityField(cornerPos[i][0], cornerPos[i][1], cornerPos[i][2]);
        }

        let cubeIndex = 0;
        for (let i = 0; i < 8; i++) {
          if (corners[i] < isoLevel) cubeIndex |= (1 << i);
        }

        if (cubeIndex === 0 || cubeIndex === 255) continue;

        const edges = MC_EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        const edgeVerts: ([number, number, number] | null)[] = new Array(12).fill(null);

        for (let i = 0; i < 12; i++) {
          if (edges & (1 << i)) {
            const [a, b] = EDGE_VERTS[i];
            const va = corners[a];
            const vb = corners[b];
            const t = (isoLevel - va) / (vb - va);
            const pa = cornerPos[a];
            const pb = cornerPos[b];
            edgeVerts[i] = [
              pa[0] + t * (pb[0] - pa[0]),
              pa[1] + t * (pb[1] - pa[1]),
              pa[2] + t * (pb[2] - pa[2]),
            ];
          }
        }

        const triOffset = cubeIndex * 16;
        for (let i = 0; i < 16; i += 3) {
          const e0 = MC_TRI_TABLE[triOffset + i];
          if (e0 < 0) break;
          const e1 = MC_TRI_TABLE[triOffset + i + 1];
          const e2 = MC_TRI_TABLE[triOffset + i + 2];

          const v0 = edgeVerts[e0];
          const v1 = edgeVerts[e1];
          const v2 = edgeVerts[e2];
          if (!v0 || !v1 || !v2) continue;

          const baseIdx = verts.length / 3;
          verts.push(v0[0], v0[1], v0[2]);
          verts.push(v1[0], v1[1], v1[2]);
          verts.push(v2[0], v2[1], v2[2]);

          const ex1 = v1[0] - v0[0];
          const ey1 = v1[1] - v0[1];
          const ez1 = v1[2] - v0[2];
          const ex2 = v2[0] - v0[0];
          const ey2 = v2[1] - v0[1];
          const ez2 = v2[2] - v0[2];
          let nx = ey1 * ez2 - ez1 * ey2;
          let ny = ez1 * ex2 - ex1 * ez2;
          let nz = ex1 * ey2 - ey1 * ex2;
          const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen > 1e-9) {
            nx /= nlen; ny /= nlen; nz /= nlen;
          } else {
            nx = 0; ny = 1; nz = 0;
          }

          norms.push(nx, ny, nz);
          norms.push(nx, ny, nz);
          norms.push(nx, ny, nz);

          indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
        }
      }
    }
  }

  return {
    vertices: new Float32Array(verts),
    normals: new Float32Array(norms),
    indices: new Uint32Array(indices),
    vertexCount: verts.length / 3,
    indexCount: indices.length,
  };
}

export function defaultDensityField(
  x: number,
  y: number,
  z: number,
  maxHeight: number = 20,
  noiseScale: number = 0.05,
): number {
  const height = y / maxHeight;
  const noise = simpleNoise(x * noiseScale, y * noiseScale, z * noiseScale);
  return height - noise;
}

function simpleNoise(x: number, y: number, z: number): number {
  const a = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  const b = Math.sin(x * 4.1231 + y * 12.7891 + z * 93.985) * 23421.6312;
  const c = Math.sin(x * 8.7543 + y * 45.1234 + z * 73.456) * 17909.231;
  return ((a - Math.floor(a)) + (b - Math.floor(b)) + (c - Math.floor(c))) / 3;
}

// ============================================================================
// Full-featured mesh extraction — VoxelField-based with sub-region, coloring,
// normal flipping, typed-array scratch buffers, and Uint16/Uint32 index support.
// ============================================================================

const CORNER_OFFSET = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
];

const SCRATCH_D = new Float32Array(8);
const SCRATCH_EDGE_VERTS = new Float32Array(12 * 3);

function ensureCapacity(arr: Float32Array, needed: number): Float32Array {
  if (arr.length >= needed) return arr;
  let newLen = arr.length * 2;
  while (newLen < needed) newLen *= 2;
  const newArr = new Float32Array(newLen);
  newArr.set(arr);
  return newArr;
}

function ensureCapacityU32(arr: Uint32Array, needed: number): Uint32Array {
  if (arr.length >= needed) return arr;
  let newLen = arr.length * 2;
  while (newLen < needed) newLen *= 2;
  const newArr = new Uint32Array(newLen);
  newArr.set(arr);
  return newArr;
}

function ensureCapacityU16(arr: Uint16Array, needed: number): Uint16Array {
  if (arr.length >= needed) return arr;
  let newLen = arr.length * 2;
  while (newLen < needed) newLen *= 2;
  const newArr = new Uint16Array(newLen);
  newArr.set(arr);
  return newArr;
}

export type MeshColorFn = (
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number,
  field: VoxelField,
) => [number, number, number];

export interface ExtractMeshOptions {
  x0?: number; y0?: number; z0?: number;
  x1?: number; y1?: number; z1?: number;
  colorFn?: MeshColorFn;
  flipDownNormals?: boolean;
}

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

  let verts: Float32Array = new Float32Array(65536);
  let vertCount = 0;
  let indices32: Uint32Array = new Uint32Array(32768);
  let indices16: Uint16Array = new Uint16Array(32768);
  let indexCount = 0;
  let useUint32 = false;

  const d = SCRATCH_D;
  const edgeVerts = SCRATCH_EDGE_VERTS;

  const xStart = options.x0 !== undefined ? Math.max(0, options.x0) : 0;
  const yStart = options.y0 !== undefined ? Math.max(0, options.y0) : 0;
  const zStart = options.z0 !== undefined ? Math.max(0, options.z0) : 0;
  const xEnd = options.x1 !== undefined ? Math.min(field.dimX - 1, options.x1) : field.dimX - 1;
  const yEnd = options.y1 !== undefined ? Math.min(field.dimY - 1, options.y1) : field.dimY - 1;
  const zEnd = options.z1 !== undefined ? Math.min(field.dimZ - 1, options.z1) : field.dimZ - 1;

  for (let x = xStart; x < xEnd; x++) {
    for (let y = yStart; y < yEnd; y++) {
      for (let z = zStart; z < zEnd; z++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const co = CORNER_OFFSET[c];
          const cx = x + co[0], cy = y + co[1], cz = z + co[2];
          let val: number;
          if (cx < 0 || cx >= field.dimX || cy < 0 || cy >= field.dimY || cz < 0 || cz >= field.dimZ) {
            val = -1.0;
          } else {
            val = field.data[cx * dimYDimZ + cy * dimZ + cz];
          }
          d[c] = val;
          if (val < iso) cubeIndex |= (1 << c);
        }

        const edges = MC_EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const conn = EDGE_VERTS[e];
          const c1 = conn[0], c2 = conn[1];
          const co1 = CORNER_OFFSET[c1];
          const co2 = CORNER_OFFSET[c2];

          const p1x = (x + co1[0]) * vs + ox, p1y = (y + co1[1]) * vs + oy, p1z = (z + co1[2]) * vs + oz;
          const p2x = (x + co2[0]) * vs + ox, p2y = (y + co2[1]) * vs + oy, p2z = (z + co2[2]) * vs + oz;
          const d1 = d[c1], d2 = d[c2];

          let ex: number, ey: number, ez: number;
          if (Math.abs(iso - d1) < 1e-10) {
            ex = p1x; ey = p1y; ez = p1z;
          } else if (Math.abs(iso - d2) < 1e-10) {
            ex = p2x; ey = p2y; ez = p2z;
          } else if (Math.abs(d1 - d2) < 1e-10) {
            ex = p1x; ey = p1y; ez = p1z;
          } else {
            const t = (iso - d1) / (d2 - d1);
            ex = p1x + t * (p2x - p1x);
            ey = p1y + t * (p2y - p1y);
            ez = p1z + t * (p2z - p1z);
          }
          const eo = e * 3;
          edgeVerts[eo] = ex;
          edgeVerts[eo + 1] = ey;
          edgeVerts[eo + 2] = ez;
        }

        const triBase = cubeIndex * 16;
        for (let t = 0; t < 15; t += 3) {
          const e0 = MC_TRI_TABLE[triBase + t];
          if (e0 < 0) break;
          const e1 = MC_TRI_TABLE[triBase + t + 1];
          const e2 = MC_TRI_TABLE[triBase + t + 2];

          const ev0o = e0 * 3, ev1o = e1 * 3, ev2o = e2 * 3;
          const v0x = edgeVerts[ev0o], v0y = edgeVerts[ev0o + 1], v0z = edgeVerts[ev0o + 2];
          const v1x = edgeVerts[ev1o], v1y = edgeVerts[ev1o + 1], v1z = edgeVerts[ev1o + 2];
          const v2x = edgeVerts[ev2o], v2y = edgeVerts[ev2o + 1], v2z = edgeVerts[ev2o + 2];

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
