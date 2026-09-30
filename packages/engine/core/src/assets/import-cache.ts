// ============================================================================
// Import Cache — caches resolved ImportSettings keyed by model path
// ============================================================================
// The cache eliminates repeated sidecar resolution + HTTP requests on
// subsequent loads of the same model. Two implementations:
//   - MemoryImportCache: in-process Map, used in browser-only mode
//   - SQLiteImportCache: persistent, used on the native host
//
// The cache is keyed by model file path. Entries are invalidated when the
// source file or sidecar mtime changes.
//

import type { ImportSettings } from "./import-settings";

export interface CacheEntry {
  settings: ImportSettings;
  /** mtime (ms) of the model file when this entry was created. */
  sourceMtime: number;
  /** mtime (ms) of the sidecar file (0 if no sidecar). */
  sidecarMtime: number;
  /** When this entry was last updated (ms epoch). */
  updatedAt: number;
}

export interface ImportCache {
  get(modelPath: string): CacheEntry | null;
  set(modelPath: string, entry: CacheEntry): void;
  invalidate(modelPath: string): void;
  close(): void;
}

/**
 * In-memory import cache. Used when no host cache store is available or as
 * a fallback when SQLite is unavailable. Does not persist across restarts.
 */
export class MemoryImportCache implements ImportCache {
  private cache = new Map<string, CacheEntry>();

  get(modelPath: string): CacheEntry | null {
    return this.cache.get(modelPath) ?? null;
  }

  set(modelPath: string, entry: CacheEntry): void {
    this.cache.set(modelPath, entry);
  }

  invalidate(modelPath: string): void {
    this.cache.delete(modelPath);
  }

  close(): void {
    this.cache.clear();
  }
}

/**
 * Check if a cache entry is still valid given current file mtimes.
 */
export function isCacheEntryValid(
  entry: CacheEntry,
  sourceMtime: number,
  sidecarMtime: number,
): boolean {
  return entry.sourceMtime === sourceMtime && entry.sidecarMtime === sidecarMtime;
}
