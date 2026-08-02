// ============================================================================
// WebGPU Queue — wraps GPUQueue behind the BackendQueue interface.
// ============================================================================

import type {
  BackendQueue,
  BackendCommandBuffer,
  BackendBuffer,
  BackendTexture,
} from "../types.ts";
import type { WebGPUCommandBuffer } from "./webgpu-encoders.ts";
import type { WebGPUBuffer } from "./webgpu-resources.ts";
import type { WebGPUTexture } from "./webgpu-resources.ts";

export class WebGPUQueue implements BackendQueue {
  constructor(private _queue: GPUQueue) {}

  submit(commandBuffers: BackendCommandBuffer[]): void {
    const buffers = commandBuffers.map(
      (cb) => (cb as unknown as WebGPUCommandBuffer).gpuCommandBuffer,
    );
    this._queue.submit(buffers);
  }

  writeBuffer(buffer: BackendBuffer, offset: number, data: BufferSource): void {
    this._queue.writeBuffer((buffer as unknown as WebGPUBuffer).gpuBuffer, offset, data);
  }

  writeTexture(
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    data: BufferSource,
    dataLayout: { offset: number; bytesPerRow: number; rowsPerImage?: number },
    size: [number, number, number] | [number, number] | number,
  ): void {
    this._queue.writeTexture(
      {
        texture: (destination.texture as unknown as WebGPUTexture).gpuTexture,
        mipLevel: destination.mipLevel,
        origin: destination.origin as GPUOrigin3D,
      },
      data,
      dataLayout,
      size as GPUExtent3D,
    );
  }

  copyExternalImageToTexture(
    source: { source: CanvasImageSource | OffscreenCanvas; flipY?: boolean },
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    copySize: [number, number, number] | [number, number] | number,
  ): void {
    this._queue.copyExternalImageToTexture(
      source as GPUImageCopyExternalImage,
      {
        texture: (destination.texture as unknown as WebGPUTexture).gpuTexture,
        mipLevel: destination.mipLevel,
        origin: destination.origin as GPUOrigin3D,
      },
      copySize as GPUExtent3D,
    );
  }

  onSubmittedWorkDone(): Promise<void> {
    return this._queue.onSubmittedWorkDone();
  }

  getNative(): unknown {
    return this._queue;
  }

  get gpuQueue(): GPUQueue {
    return this._queue;
  }
}
