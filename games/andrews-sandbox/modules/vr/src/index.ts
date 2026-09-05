// ============================================================================
// @andrews-sandbox/module-vr — VR mode integration with smooth locomotion.
// Wraps the engine's XRModule and adds sandbox-specific VR controls:
// smooth locomotion, controller-based interaction, and VR camera rig.
// ============================================================================

import { XRModule, isVRSupported, type XRSessionConfig } from "@downdraft/module-xr";
import { ToolType } from "@sandbox/shared/types";

/** Minimal renderer API for VR. */
export interface VRRendererApi {
  getDevice(): GPUDevice | null;
  getFormat(): GPUTextureFormat;
  getCameraPosition(): [number, number, number];
  setCameraPosition(pos: [number, number, number]): void;
}

/** Minimal sim API for VR. */
export interface VRSimApi {
  sendCommand(cmd: any): void;
}

export interface VRModuleConfig {
  renderer: VRRendererApi;
  sim: VRSimApi;
  moveSpeed?: number;
  smoothLocomotion?: boolean;
}

export class SandboxVRModule {
  private xrModule: XRModule | null = null;
  private renderer: VRRendererApi;
  private sim: VRSimApi;
  private moveSpeed: number;
  private smoothLocomotion: boolean;
  private vrActive = false;
  private vrSupported = false;

  private leftThumbstick: [number, number] = [0, 0];
  private rightThumbstick: [number, number] = [0, 0];
  private leftTrigger = false;
  private rightTrigger = false;
  private leftSqueeze = false;
  private rightSqueeze = false;

  private headsetPosition: [number, number, number] = [0, 0, 0];
  private headsetRotation: [number, number, number, number] = [0, 0, 0, 1];

  constructor(config: VRModuleConfig) {
    this.renderer = config.renderer;
    this.sim = config.sim;
    this.moveSpeed = config.moveSpeed ?? 3;
    this.smoothLocomotion = config.smoothLocomotion ?? true;
  }

  async checkSupport(): Promise<boolean> {
    try {
      this.vrSupported = await isVRSupported();
      return this.vrSupported;
    } catch {
      return false;
    }
  }

  isSupported(): boolean { return this.vrSupported; }
  isActive(): boolean { return this.vrActive; }

  async enterVR(config?: XRSessionConfig): Promise<void> {
    if (!this.xrModule) {
      const device = this.renderer.getDevice();
      if (!device) throw new Error("GPU device not available");
      this.xrModule = new XRModule({
        device,
        colorFormat: this.renderer.getFormat(),
        depthFormat: "depth32float" as GPUTextureFormat,
        worldOrigin: () => ({
          position: this.renderer.getCameraPosition(),
          quaternion: [0, 0, 0, 1],
        }),
      });
    }
    await this.xrModule.enterVR(config);
    this.vrActive = true;
    console.log("[VR] Entered VR mode");
  }

  async exitVR(): Promise<void> {
    this.vrActive = false;
    console.log("[VR] Exited VR mode");
  }

  async toggleVR(): Promise<void> {
    if (this.vrActive) await this.exitVR();
    else await this.enterVR();
  }

  updateControllerInput(
    left: { thumbstick: [number, number]; trigger: boolean; squeeze: boolean },
    right: { thumbstick: [number, number]; trigger: boolean; squeeze: boolean },
  ): void {
    this.leftThumbstick = left.thumbstick;
    this.rightThumbstick = right.thumbstick;
    this.leftTrigger = left.trigger;
    this.rightTrigger = right.trigger;
    this.leftSqueeze = left.squeeze;
    this.rightSqueeze = right.squeeze;
  }

  updateHeadsetPose(position: [number, number, number], rotation: [number, number, number, number]): void {
    this.headsetPosition = position;
    this.headsetRotation = rotation;
  }

  tick(dt: number): void {
    if (!this.vrActive || !this.smoothLocomotion) return;
    const [axisX, axisY] = this.leftThumbstick;
    if (Math.abs(axisX) > 0.1 || Math.abs(axisY) > 0.1) {
      const cam = this.renderer.getCameraPosition();
      const yaw = this.extractYaw(this.headsetRotation);
      const forward: [number, number, number] = [Math.sin(yaw), 0, -Math.cos(yaw)];
      const right: [number, number, number] = [Math.cos(yaw), 0, Math.sin(yaw)];
      const speed = this.moveSpeed * dt;
      const nx = cam[0] + forward[0] * (-axisY) * speed + right[0] * axisX * speed;
      const nz = cam[2] + forward[2] * (-axisY) * speed + right[2] * axisX * speed;
      this.renderer.setCameraPosition([nx, cam[1], nz]);
    }
  }

  private extractYaw(q: [number, number, number, number]): number {
    const [x, y, z, w] = q;
    return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
  }

  getVRToolMapping(): { left: ToolType; right: ToolType } {
    return { left: ToolType.Physgun, right: ToolType.Pistol };
  }

  dispose(): void {
    this.xrModule = null;
    this.vrActive = false;
  }
}
