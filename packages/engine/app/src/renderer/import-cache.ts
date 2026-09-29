// ============================================================================
// Host Import Cache — renderer-side adapter for the host's SQLite cache
// ============================================================================
// When a host bridge is installed, delegates to the host via `downdraft`
// (direct in-process calls on native). Without a host, falls back to an
// in-memory Map via MemoryImportCache.
//

import { MemoryImportCache, type CacheEntry, type ImportCache } from "@downdraft/engine";

/**
 * Create an ImportCache backed by the host SQLite database.
 * Falls back to MemoryImportCache if the bridge is unavailable (browser-only mode).
 */
export function createHostImportCache(bridge?: {
  importCacheGet?: (modelPath: string) => Promise<{ settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number } | null>;
  importCacheSet?: (modelPath: string, entry: { settings: unknown; sourceMtime: number; sidecarMtime: number; updatedAt: number }) => Promise<void>;
  importCacheInvalidate?: (modelPath: string) => Promise<void>;
} | null): ImportCache {
  if (bridge?.importCacheGet && bridge.importCacheSet && bridge.importCacheInvalidate) {
    return new HostImportCache(bridge);
  }
  return new MemoryImportCache();
}

/**
 * ImportCache implementation that delegates to the host's SQLite store.
 */
class HostImportCache implements ImportCache {
  // Synchronous get/set are backed by an in-memory mirror, since the host
  // calls are async. The async methods on the bridge are used for actual
  // persistence. This is a pragmatic trade-off: the cache is eventually
  // consistent with the SQLite store.
  private memory = new Map<string, CacheEntry>();
  private bridge: NonNullable<Parameters<typeof createHostImportCache>[0]>;

  constructor(bridge: NonNullable<Parameters<typeof createHostImportCache>[0]>) {
    this.bridge = bridge;
  }

  get(modelPath: string): CacheEntry | null {
    return this.memory.get(modelPath) ?? null;
  }

  set(modelPath: string, entry: CacheEntry): void {
    this.memory.set(modelPath, entry);
    // Persist to SQLite via the host bridge (fire-and-forget)
    this.bridge.importCacheSet?.(modelPath, {
      settings: entry.settings,
      sourceMtime: entry.sourceMtime,
      sidecarMtime: entry.sidecarMtime,
      updatedAt: entry.updatedAt,
    }).catch(() => {
      // Host failures are non-fatal — the in-memory cache still works
    });
  }

  invalidate(modelPath: string): void {
    this.memory.delete(modelPath);
    this.bridge.importCacheInvalidate?.(modelPath).catch(() => {});
  }

  close(): void {
    this.memory.clear();
  }
}
