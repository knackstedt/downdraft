import type { NavMesh } from "./navmesh";
import type { Vec3 } from "./types";

export interface DebugLine {
  start: Vec3;
  end: Vec3;
  color: [number, number, number, number];
}

export interface DebugPolygon {
  vertices: Vec3[];
  color: [number, number, number, number];
}

export class NavMeshDebugViz {
  private navMesh: NavMesh;

  constructor(navMesh: NavMesh) {
    this.navMesh = navMesh;
  }

  getPolygonOutlines(): DebugLine[] {
    const lines: DebugLine[] = [];
    const color: [number, number, number, number] = [0, 1, 0, 0.5];

    this.navMesh.polygons.forEach((poly) => {
      const verts = poly.vertexIndices;
      for (let i = 0; i < verts.length; i++) {
        const v0 = this.navMesh.getVertex(verts[i]);
        const v1 = this.navMesh.getVertex(verts[(i + 1) % verts.length]);
        lines.push({ start: v0, end: v1, color });
      }
    });

    return lines;
  }

  getPortalEdges(): DebugLine[] {
    const lines: DebugLine[] = [];
    const color: [number, number, number, number] = [1, 1, 0, 0.8];
    const seen = new Set<string>();

    this.navMesh.polygons.forEach((poly) => {
      for (let _i = 0, _it = poly.portalEdges, _n = _it.length; _i < _n; _i++) { const pe = _it[_i];
        const key = `${Math.min(pe.fromPoly, pe.toPoly)}:${Math.max(pe.fromPoly, pe.toPoly)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({ start: pe.left, end: pe.right, color });
      }
    });

    return lines;
  }

  getPolyCenters(): Vec3[] {
    return this.navMesh.polygons.map((p) => p.centroid);
  }

  getAgentPath(path: Vec3[]): DebugLine[] {
    const lines: DebugLine[] = [];
    const color: [number, number, number, number] = [0, 0, 1, 0.9];
    for (let i = 0; i < path.length - 1; i++) {
      lines.push({ start: path[i], end: path[i + 1], color });
    }
    return lines;
  }

  getAllDebugData(): { lines: DebugLine[]; centers: Vec3[] } {
    return {
      lines: [...this.getPolygonOutlines(), ...this.getPortalEdges()],
      centers: this.getPolyCenters(),
    };
  }
}
