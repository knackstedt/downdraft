import type { NavMesh } from "./navmesh.ts";
import type { Vec3 } from "./types.ts";

interface AStarNode {
  polyId: number;
  g: number;
  f: number;
  parent: AStarNode | null;
}

export class Pathfinder {
  private navMesh: NavMesh;

  constructor(navMesh: NavMesh) {
    this.navMesh = navMesh;
  }

  findPath(start: Vec3, end: Vec3): Vec3[] {
    const startPoly = this.navMesh.findClosestPoly(start);
    const endPoly = this.navMesh.findClosestPoly(end);

    if (startPoly < 0 || endPoly < 0) return [];
    if (startPoly === endPoly) return [start, end];

    const polyPath = this.aStar(startPoly, endPoly);
    if (polyPath.length === 0) return [];

    return this.funnelAlgorithm(start, end, polyPath);
  }

  private aStar(startPoly: number, endPoly: number): number[] {
    const open: AStarNode[] = [];
    const closed = new Set<number>();
    const allNodes = new Map<number, AStarNode>();

    const startNode: AStarNode = {
      polyId: startPoly,
      g: 0,
      f: 0,
      parent: null,
    };
    const endCenter = this.navMesh.getPolyCenter(endPoly);
    startNode.f = this.heuristic(this.navMesh.getPolyCenter(startPoly), endCenter);
    open.push(startNode);
    allNodes.set(startPoly, startNode);

    while (open.length > 0) {
      open.sort((a, b) => a.f - b.f);
      const current = open.shift()!;

      if (current.polyId === endPoly) {
        return this.reconstructPath(current);
      }

      closed.add(current.polyId);

      const neighbors = this.navMesh.getPolyNeighbors(current.polyId);
      for (const neighborId of neighbors) {
        if (closed.has(neighborId)) continue;

        const neighborCenter = this.navMesh.getPolyCenter(neighborId);
        const g = current.g + this.heuristic(
          this.navMesh.getPolyCenter(current.polyId),
          neighborCenter,
        );

        const existing = allNodes.get(neighborId);
        if (existing && g >= existing.g) continue;

        const h = this.heuristic(neighborCenter, endCenter);
        const node: AStarNode = {
          polyId: neighborId,
          g,
          f: g + h,
          parent: current,
        };
        allNodes.set(neighborId, node);

        const openIdx = open.findIndex((n) => n.polyId === neighborId);
        if (openIdx >= 0) {
          open[openIdx] = node;
        } else {
          open.push(node);
        }
      }
    }

    return [];
  }

  private reconstructPath(node: AStarNode): number[] {
    const path: number[] = [];
    let current: AStarNode | null = node;
    while (current) {
      path.unshift(current.polyId);
      current = current.parent;
    }
    return path;
  }

  private heuristic(a: Vec3, b: Vec3): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private funnelAlgorithm(start: Vec3, end: Vec3, polyPath: number[]): Vec3[] {
    if (polyPath.length < 2) return [start, end];

    const portals: { left: Vec3; right: Vec3 }[] = [];
    for (let i = 0; i < polyPath.length - 1; i++) {
      const portal = this.navMesh.getPortalEdge(polyPath[i], polyPath[i + 1]);
      if (portal) {
        portals.push({ left: portal.left, right: portal.right });
      } else {
        const center = this.navMesh.getPolyCenter(polyPath[i]);
        portals.push({ left: center, right: center });
      }
    }

    const path: Vec3[] = [start];
    let apex = start;
    let apexIndex = 0;
    let leftLeg = portals[0].left;
    let leftIndex = 0;
    let rightLeg = portals[0].right;
    let rightIndex = 0;

    for (let i = 1; i <= portals.length; i++) {
      if (i === portals.length) {
        if (!this.vecEqual(apex, end)) {
          path.push(end);
        }
        break;
      }

      const portal = portals[i];
      const newLeft = portal.left;
      const newRight = portal.right;

      if (this.tripleProduct(rightLeg, apex, newRight) >= 0) {
        if (this.tripleProduct(leftLeg, apex, newRight) > 0 || apexIndex === rightIndex) {
          rightLeg = newRight;
          rightIndex = i;
        } else {
          apex = leftLeg;
          apexIndex = leftIndex;
          if (!this.vecEqual(apex, path[path.length - 1])) {
            path.push(apex);
          }
          leftLeg = apex;
          leftIndex = apexIndex;
          rightLeg = apex;
          rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }

      if (this.tripleProduct(leftLeg, apex, newLeft) <= 0) {
        if (this.tripleProduct(rightLeg, apex, newLeft) < 0 || apexIndex === leftIndex) {
          leftLeg = newLeft;
          leftIndex = i;
        } else {
          apex = rightLeg;
          apexIndex = rightIndex;
          if (!this.vecEqual(apex, path[path.length - 1])) {
            path.push(apex);
          }
          leftLeg = apex;
          leftIndex = apexIndex;
          rightLeg = apex;
          rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
    }

    return path;
  }

  private tripleProduct(a: Vec3, b: Vec3, c: Vec3): number {
    const abx = b[0] - a[0];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acz = c[2] - a[2];
    return abx * acz - abz * acx;
  }

  private vecEqual(a: Vec3, b: Vec3): boolean {
    const eps = 0.0001;
    return Math.abs(a[0] - b[0]) < eps &&
           Math.abs(a[1] - b[1]) < eps &&
           Math.abs(a[2] - b[2]) < eps;
  }
}
