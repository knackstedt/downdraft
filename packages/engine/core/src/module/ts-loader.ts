import type { Module } from "./module";
import { ModuleRegistry } from "./registry";

export class TsModuleLoader {
  private registry: ModuleRegistry;

  constructor(registry: ModuleRegistry) {
    this.registry = registry;
  }

  async load(pluginPath: string): Promise<Module> {
    const mod = await import(/* @vite-ignore */ pluginPath);
    const plugin: Module = mod.default ?? mod;
    this.registry.register(plugin);
    return plugin;
  }

  async loadAll(paths: string[]): Promise<Module[]> {
    const plugins: Module[] = [];
    for (let i = 0; i < paths.length; i++) {
      const plugin = await this.load(paths[i]);
      plugins.push(plugin);
    }
    return plugins;
  }
}
