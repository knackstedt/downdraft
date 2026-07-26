import { createLogger } from "../util/logger.ts";

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
    this.device = await this.adapter.requestDevice();

    if (this.device) {
      this.device.lost.then((info: GPUDeviceLostInfo) => {
        this.deviceLost = true;
        for (let i = 0; i < this.lostHandlers.length; i++) {
          this.lostHandlers[i](info);
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
    this.deviceLost = false;
    this.device = null;
    this.adapter = null;
    return this.requestDevice();
  }

  onDeviceLost(fn: (info: GPUDeviceLostInfo) => void): void {
    this.lostHandlers.push(fn);
  }
}
