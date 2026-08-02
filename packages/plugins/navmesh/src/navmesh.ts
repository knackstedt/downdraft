import type { NavPoly, PortalEdge, Vec3, NavMeshData } from "./types.ts";

interface SpatialCell {
  polys: number[];
}

export class NavMesh {
  polygons: NavPoly[] = [];
  vertices: Float32Array = new Float32Array(0);
  vertexCount = 0;

  private spatialGrid: Map<string, SpatialCell> = new Map();
  private spatialCellSize: number;

  constructor(spatialCellSize: number = 4) {
    this.spatialCellSize = spatialCellSize;
  }

  build(data: NavMeshData): void {
    this.polygons = data.polygons;
    this.vertices = data.vertices;
    this.vertexCount = data.vertexCount;
    this.rebuildSpatialIndex();
  }

  clear(): void {
    this.polygons = [];
    this.vertices = new Float32Array(0);
    this.vertexCount = 0;
    this.spatialGrid.clear();
  }

  getPolyCount(): number {
    return this.polygons.length;
  }

  findClosestPoly(point: Vec3): number {
    let bestPoly = -1;
    let bestDistSq = Infinity;

    const candidates = this.getPolysInRadius(point, this.spatialCellSize * 2);
    for (const polyId of candidates) {
      if (this.isPointInPoly(polyId, point)) {
        return polyId;
      }
      const center = this.polygons[polyId].centroid;
      const dx = center[0] - point[0];
      const dy = center[1] - point[1];
      const dz = center[2] - point[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPoly = polyId;
      }
    }

    if (bestPoly >= 0) return bestPoly;

    for (let i = 0; i < this.polygons.length; i++) {
      const center = this.polygons[i].centroid;
      const dx = center[0] - point[0];
      const dy = center[1] - point[1];
      const dz = center[2] - point[2];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPoly = i;
      }
    }
    return bestPoly;
  }

  getPolyCenter(polyId: number): Vec3 {
    return this.polygons[polyId].centroid;
  }

  getPolyNeighbors(polyId: number): number[] {
    return this.polygons[polyId].neighborPolys;
  }

  isPointInPoly(polyId: number, point: Vec3): boolean {
    const poly = this.polygons[polyId];
    if (!poly) return false;

    const verts = poly.vertexIndices;
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const vi = verts[i];
      const vj = verts[j];
      const xi = this.vertices[vi * 3];
      const zi = this.vertices[vi * 3 + 2];
      const xj = this.vertices[vj * 3];
      const zj = this.vertices[vj * 3 + 2];

      if (((zi > point[2]) !== (zj > point[2])) &&
          (point[0] < (xj - xi) * (point[2] - zi) / (zj - zi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  getPortalEdge(fromPoly: number, toPoly: number): PortalEdge | null {
    const poly = this.polygons[fromPoly];
    if (!poly) return null;
    for (const pe of poly.portalEdges) {
      if (pe.toPoly === toPoly) return pe;
    }
    return null;
  }

  getVertex(index: number): Vec3 {
    return [
      this.vertices[index * 3],
      this.vertices[index * 3 + 1],
      this.vertices[index * 3 + 2],
    ];
  }

  getPolysInRadius(center: Vec3, radius: number): number[] {
    const minCx = Math.floor((center[0] - radius) / this.spatialCellSize);
    const maxCx = Math.floor((center[0] + radius) / this.spatialCellSize);
    const minCz = Math.floor((center[2] - radius) / this.spatialCellSize);
    const maxCz = Math.floor((center[2] + radius) / this.spatialCellSize);

    const result: number[] = [];
    const seen = new Set<number>();
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const cell = this.spatialGrid.get(`${cx}:${cz}`);
        if (!cell) continue;
        for (const pid of cell.polys) {
          if (!seen.has(pid)) {
            seen.add(pid);
            result.push(pid);
          }
        }
      }
    }
    return result;
  }

  private rebuildSpatialIndex(): void {
    this.spatialGrid.clear();
    for (let i = 0; i < this.polygons.length; i++) {
      const poly = this.polygons[i];
      const c = poly.centroid;
      const cx = Math.floor(c[0] / this.spatialCellSize);
      const cz = Math.floor(c[2] / this.spatialCellSize);
      const key = `${cx}:${cz}`;
      let cell = this.spatialGrid.get(key);
      if (!cell) {
        cell = { polys: [] };
        this.spatialGrid.set(key, cell);
      }
      cell.polys.push(i);
    }
  }
}
