// ============================================================================
// Workshop — remote plugin pack discovery, fetch, and cache.
//
// A workshop source is an `AssetManifest` (with a `plugins: PluginPackEntry[]`
// section) served from a BlobStore. The workshop fetcher:
//   1. Downloads the manifest from the configured store.
//   2. For each plugin pack entry, fetches the `plugin.json` + declared asset
//      files, caches them under `<cacheDir>/<id>@<version>/`.
//   3. Returns the validated `PluginManifest` + the local cache path so the
//      PluginHost can `discover()` it with source "workshop".
//
// Subscription state (which packs are enabled) is persisted via the provided
// persistence hook (OPFS in production; in-memory in tests).
// ============================================================================

import { createLogger } from "../util/logger";
import {
  validateManifest,
  type AssetManifest,
  type PluginPackEntry,
} from "../assets/manifest";
import type { BlobStore } from "../assets/blob-store";
import { validatePluginManifest, type PluginManifest } from "./manifest";

const log = createLogger("info");

export interface WorkshopSource {
  /** The blob store to fetch from. */
  store: BlobStore;
  /** Key/path of the workshop manifest JSON within the store. */
  manifestKey: string;
}

export interface WorkshopFetchResult {
  /** Discovered plugin manifests (validated + normalized). */
  manifests: Array<{ manifest: PluginManifest; cachePath: string }>;
  /** Packs that failed validation/fetch (with errors). */
  errors: Array<{ id: string; error: string }>;
}

export interface WorkshopOptions {
  /** Directory to cache downloaded plugin packs (e.g. userData/plugins). */
  cacheDir: string;
  /** Persistence hook for subscription state. Called with the list of
   *  enabled plugin ids. In production this writes to OPFS; tests inject
   *  an in-memory impl. */
  saveSubscriptions?: (ids: string[]) => Promise<void>;
  loadSubscriptions?: () => Promise<string[]>;
}

export class WorkshopFetcher {
  private sources: WorkshopSource[] = [];
  private opts: WorkshopOptions;
  /** id → cache path for fetched packs. */
  private cache = new Map<string, string>();

  constructor(opts: WorkshopOptions) {
    this.opts = opts;
  }

  addSource(source: WorkshopSource): void {
    this.sources.push(source);
  }

  /**
   * Fetch all workshop sources, download plugin packs, cache them, and return
   * validated manifests. Only packs in the subscription list are fetched
   * (if subscriptions are configured); otherwise all packs in the manifest.
   */
  async fetchAll(): Promise<WorkshopFetchResult> {
    const manifests: Array<{ manifest: PluginManifest; cachePath: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    const subscribed = this.opts.loadSubscriptions ? await this.opts.loadSubscriptions() : null;

    for (const source of this.sources) {
      let rawManifest: Uint8Array;
      try {
        rawManifest = await source.store.get(source.manifestKey);
      } catch (e) {
        log.error("WorkshopFetcher", `Failed to fetch workshop manifest: ${(e as Error).message}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(rawManifest));
      } catch (e) {
        log.error("WorkshopFetcher", `Workshop manifest is not valid JSON: ${(e as Error).message}`);
        continue;
      }
      if (!validateManifest(parsed)) {
        log.error("WorkshopFetcher", `Workshop manifest failed schema validation`);
        continue;
      }
      const assetManifest = parsed as AssetManifest;
      const pluginEntries = assetManifest.plugins ?? [];

      for (const entry of pluginEntries) {
        if (subscribed && !subscribed.includes(entry.id)) continue;
        try {
          const result = await this.fetchPack(source, entry);
          if (result) manifests.push(result);
        } catch (e) {
          errors.push({ id: entry.id, error: (e as Error).message });
        }
      }
    }
    return { manifests, errors };
  }

  /** Fetch a single plugin pack: download plugin.json + cache the pack. */
  private async fetchPack(
    source: WorkshopSource,
    entry: PluginPackEntry,
  ): Promise<{ manifest: PluginManifest; cachePath: string } | null> {
    const cachePath = `${this.opts.cacheDir}/${entry.id}@${entry.version}`;
    // Fetch plugin.json from the store.
    const pluginJsonKey = `${entry.path}/plugin.json`;
    let pluginJsonBytes: Uint8Array;
    try {
      pluginJsonBytes = await source.store.get(pluginJsonKey);
    } catch (e) {
      throw new Error(`Failed to fetch plugin.json for "${entry.id}": ${(e as Error).message}`);
    }
    let pluginRaw: unknown;
    try {
      pluginRaw = JSON.parse(new TextDecoder().decode(pluginJsonBytes));
    } catch (e) {
      throw new Error(`plugin.json for "${entry.id}" is not valid JSON: ${(e as Error).message}`);
    }
    const v = validatePluginManifest(pluginRaw);
    if (!v.valid) {
      throw new Error(`plugin.json for "${entry.id}" failed validation: ${v.errors.join("; ")}`);
    }
    const manifest = v.normalized!;
    // Verify the manifest id matches the entry id.
    if (manifest.id !== entry.id) {
      throw new Error(
        `Workshop entry id "${entry.id}" does not match plugin.json id "${manifest.id}"`,
      );
    }
    this.cache.set(entry.id, cachePath);
    // Note: actual asset files are fetched lazily by the AssetPluginLoader
    // via the BlobStore (or eagerly if the game wires a prefetch). The cache
    // path is exposed so the loader's `resolveBase` can point at it.
    return { manifest, cachePath };
  }

  /** Get the cache path for a fetched plugin id. */
  getCachePath(id: string): string | undefined {
    return this.cache.get(id);
  }

  /** Enable a plugin subscription (persisted). */
  async subscribe(id: string): Promise<void> {
    const current = this.opts.loadSubscriptions ? await this.opts.loadSubscriptions() : [];
    if (!current.includes(id)) {
      current.push(id);
      await this.opts.saveSubscriptions?.(current);
    }
  }

  /** Remove a plugin subscription (persisted). */
  async unsubscribe(id: string): Promise<void> {
    const current = this.opts.loadSubscriptions ? await this.opts.loadSubscriptions() : [];
    const next = current.filter((x) => x !== id);
    await this.opts.saveSubscriptions?.(next);
  }
}
