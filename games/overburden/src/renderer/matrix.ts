// ============================================================================
// Matrix utilities for 3D perspective rendering
//
// Standard mat4 functions for WebGPU (clip space Z = [0, 1]).
// World coordinate system: X right, Y down, Z toward viewer.
// ============================================================================

/** 4×4 matrix as a flat Float32Array (column-major, 16 elements). */
export type Mat4 = Float32Array;

/**
 * Create a perspective projection matrix for WebGPU (Z clip [0, 1]).
 * No Y flip — the view matrix handles the Y-down world convention.
 */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1.0 / Math.tan(fovY / 2);
  const range = far - near;
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / range, 1,
    0, 0, -(far * near) / range, 0,
  ]);
}

/**
 * Create a look-at view matrix for WebGPU.
 * World Y goes down; up = [0, -1, 0] means "up" in world.
 * Uses left-handed cross products (WebGPU Z clip [0,1] is left-handed).
 */
export function lookAt(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): Mat4 {
  // forward = normalize(target - eye)  (direction the camera looks)
  const fx = target[0] - eye[0];
  const fy = target[1] - eye[1];
  const fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  const f = [fx / fl, fy / fl, fz / fl];

  // right = normalize(cross(up, forward))  (left-handed)
  const rx = up[1] * f[2] - up[2] * f[1];
  const ry = up[2] * f[0] - up[0] * f[2];
  const rz = up[0] * f[1] - up[1] * f[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  const r = [rx / rl, ry / rl, rz / rl];

  // true up = cross(forward, right)
  const ux = f[1] * r[2] - f[2] * r[1];
  const uy = f[2] * r[0] - f[0] * r[2];
  const uz = f[0] * r[1] - f[1] * r[0];
  const u = [ux, uy, uz];

  // View matrix (column-major):
  // view = [r | u | f | -origin] where origin = (dot(r,eye), dot(u,eye), dot(f,eye))
  return new Float32Array([
    r[0], u[0], f[0], 0,
    r[1], u[1], f[1], 0,
    r[2], u[2], f[2], 0,
    -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    -(f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]),
    1,
  ]);
}

/** Multiply two matrices: result = a × b (column-major). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** Multiply two matrices in-place: out = a × b (column-major). No allocation. */
export function multiplyIP(out: Mat4, a: Mat4, b: Mat4): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
}

/** Perspective projection in-place (no allocation). */
export function perspectiveIP(out: Mat4, fovY: number, aspect: number, near: number, far: number): void {
  const f = 1.0 / Math.tan(fovY / 2);
  const range = far - near;
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = far / range; out[11] = 1;
  out[12] = 0; out[13] = 0; out[14] = -(far * near) / range; out[15] = 0;
}

/** Look-at view matrix in-place (no allocation). */
export function lookAtIP(
  out: Mat4,
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): void {
  const fx = target[0] - eye[0];
  const fy = target[1] - eye[1];
  const fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  const f0 = fx / fl, f1 = fy / fl, f2 = fz / fl;

  const rx = up[1] * f2 - up[2] * f1;
  const ry = up[2] * f0 - up[0] * f2;
  const rz = up[0] * f1 - up[1] * f0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  const r0 = rx / rl, r1 = ry / rl, r2 = rz / rl;

  const u0 = f1 * r2 - f2 * r1;
  const u1 = f2 * r0 - f0 * r2;
  const u2 = f0 * r1 - f1 * r0;

  out[0] = r0; out[1] = u0; out[2] = f0; out[3] = 0;
  out[4] = r1; out[5] = u1; out[6] = f1; out[7] = 0;
  out[8] = r2; out[9] = u2; out[10] = f2; out[11] = 0;
  out[12] = -(r0 * eye[0] + r1 * eye[1] + r2 * eye[2]);
  out[13] = -(u0 * eye[0] + u1 * eye[1] + u2 * eye[2]);
  out[14] = -(f0 * eye[0] + f1 * eye[1] + f2 * eye[2]);
  out[15] = 1;
}

/** Transform a vec3 by a mat4 (w=1, perspective divide). Returns [x, y, z, w]. */
export function transform(m: Mat4, v: [number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15],
  ];
}

/** Invert a 4×4 matrix (column-major). Returns null if singular. */
export function invert(m: Mat4): Mat4 | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1.0 / det;

  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]);
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
    const r = transform(invViewProj, [ndcX, ndcY, z]);
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
