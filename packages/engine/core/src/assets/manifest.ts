/**
 * Asset manifest format for declaring remote asset packs.
 * Each game project has a `downdraft.assets.json` that lists
 * required asset packs with versions and storage backends.
 */

import type { BlobStoreConfig } from "./blob-store";

export interface AssetPackEntry {
  name: string;
  version: string;
  store: string;
  path: string;
  files?: string[];
}

/**
 * A plugin pack entry in a workshop asset manifest. Additive to `AssetManifest`
 * (the `plugins` section) — backwards compatible: manifests without it are
 * still valid.
 */
export interface PluginPackEntry {
  /** Plugin id (must match the plugin's plugin.json id). */
  id: string;
  version: string;
  store: string;
  /** Path within the store to the plugin pack root (containing plugin.json). */
  path: string;
  /** Optional SHA-256 checksum of the pack archive for integrity verification. */
  checksum?: string;
}

export interface AssetManifest {
  version: string;
  packs: AssetPackEntry[];
  stores: Record<string, BlobStoreConfig>;
  cacheDir?: string;
  /** Workshop plugin packs (additive, optional). */
  plugins?: PluginPackEntry[];
}

export const DEFAULT_CACHE_DIR = ".downdraft-cache";
export const MANIFEST_FILENAME = "downdraft.assets.json";

export function createEmptyManifest(): AssetManifest {
  return {
    version: "1.0.0",
    packs: [],
    stores: {},
    cacheDir: DEFAULT_CACHE_DIR,
  };
}

export function validateManifest(manifest: unknown): manifest is AssetManifest {
  if (!manifest || typeof manifest !== "object") return false;
  const m = manifest as Record<string, unknown>;
  if (typeof m.version !== "string") return false;
  if (!Array.isArray(m.packs)) return false;
  if (!m.stores || typeof m.stores !== "object") return false;
  for (let _i = 0, _it = m.packs, _n = _it.length; _i < _n; _i++) { const pack = _it[_i];
    if (typeof pack.name !== "string") return false;
    if (typeof pack.version !== "string") return false;
    if (typeof pack.store !== "string") return false;
    if (typeof pack.path !== "string") return false;
  }
  // plugins section is optional; validate if present.
  if (m.plugins !== undefined) {
    if (!Array.isArray(m.plugins)) return false;
    for (let _i = 0, _it = m.plugins, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
      if (typeof p.id !== "string") return false;
      if (typeof p.version !== "string") return false;
      if (typeof p.store !== "string") return false;
      if (typeof p.path !== "string") return false;
    }
  }
  return true;
}

export function packCacheKey(pack: AssetPackEntry, filePath: string): string {
  return `${pack.name}@${pack.version}/${filePath}`;
}
