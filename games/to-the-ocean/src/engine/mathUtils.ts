import { mat4 } from "wgpu-matrix";
import type { CameraState } from "./CameraSystem";

const tmpProj = new Float32Array(16);
const tmpView = new Float32Array(16);

export function calculateViewProj(camera: CameraState): Float32Array {
  const fov = (camera.fov * Math.PI) / 180;
  mat4.perspective(fov, camera.aspect, camera.near, camera.far, tmpProj);
  mat4.lookAt(camera.position, camera.target, camera.up, tmpView);
  return mat4.multiply(tmpProj, tmpView, new Float32Array(16));
}

export function invertMat4(m: Float32Array): Float32Array {
  return mat4.inverse(m, new Float32Array(16));
}

export function transformVec4(
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

export function normalize3(v: number[]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
