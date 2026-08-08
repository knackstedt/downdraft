export interface GPUCacheEntry {
  resource: GPUTexture | GPUBuffer;
  refCount: number;
  lastUsed: number;
  key: string;
}

export class GPUResourceCache {
  private textures: Map<string, GPUCacheEntry> = new Map();
  private buffers: Map<string, GPUCacheEntry> = new Map();
  private device: GPUDevice | null = null;
  private maxAge: number = 60000;
  private cleanupInterval: number | null = null;

  setDevice(device: GPUDevice): void {
    this.device = device;
  }

  getTexture(key: string): GPUTexture | null {
    const entry = this.textures.get(key);
    if (entry) {
      entry.refCount++;
      entry.lastUsed = Date.now();
      return entry.resource as GPUTexture;
    }
    return null;
  }

  cacheTexture(key: string, texture: GPUTexture): void {
    this.textures.set(key, {
      resource: texture,
      refCount: 1,
      lastUsed: Date.now(),
      key,
    });
  }

  releaseTexture(key: string): void {
    const entry = this.textures.get(key);
    if (entry) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        (entry.resource as GPUTexture).destroy();
        this.textures.delete(key);
      }
    }
  }

  getBuffer(key: string): GPUBuffer | null {
    const entry = this.buffers.get(key);
    if (entry) {
      entry.refCount++;
      entry.lastUsed = Date.now();
      return entry.resource as GPUBuffer;
    }
    return null;
  }

  cacheBuffer(key: string, buffer: GPUBuffer): void {
    this.buffers.set(key, {
      resource: buffer,
      refCount: 1,
      lastUsed: Date.now(),
      key,
    });
  }

  releaseBuffer(key: string): void {
    const entry = this.buffers.get(key);
    if (entry) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        (entry.resource as GPUBuffer).destroy();
        this.buffers.delete(key);
      }
    }
  }

  private genericResources: Map<string, { resource: unknown; cleanup: (() => Promise<void> | void) | null; refCount: number; lastUsed: number }> = new Map();

  register(key: string, resource: unknown, cleanup?: () => Promise<void> | void): void {
    this.genericResources.set(key, {
      resource,
      cleanup: cleanup ?? null,
      refCount: 1,
      lastUsed: Date.now(),
    });
  }

  getRegistered<T>(key: string): T | null {
    const entry = this.genericResources.get(key);
    if (entry) {
      entry.refCount++;
      entry.lastUsed = Date.now();
      return entry.resource as T;
    }
    return null;
  }

  releaseRegistered(key: string): void {
    const entry = this.genericResources.get(key);
    if (entry) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        if (entry.cleanup) entry.cleanup();
        this.genericResources.delete(key);
      }
    }
  }

  startAutoCleanup(intervalMs: number = 30000): void {
    if (this.cleanupInterval !== null) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), intervalMs) as unknown as number;
  }

  stopAutoCleanup(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.textures) {
      if (entry.refCount <= 0 && now - entry.lastUsed > this.maxAge) {
        (entry.resource as GPUTexture).destroy();
        this.textures.delete(key);
      }
    }
    for (const [key, entry] of this.buffers) {
      if (entry.refCount <= 0 && now - entry.lastUsed > this.maxAge) {
        (entry.resource as GPUBuffer).destroy();
        this.buffers.delete(key);
      }
    }
    // Evict stale generic resources (refCount <= 0 and past maxAge), then
    // enforce an LRU cap of 64 entries by evicting least-recently-used items.
    const GENERIC_LRU_MAX = 64;
    for (const [key, entry] of this.genericResources) {
      if (entry.refCount <= 0 && now - entry.lastUsed > this.maxAge) {
        if (entry.cleanup) entry.cleanup();
        this.genericResources.delete(key);
      }
    }
    if (this.genericResources.size > GENERIC_LRU_MAX) {
      // Map iterates in insertion order; sort by lastUsed ascending to evict LRU.
      const sorted = [...this.genericResources.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      );
      const toEvict = sorted.length - GENERIC_LRU_MAX;
      for (let i = 0; i < toEvict; i++) {
        const [key, entry] = sorted[i];
        if (entry.cleanup) entry.cleanup();
        this.genericResources.delete(key);
      }
    }
  }

  getStats(): { textureCount: number; bufferCount: number; totalRefs: number } {
    let totalRefs = 0;
    for (const entry of this.textures.values()) totalRefs += entry.refCount;
    for (const entry of this.buffers.values()) totalRefs += entry.refCount;
    return {
      textureCount: this.textures.size,
      bufferCount: this.buffers.size,
      totalRefs,
    };
  }

  destroy(): void {
    this.stopAutoCleanup();
    for (const entry of this.textures.values()) {
      (entry.resource as GPUTexture).destroy();
    }
    for (const entry of this.buffers.values()) {
      (entry.resource as GPUBuffer).destroy();
    }
    for (const entry of this.genericResources.values()) {
      if (entry.cleanup) entry.cleanup();
    }
    this.textures.clear();
    this.buffers.clear();
    this.genericResources.clear();
  }
}
