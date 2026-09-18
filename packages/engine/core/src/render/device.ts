import { createLogger } from "../util/logger";
import { installShaderValidationGuard } from "./shader-validator";

const log = createLogger();

export interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export class GPUDeviceManager {
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private adapterInfo: GPUAdapterInfo | null = null;
  private deviceLost: boolean = false;
  private lostHandlers: Array<(info: GPUDeviceLostInfo) => void> = [];

  /**
   * Build requiredLimits for the bindless binding model. Values are clamped to
   * the adapter's reported limits so unsupported caps don't fail device request.
   */
  buildRequiredLimits(adapter: GPUAdapter): Record<string, number> {
    const a = adapter.limits as unknown as Record<string, number>;
    const clamp = (key: string, want: number): [string, number] | null => {
      const have = a[key];
      if (have === undefined) return null;
      return [key, Math.min(want, have)];
    };
    const entries: Array<[string, number]> = [];
    for (const e of [
      clamp("maxTextureArrayLayers", 512),
      clamp("maxStorageBuffersPerShaderStage", 8),
      clamp("maxStorageBufferBindingSize", 64 * 1024 * 1024),
      clamp("maxSampledTexturesPerShaderStage", 16),
    ]) {
      if (e) entries.push(e);
    }
    return Object.fromEntries(entries);
  }

  async requestDevice(): Promise<GPUDevice | null> {
    if (!navigator.gpu) {
      log.error("DownDraft", "WebGPU not available");
      return null;
    }

    this.adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });

    if (!this.adapter) {
      log.error("DownDraft", "No suitable GPU adapter found");
      return null;
    }

    this.adapterInfo = (this.adapter.info ?? {}) as GPUAdapterInfo;
    this.device = await this.adapter.requestDevice({
      requiredLimits: this.buildRequiredLimits(this.adapter),
    });

    if (this.device) {
      // Install the shader validation guard so all createShaderModule calls
      // route through getCompilationInfo() validation.
      installShaderValidationGuard(this.device);

      this.device.lost.then((info: GPUDeviceLostInfo) => {
        this.deviceLost = true;
        log.error("DownDraft", `GPU device lost: ${info?.message ?? "unknown reason"}. Application should attempt recovery or notify the user.`);
        for (let i = 0; i < this.lostHandlers.length; i++) {
          try {
            this.lostHandlers[i](info);
          } catch (err) {
            log.error("DownDraft", `Device lost handler threw: ${err}`);
          }
        }
      });
    }

    return this.device;
  }

  getDevice(): GPUDevice | null {
    return this.device;
  }

  getAdapter(): GPUAdapter | null {
    return this.adapter;
  }

  getAdapterInfo(): GPUAdapterInfo | null {
    return this.adapterInfo;
  }

  isDeviceLost(): boolean {
    return this.deviceLost;
  }

  async reinit(): Promise<GPUDevice | null> {
    log.warn("DownDraft", "Device lost — reinitializing GPU device. Pass-specific resources (pipelines, bind groups, textures) are NOT recreated and must be rebuilt by the application.");
    this.deviceLost = false;
    this.device = null;
    this.adapter = null;
    return this.requestDevice();
  }

  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): void {
    this.lostHandlers.push(fn);
  }
}
