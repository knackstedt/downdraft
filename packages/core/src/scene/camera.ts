import { mat4, vec3, type Mat4 } from "wgpu-matrix";

export interface CameraData {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  aspect: number;
  near: number;
  far: number;
  yaw: number;
  pitch: number;
  distance: number;
}

export class Camera {
  position: [number, number, number] = [0, 5, 10];
  target: [number, number, number] = [0, 0, 0];
  up: [number, number, number] = [0, 1, 0];
  fov: number = 60;
  aspect: number = 1;
  near: number = 0.1;
  far: number = 1000;
  yaw: number = 0;
  pitch: number = 0.3;
  distance: number = 10;

  private viewMatrix: Mat4 = mat4.identity();
  private projMatrix: Mat4 = mat4.identity();
  private viewProjMatrix: Mat4 = mat4.identity();
  private viewDirty: boolean = true;
  private projDirty: boolean = true;

  setPosition(x: number, y: number, z: number): void {
    this.position = [x, y, z];
    this.viewDirty = true;
  }

  setTarget(x: number, y: number, z: number): void {
    this.target = [x, y, z];
    this.viewDirty = true;
  }

  setAspect(width: number, height: number): void {
    this.aspect = width / height;
    this.projDirty = true;
  }

  setFov(degrees: number): void {
    this.fov = degrees;
    this.projDirty = true;
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    this.pitch += deltaPitch;
    const maxPitch = Math.PI / 2 - 0.01;
    if (this.pitch > maxPitch) this.pitch = maxPitch;
    if (this.pitch < -maxPitch) this.pitch = -maxPitch;
    this.updatePosition();
  }

  zoom(delta: number): void {
    this.distance -= delta;
    if (this.distance < 0.1) this.distance = 0.1;
    if (this.distance > 500) this.distance = 500;
    this.updatePosition();
  }

  pan(deltaX: number, deltaY: number): void {
    const forward = vec3.normalize(vec3.subtract(this.target, this.position));
    const right = vec3.normalize(vec3.cross(forward, this.up));
    const panAmount = this.distance * 0.001;
    this.target = vec3.subtract(this.target, vec3.scale(right, deltaX * panAmount)) as [number, number, number];
    this.target = vec3.add(this.target, vec3.scale(this.up, deltaY * panAmount)) as [number, number, number];
    this.updatePosition();
  }

  private updatePosition(): void {
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);

    this.position = [
      this.target[0] + this.distance * cosPitch * sinYaw,
      this.target[1] + this.distance * sinPitch,
      this.target[2] + this.distance * cosPitch * cosYaw,
    ];
    this.viewDirty = true;
  }

  isViewDirty(): boolean {
    return this.viewDirty;
  }

  isProjDirty(): boolean {
    return this.projDirty;
  }

  getViewMatrix(): Mat4 {
    if (this.viewDirty || this.projDirty) this.updateMatrices();
    return this.viewMatrix;
  }

  getProjectionMatrix(): Mat4 {
    if (this.viewDirty || this.projDirty) this.updateMatrices();
    return this.projMatrix;
  }

  getViewProjectionMatrix(): Mat4 {
    if (this.viewDirty || this.projDirty) this.updateMatrices();
    return this.viewProjMatrix;
  }

  private updateMatrices(): void {
    if (this.viewDirty) {
      this.viewMatrix = mat4.lookAt(this.position, this.target, this.up);
      this.viewDirty = false;
    }
    if (this.projDirty) {
      this.projMatrix = mat4.perspective(this.fov * (Math.PI / 180), this.aspect, this.near, this.far);
      this.projDirty = false;
    }
    this.viewProjMatrix = mat4.multiply(this.projMatrix, this.viewMatrix);
  }

  getData(): CameraData {
    return {
      position: [this.position[0], this.position[1], this.position[2]],
      target: [this.target[0], this.target[1], this.target[2]],
      up: [this.up[0], this.up[1], this.up[2]],
      fov: this.fov,
      aspect: this.aspect,
      near: this.near,
      far: this.far,
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
    };
  }
}
