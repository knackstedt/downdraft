// ============================================================================
// mat4 — column-major 4×4 matrix utilities (WebGPU convention)
// ============================================================================
//
// Shared implementation used by the engine's skeleton/animation system and
// by games that need matrix math (e.g. model-viewer's animation helper).
// All matrices are Float32Array(16) in column-major layout: m[col*4 + row].

/** Compute A * B in column-major layout, writing into `out` (no allocation). */
export function multiplyMat4Into(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let i = 0; i < 4; i++) {
    const bi0 = b[i * 4 + 0], bi1 = b[i * 4 + 1], bi2 = b[i * 4 + 2], bi3 = b[i * 4 + 3];
    out[i * 4 + 0] = a[0] * bi0 + a[4] * bi1 + a[8] * bi2 + a[12] * bi3;
    out[i * 4 + 1] = a[1] * bi0 + a[5] * bi1 + a[9] * bi2 + a[13] * bi3;
    out[i * 4 + 2] = a[2] * bi0 + a[6] * bi1 + a[10] * bi2 + a[14] * bi3;
    out[i * 4 + 3] = a[3] * bi0 + a[7] * bi1 + a[11] * bi2 + a[15] * bi3;
  }
}

/** Invert a 4×4 column-major matrix via adjugate / determinant. Returns zeros if singular. */
export function invertMat4(m: Float32Array): Float32Array {
  const a00 = m[0], a01 = m[4], a02 = m[8],  a03 = m[12];
  const a10 = m[1], a11 = m[5], a12 = m[9],  a13 = m[13];
  const a20 = m[2], a21 = m[6], a22 = m[10], a23 = m[14];
  const a30 = m[3], a31 = m[7], a32 = m[11], a33 = m[15];

  const b00 = a11*a22*a33 - a11*a23*a32 - a21*a12*a33 + a21*a13*a32 + a31*a12*a23 - a31*a13*a22;
  const b01 = -a10*a22*a33 + a10*a23*a32 + a20*a12*a33 - a20*a13*a32 - a30*a12*a23 + a30*a13*a22;
  const b02 = a10*a21*a33 - a10*a23*a31 - a20*a11*a33 + a20*a13*a31 + a30*a11*a23 - a30*a13*a21;
  const b03 = -a10*a21*a32 + a10*a22*a31 + a20*a11*a32 - a20*a12*a31 - a30*a11*a22 + a30*a12*a21;

  const b10 = -a01*a22*a33 + a01*a23*a32 + a21*a02*a33 - a21*a03*a32 - a31*a02*a23 + a31*a03*a22;
  const b11 = a00*a22*a33 - a00*a23*a32 - a20*a02*a33 + a20*a03*a32 + a30*a02*a23 - a30*a03*a22;
  const b12 = -a00*a21*a33 + a00*a23*a31 + a20*a01*a33 - a20*a03*a31 - a30*a01*a23 + a30*a03*a21;
  const b13 = a00*a21*a32 - a00*a22*a31 - a20*a01*a32 + a20*a02*a31 + a30*a01*a22 - a30*a02*a21;

  const b20 = a01*a12*a33 - a01*a13*a32 - a11*a02*a33 + a11*a03*a32 + a31*a02*a13 - a31*a03*a12;
  const b21 = -a00*a12*a33 + a00*a13*a32 + a10*a02*a33 - a10*a03*a32 - a30*a02*a13 + a30*a03*a12;
  const b22 = a00*a11*a33 - a00*a13*a31 - a10*a01*a33 + a10*a03*a31 + a30*a01*a13 - a30*a03*a11;
  const b23 = -a00*a11*a32 + a00*a12*a31 + a10*a01*a32 - a10*a02*a31 - a30*a01*a12 + a30*a02*a11;

  const b30 = -a01*a12*a23 + a01*a13*a22 + a11*a02*a23 - a11*a03*a22 - a21*a02*a13 + a21*a03*a12;
  const b31 = a00*a12*a23 - a00*a13*a22 - a10*a02*a23 + a10*a03*a22 + a20*a02*a13 - a20*a03*a12;
  const b32 = -a00*a11*a23 + a00*a13*a21 + a10*a01*a23 - a10*a03*a21 - a20*a01*a13 + a20*a03*a11;
  const b33 = a00*a11*a22 - a00*a12*a21 - a10*a01*a22 + a10*a02*a21 + a20*a01*a12 - a20*a02*a11;

  let det = a00*b00 + a01*b01 + a02*b02 + a03*b03;
  if (Math.abs(det) < 1e-9) return new Float32Array(16);
  det = 1 / det;

  const out = new Float32Array(16);
  out[0] = b00 * det;  out[1] = b01 * det;  out[2] = b02 * det;  out[3] = b03 * det;
  out[4] = b10 * det;  out[5] = b11 * det;  out[6] = b12 * det;  out[7] = b13 * det;
  out[8] = b20 * det;  out[9] = b21 * det;  out[10] = b22 * det; out[11] = b23 * det;
  out[12] = b30 * det; out[13] = b31 * det; out[14] = b32 * det; out[15] = b33 * det;
  return out;
}

/**
 * Write a WebGPU perspective projection matrix (clip Z ∈ [0, 1]) into `out`.
 * No Y flip — the view matrix handles the world convention.
 */
export function perspectiveMat4Into(
  out: Float32Array,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): void {
  const f = 1.0 / Math.tan(fovY / 2);
  const range = far - near;
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = far / range; out[11] = 1;
  out[12] = 0; out[13] = 0; out[14] = -(far * near) / range; out[15] = 0;
}

/**
 * Write a look-at view matrix into `out`. Uses left-handed cross products
 * (matches WebGPU's Z ∈ [0,1] clip space); `up` is the world-space up vector
 * for the game's convention (e.g. [0,-1,0] for Y-down worlds).
 */
export function lookAtMat4Into(
  out: Float32Array,
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

/**
 * Invert a 4×4 column-major matrix into `out` via adjugate / determinant.
 * Returns false (leaving `out` undefined) when the matrix is singular.
 */
export function invertMat4Into(m: Float32Array, out: Float32Array): boolean {
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
  if (det === 0) return false;
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return true;
}

/** Transform a vec4 by a column-major mat4. Returns [x, y, z, w]. */
export function transformMat4Vec4(
  m: Float32Array,
  v: [number, number, number, number],
): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/** Compose a TRS (translation, rotation, scale) into a column-major 4×4 matrix. */
export function composeMat4Into(
  pos: [number, number, number],
  rot: [number, number, number, number],
  scale: [number, number, number],
  m: Float32Array,
): void {
  const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  m[0] = (1 - (yy + zz)) * scale[0];
  m[1] = (xy + wz) * scale[0];
  m[2] = (xz - wy) * scale[0];
  m[3] = 0;
  m[4] = (xy - wz) * scale[1];
  m[5] = (1 - (xx + zz)) * scale[1];
  m[6] = (yz + wx) * scale[1];
  m[7] = 0;
  m[8] = (xz + wy) * scale[2];
  m[9] = (yz - wx) * scale[2];
  m[10] = (1 - (xx + yy)) * scale[2];
  m[11] = 0;
  m[12] = pos[0];
  m[13] = pos[1];
  m[14] = pos[2];
  m[15] = 1;
}
