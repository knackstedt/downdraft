export class PipelineCache {
  private cache: Map<string, GPURenderPipeline> = new Map();
  private device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  getPipeline(key: string): GPURenderPipeline | undefined {
    return this.cache.get(key);
  }

  setPipeline(key: string, pipeline: GPURenderPipeline): void {
    this.cache.set(key, pipeline);
  }

  getOrCreate(key: string, create: () => GPURenderPipeline): GPURenderPipeline {
    let pipeline = this.cache.get(key);
    if (!pipeline) {
      pipeline = create();
      this.cache.set(key, pipeline);
    }
    return pipeline;
  }

  invalidate(key?: string): void {
    if (key) {
      const pipeline = this.cache.get(key);
      if (pipeline) {
        try {
          pipeline.destroy();
        } catch {
          // Pipeline may already be destroyed or invalid
        }
      }
      this.cache.delete(key);
    } else {
      for (const pipeline of this.cache.values()) {
        try {
          pipeline.destroy();
        } catch {
          // Pipeline may already be destroyed or invalid
        }
      }
      this.cache.clear();
    }
  }

  size(): number {
    return this.cache.size;
  }
}
