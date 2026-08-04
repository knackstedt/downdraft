import type { Plugin } from "./plugin";
import { PluginRegistry } from "./registry";

export class TSPluginLoader {
  private registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  async load(pluginPath: string): Promise<Plugin> {
    const mod = await import(/* @vite-ignore */ pluginPath);
    const plugin: Plugin = mod.default ?? mod;
    this.registry.register(plugin);
    return plugin;
  }

  async loadAll(paths: string[]): Promise<Plugin[]> {
    const plugins: Plugin[] = [];
    for (let i = 0; i < paths.length; i++) {
      const plugin = await this.load(paths[i]);
      plugins.push(plugin);
    }
    return plugins;
  }
}
