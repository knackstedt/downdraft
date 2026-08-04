import type { Plugin } from "./plugin";

export class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private loadOrder: string[] = [];

  register(plugin: Plugin): void {
    if (plugin.dependencies) {
      for (let i = 0; i < plugin.dependencies.length; i++) {
        if (!this.plugins.has(plugin.dependencies[i])) {
          throw new Error(`Plugin "${plugin.name}" requires "${plugin.dependencies[i]}" which is not registered`);
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

  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  getAll(): Plugin[] {
    return this.loadOrder.map((name) => this.plugins.get(name)!).filter(Boolean);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  resolveOrder(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) return;
      visiting.add(name);

      const plugin = this.plugins.get(name);
      if (plugin?.dependencies) {
        for (let i = 0; i < plugin.dependencies.length; i++) {
          visit(plugin.dependencies[i]);
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
