import { createLogger } from "../util/logger";

const log = createLogger();

export type AssetPriority = "critical" | "high" | "normal" | "low" | "background";

export type AssetDestructor = (data: unknown) => Promise<void> | void;

export interface AssetLoadProgress {
  uri: string;
  loaded: number;
  total: number;
  ratio: number;
}

export type ProgressCallback = (progress: AssetLoadProgress) => void;

export interface AssetRef {
  uri: string;
  refCount: number;
  data: unknown;
  size: number;
  lastUsed: number;
  priority: AssetPriority;
}

export interface SearchPath {
  name: string;
  basePath: string;
}

export interface AssetManagerOptions {
  maxConcurrentLoads?: number;
  memoryBudget?: number;
  progressCallback?: ProgressCallback;
  searchPaths?: SearchPath[];
}

interface LoadQueueEntry {
  uri: string;
  priority: AssetPriority;
  priorityValue: number;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  progressCb?: ProgressCallback;
}

const PRIORITY_VALUES: Record<AssetPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
};

export class AssetManager {
  private assets: Map<string, AssetRef> = new Map();
  private loaders: Map<string, (uri: string) => Promise<unknown>> = new Map();
  private destructors: Map<string, AssetDestructor> = new Map();
  private codecs: Map<string, unknown> = new Map();
  private loadQueue: LoadQueueEntry[] = [];
  private loading: Set<string> = new Set();
  private pendingResolvers: Map<string, Array<(data: unknown) => void>> = new Map();
  private pendingRejectors: Map<string, Array<(err: Error) => void>> = new Map();
  private maxConcurrentLoads: number;
  private memoryBudget: number;
  private currentMemoryUsage: number = 0;
  private globalProgressCallback?: ProgressCallback;
  private searchPaths: SearchPath[] = [];

  constructor(opts: AssetManagerOptions = {}) {
    this.maxConcurrentLoads = opts.maxConcurrentLoads ?? 4;
    this.memoryBudget = opts.memoryBudget ?? 0;
    this.globalProgressCallback = opts.progressCallback;
    if (opts.searchPaths) {
      opts.searchPaths.forEach((sp) => {
        this.addSearchPath(sp.name, sp.basePath);
      });
    }
  }

  addSearchPath(name: string, basePath: string): void {
    const normalized = basePath.endsWith("/") ? basePath : basePath + "/";
    this.removeSearchPath(name);
    this.searchPaths.push({ name, basePath: normalized });
  }

  removeSearchPath(name: string): boolean {
    const idx = this.searchPaths.findIndex((sp) => sp.name === name);
    if (idx === -1) return false;
    this.searchPaths.splice(idx, 1);
    return true;
  }

  clearSearchPaths(): void {
    this.searchPaths = [];
  }

  getSearchPaths(): readonly SearchPath[] {
    return this.searchPaths;
  }

  resolveUriCandidates(uri: string): string[] {
    if (/^(https?:|data:|blob:|file:)/i.test(uri)) return [uri];
    if (uri.startsWith("/")) return [uri];
    if (this.searchPaths.length === 0) return [uri];
    const candidates: string[] = [];
    for (let i = this.searchPaths.length - 1; i >= 0; i--) {
      candidates.push(this.searchPaths[i].basePath + uri);
    }
    candidates.push(uri);
    return candidates;
  }

  registerLoader(
    extension: string,
    loader: (uri: string) => Promise<unknown>,
    destructor?: AssetDestructor,
  ): void {
    this.loaders.set(extension.toLowerCase(), loader);
    if (destructor) {
      this.destructors.set(extension.toLowerCase(), destructor);
    }
  }

  /**
   * Register a codec keyed by extension URI (e.g. "KHR_draco_mesh_compression",
   * "EXT_meshopt_compression"). This is the second axis of the asset pipeline:
   * `registerLoader` keys on file extension, `registerCodec` keys on the
   * in-band extension URI that selects a decoder for compressed/extended data.
   */
  registerCodec(extensionUri: string, codec: unknown): void {
    this.codecs.set(extensionUri, codec);
  }

  getCodec(extensionUri: string): unknown | undefined {
    return this.codecs.get(extensionUri);
  }

  getRegisteredCodecs(): string[] {
    return Array.from(this.codecs.keys());
  }

