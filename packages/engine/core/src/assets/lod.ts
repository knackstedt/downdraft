import type { MeshData } from "../mesh/builder";

export interface LODLevel {
  mesh: MeshData;
  screenSpaceError: number;
  distance: number;
}

export interface LODConfig {
  levels: LODLevel[];
  autoGenerate: boolean;
  maxReduction: number;
}

type Quadric = { a: number; b: number; c: number; d: number };

function addQuadric(q1: Quadric, q2: Quadric): Quadric {
  return { a: q1.a + q2.a, b: q1.b + q2.b, c: q1.c + q2.c, d: q1.d + q2.d };
}

function quadricError(q: Quadric, x: number, y: number, z: number): number {
  return q.a * x * x + q.b * y * y + q.c * z * z + 2 * (q.a * y * z + q.b * x * z + q.c * x * y) + q.d * x + q.d * y + q.d * z;
}

function quadricFromPlane(a: number, b: number, c: number, d: number): Quadric {
  return { a: a * a, b: b * b, c: c * c, d: d };
}

function quadricFromTriangle(
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
): Quadric {
  const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2];
  const fx = p2[0] - p0[0], fy = p2[1] - p0[1], fz = p2[2] - p0[2];
  const nx = ey * fz - ez * fy;
  const ny = ez * fx - ex * fz;
  const nz = ex * fy - ey * fx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const a = nx / len, b = ny / len, c = nz / len;
  const d = -(a * p0[0] + b * p0[1] + c * p0[2]);
  return quadricFromPlane(a, b, c, d);
}

export class LODGenerator {
  generateLOD(mesh: MeshData, targetReduction: number): MeshData {
    if (targetReduction <= 0 || targetReduction >= 1) return mesh;

    const indices = mesh.indices;
    const vertices = mesh.vertices;
    const indexCount = indices.length;
    const targetIndexCount = Math.floor(indexCount * (1 - targetReduction));

    if (targetIndexCount >= indexCount) return mesh;

    const stride = mesh.layout.stride / 4;
    const edgeCollapses = this.computeQEMEdgeCollapses(vertices, indices, targetIndexCount, stride);
    const { newVertices, newIndices } = this.applyEdgeCollapses(vertices, indices, edgeCollapses, stride);

    return {
      vertices: newVertices,
      indices: newIndices,
      layout: mesh.layout,
      vertexCount: newVertices.length / stride,
      indexCount: newIndices.length,
    };
  }

  generateLODLevels(mesh: MeshData, levels: number): LODLevel[] {
    const result: LODLevel[] = [];
    const baseReduction = 0.5;

    result.push({
      mesh,
      screenSpaceError: 0,
      distance: 0,
    });

    for (let i = 1; i < levels; i++) {
      const reduction = Math.min(baseReduction * i, 0.9);
      const lodMesh = this.generateLOD(mesh, reduction);
      result.push({
        mesh: lodMesh,
        screenSpaceError: i * 2,
        distance: i * 20,
      });
    }

    return result;
  }

  selectLOD(levels: LODLevel[], distance: number, screenSize: number): LODLevel {
    let selected = levels[0];
    levels.forEach((level) => {
      if (distance >= level.distance) {
        const projectedSize = screenSize / Math.max(distance, 0.1);
        if (projectedSize > level.screenSpaceError || level === levels[levels.length - 1]) {
          selected = level;
        }
      }
    });
    return selected;
  }

  private computeQEMEdgeCollapses(
    vertices: Float32Array,
    indices: Uint16Array | Uint32Array,
    targetIndexCount: number,
    stride: number,
  ): Array<{ from: number; to: number; cost: number }> {
    const vertexCount = vertices.length / stride;
    const quadrics: Quadric[] = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) quadrics[i] = { a: 0, b: 0, c: 0, d: 0 };

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const p0: [number, number, number] = [vertices[a * stride], vertices[a * stride + 1], vertices[a * stride + 2]];
      const p1: [number, number, number] = [vertices[b * stride], vertices[b * stride + 1], vertices[b * stride + 2]];
      const p2: [number, number, number] = [vertices[c * stride], vertices[c * stride + 1], vertices[c * stride + 2]];
      const q = quadricFromTriangle(p0, p1, p2);
      quadrics[a] = addQuadric(quadrics[a], q);
      quadrics[b] = addQuadric(quadrics[b], q);
      quadrics[c] = addQuadric(quadrics[c], q);
    }

    const edgeMap = new Map<string, { from: number; to: number; cost: number }>();
    for (let i = 0; i < indices.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const a = indices[i + j];
        const b = indices[i + (j + 1) % 3];
        if (a > b) continue;
        const key = `${a}:${b}`;
        if (!edgeMap.has(key)) {
          const combined = addQuadric(quadrics[a], quadrics[b]);
          const mx = (vertices[a * stride] + vertices[b * stride]) / 2;
          const my = (vertices[a * stride + 1] + vertices[b * stride + 1]) / 2;
          const mz = (vertices[a * stride + 2] + vertices[b * stride + 2]) / 2;
          const cost = quadricError(combined, mx, my, mz);
          edgeMap.set(key, { from: a, to: b, cost });
        }
      }
    }

    const edges = [...edgeMap.values()].sort((a, b) => a.cost - b.cost);
    const collapseCount = Math.floor((indices.length - targetIndexCount) / 3);
    return edges.slice(0, collapseCount);
  }

  private applyEdgeCollapses(
    vertices: Float32Array,
    indices: Uint16Array | Uint32Array,
    collapses: Array<{ from: number; to: number }>,
    stride: number,
  ): { newVertices: Float32Array; newIndices: Uint32Array } {
    const remap = new Map<number, number>();
    collapses.forEach((c) => {
      remap.set(c.from, c.to);
    });

    const newIndices: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      let a = indices[i];
      let b = indices[i + 1];
      let c = indices[i + 2];

      while (remap.has(a)) a = remap.get(a)!;
      while (remap.has(b)) b = remap.get(b)!;
      while (remap.has(c)) c = remap.get(c)!;

      if (a !== b && b !== c && a !== c) {
        newIndices.push(a, b, c);
      }
    }

    const usedVertices = new Set<number>();
    newIndices.forEach((idx) => { usedVertices.add(idx);; });

    const compactedVertices: number[] = [];
    const vertexRemap = new Map<number, number>();
    let compactIdx = 0;
    for (let i = 0; i < vertices.length / stride; i++) {
      if (usedVertices.has(i)) {
        for (let j = 0; j < stride; j++) {
          compactedVertices.push(vertices[i * stride + j]);
        }
        vertexRemap.set(i, compactIdx);
        compactIdx++;
      }
    }

    const compactedIndices = newIndices.map(idx => vertexRemap.get(idx)!);

    return {
      newVertices: new Float32Array(compactedVertices),
      newIndices: new Uint32Array(compactedIndices),
    };
  }
}
