import type { HeightFieldSampler, NavMeshData, NavMeshGeneratorConfig, NavPoly, PortalEdge, Vec3 } from "./types";

interface WalkableCell {
  x: number;
  z: number;
  height: number;
  region: number;
  walkable: boolean;
}

export class NavMeshGenerator {
  private config: NavMeshGeneratorConfig;

  constructor(config: NavMeshGeneratorConfig) {
    this.config = config;
  }

  generate(sampler: HeightFieldSampler, minX: number, minZ: number, maxX: number, maxZ: number): NavMeshData {
    const cells = this.voxelize(sampler, minX, minZ, maxX, maxZ);
    this.partitionRegions(cells);
    const { polygons, vertices, vertexCount } = this.buildCellPolygons(cells, minX, minZ);
    const polysWithPortals = this.detectPortals(polygons, vertices);
    this.computeCentroidsAndArea(polysWithPortals, vertices);

    return {
      polygons: polysWithPortals,
      vertices,
      vertexCount,
    };
  }

  private voxelize(sampler: HeightFieldSampler, minX: number, minZ: number, maxX: number, maxZ: number): WalkableCell[][] {
    const cs = this.config.cellSize;
    const cols = Math.ceil((maxX - minX) / cs);
    const rows = Math.ceil((maxZ - minZ) / cs);
    const grid: WalkableCell[][] = [];

    for (let z = 0; z < rows; z++) {
      grid[z] = [];
      for (let x = 0; x < cols; x++) {
        const wx = minX + x * cs;
        const wz = minZ + z * cs;
        if (sampler.isWalkable(wx, wz)) {
          const h = sampler.sampleHeight(wx, wz);
          grid[z][x] = { x, z, height: h, region: -1, walkable: true };
        } else {
          grid[z][x] = { x, z, height: 0, region: -1, walkable: false };
        }
      }
    }

    return grid;
  }

