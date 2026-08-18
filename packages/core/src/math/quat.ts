// ============================================================================
// quat — quaternion utilities for 3D rotation
// ============================================================================
//
// Quaternions use the engine's `Quat` type ({x, y, z, w}). Used by
// animation/skeleton systems and games that compose rotations.

import type { Quat } from "../sim/types";

/** Quaternion multiplication: a * b (Hamilton product). */
export function quatMul(a: Quat, b: Quat): Quat {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  return {
    x: aw * bx + ax * bw + ay * bz - az * by,
    y: aw * by - ax * bz + ay * bw + az * bx,
    z: aw * bz + ax * by - ay * bx + az * bw,
    w: aw * bw - ax * bx - ay * by - az * bz,
  };
}

/** Euler XYZ (radians) → quaternion (ZYX intrinsic: q = qz*qy*qx). */
export function eulerXYZToQuat(ex: number, ey: number, ez: number): Quat {
  const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
  const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
  const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}
