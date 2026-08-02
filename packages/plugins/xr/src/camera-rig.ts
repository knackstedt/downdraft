import type { CameraViewportInfo } from "@downdraft/core";
import type { ViewportRect } from "@downdraft/core";
import type { XREye } from "./layer.ts";
import type { XRLayerManager } from "./layer.ts";
import type { XRWorldOrigin } from "./types.ts";

const DEFAULT_VIEWPORT: ViewportRect = { x: 0, y: 0, w: 1, h: 1 };

export class XRCameraRig {
  private layerManager: XRLayerManager;
  private getWorldOrigin: () => XRWorldOrigin;

  private headPosition: [number, number, number] = [0, 0, 0];
  private headQuaternion: [number, number, number, number] = [0, 0, 0, 1];

  constructor(layerManager: XRLayerManager, getWorldOrigin: () => XRWorldOrigin) {
    this.layerManager = layerManager;
    this.getWorldOrigin = getWorldOrigin;
  }

  computeEyeCameras(
    screenW: number,
    screenH: number,
  ): [CameraViewportInfo | null, CameraViewportInfo | null] {
    const left = this.computeEyeCamera("left", screenW, screenH);
    const right = this.computeEyeCamera("right", screenW, screenH);
    return [left, right];
  }

  private computeEyeCamera(eye: XREye, screenW: number, screenH: number): CameraViewportInfo | null {
    const projMatrix = this.layerManager.getProjectionMatrix(eye);
    const viewMatrix = this.layerManager.getViewMatrix(eye);
    const viewport = this.layerManager.getViewport(eye);

    if (!projMatrix || !viewMatrix) return null;

    const vp: ViewportRect = viewport
      ? { x: viewport.x, y: viewport.y, w: viewport.width, h: viewport.height }
      : DEFAULT_VIEWPORT;

    const aspect = vp.w > 0 && vp.h > 0 ? vp.w / vp.h : 1;

    const worldOrigin = this.getWorldOrigin();
    const worldMatrix = composeWorldMatrix(worldOrigin);
    const finalViewMatrix = multiplyMat4(worldMatrix, viewMatrix);

    const position = extractPosition(finalViewMatrix);

    return {
      camera: {
        position,
        target: [position[0], position[1] - 1, position[2]],
        up: [0, 1, 0],
        fov: 90,
        near: 0.05,
        far: 1000,
        aspect,
        projectionMatrix: projMatrix,
        viewMatrix: finalViewMatrix,
      },
      viewport: vp,
    };
  }

  updateHeadPose(pose: XRViewerPose, referenceSpace: XRReferenceSpace): void {
    const matrix = pose.transform.matrix;
    const worldOrigin = this.getWorldOrigin();
    const worldMatrix = composeWorldMatrix(worldOrigin);
    const headMatrix = multiplyMat4(worldMatrix, matrix);

    this.headPosition = extractPosition(headMatrix);
    this.headQuaternion = extractQuaternion(headMatrix);
  }

  getHeadPose(): { position: [number, number, number]; quaternion: [number, number, number, number] } {
    return { position: this.headPosition, quaternion: this.headQuaternion };
  }
}

function composeWorldMatrix(origin: XRWorldOrigin): Float32Array {
  const [px, py, pz] = origin.position;
  const [qx, qy, qz, qw] = origin.quaternion;

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  return new Float32Array([
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    px, py, pz, 1,
  ]);
}

function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[i * 4 + k] * b[k * 4 + j];
      }
      result[i * 4 + j] = sum;
    }
  }
  return result;
}

function extractPosition(m: Float32Array): [number, number, number] {
  return [m[12], m[13], m[14]];
}

function extractQuaternion(m: Float32Array): [number, number, number, number] {
  const trace = m[0] + m[5] + m[10];
  let qw: number, qx: number, qy: number, qz: number;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (m[6] - m[9]) * s;
    qy = (m[8] - m[2]) * s;
    qz = (m[1] - m[4]) * s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[5] - m[10]);
    qw = (m[6] - m[9]) / s;
    qx = 0.25 * s;
    qy = (m[4] + m[1]) / s;
    qz = (m[8] + m[2]) / s;
  } else if (m[5] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[5] - m[0] - m[10]);
    qw = (m[8] - m[2]) / s;
    qx = (m[4] + m[1]) / s;
    qy = 0.25 * s;
    qz = (m[9] + m[6]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[10] - m[0] - m[5]);
    qw = (m[1] - m[4]) / s;
    qx = (m[8] + m[2]) / s;
    qy = (m[9] + m[6]) / s;
    qz = 0.25 * s;
  }

  return [qx, qy, qz, qw];
}
