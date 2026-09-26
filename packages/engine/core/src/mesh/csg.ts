import type { MeshData } from "./builder";
import type { VertexLayout } from "./vertex-layout";

export type Vec3 = [number, number, number];

export interface CSGPolygon {
  vertices: Vec3[];
  normal: Vec3;
  shared: number;
}

export type CSGOperation = "union" | "subtract" | "intersect";

const EPS = 1e-6;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function normalize(a: Vec3): Vec3 {
  const len = Math.sqrt(dot(a, a)) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

interface BSPPlane {
  normal: Vec3;
  w: number;
}

function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): BSPPlane {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  return { normal: n, w: dot(n, a) };
}

function classifyPoint(plane: BSPPlane, point: Vec3): number {
  return dot(plane.normal, point) - plane.w;
}

function splitPolygon(
  plane: BSPPlane,
  polygon: CSGPolygon,
  coplanarFront: CSGPolygon[],
  coplanarBack: CSGPolygon[],
  front: CSGPolygon[],
  back: CSGPolygon[],
): void {
  const types = polygon.vertices.map(v => {
    const d = classifyPoint(plane, v);
    if (d < -EPS) return -1;
    if (d > EPS) return 1;
    return 0;
  });

  const frontCount = types.filter(t => t > 0).length;
  const backCount = types.filter(t => t < 0).length;

  if (frontCount === 0 && backCount === 0) {
    if (dot(plane.normal, polygon.normal) > 0) {
      coplanarFront.push(polygon);
    } else {
      coplanarBack.push(polygon);
    }
    return;
  }

  if (frontCount === 0) {
    back.push(polygon);
    return;
  }

  if (backCount === 0) {
    front.push(polygon);
    return;
  }

  const ff: Vec3[] = [];
  const bb: Vec3[] = [];

  for (let i = 0; i < polygon.vertices.length; i++) {
    const j = (i + 1) % polygon.vertices.length;
    const vi = polygon.vertices[i];
    const vj = polygon.vertices[j];
    const ti = types[i];
    const tj = types[j];

    if (ti !== -1) ff.push(vi);
    if (ti !== 1) bb.push(vi);

    if ((ti | tj) === 0) continue;

    const t = (plane.w - dot(plane.normal, vi)) / dot(plane.normal, sub(vj, vi));
    if (t > 0 && t < 1) {
      const mid = add(vi, scale(sub(vj, vi), t));
      ff.push(mid);
      bb.push(mid);
    }
  }

  if (ff.length >= 3) front.push({ vertices: ff, normal: polygon.normal, shared: polygon.shared });
  if (bb.length >= 3) back.push({ vertices: bb, normal: polygon.normal, shared: polygon.shared });
}

export class BSPNode {
  plane: BSPPlane | null = null;
  front: BSPNode | null = null;
  back: BSPNode | null = null;
  polygons: CSGPolygon[] = [];

  build(polygons: CSGPolygon[]): void {
    if (polygons.length === 0) return;

    if (!this.plane) {
      const p = polygons[0];
      this.plane = planeFromPoints(p.vertices[0], p.vertices[1], p.vertices[2]);
    }

    const frontPolys: CSGPolygon[] = [];
    const backPolys: CSGPolygon[] = [];

    polygons.forEach((poly) => {
      splitPolygon(this.plane!, poly, this.polygons, this.polygons, frontPolys, backPolys);
    });

    if (frontPolys.length > 0) {
      if (!this.front) this.front = new BSPNode();
      this.front.build(frontPolys);
    }

    if (backPolys.length > 0) {
      if (!this.back) this.back = new BSPNode();
      this.back.build(backPolys);
    }
  }

  clipPolygons(polygons: CSGPolygon[]): CSGPolygon[] {
    if (!this.plane) return polygons;

    const front: CSGPolygon[] = [];
    const back: CSGPolygon[] = [];

    for (let _i3842 = 0, _it3842 = polygons, _n3842 = _it3842.length; _i3842 < _n3842; _i3842++) { const poly = _it3842[_i3842];
      splitPolygon(this.plane, poly, front, back, front, back);
    };

    let frontResult = front;
    let backResult = back;

    if (this.front) frontResult = this.front.clipPolygons(front.splice(0));
    if (this.back) backResult = this.back.clipPolygons(back.splice(0));

    return frontResult.concat(backResult);
  }

