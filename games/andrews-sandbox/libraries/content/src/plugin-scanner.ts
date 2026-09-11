// ============================================================================
// PluginScanner — discovers plugins from the local plugins/ directory.
// Scans plugins/*/plugin.json, parses manifests, and extracts content entries
// (model files, textures) from asset-tier plugins.
// ============================================================================

import type { PluginManifest } from "@downdraft/core";
import type { ContentEntry } from "./content-registry";

export interface ScannedPlugin {
  manifest: PluginManifest;
  /** Base URL for resolving relative asset paths (e.g. "/plugins/crate-pack/"). */
  baseUrl: string;
  entries: ContentEntry[];
}

export class PluginScanner {
  /**
   * Scan a list of pre-discovered plugin manifests (from the main process
   * or Vite glob import) and extract content entries.
   *
   * In the Electron renderer, we can't directly read the filesystem, so
   * plugins are discovered via:
   *   1. Vite glob imports of plugin.json files (dev mode)
   *   2. IPC to the main process (production)
   *
   * This method takes already-loaded manifest objects + base URLs.
   */
  scan(manifests: Array<{ manifest: PluginManifest; baseUrl: string }>): ScannedPlugin[] {
    const results: ScannedPlugin[] = [];
    for (const { manifest, baseUrl } of manifests) {
      const entries = this.extractEntries(manifest, baseUrl);
      results.push({ manifest, baseUrl, entries });
    }
    return results;
  }

  private extractEntries(manifest: PluginManifest, baseUrl: string): ContentEntry[] {
    const entries: ContentEntry[] = [];
    if (manifest.format !== "asset" || !manifest.assets) return entries;

    // Register mesh files as prop content
    for (const meshPath of manifest.assets.meshes ?? []) {
      const id = `${manifest.id}:${meshPath}`;
      entries.push({
        id,
        name: this.deriveName(meshPath),
        category: "prop",
        modelUri: this.resolveUrl(baseUrl, meshPath),
        pluginSource: manifest.id,
        pack: manifest.id,
        packLabel: manifest.name ?? manifest.id,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: true,
      });
    }

    // Register texture files as paintable textures
    for (const texPath of manifest.assets.textures ?? []) {
      const id = `${manifest.id}:${texPath}`;
      entries.push({
        id,
        name: this.deriveName(texPath),
        category: "texture",
        thumbnailUri: this.resolveUrl(baseUrl, texPath),
        pluginSource: manifest.id,
        pack: manifest.id,
        packLabel: manifest.name ?? manifest.id,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: true,
      });
    }

    // Register data files
    for (const dataPath of manifest.assets.data ?? []) {
      const id = `${manifest.id}:${dataPath}`;
      entries.push({
        id,
        name: this.deriveName(dataPath),
        category: "data",
        pluginSource: manifest.id,
        pack: manifest.id,
        packLabel: manifest.name ?? manifest.id,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: false,
      });
    }

    // Register declared props (builtin shapes with custom physics)
    const propsSection = (manifest as any).props ?? [];
    for (const propDef of propsSection) {
      entries.push({
        id: propDef.id,
        name: propDef.name ?? this.deriveName(propDef.id),
        category: "prop",
        modelUri: propDef.modelUri ? this.resolveUrl(baseUrl, propDef.modelUri) : undefined,
        pluginSource: manifest.id,
        pack: manifest.id,
        packLabel: manifest.name ?? manifest.id,
        physics: {
          mass: propDef.physics?.mass ?? 1.0,
          restitution: propDef.physics?.restitution ?? 0.3,
          friction: propDef.physics?.friction ?? 0.5,
          gravityScale: propDef.physics?.gravityScale ?? 1.0,
        },
        scale: propDef.scale ?? 1.0,
        paintable: propDef.paintable ?? true,
        shape: propDef.shape,
      });
    }

    return entries;
  }

  private deriveName(path: string): string {
    const parts = path.split("/");
    const filename = parts[parts.length - 1];
    return filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  }

  private resolveUrl(baseUrl: string, path: string): string {
    // Strip leading ./ from path
    const cleanPath = path.replace(/^\.\//, "");
    if (baseUrl.endsWith("/")) return baseUrl + cleanPath;
    return baseUrl + "/" + cleanPath;
  }
}
