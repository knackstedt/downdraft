import type { ComponentId } from "../ecs/component";
import { getComponentId } from "../ecs/component";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, System, SystemFn } from "../ecs/system";
import type { World } from "../ecs/world";
import { createLogger } from "../util/logger";
import { assertNoDuplicate, assertRequired, isStrict, warnLeak } from "./diagnostics";
import type { Plugin, PluginContext, PluginDevToolsAPI, SABChannel } from "./plugin";
import { PluginRegistry } from "./registry";
import { TSPluginLoader } from "./ts-loader";

const log = createLogger();

interface ActivePlugin {
  plugin: Plugin;
  disposeFns: Array<() => void>;
  sabChannels: Map<string, SharedArrayBuffer>;
  providedKeys: Set<string>;
}

interface ResourceEntry {
  token: ResourceToken<unknown>;
  value: unknown;
}

export class PluginHost implements PluginContext {
  private world: World;
  private registry: PluginRegistry;
  private tsLoader: TSPluginLoader;
  private active: Map<string, ActivePlugin> = new Map();
  private pending: Map<string, Plugin> = new Map();
  private migrations: Map<number, (data: unknown) => unknown> = new Map();
  private _devtools: PluginDevToolsAPI | null = null;
  /** Typed resource store: tokenKey → { token, value } */
  private resources: Map<string, ResourceEntry> = new Map();
  /** Reverse map: tokenKey → provider plugin name */
  private providers: Map<string, string> = new Map();

  constructor(world: World, registry?: PluginRegistry) {
    this.world = world;
    this.registry = registry ?? new PluginRegistry();
    this.tsLoader = new TSPluginLoader(this.registry);
  }

  /**
   * Inject the DevTools API. Called by the game bootstrap after
   * `initDevTools()` so plugins can self-register debug panels via
   * `ctx.devtools.registerPanel(...)` during their `register()` lifecycle.
   */
  setDevToolsAPI(api: PluginDevToolsAPI): void {
    this._devtools = api;
  }

  get devtools(): PluginDevToolsAPI {
    // Return the injected API, or a no-op stub if not set (so plugins that
    // call ctx.devtools.registerPanel() don't crash if devtools isn't wired).
    return this._devtools ?? NoopDevToolsAPI;
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
    this.validatePlugin(plugin);
    this.activatePlugin(plugin);
  }

  /**
   * Register a plugin without activating it.
   * Call `activateAll()` after all plugins are registered
   * to activate them in dependency-resolved order (topological sort).
   */
  registerPluginDeferred(plugin: Plugin): void {
    this.registry.register(plugin);
    this.pending.set(plugin.name, plugin);
  }

  /**
   * Activate all plugins registered via `registerPluginDeferred()`
   * in dependency-resolved order (topological sort).
   * Plugins with no dependencies are activated first.
   *
   * In DOWNDRAFT_STRICT mode, validates the full dependency graph
   * (provides/requires) before activating any plugin.
   */
  activateAll(): void {
    this.validateGraph();
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

  /**
   * Validate a single plugin's requires against already-active providers.
   * Used for immediate-activation (registerPlugin) path.
   */
  private validatePlugin(plugin: Plugin): void {
    if (!isStrict()) return;
    if (!plugin.requires) return;
    const selfProvides = new Set(plugin.provides?.map((t) => t.key) ?? []);
    for (const token of plugin.requires) {
      if (!this.providers.has(token.key) && !selfProvides.has(token.key)) {
        assertRequired(this.providers, token, plugin.name);
      }
    }
  }

  /**
   * Validate the full dependency graph across all pending + active plugins.
   * Called before batch activation in activateAll().
   */
  private validateGraph(): void {
    if (!isStrict()) return;
    // Build a complete providers map from all pending + active plugins
    const allProviders = new Map<string, string>();
    for (const [name, active] of this.active) {
      for (const token of active.plugin.provides ?? []) {
        allProviders.set(token.key, name);
      }
    }
    for (const [name, plugin] of this.pending) {
      for (const token of plugin.provides ?? []) {
        if (allProviders.has(token.key)) {
          throw new Error(
            `Plugin "${name}" provides "${token.key}" but it is already provided by "${allProviders.get(token.key)}". ` +
              `Duplicate provides are not allowed.`,
          );
        }
        allProviders.set(token.key, name);
      }
    }
    // Check all requires
    for (const [name, plugin] of this.pending) {
      if (!plugin.requires) continue;
      for (const token of plugin.requires) {
        if (!allProviders.has(token.key)) {
          assertRequired(allProviders, token, name);
        }
      }
    }
  }

  private activatePlugin(plugin: Plugin): void {
    const active: ActivePlugin = {
      plugin,
      disposeFns: [],
      sabChannels: new Map(),
      providedKeys: new Set(),
    };
    this.active.set(plugin.name, active);
    this.currentPluginName = plugin.name;
    plugin.register(this);
  }

  unloadPlugin(name: string): void {
    const active = this.active.get(name);
    if (!active) return;
    // Leak detection: warn if plugin provided resources / SAB channels
    // but registered no dispose fns.
    if (isStrict()) {
      warnLeak(name, {
        providedCount: active.providedKeys.size,
        sabCount: active.sabChannels.size,
        disposeFnCount: active.disposeFns.length,
      });
    }
    // Clean up provided resources
    for (const key of active.providedKeys) {
      this.resources.delete(key);
      this.providers.delete(key);
    }
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
    return { name, buffer };
  }

  provide<T>(token: ResourceToken<T>, value: T): void {
    if (isStrict()) {
      assertNoDuplicate(this.providers, token as ResourceToken<unknown>, this.currentPluginName);
    }
    this.resources.set(token.key, { token: token as ResourceToken<unknown>, value });
    this.providers.set(token.key, this.currentPluginName);
    const active = this.active.get(this.currentPluginName);
    if (active) {
      active.providedKeys.add(token.key);
    }
  }

  inject<T>(token: ResourceToken<T>): T {
    const entry = this.resources.get(token.key);
    if (!entry) {
      throw new Error(
        `Plugin "${this.currentPluginName}" injects "${token.key}" which is not provided. ` +
          `Add a plugin that provides it, or use injectOptional() for safe reads.`,
      );
    }
    return entry.value as T;
  }

  injectOptional<T>(token: ResourceToken<T>): T | undefined {
    const entry = this.resources.get(token.key);
    return entry?.value as T | undefined;
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

// No-op DevTools API stub — used when setDevToolsAPI() hasn't been called.
// Plugins that call ctx.devtools.registerPanel() will silently no-op.
const NoopDevToolsAPI: PluginDevToolsAPI = {
  registerPanel: () => {},
  registerOverlayToggle: () => {},
  registerDataFeed: () => {},
  registerCommand: () => {},
  registerSABStat: () => {},
};
