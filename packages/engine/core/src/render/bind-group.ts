export class BindGroupCache {
  private cache: Map<string, GPUBindGroup> = new Map();
  private device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  getBindGroup(key: string): GPUBindGroup | undefined {
    return this.cache.get(key);
  }

  setBindGroup(key: string, group: GPUBindGroup): void {
    this.cache.set(key, group);
  }

  getOrCreate(key: string, create: () => GPUBindGroup): GPUBindGroup {
    let group = this.cache.get(key);
    if (!group) {
      group = create();
      this.cache.set(key, group);
    }
    return group;
  }

  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  /** Clear all cached bind groups. GPUBindGroup does not have .destroy(). */
  destroy(): void {
    this.cache.clear();
  }
}
