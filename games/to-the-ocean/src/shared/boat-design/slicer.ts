// ============================================================================
// Boat Design Slicer — rasterized axial cross-sections of a RuntimeBoatGeometry
// Used for Playwright baseline PNGs and quick volumetric sanity checks.
// ============================================================================

import type { RuntimeBoatGeometry, Triangle } from "./geometry";
import type { Vec3 } from "./types";

const EPS = 1e-7;

export interface SliceResult {
  axis: "x" | "y" | "z";
  value: number;
  width: number;
  height: number;
  step: number;
  minU: number;
  minV: number;
  /** Grayscale occupancy data: 255 = inside solid, 0 = empty. */
  data: Uint8Array;
}

function getComponent(p: Vec3, axis: "x" | "y" | "z"): number {
  return p[axis];
}

function vec3AxisValue(axis: "x" | "y" | "z", value: number, u: number, v: number): Vec3 {
  if (axis === "x") return { x: value, y: u, z: v };
  if (axis === "y") return { x: u, y: value, z: v };
  return { x: u, y: v, z: value };
}

function axisVector(axis: "x" | "y" | "z"): Vec3 {
  if (axis === "x") return { x: 1, y: 0, z: 0 };
  if (axis === "y") return { x: 0, y: 1, z: 0 };
  return { x: 0, y: 0, z: 1 };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function rayTriangleIntersection(rayOrigin: Vec3, rayDir: Vec3, p0: Vec3, p1: Vec3, p2: Vec3): number | null {
  const edge0 = sub(p1, p0);
  const edge1 = sub(p2, p0);
  const h = cross(rayDir, edge1);
  const a = dot(edge0, h);
  if (Math.abs(a) < EPS) return null;
  const f = 1 / a;
  const s = sub(rayOrigin, p0);
  const u = f * dot(s, h);
  if (u < -EPS || u > 1 + EPS) return null;
  const q = cross(s, edge0);
  const v = f * dot(rayDir, q);
  if (v < -EPS || u + v > 1 + EPS) return null;
  const t = f * dot(edge1, q);
  if (t < EPS) return null;
  return t;
}

function isPointInside(geometry: RuntimeBoatGeometry, point: Vec3, axis: "x" | "y" | "z"): boolean {
  const dir = axisVector(axis);
  // Count ray-triangle intersections strictly in front of the point.
  // Odd count means the point is inside the solid material.
  const triangles = geometry.getTriangles();
  let count = 0;
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const tHit = rayTriangleIntersection(point, dir, t.v0, t.v1, t.v2);
    if (tHit !== null && tHit > 1e-4) {
      count++;
    }
  }
  return (count & 1) === 1;
}

function chooseUVAxes(axis: "x" | "y" | "z"): { uAxis: "x" | "y" | "z"; vAxis: "x" | "y" | "z" } {
  if (axis === "x") return { uAxis: "y", vAxis: "z" };
  if (axis === "y") return { uAxis: "x", vAxis: "z" };
  return { uAxis: "x", vAxis: "y" };
}

/** Rasterize a single cross-section of the boat at the given axis value. */
export function sliceGeometry(
  geometry: RuntimeBoatGeometry,
  axis: "x" | "y" | "z",
  value: number,
  resolution = 128,
  padding = 0.25,
): SliceResult {
  const bounds = geometry.getBounds();
  const { uAxis, vAxis } = chooseUVAxes(axis);

  const minU = bounds[`min${uAxis.toUpperCase()}` as keyof typeof bounds] as number;
  const maxU = bounds[`max${uAxis.toUpperCase()}` as keyof typeof bounds] as number;
  const minV = bounds[`min${vAxis.toUpperCase()}` as keyof typeof bounds] as number;
  const maxV = bounds[`max${vAxis.toUpperCase()}` as keyof typeof bounds] as number;

  const sizeU = Math.max(0, maxU - minU) + padding * 2;
  const sizeV = Math.max(0, maxV - minV) + padding * 2;
  const step = Math.max(sizeU, sizeV) / resolution;

  const width = Math.ceil(sizeU / step);
  const height = Math.ceil(sizeV / step);
  const data = new Uint8Array(width * height);

  for (let iy = 0; iy < height; iy++) {
    const v = minV - padding + (iy + 0.5) * step;
    for (let ix = 0; ix < width; ix++) {
      const u = minU - padding + (ix + 0.5) * step;
      const point = vec3AxisValue(axis, value, u, v);
      if (isPointInside(geometry, point, axis)) {
        data[iy * width + ix] = 255;
      }
    }
  }

  return {
    axis,
    value,
    width,
    height,
    step,
    minU: minU - padding,
    minV: minV - padding,
    data,
  };
}

/** Return all axis values where a slice intersects the hull, sampled at the given step. */
export function occupiedAxisSlices(
  geometry: RuntimeBoatGeometry,
  axis: "x" | "y" | "z",
  step = 0.5,
): number[] {
  const bounds = geometry.getBounds();
  const min = bounds[`min${axis.toUpperCase()}` as keyof typeof bounds] as number;
  const max = bounds[`max${axis.toUpperCase()}` as keyof typeof bounds] as number;

  const values: number[] = [];
  const triangles = geometry.getTriangles();
  for (let v = min; v <= max + EPS; v += step) {
    let occupied = false;
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i];
      const tMin = Math.min(getComponent(t.v0, axis), getComponent(t.v1, axis), getComponent(t.v2, axis));
      const tMax = Math.max(getComponent(t.v0, axis), getComponent(t.v1, axis), getComponent(t.v2, axis));
      if (v >= tMin - EPS && v <= tMax + EPS) {
        occupied = true;
        break;
      }
    }
    if (occupied) values.push(v);
  }
  return values;
}
