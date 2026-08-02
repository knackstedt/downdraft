// ============================================================================
// WebGL2 Command Encoder + Render Pass — records GPU commands into a list
// that is replayed on submit. WebGL2 is immediate-mode so we must record
// all state changes and draw calls, then execute them on the GL context.
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
    RenderPassDescriptor
} from "../types.ts";
import {
    WebGL2BindGroup,
    WebGL2Buffer,
    WebGL2RenderPipeline,
    WebGL2Texture
} from "./webgl2-resources.ts";

// ─── Command Types ─────────────────────────────────────────────────────────

export type Command =
  | { type: "beginRenderPass"; desc: RenderPassDescriptor }
  | { type: "endRenderPass" }
  | { type: "setPipeline"; pipeline: WebGL2RenderPipeline }
  | { type: "setBindGroup"; index: number; group: WebGL2BindGroup; dynamicOffsets: number[] }
  | { type: "setVertexBuffer"; slot: number; buffer: WebGL2Buffer; offset: number }
  | { type: "setIndexBuffer"; buffer: WebGL2Buffer; format: IndexFormat; offset: number }
  | { type: "setViewport"; x: number; y: number; w: number; h: number; minD: number; maxD: number }
  | { type: "setScissor"; x: number; y: number; w: number; h: number }
  | { type: "draw"; vertexCount: number; instanceCount: number; firstVertex: number; firstInstance: number }
  | { type: "drawIndexed"; indexCount: number; instanceCount: number; firstIndex: number; baseVertex: number; firstInstance: number }
  | { type: "copyBufferToBuffer"; src: WebGL2Buffer; srcOffset: number; dst: WebGL2Buffer; dstOffset: number; size: number }
  | { type: "copyBufferToTexture"; srcBuf: WebGL2Buffer; srcOffset: number; bytesPerRow: number; rowsPerImage: number; dstTex: WebGL2Texture; mipLevel: number; origin: number[]; copySize: number[] }
  | { type: "copyTextureToBuffer"; srcTex: WebGL2Texture; mipLevel: number; origin: number[]; dstBuf: WebGL2Buffer; dstOffset: number; bytesPerRow: number; rowsPerImage: number; copySize: number[] }
  | { type: "copyTextureToTexture"; srcTex: WebGL2Texture; srcMip: number; srcOrigin: number[]; dstTex: WebGL2Texture; dstMip: number; dstOrigin: number[]; copySize: number[] };

// ─── Command Buffer ────────────────────────────────────────────────────────

export class WebGL2CommandBuffer implements BackendCommandBuffer {
  constructor(
    private _commands: Command[],
  ) {}

  get commands(): Command[] {
    return this._commands;
  }

  getNative(): unknown {
    return this._commands;
  }
}

// ─── Render Pass Encoder ───────────────────────────────────────────────────

export class WebGL2RenderPassEncoder implements BackendRenderPassEncoder {
  private _commands: Command[];
  private _ended = false;

  constructor(
    commands: Command[],
    descriptor: RenderPassDescriptor,
  ) {
    this._commands = commands;
    this._commands.push({ type: "beginRenderPass", desc: descriptor });
  }

  setPipeline(pipeline: BackendRenderPipeline): void {
    if (this._ended) return;
    const p = pipeline as WebGL2RenderPipeline;
    this._commands.push({ type: "setPipeline", pipeline: p });
  }

  setBindGroup(index: number, bindGroup: BackendBindGroup, dynamicOffsets: number[] = []): void {
    if (this._ended) return;
    const bg = bindGroup as WebGL2BindGroup;
    this._commands.push({ type: "setBindGroup", index, group: bg, dynamicOffsets });
  }

  setVertexBuffer(slot: number, buffer: BackendBuffer, offset: number = 0): void {
    if (this._ended) return;
    const buf = buffer as WebGL2Buffer;
    this._commands.push({ type: "setVertexBuffer", slot, buffer: buf, offset });
  }

  setIndexBuffer(buffer: BackendBuffer, format: IndexFormat, offset: number = 0): void {
    if (this._ended) return;
    const buf = buffer as WebGL2Buffer;
    this._commands.push({ type: "setIndexBuffer", buffer: buf, format, offset });
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    if (this._ended) return;
    this._commands.push({ type: "setViewport", x, y, w: width, h: height, minD: minDepth, maxD: maxDepth });
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    if (this._ended) return;
    this._commands.push({ type: "setScissor", x, y, w: width, h: height });
  }

  setBlendColor(_r: number, _g: number, _b: number, _a: number): void {
    // WebGL2 blend color is set via gl.blendColor — recorded as part of pipeline state
    // For now, this is a no-op since blend color is rarely used
  }

  setStencilReference(reference: number): void {
    if (this._ended) return;
    // Stored in the command list and applied during replay
    // For simplicity, we don't record this separately — it's part of pipeline state
    void reference;
  }

  draw(vertexCount: number, instanceCount: number = 1, firstVertex: number = 0, firstInstance: number = 0): void {
    if (this._ended) return;
    this._commands.push({ type: "draw", vertexCount, instanceCount, firstVertex, firstInstance });
  }

  drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0, baseVertex: number = 0, firstInstance: number = 0): void {
    if (this._ended) return;
    this._commands.push({ type: "drawIndexed", indexCount, instanceCount, firstIndex, baseVertex, firstInstance });
  }

  drawIndirect(_indirectBuffer: BackendBuffer, _indirectOffset: number): void {
    // WebGL2 doesn't have native indirect draws — would need CPU emulation
    // This is a stub for now
  }

  drawIndexedIndirect(_indirectBuffer: BackendBuffer, _indirectOffset: number): void {
    // WebGL2 doesn't have native indirect draws — would need CPU emulation
    // This is a stub for now
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    this._commands.push({ type: "endRenderPass" });
  }

  getNative(): unknown {
    return this._commands;
  }
}

// ─── Compute Pass Encoder (stub — WebGL2 has no compute) ───────────────────

export class WebGL2ComputePassEncoder implements BackendComputePassEncoder {
  setPipeline(_pipeline: unknown): void {
    // No compute in WebGL2
  }

  setBindGroup(_index: number, _bindGroup: BackendBindGroup, _dynamicOffsets?: number[]): void {
    // No compute in WebGL2
  }

  dispatchWorkgroups(_x: number, _y?: number, _z?: number): void {
    // No compute in WebGL2
  }

  dispatchWorkgroupsIndirect(_indirectBuffer: BackendBuffer, _indirectOffset: number): void {
    // No compute in WebGL2
  }

  end(): void {
    // No compute in WebGL2
  }

  getNative(): unknown {
    return null;
  }
}

// ─── Command Encoder ───────────────────────────────────────────────────────

export class WebGL2CommandEncoder implements BackendCommandEncoder {
  private _commands: Command[] = [];

  beginRenderPass(descriptor: RenderPassDescriptor): BackendRenderPassEncoder {
    return new WebGL2RenderPassEncoder(this._commands, descriptor);
  }

  beginComputePass(_descriptor?: { label?: string }): BackendComputePassEncoder {
    return new WebGL2ComputePassEncoder();
  }

  copyBufferToBuffer(
    source: BackendBuffer,
    sourceOffset: number,
    destination: BackendBuffer,
    destinationOffset: number,
    size: number,
  ): void {
    const src = source as WebGL2Buffer;
    const dst = destination as WebGL2Buffer;
    this._commands.push({
      type: "copyBufferToBuffer",
      src, srcOffset: sourceOffset, dst, dstOffset: destinationOffset, size,
    });
  }

  copyBufferToTexture(
    source: { buffer: BackendBuffer; offset: number; bytesPerRow: number; rowsPerImage?: number },
    destination: { texture: BackendTexture; mipLevel: number; origin: number[] | number },
    _copySize: number[] | number,
  ): void {
    const srcBuf = source.buffer as WebGL2Buffer;
    const dstTex = destination.texture as WebGL2Texture;
    const origin = Array.isArray(destination.origin) ? destination.origin : [destination.origin, 0, 0];
    this._commands.push({
      type: "copyBufferToTexture",
      srcBuf, srcOffset: source.offset, bytesPerRow: source.bytesPerRow, rowsPerImage: source.rowsPerImage ?? 0,
      dstTex, mipLevel: destination.mipLevel, origin, copySize: Array.isArray(_copySize) ? _copySize : [_copySize, 1, 1],
    });
  }

  copyTextureToBuffer(
    source: { texture: BackendTexture; mipLevel: number; origin: number[] | number },
    destination: { buffer: BackendBuffer; offset: number; bytesPerRow: number; rowsPerImage?: number },
    _copySize: number[] | number,
  ): void {
    const srcTex = source.texture as WebGL2Texture;
    const dstBuf = destination.buffer as WebGL2Buffer;
    const origin = Array.isArray(source.origin) ? source.origin : [source.origin, 0, 0];
    this._commands.push({
      type: "copyTextureToBuffer",
      srcTex, mipLevel: source.mipLevel, origin,
      dstBuf, dstOffset: destination.offset, bytesPerRow: destination.bytesPerRow, rowsPerImage: destination.rowsPerImage ?? 0,
      copySize: Array.isArray(_copySize) ? _copySize : [_copySize, 1, 1],
    });
  }

  copyTextureToTexture(
    source: { texture: BackendTexture; mipLevel: number; origin: number[] | number },
    destination: { texture: BackendTexture; mipLevel: number; origin: number[] | number },
    _copySize: number[] | number,
  ): void {
    const srcTex = source.texture as WebGL2Texture;
    const dstTex = destination.texture as WebGL2Texture;
    const srcOrigin = Array.isArray(source.origin) ? source.origin : [source.origin, 0, 0];
    const dstOrigin = Array.isArray(destination.origin) ? destination.origin : [destination.origin, 0, 0];
    this._commands.push({
      type: "copyTextureToTexture",
      srcTex, srcMip: source.mipLevel, srcOrigin,
      dstTex, dstMip: destination.mipLevel, dstOrigin,
      copySize: Array.isArray(_copySize) ? _copySize : [_copySize, 1, 1],
    });
  }

  finish(): BackendCommandBuffer {
    const cmds = this._commands;
    this._commands = [];
    return new WebGL2CommandBuffer(cmds);
  }

  getNative(): unknown {
    return this._commands;
  }
}