  private partitionRegions(cells: WalkableCell[][]): number {
    let nextRegion = 0;
    const rows = cells.length;
    const cols = rows > 0 ? cells[0].length : 0;
    const minSize = this.config.regionMinSize;
    const visited: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        if (!cells[z][x].walkable) visited[z][x] = true;
      }
    }

    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        if (visited[z][x] || !cells[z][x].walkable || cells[z][x].region >= 0) continue;

        const flood: WalkableCell[] = [];
        const queue: [number, number][] = [[x, z]];
        visited[z][x] = true;

        while (queue.length > 0) {
          const [cx, cz] = queue.shift()!;
          const cell = cells[cz][cx];
          if (cell.region >= 0) continue;

          cell.region = nextRegion;
          flood.push(cell);

          const neighbors: [number, number][] = [
            [cx + 1, cz], [cx - 1, cz],
            [cx, cz + 1], [cx, cz - 1],
          ];

          for (const [nx, nz] of neighbors) {
            if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
            if (visited[nz][nx]) continue;
            const nc = cells[nz][nx];
            if (!nc.walkable || nc.region >= 0) continue;

            const heightDiff = Math.abs(nc.height - cell.height);
            if (heightDiff > this.config.maxStep) continue;

            visited[nz][nx] = true;
            queue.push([nx, nz]);
          }
        }

        if (flood.length < minSize) {
          for (const c of flood) {
            c.region = -1;
          }
        } else {
          nextRegion++;
        }
      }
    }

    return nextRegion;
  }

  private extractContours(cells: WalkableCell[][], _regionCount: number): Map<number, Vec3[]> {
    const rows = cells.length;
    const cols = rows > 0 ? cells[0].length : 0;
    const cs = this.config.cellSize;
    const contours = new Map<number, Vec3[]>();

    const regionEdges = new Map<number, [Vec3, Vec3][]>();

    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const cell = cells[z][x];
        if (cell.region < 0) continue;

        const h = cell.height;
        const wx = x * cs;
        const wz = z * cs;
        const corners: Vec3[] = [
          [wx, h, wz],
          [wx + cs, h, wz],
          [wx + cs, h, wz + cs],
          [wx, h, wz + cs],
        ];

        const neighbors: [number, number][] = [
          [x, z - 1], [x + 1, z], [x, z + 1], [x - 1, z],
        ];

        for (let d = 0; d < 4; d++) {
          const [nx, nz] = neighbors[d];
          const isBoundary = nx < 0 || nx >= cols || nz < 0 || nz >= rows || cells[nz][nx].region !== cell.region;
          if (!isBoundary) continue;

          if (!regionEdges.has(cell.region)) {
            regionEdges.set(cell.region, []);
          }
          const edges = regionEdges.get(cell.region)!;
          const v0 = corners[d];
          const v1 = corners[(d + 1) % 4];
          edges.push([v0, v1]);
        }
      }
    }

    for (const [region, edges] of regionEdges) {
      const contour = this.chainEdges(edges);
      if (contour.length >= 3) {
        contours.set(region, this.simplifyContour(contour));
      }
    }

    return contours;
  }

  private chainEdges(edges: [Vec3, Vec3][]): Vec3[] {
    if (edges.length === 0) return [];

    const used = new Array(edges.length).fill(false);
    const contour: Vec3[] = [edges[0][0]];
    let current = edges[0][1];
    contour.push(current);
    used[0] = true;
    let count = 1;

    while (count < edges.length) {
      let found = false;
      for (let i = 0; i < edges.length; i++) {
        if (used[i]) continue;
        if (this.vecClose(edges[i][0], current)) {
          current = edges[i][1];
          used[i] = true;
          count++;
          found = true;
          break;
        }
        if (this.vecClose(edges[i][1], current)) {
          current = edges[i][0];
          used[i] = true;
          count++;
          found = true;
          break;
        }
      }
      if (!found) break;
      if (!this.vecClose(current, contour[0])) {
        contour.push(current);
      }
    }

    if (contour.length > 1 && this.vecClose(contour[contour.length - 1], contour[0])) {
      contour.pop();
    }
    return contour;
  }

  private vecClose(a: Vec3, b: Vec3): boolean {
    const eps = 0.001;
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[2] - b[2]) < eps;
  }

  private simplifyContour(contour: Vec3[], epsilon: number = 0.1): Vec3[] {
    if (contour.length <= 3) return contour;

    const result: Vec3[] = [contour[0]];
    for (let i = 1; i < contour.length - 1; i++) {
      const prev = result[result.length - 1];
      const curr = contour[i];
      const next = contour[i + 1];

      const dx1 = curr[0] - prev[0];
      const dz1 = curr[2] - prev[2];
      const dx2 = next[0] - curr[0];
      const dz2 = next[2] - curr[2];

      const cross = dx1 * dz2 - dz1 * dx2;
      const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1);
      const len2 = Math.sqrt(dx2 * dx2 + dz2 * dz2);
      if (len1 < epsilon || len2 < epsilon) continue;

      const angle = Math.abs(Math.atan2(cross, dx1 * dx2 + dz1 * dz2));
      if (angle > 0.05) {
        result.push(curr);
      }
    }
    result.push(contour[contour.length - 1]);
    return result;
  }

  private buildCellPolygons(cells: WalkableCell[][], originX: number, originZ: number): {
    polygons: NavPoly[];
    vertices: Float32Array;
    vertexCount: number;
  } {
    const cs = this.config.cellSize;
    const rows = cells.length;
    const cols = rows > 0 ? cells[0].length : 0;
    const vertexList: number[] = [];
    const vertexMap: Map<string, number> = new Map();
    const polygons: NavPoly[] = [];

    const polyGrid: (number | -1)[][] = Array.from({ length: rows }, () => new Array(cols).fill(-1));

    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const cell = cells[z][x];
        if (cell.region < 0 || !cell.walkable) continue;

        const h = cell.height;
        const wx = originX + x * cs;
        const wz = originZ + z * cs;
        const corners: Vec3[] = [
          [wx, h, wz],
          [wx + cs, h, wz],
          [wx + cs, h, wz + cs],
          [wx, h, wz + cs],
        ];

        const vertexIndices: number[] = [];
        for (const v of corners) {
          const key = `${v[0].toFixed(3)}:${v[1].toFixed(3)}:${v[2].toFixed(3)}`;
          let idx = vertexMap.get(key);
          if (idx === undefined) {
            idx = vertexList.length / 3;
            vertexList.push(v[0], v[1], v[2]);
            vertexMap.set(key, idx);
          }
          vertexIndices.push(idx);
        }

        const polyId = polygons.length;
        polyGrid[z][x] = polyId;
        polygons.push({
          id: polyId,
          vertexIndices,
          neighborPolys: [],
          portalEdges: [],
          centroid: [0, 0, 0],
          area: 0,
          region: cell.region,
        });
      }
    }

    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const polyId = polyGrid[z][x];
        if (polyId < 0) continue;

        const neighbors: [number, number][] = [[x + 1, z], [x, z + 1]];
        for (const [nx, nz] of neighbors) {
          if (nx >= cols || nz >= rows) continue;
          const neighborId = polyGrid[nz][nx];
          if (neighborId < 0) continue;
          polygons[polyId].neighborPolys.push(neighborId);
          polygons[neighborId].neighborPolys.push(polyId);
        }
      }
    }

    const vertices = new Float32Array(vertexList);
    return { polygons, vertices, vertexCount: vertexList.length / 3 };
  }

  private detectPortals(polygons: NavPoly[], vertices: Float32Array): NavPoly[] {
    for (let i = 0; i < polygons.length; i++) {
      for (const j of polygons[i].neighborPolys) {
        if (j <= i) continue;
        const shared = this.findSharedEdge(polygons[i], polygons[j], vertices);
        if (shared) {
          const portal: PortalEdge = {
            fromPoly: i,
            toPoly: j,
            left: shared[0],
            right: shared[1],
          };
          polygons[i].portalEdges.push(portal);

          const reversePortal: PortalEdge = {
            fromPoly: j,
            toPoly: i,
            left: shared[1],
            right: shared[0],
          };
          polygons[j].portalEdges.push(reversePortal);
        }
      }
    }
    return polygons;
  }

  private findSharedEdge(a: NavPoly, b: NavPoly, vertices: Float32Array): [Vec3, Vec3] | null {
    const vertsA = a.vertexIndices;
    const vertsB = b.vertexIndices;

    for (let i = 0; i < vertsA.length; i++) {
      const ai1 = vertsA[i];
      const ai2 = vertsA[(i + 1) % vertsA.length];
      for (let j = 0; j < vertsB.length; j++) {
        const bj1 = vertsB[j];
        const bj2 = vertsB[(j + 1) % vertsB.length];

        if (this.vertexEqual(ai1, bj2, vertices) && this.vertexEqual(ai2, bj1, vertices)) {
          return [
            [vertices[ai1 * 3], vertices[ai1 * 3 + 1], vertices[ai1 * 3 + 2]],
            [vertices[ai2 * 3], vertices[ai2 * 3 + 1], vertices[ai2 * 3 + 2]],
          ];
        }
      }
    }
    return null;
  }

  private vertexEqual(a: number, b: number, vertices: Float32Array): boolean {
    const eps = 0.001;
    return Math.abs(vertices[a * 3] - vertices[b * 3]) < eps &&
           Math.abs(vertices[a * 3 + 1] - vertices[b * 3 + 1]) < eps &&
           Math.abs(vertices[a * 3 + 2] - vertices[b * 3 + 2]) < eps;
  }

  private computeCentroidsAndArea(polygons: NavPoly[], vertices: Float32Array): void {
    for (const poly of polygons) {
      let cx = 0, cy = 0, cz = 0;
      let area = 0;
      const verts = poly.vertexIndices;
      const n = verts.length;

      for (let i = 0; i < n; i++) {
        const vi = verts[i];
        const vj = verts[(i + 1) % n];
        const xi = vertices[vi * 3];
        const zi = vertices[vi * 3 + 2];
        const xj = vertices[vj * 3];
        const zj = vertices[vj * 3 + 2];
        const cross = xi * zj - xj * zi;
        area += cross;
        cx += (xi + xj) * cross;
        cz += (zi + zj) * cross;
        cy += vertices[vi * 3 + 1];
      }

      area = Math.abs(area) * 0.5;
      if (area > 0.0001) {
        poly.centroid = [cx / (6 * area), cy / n, cz / (6 * area)];
      } else {
        for (let i = 0; i < n; i++) {
          cx += vertices[verts[i] * 3];
          cz += vertices[verts[i] * 3 + 2];
        }
        poly.centroid = [cx / n, cy / n, cz / n];
      }
      poly.area = area;
    }
  }
}
