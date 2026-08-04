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

export interface AssetManifest {
  version: string;
  packs: AssetPackEntry[];
  stores: Record<string, BlobStoreConfig>;
  cacheDir?: string;
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
  for (const pack of m.packs) {
    if (typeof pack.name !== "string") return false;
    if (typeof pack.version !== "string") return false;
    if (typeof pack.store !== "string") return false;
    if (typeof pack.path !== "string") return false;
  }
  return true;
}

export function packCacheKey(pack: AssetPackEntry, filePath: string): string {
  return `${pack.name}@${pack.version}/${filePath}`;
}
