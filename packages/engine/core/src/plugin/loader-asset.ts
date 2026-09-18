// ============================================================================
// AssetPluginLoader — loads `asset` format (data-tier) plugins.
//
// An asset plugin has no code entry. Its manifest declares an `assets`
// section listing files (textures, audio, meshes, data) that the loader
// registers into the game's `AssetManager`:
//   - adds the plugin directory as a search path (so `load("bronze.png")`
//     resolves to the plugin's file),
//   - registers per-extension loaders if not already registered,
//   - eagerly loads the declared textures/audio/meshes so they're available
//     when the game queries them,
//   - exposes data files via `AssetManager.get(uri)`.
//
// On dispose, the loader removes the search path and unloads the assets.
// ============================================================================

import type { AssetManager } from "../assets/manager";
import { createLogger } from "../util/logger";
import type { ScriptPluginContext } from "./context";
import type { PluginLoader } from "./host";
import type { PluginManifest } from "./manifest";
import type { PermissionGrant } from "./permissions";

const log = createLogger("info");

export interface AssetPluginLoaderOptions {
  /** The AssetManager to register assets into. */
  assetManager: AssetManager;
  /** Base URL resolver: maps a plugin id → the base URL/path for its files.
   *  For local plugins this is the plugin dir; for workshop plugins it's the
   *  cache dir under userData. */
  resolveBase: (pluginId: string, source: string) => string;
}

export class AssetPluginLoader implements PluginLoader {
  readonly format = "asset" as const;
  private opts: AssetPluginLoaderOptions;
  /** pluginId → list of URIs loaded (for unload). */
  private loadedUris = new Map<string, string[]>();
  /** pluginId → search-path name registered (for unload). */
  private searchPathNames = new Map<string, string>();

  constructor(opts: AssetPluginLoaderOptions) {
    this.opts = opts;
  }

  async load(
    manifest: PluginManifest,
    _ctx: ScriptPluginContext,
    _granted: PermissionGrant,
  ): Promise<(() => void) | void> {
    const am = this.opts.assetManager;
    const base = this.opts.resolveBase(manifest.id, (manifest as any).__source ?? "local");
    const spName = `plugin:${manifest.id}`;
    am.addSearchPath(spName, base);
    this.searchPathNames.set(manifest.id, spName);

    const assets = manifest.assets;
    if (!assets) return;

    const loaded: string[] = [];

    // Eagerly load declared asset categories. Each entry is a path relative
    // to the plugin dir; the search path makes them resolvable.
    for (const path of assets.textures ?? []) {
      try {
        await am.load(path);
        loaded.push(path);
      } catch (e) {
        log.error("AssetPluginLoader", `Failed to load texture "${path}" for plugin "${manifest.id}": ${(e as Error).message}`);
      }
    }
    for (const path of assets.audio ?? []) {
      try {
        await am.load(path);
        loaded.push(path);
      } catch (e) {
        log.error("AssetPluginLoader", `Failed to load audio "${path}" for plugin "${manifest.id}": ${(e as Error).message}`);
      }
    }
    for (const path of assets.meshes ?? []) {
      try {
        await am.load(path);
        loaded.push(path);
      } catch (e) {
        log.error("AssetPluginLoader", `Failed to load mesh "${path}" for plugin "${manifest.id}": ${(e as Error).message}`);
      }
    }
    // Data files (JSON etc.) — loaded as raw text via the generic loader.
    for (const path of assets.data ?? []) {
      try {
        await am.load(path);
        loaded.push(path);
      } catch (e) {
        log.error("AssetPluginLoader", `Failed to load data "${path}" for plugin "${manifest.id}": ${(e as Error).message}`);
      }
    }

    this.loadedUris.set(manifest.id, loaded);
    log.info("AssetPluginLoader", `Loaded ${loaded.length} asset(s) for plugin "${manifest.id}" from ${base}`);

    return () => this.dispose(manifest.id);
  }

  dispose(pluginId: string): void {
    const am = this.opts.assetManager;
    const uris = this.loadedUris.get(pluginId);
    if (uris) {
      for (const uri of uris) {
        try {
          am.releaseSync(uri);
        } catch {
          /* best-effort */
        }
      }
      this.loadedUris.delete(pluginId);
    }
    const spName = this.searchPathNames.get(pluginId);
    if (spName) {
      am.removeSearchPath(spName);
      this.searchPathNames.delete(pluginId);
    }
  }
}
