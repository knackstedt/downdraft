import type { Module } from "./module";

export class ModuleRegistry {
  private plugins: Map<string, Module> = new Map();
  private loadOrder: string[] = [];

  register(plugin: Module): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Module "${plugin.name}" is already registered`);
    }
    if (plugin.dependencies) {
      for (let i = 0; i < plugin.dependencies.length; i++) {
        if (!this.plugins.has(plugin.dependencies[i])) {
          throw new Error(`Module "${plugin.name}" requires "${plugin.dependencies[i]}" which is not registered`);
        }
      }
    }
    this.plugins.set(plugin.name, plugin);
    this.loadOrder.push(plugin.name);
  }

  unregister(name: string): void {
    this.plugins.delete(name);
    const idx = this.loadOrder.indexOf(name);
    if (idx >= 0) this.loadOrder.splice(idx, 1);
  }

  get(name: string): Module | undefined {
    return this.plugins.get(name);
  }

  getAll(): Module[] {
    return this.loadOrder.map((name) => this.plugins.get(name)!).filter(Boolean);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Resolve activation order via topological sort over `dependencies`
   * (module names) AND `requires` (typed tokens → provider module). A module
   * that `requires` a token must activate after whichever module `provides`
   * it — otherwise its `register()` would fail at `inject()`.
   *
   * Throws on a dependency cycle. A `requires` token with no registered
   * provider adds no edge (the strict-mode graph validation reports it).
   */
  resolveOrder(): string[] {
    // Provider map: token key → module name that provides it.
    const providers = new Map<string, string>();
    for (const m of this.getAll()) {
      for (const token of m.provides ?? []) {
        providers.set(token.key, m.name);
      }
    }

    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Module dependency cycle detected at "${name}"`);
      }
      visiting.add(name);

      const plugin = this.plugins.get(name);
      if (plugin?.dependencies) {
        for (let i = 0; i < plugin.dependencies.length; i++) {
          visit(plugin.dependencies[i]);
        }
      }
      // requires (typed tokens → provider module)
      if (plugin?.requires) {
        for (const token of plugin.requires) {
          const providerName = providers.get(token.key);
          if (providerName && providerName !== name) visit(providerName);
        }
      }

      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (let i = 0; i < this.loadOrder.length; i++) {
      visit(this.loadOrder[i]);
    }

    return result;
  }
}
