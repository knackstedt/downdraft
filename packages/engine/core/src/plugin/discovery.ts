// ============================================================================
// Plugin discovery helpers — generalized from andrews-sandbox's main.tsx +
// plugin-host-bridge.ts.
//
// Games collect manifests via import.meta.glob (the glob call MUST stay in
// game code — Vite analyzes the literal pattern relative to the importing
// file), then hand the results to collectPluginManifests + discoverPlugins:
//
//   const found = collectPluginManifests({
//     "mod.json":     import.meta.glob("../plugins/*\/mod.json",     { eager: true, query: "?json", import: "default" }),
//     "plugin.json":  import.meta.glob("../plugins/*\/plugin.json",  { eager: true, query: "?json", import: "default" }),
//   });
//   const host = new PluginHost({ gameId, engineVersion });
//   const result = await discoverPlugins(host, found);
//   const getBaseUrl = pluginBaseUrlLookup(found);
// ============================================================================

import { createLogger } from "../util/logger";
import type { AssetRegistry, MapRegistry, PhysicsRegistry } from "./extension-loaders";
import type { PluginHost } from "./host";
import type { PluginManifest } from "./manifest";

const log = createLogger();

function tagFromPrefix(logPrefix: string): string {
  return logPrefix.replace(/^\[|\]$/g, "");
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** Absolute base URL of the plugin directory (for asset resolution). */
  baseUrl: string;
}

/**
 * Collect plugin manifests from import.meta.glob results.
 * `globResults` maps the manifest filename ("mod.json", "plugin.json") to
 * the eager-glob result object (`{ "../plugins/foo/mod.json": manifest }`).
 */
export function collectPluginManifests(
  globResults: Record<string, Record<string, unknown>>,
): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  for (const [fileName, modules] of Object.entries(globResults)) {
    for (const [path, manifest] of Object.entries(modules)) {
      // Convert glob path (e.g. "../plugins/acid-postfx/mod.json") to a URL
      // relative to the Vite dev server root (the game directory).
      const pluginDir = path.replace(`/${fileName}`, "");
      const absDir = pluginDir.replace(/^\.\.\//, "/");
      out.push({ manifest: manifest as PluginManifest, baseUrl: absDir });
    }
  }
  return out;
}

/**
 * Discover all collected manifests on the host, then load them.
 * Returns the count of active plugins + any rejected manifests.
 */
export async function discoverPlugins(
  host: PluginHost,
  manifests: DiscoveredPlugin[],
): Promise<{ active: number; rejected: Array<{ id: string; errors: string[] }> }> {
  const rejected: Array<{ id: string; errors: string[] }> = [];
  for (const { manifest, baseUrl } of manifests) {
    const r = host.discover(manifest, baseUrl);
    if (!r.ok) {
      rejected.push({ id: manifest.id, errors: r.errors });
      log.warn("PluginHost", `Rejected manifest "${manifest.id}": ${r.errors.join("; ")}`);
    }
  }
  await host.loadAll();
  const active = host.snapshot().filter((p) => p.status === "active").length;
  return { active, rejected };
}

/** Build a manifestId → baseUrl lookup for asset resolution. */
export function pluginBaseUrlLookup(
  manifests: DiscoveredPlugin[],
): (manifestId: string) => string {
  const map = new Map<string, string>();
  for (const { manifest, baseUrl } of manifests) {
    map.set(manifest.id, baseUrl);
  }
  return (manifestId) => map.get(manifestId) ?? "";
}

/** Derive a display name from an asset path ("textures/stone.png" → "stone"). */
export function deriveAssetName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1].replace(/\.[^.]+$/, "");
}

/** Resolve a plugin-relative asset path against the manifest's base URL. */
export function resolvePluginAssetUrl(baseUrl: string, path: string): string {
  const clean = path.replace(/^\.\//, "");
  return baseUrl ? `${baseUrl}/${clean}` : clean;
}

// --- Generic asset registry bridge ---

export type PluginAssetKind = "mesh" | "texture" | "pbrMaterial" | "texturePipeline";

export interface PluginAssetEntry {
  id: string;
  kind: PluginAssetKind;
  /** Derived display name (from meta.name or the filename). */
  name: string;
  /** Original path from the manifest. */
  path: string;
  /** Resolved absolute URL (empty string when the manifest gave no path). */
  url: string;
  manifestId: string;
  /** Raw meta/props from the manifest extension. */
  meta?: Record<string, unknown>;
}

export interface AssetRegistryBridgeHooks {
  /** Register a discovered asset into the game's content/asset registry. */
  register(entry: PluginAssetEntry): void;
  /** Remove a previously-registered asset. */
  unregister(id: string): void;
  /** Resolve a manifest's base URL. */
  getBaseUrl(manifestId: string): string;
}

/**
 * Generic AssetRegistry implementation — handles name derivation + URL
 * resolution and delegates the actual registration to the game's hooks.
 */
export function createAssetRegistryBridge(hooks: AssetRegistryBridgeHooks): AssetRegistry {
  const entry = (
    id: string,
    kind: PluginAssetKind,
    path: string,
    manifestId: string,
    meta?: Record<string, unknown>,
  ): PluginAssetEntry => ({
    id,
    kind,
    name: (meta?.name as string) ?? deriveAssetName(path || id),
    path,
    url: path ? resolvePluginAssetUrl(hooks.getBaseUrl(manifestId), path) : "",
    manifestId,
    meta,
  });

  return {
    async registerMesh(id, path, manifestId, meta) {
      hooks.register(entry(id, "mesh", path, manifestId, meta));
    },
    async unregisterMesh(id) { hooks.unregister(id); },
    async registerTexture(id, path, manifestId, meta) {
      hooks.register(entry(id, "texture", path, manifestId, meta));
    },
    async unregisterTexture(id) { hooks.unregister(id); },
    async registerPBRMaterial(id, path, manifestId, props) {
      hooks.register(entry(id, "pbrMaterial", path, manifestId, props));
    },
    async unregisterPBRMaterial(id) { hooks.unregister(id); },
    async registerTexturePipeline(id, path, manifestId, props) {
      hooks.register(entry(id, "texturePipeline", path, manifestId, props));
    },
    async unregisterTexturePipeline(id) { hooks.unregister(id); },
  };
}

// --- No-op registries (for games that don't support a category yet) ---

export function createNoopMapRegistry(logPrefix = "[PluginHost]"): MapRegistry {
  return {
    async registerMap(id, _path, manifestId) {
      log.info(tagFromPrefix(logPrefix), `Map "${id}" from mod "${manifestId}" registered (noop)`);
    },
    async unregisterMap() { /* noop */ },
  };
}

export function createNoopPhysicsRegistry(logPrefix = "[PluginHost]"): PhysicsRegistry {
  return {
    async registerPhysicsOverride(id, _path, manifestId) {
      log.info(tagFromPrefix(logPrefix), `Physics override "${id}" from mod "${manifestId}" registered (noop)`);
    },
    async unregisterPhysicsOverride() { /* noop */ },
  };
}
