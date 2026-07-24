export class TrackedRenderPass {
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

  constructor(pass: GPURenderPassEncoder) {
    this.pass = pass;
  }

  setPipeline(pipeline: GPURenderPipeline): void {
    if (this.state.pipeline !== pipeline) {
      this.pass.setPipeline(pipeline);
      this.state.pipeline = pipeline;
    }
  }

  setBindGroup(index: number, group: GPUBindGroup, dynamicOffsets?: number[]): void {
    const existing = this.state.bindGroups.get(index);
    if (existing !== group) {
      this.pass.setBindGroup(index, group, dynamicOffsets ?? []);
      this.state.bindGroups.set(index, group);
    }
  }

  setVertexBuffer(slot: number, buffer: GPUBuffer, offset: number = 0): void {
    const existing = this.state.vertexBuffers.get(slot);
    if (existing !== buffer) {
      this.pass.setVertexBuffer(slot, buffer, offset);
      this.state.vertexBuffers.set(slot, buffer);
    }
  }

  setIndexBuffer(buffer: GPUBuffer, format: GPUIndexFormat, offset: number = 0): void {
    if (this.state.indexBuffer !== buffer || this.state.indexFormat !== format) {
      this.pass.setIndexBuffer(buffer, format, offset);
      this.state.indexBuffer = buffer;
      this.state.indexFormat = format;
    }
  }

  draw(vertexCount: number, instanceCount: number = 1, firstVertex: number = 0, firstInstance: number = 0): void {
    this.pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0, baseVertex: number = 0, firstInstance: number = 0): void {
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  }

  end(): void {
    this.pass.end();
  }

  getRawPass(): GPURenderPassEncoder {
    return this.pass;
  }
}
