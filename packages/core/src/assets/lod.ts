import type { MeshData } from "../mesh/builder.ts";

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

export class LODGenerator {
  generateLOD(mesh: MeshData, targetReduction: number): MeshData {
    if (targetReduction <= 0 || targetReduction >= 1) return mesh;

    const indices = mesh.indices;
    const vertices = mesh.vertices;
    const indexCount = indices.length;
    const targetIndexCount = Math.floor(indexCount * (1 - targetReduction));

    if (targetIndexCount >= indexCount) return mesh;

    const edgeCollapse = this.computeEdgeCollapses(vertices, indices, targetIndexCount);
    const { newVertices, newIndices } = this.applyEdgeCollapses(vertices, indices, edgeCollapse);

    return {
      vertices: newVertices,
      indices: newIndices,
      layout: mesh.layout,
      vertexCount: mesh.vertexCount,
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
    for (const level of levels) {
      if (distance >= level.distance) {
        const projectedSize = screenSize / Math.max(distance, 0.1);
        if (projectedSize > level.screenSpaceError || level === levels[levels.length - 1]) {
          selected = level;
        }
      }
    }
    return selected;
  }

  private computeEdgeCollapses(
    vertices: Float32Array,
    indices: Uint16Array | Uint32Array,
    targetIndexCount: number,
  ): Array<{ from: number; to: number; cost: number }> {
    const edgeMap = new Map<string, { from: number; to: number; cost: number }>();

    for (let i = 0; i < indices.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const a = indices[i + j];
        const b = indices[i + (j + 1) % 3];
        if (a > b) continue;
        const key = `${a}:${b}`;
        if (!edgeMap.has(key)) {
          const cost = this.edgeCost(vertices, a, b);
          edgeMap.set(key, { from: a, to: b, cost });
        }
      }
    }

    const edges = [...edgeMap.values()].sort((a, b) => a.cost - b.cost);
    const collapseCount = Math.floor((indices.length - targetIndexCount) / 3);
    return edges.slice(0, collapseCount);
  }

  private edgeCost(vertices: Float32Array, a: number, b: number): number {
    const stride = 8;
    const ax = vertices[a * stride], ay = vertices[a * stride + 1], az = vertices[a * stride + 2];
    const bx = vertices[b * stride], by = vertices[b * stride + 1], bz = vertices[b * stride + 2];
    const dx = ax - bx, dy = ay - by, dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private applyEdgeCollapses(
    vertices: Float32Array,
    indices: Uint16Array | Uint32Array,
    collapses: Array<{ from: number; to: number }>,
  ): { newVertices: Float32Array; newIndices: Uint32Array } {
    const remap = new Map<number, number>();
    for (const c of collapses) {
      remap.set(c.from, c.to);
    }

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

    return {
      newVertices: vertices,
      newIndices: new Uint32Array(newIndices),
    };
  }
}
