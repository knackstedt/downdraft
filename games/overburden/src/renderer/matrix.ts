// ============================================================================
// Picking utilities for 3D perspective rendering
//
// The generic mat4 ops (perspective / lookAt / multiply / invert / vec4
// transform) live in @downdraft/core — see packages/core/src/math/mat4.ts.
// This file keeps only the game-specific picking helpers: screen→ray
// unprojection, Z-plane intersection, and the 2.5D grid slab DDA raycast.
//
// World coordinate system: X right, Y down, Z toward viewer.
// ============================================================================

import { invertMat4Into, transformMat4Vec4 } from "@downdraft/core";

/** 4×4 matrix as a flat Float32Array (column-major, 16 elements). */
export type Mat4 = Float32Array;

/** Invert a 4×4 matrix (column-major). Returns null if singular. */
export function invert(m: Mat4): Mat4 | null {
  const out = new Float32Array(16);
  return invertMat4Into(m, out) ? out : null;
}

/**
 * Unproject screen coordinates (pixels) to a world-space ray.
 * Returns { origin, dir } where the ray starts at the camera and points
 * through the screen pixel. The caller intersects this with a plane.
 */
export function unprojectScreen(
  screenX: number, screenY: number,
  canvasW: number, canvasH: number,
  invViewProj: Mat4,
): { origin: [number, number, number]; dir: [number, number, number] } {
  // Screen pixels → NDC (WebGPU: Y down in screen, NDC Y up → flip)
  const ndcX = (screenX / canvasW) * 2 - 1;
  const ndcY = 1 - (screenY / canvasH) * 2; // flip Y

  // Unproject two points: one at NDC Z=near (0), one at NDC Z=far (1)
  function unproject(z: number): [number, number, number] {
    const r = transformMat4Vec4(invViewProj, [ndcX, ndcY, z, 1]);
    const w = r[3] || 1;
    return [r[0] / w, r[1] / w, r[2] / w];
  }

  const near = unproject(0);
  const far = unproject(1);
  const dx = far[0] - near[0];
  const dy = far[1] - near[1];
  const dz = far[2] - near[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  return {
    origin: near,
    dir: [dx / dl, dy / dl, dz / dl],
  };
}

/**
 * Intersect a ray with a Z=constant plane (the block grid plane).
 * Returns the world [x, y] at the intersection, or null if the ray
 * is parallel to the plane.
 * @param planeZ The Z value of the plane (default 1.0 = front face of foreground blocks)
 */
export function rayToZ0(
  origin: [number, number, number],
  dir: [number, number, number],
  planeZ: number = 1.0,
): { x: number; y: number } | null {
  if (Math.abs(dir[2]) < 1e-8) return null;
  const t = (planeZ - origin[2]) / dir[2];
  if (t < 0) return null; // behind the camera
  return { x: origin[0] + dir[0] * t, y: origin[1] + dir[1] * t };
}

/**
 * Raycast against a 2D grid of unit cubes occupying the Z=[zNear, zFar] slab.
 *
 * The cubes are unit-sized at integer grid positions: cell (cx, cy) occupies
 * X=[cx, cx+1], Y=[cy, cy+1], Z=[zNear, zFar]. This function marches a 2D
 * DDA (Amanatides & Woo) from the ray's entry point at zNear to its exit
 * point at zFar, checking each grid cell via `isSolid`. The first solid cell
 * hit is returned as continuous world coords at the cell center.
 *
 * This correctly handles perspective: near screen edges the ray is angled and
 * may hit the side face of a cube (at zNear < Z < zFar) rather than the front
 * face. A simple Z-plane intersection would project to the wrong cell in that
 * case; the DDA finds the actual cube the ray passes through.
 *
 * @returns Cell center {x, y} of the first solid cube hit, or null if no
 *          solid cell is intersected (caller should fall back to a plane
 *          intersection for empty-space placement).
 */
export function raycastGridSlab(
  origin: [number, number, number],
  dir: [number, number, number],
  zNear: number,
  zFar: number,
  gridW: number,
  gridH: number,
  isSolid: (cx: number, cy: number) => boolean,
): { x: number; y: number } | null {
  if (Math.abs(dir[2]) < 1e-8) return null;

  // Parametric t where the ray crosses zNear and zFar
  const tNear = (zNear - origin[2]) / dir[2];
  const tFar = (zFar - origin[2]) / dir[2];
  if (tNear < 0 && tFar < 0) return null; // slab is behind the camera

  // Entry (closer to camera) and exit (farther) parametric values
  const tEnter = Math.min(tNear, tFar);
  const tExit = Math.max(tNear, tFar);

  // 2D entry/exit points in the XY plane
  const ex = origin[0] + dir[0] * tEnter;
  const ey = origin[1] + dir[1] * tEnter;
  const fx = origin[0] + dir[0] * tExit;
  const fy = origin[1] + dir[1] * tExit;

  // 2D DDA from (ex, ey) to (fx, fy) — parameterized as P(s) = entry + s * (exit - entry), s ∈ [0, 1]
  const dx = fx - ex;
  const dy = fy - ey;

  let cx = Math.floor(ex);
  let cy = Math.floor(ey);

  const inBounds = (x: number, y: number) => x >= 0 && x < gridW && y >= 0 && y < gridH;

  // Check the entry cell
  if (inBounds(cx, cy) && isSolid(cx, cy)) {
    return { x: cx + 0.5, y: cy + 0.5 };
  }

  if (Math.abs(dx) < 1e-10 && Math.abs(dy) < 1e-10) return null;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;

  // s-distance to cross one full grid cell in each axis
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;

  // s-distance to the first gridline crossing
  let tMaxX: number;
  let tMaxY: number;
  if (stepX > 0) tMaxX = (cx + 1 - ex) / dx;
  else if (stepX < 0) tMaxX = (cx - ex) / dx;
  else tMaxX = Infinity;
  if (stepY > 0) tMaxY = (cy + 1 - ey) / dy;
  else if (stepY < 0) tMaxY = (cy - ey) / dy;
  else tMaxY = Infinity;

  let s = 0;
  while (s <= 1) {
    if (tMaxX < tMaxY) {
      s = tMaxX;
      tMaxX += tDeltaX;
      cx += stepX;
    } else {
      s = tMaxY;
      tMaxY += tDeltaY;
      cy += stepY;
    }
    if (s > 1) break;
    if (!inBounds(cx, cy)) break;
    if (isSolid(cx, cy)) {
      return { x: cx + 0.5, y: cy + 0.5 };
    }
  }

  return null;
}
