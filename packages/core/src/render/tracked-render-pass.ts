import type {
    BackendBindGroup,
    BackendBuffer,
    BackendRenderPassEncoder,
    BackendRenderPipeline,
    IndexFormat,
} from "./backend/types.ts";

/**
 * Interface for tracked render pass state tracking.
 * Implemented by both TrackedRenderPass (WebGPU) and BackendTrackedRenderPass (backend-agnostic).
 * Passes use ctx.pass via this interface — the underlying implementation depends on which backend is active.
 */
export interface ITrackedRenderPass {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly pipelineSwitches: number;
  readonly bindGroupChanges: number;
  readonly bufferRebinds: number;

  resetStats(): void;

  setPipeline(pipeline: GPURenderPipeline | BackendRenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup | BackendBindGroup, dynamicOffsets?: number[]): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer | BackendBuffer, offset?: number): void;
  setIndexBuffer(buffer: GPUBuffer | BackendBuffer, format: GPUIndexFormat | IndexFormat, offset?: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  end(): void;
}

export class TrackedRenderPass implements ITrackedRenderPass {
  private state: {
    pipeline: GPURenderPipeline | null;
    bindGroups: Map<number, GPUBindGroup>;
    vertexBuffers: Map<number, GPUBuffer>;
    indexBuffer: GPUBuffer | null;
    indexFormat: GPUIndexFormat | null;
  } = {
    pipeline: null,
    bindGroups: new Map(),
    vertexBuffers: new Map(),
    indexBuffer: null,
    indexFormat: null,
  };
  private pass: GPURenderPassEncoder;
  private _drawCalls: number = 0;
  private _triangles: number = 0;
  private _pipelineSwitches: number = 0;
  private _bindGroupChanges: number = 0;
  private _bufferRebinds: number = 0;

  constructor(pass: GPURenderPassEncoder) {
    this.pass = pass;
  }

  get drawCalls(): number {
    return this._drawCalls;
  }

  get triangles(): number {
    return this._triangles;
  }

  get pipelineSwitches(): number {
    return this._pipelineSwitches;
  }

  get bindGroupChanges(): number {
    return this._bindGroupChanges;
  }

  get bufferRebinds(): number {
    return this._bufferRebinds;
  }

  resetStats(): void {
    this._drawCalls = 0;
    this._triangles = 0;
    this._pipelineSwitches = 0;
    this._bindGroupChanges = 0;
    this._bufferRebinds = 0;
  }

  setPipeline(pipeline: GPURenderPipeline | BackendRenderPipeline): void {
    if (this.state.pipeline !== pipeline) {
      this.pass.setPipeline(pipeline as GPURenderPipeline);
      this.state.pipeline = pipeline as GPURenderPipeline;
      this._pipelineSwitches++;
    }
  }

  setBindGroup(index: number, group: GPUBindGroup | BackendBindGroup, dynamicOffsets?: number[]): void {
    const existing = this.state.bindGroups.get(index);
    if (existing !== group) {
      this.pass.setBindGroup(index, group as GPUBindGroup, dynamicOffsets ?? []);
      this.state.bindGroups.set(index, group as GPUBindGroup);
      this._bindGroupChanges++;
    }
  }

  setVertexBuffer(slot: number, buffer: GPUBuffer | BackendBuffer, offset: number = 0): void {
    const existing = this.state.vertexBuffers.get(slot);
    if (existing !== buffer) {
      this.pass.setVertexBuffer(slot, buffer as GPUBuffer, offset);
      this.state.vertexBuffers.set(slot, buffer as GPUBuffer);
      this._bufferRebinds++;
    }
  }

  setIndexBuffer(buffer: GPUBuffer | BackendBuffer, format: GPUIndexFormat | IndexFormat, offset: number = 0): void {
    if (this.state.indexBuffer !== buffer || this.state.indexFormat !== format) {
      this.pass.setIndexBuffer(buffer as GPUBuffer, format as GPUIndexFormat, offset);
      this.state.indexBuffer = buffer as GPUBuffer;
      this.state.indexFormat = format as GPUIndexFormat;
      this._bufferRebinds++;
    }
  }

  draw(vertexCount: number, instanceCount: number = 1, firstVertex: number = 0, firstInstance: number = 0): void {
    this.pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    this._drawCalls++;
    this._triangles += Math.floor(vertexCount / 3) * instanceCount;
  }

  drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0, baseVertex: number = 0, firstInstance: number = 0): void {
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    this._drawCalls++;
    this._triangles += Math.floor(indexCount / 3) * instanceCount;
  }

  end(): void {
    this.pass.end();
  }

  getRawPass(): GPURenderPassEncoder {
    return this.pass;
  }
}

/**
 * Backend-agnostic TrackedRenderPass that wraps a BackendRenderPassEncoder.
 * Provides the same state-tracking and stats as TrackedRenderPass but uses backend-agnostic types.
 */
export class BackendTrackedRenderPass implements ITrackedRenderPass {
  private state: {
    pipeline: BackendRenderPipeline | null;
    bindGroups: Map<number, BackendBindGroup>;
    vertexBuffers: Map<number, BackendBuffer>;
    indexBuffer: BackendBuffer | null;
    indexFormat: IndexFormat | null;
  } = {
    pipeline: null,
    bindGroups: new Map(),
    vertexBuffers: new Map(),
    indexBuffer: null,
    indexFormat: null,
  };
  private pass: BackendRenderPassEncoder;
  private _drawCalls: number = 0;
  private _triangles: number = 0;
  private _pipelineSwitches: number = 0;
  private _bindGroupChanges: number = 0;
  private _bufferRebinds: number = 0;

  constructor(pass: BackendRenderPassEncoder) {
    this.pass = pass;
  }

  get drawCalls(): number {
    return this._drawCalls;
  }

  get triangles(): number {
    return this._triangles;
  }

  get pipelineSwitches(): number {
    return this._pipelineSwitches;
  }

  get bindGroupChanges(): number {
    return this._bindGroupChanges;
  }

  get bufferRebinds(): number {
    return this._bufferRebinds;
  }

  resetStats(): void {
    this._drawCalls = 0;
    this._triangles = 0;
    this._pipelineSwitches = 0;
    this._bindGroupChanges = 0;
    this._bufferRebinds = 0;
  }

  setPipeline(pipeline: GPURenderPipeline | BackendRenderPipeline): void {
    if (this.state.pipeline !== pipeline) {
      this.pass.setPipeline(pipeline as BackendRenderPipeline);
      this.state.pipeline = pipeline as BackendRenderPipeline;
      this._pipelineSwitches++;
    }
  }

  setBindGroup(index: number, group: GPUBindGroup | BackendBindGroup, dynamicOffsets?: number[]): void {
    const existing = this.state.bindGroups.get(index);
    if (existing !== group) {
      this.pass.setBindGroup(index, group as BackendBindGroup, dynamicOffsets);
      this.state.bindGroups.set(index, group as BackendBindGroup);
      this._bindGroupChanges++;
    }
  }

  setVertexBuffer(slot: number, buffer: GPUBuffer | BackendBuffer, offset: number = 0): void {
    const existing = this.state.vertexBuffers.get(slot);
    if (existing !== buffer) {
      this.pass.setVertexBuffer(slot, buffer as BackendBuffer, offset);
      this.state.vertexBuffers.set(slot, buffer as BackendBuffer);
      this._bufferRebinds++;
    }
  }

  setIndexBuffer(buffer: GPUBuffer | BackendBuffer, format: GPUIndexFormat | IndexFormat, offset: number = 0): void {
    if (this.state.indexBuffer !== buffer || this.state.indexFormat !== format) {
      this.pass.setIndexBuffer(buffer as BackendBuffer, format as IndexFormat, offset);
      this.state.indexBuffer = buffer as BackendBuffer;
      this.state.indexFormat = format as IndexFormat;
      this._bufferRebinds++;
    }
  }

  draw(vertexCount: number, instanceCount: number = 1, firstVertex: number = 0, firstInstance: number = 0): void {
    this.pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    this._drawCalls++;
    this._triangles += Math.floor(vertexCount / 3) * instanceCount;
  }

  drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0, baseVertex: number = 0, firstInstance: number = 0): void {
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    this._drawCalls++;
    this._triangles += Math.floor(indexCount / 3) * instanceCount;
  }

  end(): void {
    this.pass.end();
  }

  getRawPass(): BackendRenderPassEncoder {
    return this.pass;
  }
}
