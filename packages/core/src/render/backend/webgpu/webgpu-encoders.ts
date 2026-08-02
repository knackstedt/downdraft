// ============================================================================
// WebGPU Command Encoder + Render Pass — wraps GPUCommandEncoder and
// GPURenderPassEncoder behind backend interfaces.
// ============================================================================

import type {
    BackendBindGroup,
    BackendBuffer,
    BackendCommandBuffer,
    BackendCommandEncoder,
    BackendComputePassEncoder,
    BackendRenderPassEncoder,
    BackendRenderPipeline,
    BackendTexture,
    IndexFormat,
    RenderPassDescriptor,
} from "../types.ts";

// ─── Command Buffer ────────────────────────────────────────────────────────

export class WebGPUCommandBuffer implements BackendCommandBuffer {
  constructor(private _buffer: GPUCommandBuffer) {}

  getNative(): unknown {
    return this._buffer;
  }

  get gpuCommandBuffer(): GPUCommandBuffer {
    return this._buffer;
  }
}

// ─── Command Encoder ───────────────────────────────────────────────────────

export class WebGPUCommandEncoder implements BackendCommandEncoder {
  constructor(private _encoder: GPUCommandEncoder) {}

  beginRenderPass(descriptor: RenderPassDescriptor): BackendRenderPassEncoder {
    const gpuDesc: GPURenderPassDescriptor = {
      colorAttachments: descriptor.colorAttachments.map(a => ({
        view: (a.view as unknown as { gpuView: GPUTextureView }).gpuView,
        depthSlice: a.depthSlice,
        resolveTarget: a.resolveTarget
          ? (a.resolveTarget as unknown as { gpuView: GPUTextureView }).gpuView
          : undefined,
        loadOp: a.loadOp,
        storeOp: a.storeOp,
        clearValue: a.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
      })),
      depthStencilAttachment: descriptor.depthStencilAttachment
        ? {
            view: (descriptor.depthStencilAttachment.view as unknown as { gpuView: GPUTextureView }).gpuView,
            depthLoadOp: descriptor.depthStencilAttachment.depthLoadOp,
            depthStoreOp: descriptor.depthStencilAttachment.depthStoreOp,
            depthClearValue: descriptor.depthStencilAttachment.depthClearValue ?? 1.0,
            depthReadOnly: descriptor.depthStencilAttachment.depthReadOnly ?? false,
            stencilLoadOp: descriptor.depthStencilAttachment.stencilLoadOp,
            stencilStoreOp: descriptor.depthStencilAttachment.stencilStoreOp,
            stencilClearValue: descriptor.depthStencilAttachment.stencilClearValue ?? 0,
            stencilReadOnly: descriptor.depthStencilAttachment.stencilReadOnly ?? false,
          }
        : undefined,
    };

    const pass = this._encoder.beginRenderPass(gpuDesc);
    return new WebGPURenderPassEncoder(pass);
  }

  beginComputePass(descriptor?: { label?: string }): BackendComputePassEncoder {
    const pass = this._encoder.beginComputePass(descriptor);
    return new WebGPUComputePassEncoder(pass);
  }

  copyBufferToBuffer(
    source: BackendBuffer,
    sourceOffset: number,
    destination: BackendBuffer,
    destinationOffset: number,
    size: number,
  ): void {
    this._encoder.copyBufferToBuffer(
      (source as unknown as WebGPUBuffer).gpuBuffer,
      sourceOffset,
      (destination as unknown as WebGPUBuffer).gpuBuffer,
      destinationOffset,
      size,
    );
  }

  copyBufferToTexture(
    source: { buffer: BackendBuffer; offset: number; bytesPerRow: number; rowsPerImage?: number },
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    copySize: [number, number, number] | [number, number] | number,
  ): void {
    this._encoder.copyBufferToTexture(
      {
        buffer: (source.buffer as unknown as WebGPUBuffer).gpuBuffer,
        offset: source.offset,
        bytesPerRow: source.bytesPerRow,
        rowsPerImage: source.rowsPerImage,
      },
      {
        texture: (destination.texture as unknown as WebGPUTexture).gpuTexture,
        mipLevel: destination.mipLevel,
        origin: destination.origin as GPUOrigin3D,
      },
      copySize as GPUExtent3D,
    );
  }

  copyTextureToBuffer(
    source: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    destination: { buffer: BackendBuffer; offset: number; bytesPerRow: number; rowsPerImage?: number },
    copySize: [number, number, number] | [number, number] | number,
  ): void {
    this._encoder.copyTextureToBuffer(
      {
        texture: (source.texture as unknown as WebGPUTexture).gpuTexture,
        mipLevel: source.mipLevel,
        origin: source.origin as GPUOrigin3D,
      },
      {
        buffer: (destination.buffer as unknown as WebGPUBuffer).gpuBuffer,
        offset: destination.offset,
        bytesPerRow: destination.bytesPerRow,
        rowsPerImage: destination.rowsPerImage,
      },
      copySize as GPUExtent3D,
    );
  }

