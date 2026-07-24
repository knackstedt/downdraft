import { vec3, type Mat4, type Vec3 } from "wgpu-matrix";

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface FrustumPlane {
  normal: Vec3;
  distance: number;
}

type Vec4 = [number, number, number, number];

function addVec4(a: Vec4, b: Vec4): Vec4 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}
function subVec4(a: Vec4, b: Vec4): Vec4 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
}

function getColumn(m: Mat4, col: number): Vec4 {
  const base = col * 4;
  return [m[base], m[base + 1], m[base + 2], m[base + 3]];
}

export class Frustum {
  private planes: FrustumPlane[] = [];

  extractFromViewProj(viewProj: Mat4): void {
    const m = viewProj;
    const c0 = getColumn(m, 0);
    const c1 = getColumn(m, 1);
    const c2 = getColumn(m, 2);
    const c3 = getColumn(m, 3);

    this.planes = [];
    this.planes.push(this.normalizePlane(addVec4(c3, c0)));
    this.planes.push(this.normalizePlane(subVec4(c3, c0)));
    this.planes.push(this.normalizePlane(addVec4(c3, c1)));
    this.planes.push(this.normalizePlane(subVec4(c3, c1)));
    this.planes.push(this.normalizePlane(c2));
    this.planes.push(this.normalizePlane(subVec4(c3, c2)));
  }

  private normalizePlane(v: Vec4): FrustumPlane {
    const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (length < 1e-6) {
      return { normal: vec3.create(0, 0, 0), distance: 0 };
    }
    return {
      normal: vec3.create(v[0] / length, v[1] / length, v[2] / length),
      distance: v[3] / length,
    };
  }

  intersectsAABB(aabb: AABB): boolean {
    for (let i = 0; i < this.planes.length; i++) {
      const plane = this.planes[i];
      const nx = plane.normal[0];
      const ny = plane.normal[1];
      const nz = plane.normal[2];

      const px = nx >= 0 ? aabb.max[0] : aabb.min[0];
      const py = ny >= 0 ? aabb.max[1] : aabb.min[1];
      const pz = nz >= 0 ? aabb.max[2] : aabb.min[2];

      const dist = nx * px + ny * py + nz * pz + plane.distance;
      if (dist < 0) return false;
    }
    return true;
  }

  intersectsPoint(point: Vec3): boolean {
    for (let i = 0; i < this.planes.length; i++) {
      const plane = this.planes[i];
      const dist =
        plane.normal[0] * point[0] +
        plane.normal[1] * point[1] +
        plane.normal[2] * point[2] +
        plane.distance;
      if (dist < 0) return false;
    }
    return true;
  }

  intersectsSphere(center: Vec3, radius: number): boolean {
    for (let i = 0; i < this.planes.length; i++) {
      const plane = this.planes[i];
      const dist =
        plane.normal[0] * center[0] +
        plane.normal[1] * center[1] +
        plane.normal[2] * center[2] +
        plane.distance;
      if (dist < -radius) return false;
    }
    return true;
  }

  getPlanes(): FrustumPlane[] {
    return this.planes;
  }
}

export function computeAABB(
  positions: Float32Array,
  stride: number = 12,
  offset: number = 0,
): AABB {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const count = positions.length / (stride / 4);
  const strideFloats = stride / 4;
  for (let i = 0; i < count; i++) {
    const x = positions[i * strideFloats + offset / 4 + 0];
    const y = positions[i * strideFloats + offset / 4 + 1];
    const z = positions[i * strideFloats + offset / 4 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    min: vec3.create(minX, minY, minZ),
    max: vec3.create(maxX, maxY, maxZ),
  };
}

export function transformAABB(aabb: AABB, modelMatrix: Mat4): AABB {
  const corners: Vec3[] = [
    vec3.create(aabb.min[0], aabb.min[1], aabb.min[2]),
    vec3.create(aabb.max[0], aabb.min[1], aabb.min[2]),
    vec3.create(aabb.min[0], aabb.max[1], aabb.min[2]),
    vec3.create(aabb.max[0], aabb.max[1], aabb.min[2]),
    vec3.create(aabb.min[0], aabb.min[1], aabb.max[2]),
    vec3.create(aabb.max[0], aabb.min[1], aabb.max[2]),
    vec3.create(aabb.min[0], aabb.max[1], aabb.max[2]),
    vec3.create(aabb.max[0], aabb.max[1], aabb.max[2]),
  ];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < 8; i++) {
    const c = corners[i];
    const m = modelMatrix;
    const transformed: Vec3 = vec3.create(
      m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12],
      m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
      m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14],
    );
    if (transformed[0] < minX) minX = transformed[0];
    if (transformed[1] < minY) minY = transformed[1];
    if (transformed[2] < minZ) minZ = transformed[2];
    if (transformed[0] > maxX) maxX = transformed[0];
    if (transformed[1] > maxY) maxY = transformed[1];
    if (transformed[2] > maxZ) maxZ = transformed[2];
  }

  return {
    min: vec3.create(minX, minY, minZ),
    max: vec3.create(maxX, maxY, maxZ),
  };
}

export interface CullableItem {
  aabb: AABB;
  modelMatrix: Mat4;
  visible: boolean;
}

export function cullItems(items: CullableItem[], frustum: Frustum): CullableItem[] {
  const result: CullableItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const worldAABB = transformAABB(item.aabb, item.modelMatrix);
    if (frustum.intersectsAABB(worldAABB)) {
      result.push({ ...item, visible: true });
    }
  }
  return result;
}
