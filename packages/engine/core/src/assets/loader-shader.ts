export interface ShaderSource {
  code: string;
  path: string;
  lastModified: number;
}

export class ShaderLoader {
  private cache: Map<string, ShaderSource> = new Map();
  private watchers: Map<string, (source: ShaderSource) => void> = new Map();

  async load(path: string): Promise<ShaderSource> {
    const cached = this.cache.get(path);
    if (cached) return cached;

    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Failed to load shader ${path}: ${response.status} ${response.statusText}`);
    }
    const code = await response.text();
    const source: ShaderSource = { code, path, lastModified: Date.now() };
    this.cache.set(path, source);
    return source;
  }

  loadSync(path: string, fs?: { readFileSync(path: string): string }): ShaderSource | null {
    if (!fs) return null;
    const cached = this.cache.get(path);
    if (cached) return cached;
    try {
      const code = fs.readFileSync(path);
      const source: ShaderSource = { code, path, lastModified: Date.now() };
      this.cache.set(path, source);
      return source;
    } catch {
      return null;
    }
  }

  preload(path: string, code: string): void {
    this.cache.set(path, { code, path, lastModified: Date.now() });
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  get(path: string): ShaderSource | null {
    return this.cache.get(path) ?? null;
  }

  watch(path: string, callback: (source: ShaderSource) => void): void {
    this.watchers.set(path, callback);
  }

  unwatch(path: string): void {
    this.watchers.delete(path);
  }

  notifyReload(path: string, newCode: string): void {
    const source: ShaderSource = { code: newCode, path, lastModified: Date.now() };
    this.cache.set(path, source);
    const watcher = this.watchers.get(path);
    if (watcher) watcher(source);
  }

  has(path: string): boolean {
    return this.cache.has(path);
  }
}
