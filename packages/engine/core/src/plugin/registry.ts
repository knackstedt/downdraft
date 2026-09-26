// ============================================================================
// Plugin registry — tracks discovered plugins and resolves load order.
//
// Mirrors `ModuleRegistry` but operates on `PluginManifest`s and resolves
// order over BOTH `dependencies` (other plugin ids) and `requires` (stringly-
// typed plugin resource keys). A plugin that `requires` a key must load
// after whichever plugin `provides` it.
// ============================================================================

import type { PluginManifest } from "./manifest";

export class PluginRegistry {
  private manifests: Map<string, PluginManifest> = new Map();
  private loadOrder: string[] = [];

  register(manifest: PluginManifest): void {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already registered`);
    }
    this.manifests.set(manifest.id, manifest);
    this.loadOrder.push(manifest.id);
  }

  unregister(id: string): void {
    this.manifests.delete(id);
    const idx = this.loadOrder.indexOf(id);
    if (idx >= 0) this.loadOrder.splice(idx, 1);
  }

  get(id: string): PluginManifest | undefined {
    return this.manifests.get(id);
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  getAll(): PluginManifest[] {
    return this.loadOrder.map((id) => this.manifests.get(id)!).filter(Boolean);
  }

  /**
   * Resolve load order via topological sort over `dependencies` + `requires`.
   * Plugins with no dependencies/providers come first.
   *
   * Throws on:
   *   - missing dependency (declared dep not registered)
   *   - missing provider (requires a key nobody provides)
   *   - cycle
   */
  resolveOrder(): string[] {
    // Build provider map: resourceKey → plugin id that provides it.
    const providers = new Map<string, string>();
    for (const m of this.getAll()) {
      (m.provides ?? []).forEach((key) => {
        if (providers.has(key)) {
          throw new Error(
            `Plugin resource "${key}" is provided by both "${providers.get(key)}" and "${m.id}".`,
          );
        }
        providers.set(key, m.id);
      });
    }

    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Plugin dependency cycle detected at "${id}"`);
      }
      const m = this.manifests.get(id);
      if (!m) {
        throw new Error(`Plugin "${id}" is not registered (required as a dependency)`);
      }
      visiting.add(id);

      // dependencies (other plugin ids)
      (m.dependencies ?? []).forEach((dep) => {
        const depId = dep.split("@")[0];
        if (!this.manifests.has(depId)) {
          throw new Error(`Plugin "${id}" depends on "${depId}" which is not registered`);
        }
        visit(depId);
      });
      // requires (resource keys → provider plugin id)
      (m.requires ?? []).forEach((key) => {
        const providerId = providers.get(key);
        if (!providerId) {
          throw new Error(
            `Plugin "${id}" requires resource "${key}" which no registered plugin provides`,
          );
        }
        if (providerId !== id) visit(providerId);
      });

      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    this.loadOrder.forEach((id) => { visit(id);; });
    return result;
  }
}