  copyTextureToTexture(
    source: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    copySize: [number, number, number] | [number, number] | number,
  ): void {
    this._encoder.copyTextureToTexture(
      {
        texture: (source.texture as unknown as WebGPUTexture).gpuTexture,
        mipLevel: source.mipLevel,
        origin: source.origin as GPUOrigin3D,
      },
      {
        texture: (destination.texture as unknown as WebGPUTexture).gpuTexture,
        mipLevel: destination.mipLevel,
        origin: destination.origin as GPUOrigin3D,
      },
      copySize as GPUExtent3D,
    );
  }

  finish(): BackendCommandBuffer {
    return new WebGPUCommandBuffer(this._encoder.finish());
  }

  getNative(): unknown {
    return this._encoder;
  }

  get gpuEncoder(): GPUCommandEncoder {
    return this._encoder;
  }
}

// ─── Render Pass Encoder ───────────────────────────────────────────────────

export class WebGPURenderPassEncoder implements BackendRenderPassEncoder {
  constructor(private _pass: GPURenderPassEncoder) {}

  setPipeline(pipeline: BackendRenderPipeline): void {
    this._pass.setPipeline((pipeline as unknown as { gpuPipeline: GPURenderPipeline }).gpuPipeline);
  }

  setBindGroup(index: number, bindGroup: BackendBindGroup, dynamicOffsets?: number[]): void {
    this._pass.setBindGroup(
      index,
      (bindGroup as unknown as { gpuGroup: GPUBindGroup }).gpuGroup,
      dynamicOffsets ?? [],
    );
  }

  setVertexBuffer(slot: number, buffer: BackendBuffer, offset: number = 0): void {
    this._pass.setVertexBuffer(slot, (buffer as unknown as WebGPUBuffer).gpuBuffer, offset);
  }

  setIndexBuffer(buffer: BackendBuffer, format: IndexFormat, offset: number = 0): void {
    this._pass.setIndexBuffer((buffer as unknown as WebGPUBuffer).gpuBuffer, format, offset);
  }

  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number,
  ): void {
    this._pass.setViewport(x, y, width, height, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    this._pass.setScissorRect(x, y, width, height);
  }

  setBlendColor(_r: number, _g: number, _b: number, _a: number): void {
    // setBlendColor is not part of the WebGPU render pass encoder API
    // Blend constants are set via the pipeline in WebGPU
  }

  setStencilReference(reference: number): void {
    this._pass.setStencilReference(reference);
  }

  draw(
    vertexCount: number,
    instanceCount: number = 1,
    firstVertex: number = 0,
    firstInstance: number = 0,
  ): void {
    this._pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(
    indexCount: number,
    instanceCount: number = 1,
    firstIndex: number = 0,
    baseVertex: number = 0,
    firstInstance: number = 0,
  ): void {
    this._pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  }

  drawIndirect(indirectBuffer: BackendBuffer, indirectOffset: number): void {
    this._pass.drawIndirect((indirectBuffer as unknown as WebGPUBuffer).gpuBuffer, indirectOffset);
  }

  drawIndexedIndirect(indirectBuffer: BackendBuffer, indirectOffset: number): void {
    this._pass.drawIndexedIndirect((indirectBuffer as unknown as WebGPUBuffer).gpuBuffer, indirectOffset);
  }

  end(): void {
    this._pass.end();
  }

  getNative(): unknown {
    return this._pass;
  }

  get gpuPass(): GPURenderPassEncoder {
    return this._pass;
  }
}

// ─── Compute Pass Encoder ──────────────────────────────────────────────────

export class WebGPUComputePassEncoder implements BackendComputePassEncoder {
  constructor(private _pass: GPUComputePassEncoder) {}

  setPipeline(pipeline: unknown): void {
    this._pass.setPipeline(pipeline as GPUComputePipeline);
  }

  setBindGroup(index: number, bindGroup: BackendBindGroup, dynamicOffsets?: number[]): void {
    this._pass.setBindGroup(
      index,
      (bindGroup as unknown as { gpuGroup: GPUBindGroup }).gpuGroup,
      dynamicOffsets ?? [],
    );
  }

  dispatchWorkgroups(x: number, y: number = 1, z: number = 1): void {
    this._pass.dispatchWorkgroups(x, y, z);
  }

  dispatchWorkgroupsIndirect(indirectBuffer: BackendBuffer, indirectOffset: number): void {
    this._pass.dispatchWorkgroupsIndirect(
      (indirectBuffer as unknown as WebGPUBuffer).gpuBuffer,
      indirectOffset,
    );
  }

  end(): void {
    this._pass.end();
  }

  getNative(): unknown {
    return this._pass;
  }

  get gpuPass(): GPUComputePassEncoder {
    return this._pass;
  }
}

// Import WebGPUBuffer and WebGPUTexture for type access
import type { WebGPUBuffer, WebGPUTexture } from "./webgpu-resources.ts";

