export interface AssetRef {
  uri: string;
  refCount: number;
  data: unknown;
}

export class AssetManager {
  private assets: Map<string, AssetRef> = new Map();
  private loaders: Map<string, (uri: string) => Promise<unknown>> = new Map();

  registerLoader(extension: string, loader: (uri: string) => Promise<unknown>): void {
    this.loaders.set(extension.toLowerCase(), loader);
  }

  async load(uri: string): Promise<unknown> {
    const existing = this.assets.get(uri);
    if (existing) {
      existing.refCount++;
      return existing.data;
    }

    const ext = uri.split(".").pop()?.toLowerCase() ?? "";
    const loader = this.loaders.get(ext);
    if (!loader) {
      throw new Error(`No loader registered for extension: ${ext}`);
    }

    const data = await loader(uri);
    this.assets.set(uri, { uri, refCount: 1, data });
    return data;
  }

  release(uri: string): void {
    const ref = this.assets.get(uri);
    if (!ref) return;
    ref.refCount--;
    if (ref.refCount <= 0) {
      this.assets.delete(uri);
    }
  }

  get(uri: string): unknown | undefined {
    return this.assets.get(uri)?.data;
  }

  list(): string[] {
    return [...this.assets.keys()];
  }

  has(uri: string): boolean {
    return this.assets.has(uri);
  }
}
