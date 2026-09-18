// ============================================================================
// Camera System — view matrix calculation for 1st/3rd person and freecam
// Generic camera with configurable eye height and player height parameters.
// ============================================================================

import { mat4 } from "wgpu-matrix";

export enum CameraMode {
  FirstPerson = 0,
  ThirdPerson = 1,
  FreeCam = 2,
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  near: number;
  far: number;
  aspect: number;
  projectionMatrix?: Float32Array;
  viewMatrix?: Float32Array;
}

export interface CameraConfig {
  eyeHeight: number;
  playerHeight: number;
  thirdPersonDistance?: number;
  firstPersonSensitivity?: number;
  thirdPersonSensitivity?: number;
  freecamSensitivity?: number;
}

const DEFAULT_CONFIG: CameraConfig = {
  eyeHeight: 1.62,
  playerHeight: 1.8,
  thirdPersonDistance: 12,
  firstPersonSensitivity: 1.0,
  thirdPersonSensitivity: 1.0,
  freecamSensitivity: 1.0,
};

const FREECAM_MOUSE_SENSITIVITY = 0.001;
const FIRST_PERSON_MOUSE_SENSITIVITY = 0.001;
const THIRD_PERSON_MOUSE_SENSITIVITY = 0.005;

const KEY_W = 87, KEY_A = 65, KEY_S = 83, KEY_D = 68;
const KEY_SPACE = 32, KEY_SHIFT = 16;

// ── Math utilities ──

const tmpProj = new Float32Array(16);
const tmpView = new Float32Array(16);
const tmpResult = new Float32Array(16);

export function calculateViewProj(camera: CameraState): Float32Array {
  return calculateViewProjInto(camera, tmpResult);
}

