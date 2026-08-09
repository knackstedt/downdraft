import type { ComponentId } from "../ecs/component";
import { getComponentId } from "../ecs/component";
import type { Stage, System, SystemFn } from "../ecs/system";
import type { World } from "../ecs/world";
import { createLogger } from "../util/logger";
import type { Plugin, PluginContext, SABChannel } from "./plugin";
import { PluginRegistry } from "./registry";
import { TSPluginLoader } from "./ts-loader";

const log = createLogger();

interface ActivePlugin {
  plugin: Plugin;
  disposeFns: Array<() => void>;
  sabChannels: Map<string, SharedArrayBuffer>;
}

export class PluginHost implements PluginContext {
  private world: World;
  private registry: PluginRegistry;
  private tsLoader: TSPluginLoader;
  private active: Map<string, ActivePlugin> = new Map();
  private pending: Map<string, Plugin> = new Map();
  private migrations: Map<number, (data: unknown) => unknown> = new Map();

  constructor(world: World, registry?: PluginRegistry) {
    this.world = world;
    this.registry = registry ?? new PluginRegistry();
    this.tsLoader = new TSPluginLoader(this.registry);
  }

  getRegistry(): PluginRegistry {
    return this.registry;
  }

  async loadPlugin(pluginPath: string): Promise<Plugin> {
    const plugin = await this.tsLoader.load(pluginPath);
    this.activatePlugin(plugin);
    return plugin;
  }

  /**
   * Register and immediately activate a plugin.
   * For batch registration with dependency-ordered activation,
   * use `registerPluginDeferred()` + `activateAll()` instead.
   */
  registerPlugin(plugin: Plugin): void {
    this.registry.register(plugin);
    this.activatePlugin(plugin);
  }

  /**
   * Register a plugin without activating it.
   * Call `activateAll()` after all plugins are registered
   * to activate them in dependency-resolved order.
   */
  registerPluginDeferred(plugin: Plugin): void {
    this.registry.register(plugin);
    this.pending.set(plugin.name, plugin);
  }

  /**
   * Activate all plugins registered via `registerPluginDeferred()`
   * in dependency-resolved order (topological sort).
   * Plugins with no dependencies are activated first.
   */
  activateAll(): void {
    const order = this.registry.resolveOrder();
    for (let i = 0; i < order.length; i++) {
      const name = order[i];
      if (this.pending.has(name) && !this.active.has(name)) {
        const plugin = this.pending.get(name)!;
        this.pending.delete(name);
        this.activatePlugin(plugin);
      }
    }
  }

  private activatePlugin(plugin: Plugin): void {
    const active: ActivePlugin = {
      plugin,
      disposeFns: [],
      sabChannels: new Map(),
    };
    this.active.set(plugin.name, active);
    this.currentPluginName = plugin.name;
    plugin.register(this);
  }

  unloadPlugin(name: string): void {
    const active = this.active.get(name);
    if (!active) return;
    for (let i = active.disposeFns.length - 1; i >= 0; i--) {
      try {
        active.disposeFns[i]();
      } catch (err) {
        log.error("PluginHost", `Dispose error in plugin "${name}": ${err}`);
      }
    }
    this.active.delete(name);
    this.pending.delete(name);
    this.registry.unregister(name);
  }

  getPlugin(name: string): Plugin | undefined {
    return this.registry.get(name);
  }

  listPlugins(): string[] {
    return this.registry.getAll().map((p) => p.name);
  }

  disposeAll(): void {
    const order = this.registry.resolveOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      this.unloadPlugin(order[i]);
    }
  }

  registerComponent<T>(name: string, _schema: T): ComponentId {
    return getComponentId(name);
  }

  registerSystem(stage: Stage, system: SystemFn): void {
    this.systemCounter++;
    this.world.schedule.add({
      name: `plugin:${this.currentPluginName}:${this.systemCounter}`,
      stage,
      fn: system,
      queries: [],
    });
  }

  registerSystemObject(system: System): void {
    this.world.schedule.add(system);
  }

  allocateSABChannel(name: string, size: number): SABChannel {
    const buffer = new SharedArrayBuffer(size);
    const active = this.active.get(this.currentPluginName);
    if (active) {
      active.sabChannels.set(name, buffer);
    }
    this.world.setResource(`sab:${name}`, buffer);
    return { name, buffer };
  }

  registerResource<T>(name: string, value: T): void {
    this.world.setResource(name, value);
  }

  registerMigration(fromVersion: number, fn: (data: unknown) => unknown): void {
    this.migrations.set(fromVersion, fn);
  }

  getMigration(fromVersion: number): ((data: unknown) => unknown) | undefined {
    return this.migrations.get(fromVersion);
  }

  onDispose(fn: () => void): void {
    const active = this.active.get(this.currentPluginName);
    if (active) {
      active.disposeFns.push(fn);
    }
  }

  private currentPluginName: string = "";
  private systemCounter = 0;

  setCurrentPlugin(name: string): void {
    this.currentPluginName = name;
  }
}
