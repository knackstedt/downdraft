import { EDGE_VERTS, MC_EDGE_TABLE, MC_TRI_TABLE } from "./tables.ts";

export type DensityField = (x: number, y: number, z: number) => number;

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