export function calculateViewProjInto(camera: CameraState, target: Float32Array): Float32Array {
  if (camera.projectionMatrix && camera.viewMatrix) {
    return mat4.multiply(camera.projectionMatrix, camera.viewMatrix, target);
  }
  if (camera.projectionMatrix) {
    mat4.lookAt(camera.position, camera.target, camera.up, tmpView);
    return mat4.multiply(camera.projectionMatrix, tmpView, target);
  }
  if (camera.viewMatrix) {
    const fov = (camera.fov * Math.PI) / 180;
    mat4.perspective(fov, camera.aspect, camera.near, camera.far, tmpProj);
    return mat4.multiply(tmpProj, camera.viewMatrix, target);
  }
  const fov = (camera.fov * Math.PI) / 180;
  mat4.perspective(fov, camera.aspect, camera.near, camera.far, tmpProj);
  mat4.lookAt(camera.position, camera.target, camera.up, tmpView);
  return mat4.multiply(tmpProj, tmpView, target);
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

// ── CameraSystem class ──

export class CameraSystem {
  private config: CameraConfig;
  private thirdPersonDistance: number;
  private thirdPersonHeight: number;
  private smoothPos: [number, number, number] | null = null;
  private smoothTarget: [number, number, number] | null = null;
  private lastMode: number = CameraMode.FirstPerson;
  private prevPlayerPos: [number, number, number] | null = null;

  private freecamPos: [number, number, number] = [0, 10, 0];
  private freecamAngles: { pitch: number; yaw: number } = { pitch: 0, yaw: 0 };
  private freecamInitialized = false;

  private lookHeading = 0;
  private lookPitch = 0;
  private lookSyncedTick = -1;

  private firstPersonSensitivity: number;
  private thirdPersonSensitivity: number;
  private freecamSensitivity: number;

  private pooledReturnState: CameraState = {
    position: [0, 0, 0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: 60,
    near: 0.1,
    far: 4096,
    aspect: 1,
  };
  private pooledPos: [number, number, number] = [0, 0, 0];
  private pooledTarget: [number, number, number] = [0, 0, 0];
  private pooledDesiredOffset: [number, number, number] = [0, 0, 0];
  private pooledCurrentOffset: [number, number, number] = [0, 0, 0];

  constructor(config?: Partial<CameraConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.thirdPersonDistance = this.config.thirdPersonDistance!;
    this.thirdPersonHeight = this.config.playerHeight * 0.8;
    this.firstPersonSensitivity = this.config.firstPersonSensitivity!;
    this.thirdPersonSensitivity = this.config.thirdPersonSensitivity!;
    this.freecamSensitivity = this.config.freecamSensitivity!;
  }

  calculateCamera(
    playerPos: { x: number; y: number; z: number },
    heading: number,
    pitch: number,
    mode: number,
    viewportIdx: number,
    dt: number,
    aspect: number,
  ): CameraState {
    const pos = this.pooledPos;
    const target = this.pooledTarget;

    const modeChanged = mode !== this.lastMode;
    this.lastMode = mode;

    switch (mode) {
      case CameraMode.FirstPerson: {
        const eyeY = playerPos.y + this.config.eyeHeight;
        pos[0] = playerPos.x; pos[1] = eyeY; pos[2] = playerPos.z;
        const lookDist = 100;
        const cp = Math.cos(this.lookPitch);
        const sp = Math.sin(this.lookPitch);
        target[0] = playerPos.x + Math.sin(this.lookHeading) * cp * lookDist;
        target[1] = eyeY + sp * lookDist;
        target[2] = playerPos.z - Math.cos(this.lookHeading) * cp * lookDist;
        break;
      }

      case CameraMode.ThirdPerson: {
        const dist = this.thirdPersonDistance;
        const clampedPitch = Math.max(-0.8, Math.min(0.6, this.lookPitch));
        const cp = Math.cos(clampedPitch);
        const sp = Math.sin(clampedPitch);

        pos[0] = playerPos.x - Math.sin(this.lookHeading) * cp * dist;
        pos[1] = playerPos.y + this.thirdPersonHeight - sp * dist;
        pos[2] = playerPos.z + Math.cos(this.lookHeading) * cp * dist;

        const torsoOffset = this.config.playerHeight * 0.5;
        target[0] = playerPos.x;
        target[1] = playerPos.y + torsoOffset;
        target[2] = playerPos.z;
        break;
      }

      case CameraMode.FreeCam: {
        pos[0] = this.freecamPos[0];
        pos[1] = this.freecamPos[1];
        pos[2] = this.freecamPos[2];
        const cp = Math.cos(this.freecamAngles.pitch);
        const sp = Math.sin(this.freecamAngles.pitch);
        const lookDist = 100;
        target[0] = this.freecamPos[0] + Math.sin(this.freecamAngles.yaw) * cp * lookDist;
        target[1] = this.freecamPos[1] + sp * lookDist;
        target[2] = this.freecamPos[2] - Math.cos(this.freecamAngles.yaw) * cp * lookDist;
        break;
      }

      default: {
        pos[0] = playerPos.x;
        pos[1] = playerPos.y + 3;
        pos[2] = playerPos.z + 8;
        target[0] = playerPos.x;
        target[1] = playerPos.y;
        target[2] = playerPos.z;
        break;
      }
    }

    if (mode === CameraMode.FirstPerson || mode === CameraMode.FreeCam || modeChanged) {
      if (!this.smoothPos) this.smoothPos = [0, 0, 0];
      if (!this.smoothTarget) this.smoothTarget = [0, 0, 0];
      this.smoothPos[0] = pos[0]; this.smoothPos[1] = pos[1]; this.smoothPos[2] = pos[2];
      this.smoothTarget[0] = target[0]; this.smoothTarget[1] = target[1]; this.smoothTarget[2] = target[2];
      if (!this.prevPlayerPos) this.prevPlayerPos = [0, 0, 0];
      this.prevPlayerPos[0] = playerPos.x;
      this.prevPlayerPos[1] = playerPos.y;
      this.prevPlayerPos[2] = playerPos.z;
    } else {
      if (!this.smoothPos) this.smoothPos = [pos[0], pos[1], pos[2]];
      if (!this.smoothTarget) this.smoothTarget = [target[0], target[1], target[2]];

      const lerp = 1 - Math.pow(0.001, dt);

      if (mode === CameraMode.ThirdPerson) {
        if (this.prevPlayerPos) {
          this.smoothPos[0] += playerPos.x - this.prevPlayerPos[0];
          this.smoothPos[1] += playerPos.y - this.prevPlayerPos[1];
          this.smoothPos[2] += playerPos.z - this.prevPlayerPos[2];
        }
        if (!this.prevPlayerPos) this.prevPlayerPos = [0, 0, 0];
        this.prevPlayerPos[0] = playerPos.x;
        this.prevPlayerPos[1] = playerPos.y;
        this.prevPlayerPos[2] = playerPos.z;

        const desiredOffset = this.pooledDesiredOffset;
        desiredOffset[0] = pos[0] - playerPos.x;
        desiredOffset[1] = pos[1] - playerPos.y;
        desiredOffset[2] = pos[2] - playerPos.z;
        const currentOffset = this.pooledCurrentOffset;
        currentOffset[0] = this.smoothPos[0] - playerPos.x;
        currentOffset[1] = this.smoothPos[1] - playerPos.y;
        currentOffset[2] = this.smoothPos[2] - playerPos.z;
        currentOffset[0] += (desiredOffset[0] - currentOffset[0]) * lerp;
        currentOffset[1] += (desiredOffset[1] - currentOffset[1]) * lerp;
        currentOffset[2] += (desiredOffset[2] - currentOffset[2]) * lerp;
        this.smoothPos[0] = playerPos.x + currentOffset[0];
        this.smoothPos[1] = playerPos.y + currentOffset[1];
        this.smoothPos[2] = playerPos.z + currentOffset[2];

        this.smoothTarget[0] = target[0];
        this.smoothTarget[1] = target[1];
        this.smoothTarget[2] = target[2];
      } else {
        this.smoothPos[0] += (pos[0] - this.smoothPos[0]) * lerp;
        this.smoothPos[1] += (pos[1] - this.smoothPos[1]) * lerp;
        this.smoothPos[2] += (pos[2] - this.smoothPos[2]) * lerp;
        this.smoothTarget[0] += (target[0] - this.smoothTarget[0]) * lerp;
        this.smoothTarget[1] += (target[1] - this.smoothTarget[1]) * lerp;
        this.smoothTarget[2] += (target[2] - this.smoothTarget[2]) * lerp;
      }
    }

    const ret = this.pooledReturnState;
    ret.position[0] = this.smoothPos[0];
    ret.position[1] = this.smoothPos[1];
    ret.position[2] = this.smoothPos[2];
    ret.target[0] = this.smoothTarget[0];
    ret.target[1] = this.smoothTarget[1];
    ret.target[2] = this.smoothTarget[2];
    ret.aspect = aspect;
    return ret;
  }

  getThirdPersonDistance(): number {
    return this.thirdPersonDistance;
  }

  setThirdPersonDistance(d: number): void {
    this.thirdPersonDistance = Math.max(2, Math.min(20, d));
  }

  setThirdPersonHeight(h: number): void {
    this.thirdPersonHeight = Math.max(1, Math.min(10, h));
  }

  updateFreecam(
    keysDown: Set<number>,
    mouseDelta: { dx: number; dy: number },
    dt: number,
    playerPos: { x: number; y: number; z: number },
    playerHeading: number,
    playerPitch: number,
  ): void {
    if (!this.freecamInitialized) {
      this.freecamPos = [playerPos.x, playerPos.y + 5, playerPos.z];
      this.freecamAngles = { pitch: playerPitch, yaw: playerHeading };
      this.freecamInitialized = true;
    }

    const speed = 20 * dt;
    const cos = Math.cos(this.freecamAngles.yaw);
    const sin = Math.sin(this.freecamAngles.yaw);

    if (keysDown.has(KEY_W)) {
      this.freecamPos[0] += sin * speed;
      this.freecamPos[2] -= cos * speed;
    }
    if (keysDown.has(KEY_S)) {
      this.freecamPos[0] -= sin * speed;
      this.freecamPos[2] += cos * speed;
    }
    if (keysDown.has(KEY_A)) {
      this.freecamPos[0] -= cos * speed;
      this.freecamPos[2] -= sin * speed;
    }
    if (keysDown.has(KEY_D)) {
      this.freecamPos[0] += cos * speed;
      this.freecamPos[2] += sin * speed;
    }
    if (keysDown.has(KEY_SPACE)) {
      this.freecamPos[1] += speed;
    }
    if (keysDown.has(KEY_SHIFT)) {
      this.freecamPos[1] -= speed;
    }

    const fSens = FREECAM_MOUSE_SENSITIVITY * this.freecamSensitivity;
    if (mouseDelta.dx !== 0) this.freecamAngles.yaw += mouseDelta.dx * fSens;
    if (mouseDelta.dy !== 0) {
      this.freecamAngles.pitch -= mouseDelta.dy * fSens;
      this.freecamAngles.pitch = Math.max(-1.4, Math.min(1.4, this.freecamAngles.pitch));
    }
  }

  updateLook(
    mouseDelta: { dx: number; dy: number },
    simTick: number,
    sabHeading: number,
    sabPitch: number,
    mode: number,
  ): void {
    if (this.lookSyncedTick < 0) {
      this.lookHeading = sabHeading;
      this.lookPitch = sabPitch;
    }
    this.lookSyncedTick = simTick;

    const baseSens = mode === CameraMode.ThirdPerson
      ? THIRD_PERSON_MOUSE_SENSITIVITY
      : FIRST_PERSON_MOUSE_SENSITIVITY;
    const sens = baseSens * (mode === CameraMode.ThirdPerson
      ? this.thirdPersonSensitivity
      : this.firstPersonSensitivity);

    if (mouseDelta.dx !== 0) this.lookHeading += mouseDelta.dx * sens;
    if (mouseDelta.dy !== 0) {
      if (mode === CameraMode.ThirdPerson) {
        this.lookPitch -= mouseDelta.dy * sens;
        this.lookPitch = Math.max(-0.8, Math.min(0.6, this.lookPitch));
      } else {
        this.lookPitch -= mouseDelta.dy * sens;
        this.lookPitch = Math.max(-1.4, Math.min(1.4, this.lookPitch));
      }
    }
  }

  resetLook(heading: number, pitch: number): void {
    this.lookHeading = heading;
    this.lookPitch = pitch;
    this.lookSyncedTick = -1;
  }

  getLookHeading(): number { return this.lookHeading; }
  getLookPitch(): number { return this.lookPitch; }

  resetFreecam(playerPos: { x: number; y: number; z: number }, heading: number, pitch: number): void {
    this.freecamPos = [playerPos.x, playerPos.y + 5, playerPos.z];
    this.freecamAngles = { pitch, yaw: heading };
    this.freecamInitialized = true;
  }

  clearFreecam(): void {
    this.freecamInitialized = false;
  }

  setFirstPersonSensitivity(v: number): void { this.firstPersonSensitivity = v; }
  setThirdPersonSensitivity(v: number): void { this.thirdPersonSensitivity = v; }
  setFreecamSensitivity(v: number): void { this.freecamSensitivity = v; }
}