  clipTo(bsp: BSPNode): void {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }

  invert(): void {
    if (!this.plane) return;
    this.plane.normal = scale(this.plane.normal, -1);
    this.plane.w = -this.plane.w;

    this.polygons.forEach((poly) => {
      poly.normal = scale(poly.normal, -1);
      poly.vertices.reverse();
    });

    const temp = this.front;
    this.front = this.back;
    this.back = temp;

    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
  }

  allPolygons(): CSGPolygon[] {
    const result = [...this.polygons];
    if (this.front) result.push(...this.front.allPolygons());
    if (this.back) result.push(...this.back.allPolygons());
    return result;
  }
}

function meshToPolygons(mesh: MeshData): CSGPolygon[] {
  const stride = mesh.layout.stride / 4;
  const polygons: CSGPolygon[] = [];

  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];

    const va: Vec3 = [mesh.vertices[a * stride], mesh.vertices[a * stride + 1], mesh.vertices[a * stride + 2]];
    const vb: Vec3 = [mesh.vertices[b * stride], mesh.vertices[b * stride + 1], mesh.vertices[b * stride + 2]];
    const vc: Vec3 = [mesh.vertices[c * stride], mesh.vertices[c * stride + 1], mesh.vertices[c * stride + 2]];

    const normal = normalize(cross(sub(vb, va), sub(vc, va)));
    polygons.push({ vertices: [va, vb, vc], normal, shared: 0 });
  }

  return polygons;
}

function polygonsToMesh(polygons: CSGPolygon[], layout: VertexLayout): MeshData {
  const stride = layout.stride / 4;
  const vertices: number[] = [];
  const indices: number[] = [];

  polygons.forEach((poly) => {
    const baseIdx = vertices.length / stride;
    poly.vertices.forEach((v) => {
      vertices.push(v[0], v[1], v[2]);
      vertices.push(poly.normal[0], poly.normal[1], poly.normal[2]);
      vertices.push(0, 0);
      vertices.push(1, 1, 1, 1);
    });
    for (let i = 1; i < poly.vertices.length - 1; i++) {
      indices.push(baseIdx, baseIdx + i, baseIdx + i + 1);
    }
  });

  const vertArr = new Float32Array(vertices);
  const indexCount = indices.length;
  const indexArr = indexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  return {
    vertices: vertArr,
    indices: indexArr,
    layout,
    vertexCount: vertArr.length / stride,
    indexCount,
  };
}


export function csgUnion(a: MeshData, b: MeshData): MeshData {
  const polysA = meshToPolygons(a);
  const polysB = meshToPolygons(b);

  const bspA = new BSPNode();
  bspA.build(polysA);
  const bspB = new BSPNode();
  bspB.build(polysB);

  bspA.clipTo(bspB);
  bspB.clipTo(bspA);
  bspB.invert();
  bspB.clipTo(bspA);
  bspB.invert();

  const result = [...bspA.allPolygons(), ...bspB.allPolygons()];
  return polygonsToMesh(result, a.layout);
}

export function csgSubtract(a: MeshData, b: MeshData): MeshData {
  const polysA = meshToPolygons(a);
  const polysB = meshToPolygons(b);

  const bspA = new BSPNode();
  bspA.build(polysA);
  const bspB = new BSPNode();
  bspB.build(polysB);

  bspA.invert();
  bspA.clipTo(bspB);
  bspB.clipTo(bspA);
  bspA.invert();
  bspB.invert();
  bspB.clipTo(bspA);
  bspB.invert();

  const result = [...bspA.allPolygons(), ...bspB.allPolygons()];
  return polygonsToMesh(result, a.layout);
}

export function csgIntersect(a: MeshData, b: MeshData): MeshData {
  const polysA = meshToPolygons(a);
  const polysB = meshToPolygons(b);

  const bspA = new BSPNode();
  bspA.build(polysA);
  const bspB = new BSPNode();
  bspB.build(polysB);

  bspA.invert();
  bspB.clipTo(bspA);
  bspA.invert();
  bspB.invert();
  bspA.clipTo(bspB);
  bspB.clipTo(bspA);

  const result = [...bspA.allPolygons(), ...bspB.allPolygons()];
  return polygonsToMesh(result, a.layout);
}
