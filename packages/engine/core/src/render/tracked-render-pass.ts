export interface ITrackedRenderPass {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly pipelineSwitches: number;
  readonly bindGroupChanges: number;
  readonly bufferRebinds: number;
  resetStats(): void;
  setPipeline(pipeline: GPURenderPipeline | unknown): void;
  setBindGroup(index: number, group: GPUBindGroup | unknown, dynamicOffsets?: number[]): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer | unknown, offset?: number): void;
  setIndexBuffer(buffer: GPUBuffer | unknown, format: GPUIndexFormat | unknown, offset?: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  drawIndirect(indirectBuffer: GPUBuffer | unknown, indirectOffset?: number): void;
  drawIndexedIndirect(indirectBuffer: GPUBuffer | unknown, indirectOffset?: number): void;
  end(): void;
  getRawPass(): GPURenderPassEncoder | unknown;
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

  /**
   * Rebind to a fresh GPURenderPassEncoder and clear stats/state so this
   * wrapper can be reused instead of allocating one per pass per frame.
   * (FrameGraph keeps a per-slot pool.)
   */
  resetForReuse(pass: GPURenderPassEncoder): void {
    this.pass = pass;
    this.state.pipeline = null;
    this.state.bindGroups.clear();
    this.state.vertexBuffers.clear();
    this.state.indexBuffer = null;
    this.state.indexFormat = null;
    this._drawCalls = 0;
    this._triangles = 0;
    this._pipelineSwitches = 0;
    this._bindGroupChanges = 0;
    this._bufferRebinds = 0;
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

  setPipeline(pipeline: GPURenderPipeline): void {
    if (this.state.pipeline !== pipeline) {
      this.pass.setPipeline(pipeline);
      this.state.pipeline = pipeline;
      this._pipelineSwitches++;
    }
  }

  setBindGroup(index: number, group: GPUBindGroup, dynamicOffsets?: number[]): void {
    const existing = this.state.bindGroups.get(index);
    if (existing !== group) {
      this.pass.setBindGroup(index, group, dynamicOffsets ?? []);
      this.state.bindGroups.set(index, group);
      this._bindGroupChanges++;
    }
  }

  setVertexBuffer(slot: number, buffer: GPUBuffer, offset: number = 0): void {
    const existing = this.state.vertexBuffers.get(slot);
    if (existing !== buffer) {
      this.pass.setVertexBuffer(slot, buffer, offset);
      this.state.vertexBuffers.set(slot, buffer);
      this._bufferRebinds++;
    }
  }

  setIndexBuffer(buffer: GPUBuffer, format: GPUIndexFormat, offset: number = 0): void {
    if (this.state.indexBuffer !== buffer || this.state.indexFormat !== format) {
      this.pass.setIndexBuffer(buffer, format, offset);
      this.state.indexBuffer = buffer;
      this.state.indexFormat = format;
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

  drawIndirect(indirectBuffer: GPUBuffer, indirectOffset: number = 0): void {
    this.pass.drawIndirect(indirectBuffer, indirectOffset);
    this._drawCalls++;
    // Indirect arg counts are on the GPU; triangle count is not available synchronously.
  }

  drawIndexedIndirect(indirectBuffer: GPUBuffer, indirectOffset: number = 0): void {
    this.pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    this._drawCalls++;
    // Indirect arg counts are on the GPU; triangle count is not available synchronously.
  }

  end(): void {
    this.pass.end();
  }

  getRawPass(): GPURenderPassEncoder {
    return this.pass;
  }
}
