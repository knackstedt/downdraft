// ============================================================================
// OSR Texture Receiver Manager — Manages multiple OSRTextureReceiver instances
// ============================================================================

import { OSRTextureReceiver } from "./texture-receiver.ts";
import type { OSRSharedTexturePixelFormat } from "../types.ts";

export class OSRTextureReceiverManager {
  private device: GPUDevice;
  private receivers = new Map<string, OSRTextureReceiver>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  createReceiver(
    rendererId: string,
    width: number,
    height: number,
    pixelFormat: OSRSharedTexturePixelFormat,
  ): OSRTextureReceiver {
    if (this.receivers.has(rendererId)) {
      throw new Error(`Texture receiver '${rendererId}' already exists`);
    }

    const receiver = new OSRTextureReceiver(this.device, rendererId, width, height, pixelFormat);
    receiver.init();
    this.receivers.set(rendererId, receiver);
    return receiver;
  }

  destroyReceiver(rendererId: string): void {
    const receiver = this.receivers.get(rendererId);
    if (receiver) {
      receiver.destroy();
      this.receivers.delete(rendererId);
    }
  }

  getTextureView(rendererId: string): GPUTextureView | null {
    return this.receivers.get(rendererId)?.getTextureView() ?? null;
  }

  getTextureList(): { rendererId: string; textureView: GPUTextureView }[] {
    const list: { rendererId: string; textureView: GPUTextureView }[] = [];
    for (const [rendererId, receiver] of this.receivers) {
      const view = receiver.getTextureView();
      if (view) {
        list.push({ rendererId, textureView: view });
      }
    }
    return list;
  }

  getReceiverCount(): number {
    return this.receivers.size;
  }

  destroy(): void {
    for (const receiver of this.receivers.values()) {
      receiver.destroy();
    }
    this.receivers.clear();
  }
}