  async load(uri: string, priority: AssetPriority = "normal"): Promise<unknown> {
    const existing = this.assets.get(uri);
    if (existing) {
      existing.refCount++;
      existing.lastUsed = Date.now();
      return existing.data;
    }

    if (this.loading.has(uri)) {
      return new Promise<unknown>((resolve, reject) => {
        const resolvers = this.pendingResolvers.get(uri) ?? [];
        resolvers.push(resolve);
        this.pendingResolvers.set(uri, resolvers);
        const rejectors = this.pendingRejectors.get(uri) ?? [];
        rejectors.push(reject);
        this.pendingRejectors.set(uri, rejectors);
      });
    }

    return new Promise<unknown>((resolve, reject) => {
      this.loadQueue.push({
        uri,
        priority,
        priorityValue: PRIORITY_VALUES[priority],
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  loadWithProgress(
    uri: string,
    priority: AssetPriority = "normal",
    progressCb?: ProgressCallback,
  ): Promise<unknown> {
    const existing = this.assets.get(uri);
    if (existing) {
      existing.refCount++;
      existing.lastUsed = Date.now();
      return Promise.resolve(existing.data);
    }

    if (this.loading.has(uri)) {
      return new Promise<unknown>((resolve, reject) => {
        const resolvers = this.pendingResolvers.get(uri) ?? [];
        resolvers.push(resolve);
        this.pendingResolvers.set(uri, resolvers);
        const rejectors = this.pendingRejectors.get(uri) ?? [];
        rejectors.push(reject);
        this.pendingRejectors.set(uri, rejectors);
      });
    }

    return new Promise<unknown>((resolve, reject) => {
      this.loadQueue.push({
        uri,
        priority,
        priorityValue: PRIORITY_VALUES[priority],
        resolve,
        reject,
        progressCb,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    while (this.loadQueue.length > 0 && this.loading.size < this.maxConcurrentLoads) {
      this.loadQueue.sort((a, b) => a.priorityValue - b.priorityValue);
      const entry = this.loadQueue.shift()!;
      const uri = entry.uri;

      if (this.loading.has(uri)) {
        const resolvers = this.pendingResolvers.get(uri) ?? [];
        resolvers.push(entry.resolve);
        this.pendingResolvers.set(uri, resolvers);
        const rejectors = this.pendingRejectors.get(uri) ?? [];
        rejectors.push(entry.reject);
        this.pendingRejectors.set(uri, rejectors);
        continue;
      }

      if (this.assets.has(uri)) {
        const ref = this.assets.get(uri)!;
        ref.refCount++;
        entry.resolve(ref.data);
        continue;
      }

      const ext = uri.split(".").pop()?.toLowerCase() ?? "";
      const loader = this.loaders.get(ext);
      if (!loader) {
        entry.reject(new Error(`No loader registered for extension: ${ext}`));
        continue;
      }

      this.loading.add(uri);

      this.tryEvictMemory(uri, entry.priority);

      const candidates = this.resolveUriCandidates(uri);

      try {
        let data: unknown | undefined;
        let lastError: Error | null = null;
        for (let _i = 0, _it = candidates, _n = _it.length; _i < _n; _i++) { const candidate = _it[_i];
          try {
            data = await loader(candidate);
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
          }
        }
        if (data === undefined) throw lastError ?? new Error(`Failed to load ${uri}`);
        const size = this.estimateSize(data);

        while (
          this.memoryBudget > 0 &&
          this.currentMemoryUsage + size > this.memoryBudget
        ) {
          if (!this.evictLRU()) break;
        }

        if (this.memoryBudget > 0 && this.currentMemoryUsage + size > this.memoryBudget) {
          const budgetError = new Error(`Memory budget exceeded: cannot load ${uri} (size ${size}, budget ${this.memoryBudget}, usage ${this.currentMemoryUsage})`);
          entry.reject(budgetError);
          const rejectors = this.pendingRejectors.get(uri);
          if (rejectors) {
            rejectors.forEach((r) => { r(budgetError);; });
            this.pendingRejectors.delete(uri);
            this.pendingResolvers.delete(uri);
          }
          log.warn("asset-manager", budgetError.message);
          return;
        }

        const ref: AssetRef = {
          uri,
          refCount: 1,
          data,
          size,
          lastUsed: Date.now(),
          priority: entry.priority,
        };
        this.assets.set(uri, ref);
        this.currentMemoryUsage += size;

        entry.resolve(data);

        const resolvers = this.pendingResolvers.get(uri);
        if (resolvers) {
          resolvers.forEach((r) => { r(data);; });
          this.pendingResolvers.delete(uri);
          this.pendingRejectors.delete(uri);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        entry.reject(error);

        const rejectors = this.pendingRejectors.get(uri);
        if (rejectors) {
          rejectors.forEach((r) => { r(error);; });
          this.pendingRejectors.delete(uri);
          this.pendingResolvers.delete(uri);
        }
        log.error("asset-manager", `Failed to load ${uri}: ${error.message}`);
      } finally {
        this.loading.delete(uri);
      }
    }
  }

  private estimateSize(data: unknown): number {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (data instanceof Uint8Array) return data.byteLength;
    if (data instanceof Float32Array) return data.byteLength;
    if (data instanceof Uint16Array) return data.byteLength;
    if (data instanceof Uint32Array) return data.byteLength;
    if (data instanceof Int8Array) return data.byteLength;
    if (data instanceof Int16Array) return data.byteLength;
    if (data instanceof Int32Array) return data.byteLength;
    if (data instanceof Float64Array) return data.byteLength;
    if (data instanceof DataView) return data.byteLength;
    if (typeof data === "string") return data.length * 2;
    if (data && typeof data === "object") {
      const json = JSON.stringify(data);
      return json ? json.length * 2 : 1024;
    }
    return 1024;
  }

  private tryEvictMemory(_incomingUri: string, _incomingPriority: AssetPriority): void {
    if (this.memoryBudget <= 0) return;
    if (this.currentMemoryUsage < this.memoryBudget) return;
    this.evictLRU();
  }

  private evictLRU(): boolean {
    let oldest: AssetRef | null = null;
    let oldestKey: string | null = null;

    for (const [key, ref] of this.assets.entries()) {
      if (ref.refCount > 0) continue;
      if (!oldest || ref.lastUsed < oldest.lastUsed) {
        oldest = ref;
        oldestKey = key;
      }
    }

    if (!oldest || !oldestKey) return false;

    this.destroyAsset(oldestKey, oldest);
    return true;
  }

  private destroyAsset(key: string, ref: AssetRef): void {
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    const destructor = this.destructors.get(ext);
    if (destructor) {
      try {
        const result = destructor(ref.data);
        if (result instanceof Promise) {
          result.catch((e) =>
            log.error("asset-manager", `Destructor error for ${key}: ${e}`),
          );
        }
      } catch (e) {
        log.error("asset-manager", `Destructor error for ${key}: ${e}`);
      }
    }
    this.assets.delete(key);
    this.currentMemoryUsage -= ref.size;
  }

  async release(uri: string): Promise<void> {
    const ref = this.assets.get(uri);
    if (!ref) return;
    ref.refCount--;
    if (ref.refCount <= 0) {
      this.destroyAsset(uri, ref);
    }
  }

  releaseSync(uri: string): void {
    const ref = this.assets.get(uri);
    if (!ref) return;
    ref.refCount--;
    if (ref.refCount <= 0) {
      this.destroyAsset(uri, ref);
    }
  }

  get(uri: string): unknown | undefined {
    const ref = this.assets.get(uri);
    if (ref) {
      ref.lastUsed = Date.now();
      return ref.data;
    }
    return undefined;
  }

  isLoaded(uri: string): boolean {
    return this.assets.has(uri);
  }

  isLoading(uri: string): boolean {
    return this.loading.has(uri);
  }

  isQueued(uri: string): boolean {
    return this.loadQueue.some((e) => e.uri === uri);
  }

  list(): string[] {
    return [...this.assets.keys()];
  }

  has(uri: string): boolean {
    return this.assets.has(uri);
  }

  getMemoryUsage(): number {
    return this.currentMemoryUsage;
  }

  getMemoryBudget(): number {
    return this.memoryBudget;
  }

  setMemoryBudget(budget: number): void {
    this.memoryBudget = budget;
    if (budget > 0) {
      while (this.currentMemoryUsage > budget) {
        if (!this.evictLRU()) break;
      }
    }
  }

  getLoadStats(): { queued: number; loading: number; loaded: number; memoryUsage: number } {
    return {
      queued: this.loadQueue.length,
      loading: this.loading.size,
      loaded: this.assets.size,
      memoryUsage: this.currentMemoryUsage,
    };
  }

  async unloadAll(): Promise<void> {
    for (const [key, ref] of this.assets.entries()) {
      this.destroyAsset(key, ref);
    }
    this.assets.clear();
    this.loadQueue = [];
    this.loading.clear();
    this.pendingResolvers.clear();
    this.pendingRejectors.clear();
    this.currentMemoryUsage = 0;
  }

  reprioritize(uri: string, priority: AssetPriority): boolean {
    const entry = this.loadQueue.find((e) => e.uri === uri);
    if (!entry) return false;
    entry.priority = priority;
    entry.priorityValue = PRIORITY_VALUES[priority];
    return true;
  }

  cancelLoad(uri: string): boolean {
    const idx = this.loadQueue.findIndex((e) => e.uri === uri);
    if (idx === -1) return false;
    const entry = this.loadQueue[idx];
    this.loadQueue.splice(idx, 1);
    entry.reject(new Error(`Load cancelled: ${uri}`));
    return true;
  }
}
