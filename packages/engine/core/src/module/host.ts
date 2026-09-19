import type { ComponentId } from "../ecs/component";
import { getComponentId } from "../ecs/component";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, System, SystemFn } from "../ecs/system";
import type { World } from "../ecs/world";
import { createLogger } from "../util/logger";
import type { CrossThreadToken, ModuleThreadInfo, ThreadTag } from "./cross-thread";
import { assertNoDuplicate, assertRequired, isStrict, warnLeak } from "./diagnostics";
import type { Module, ModuleContext, ModuleDevToolsAPI, SABChannel } from "./module";
import { ModuleRegistry } from "./registry";
import { TsModuleLoader } from "./ts-loader";

const log = createLogger();

interface ActiveModule {
  plugin: Module;
  disposeFns: Array<() => void>;
  sabChannels: Map<string, SharedArrayBuffer>;
  providedKeys: Set<string>;
  /** Names of systems this module registered — removed from the schedule on unload. */
  systemNames: string[];
}

interface ResourceEntry {
  token: ResourceToken<unknown>;
  value: unknown;
}

export class ModuleHost implements ModuleContext {
  private world: World;
  private registry: ModuleRegistry;
  private tsLoader: TsModuleLoader;
  private active: Map<string, ActiveModule> = new Map();
  private pending: Map<string, Module> = new Map();
  private migrations: Map<number, (data: unknown) => unknown> = new Map();
  private _devtools: ModuleDevToolsAPI | null = null;
  /** Typed resource store: tokenKey → { token, value } */
  private resources: Map<string, ResourceEntry> = new Map();
  /** Reverse map: tokenKey → provider plugin name */
  private providers: Map<string, string> = new Map();

  constructor(world: World, registry?: ModuleRegistry) {
    this.world = world;
    this.registry = registry ?? new ModuleRegistry();
    this.tsLoader = new TsModuleLoader(this.registry);
  }

  /**
   * Inject the DevTools API. Called by the game bootstrap after
   * `initDevTools()` so plugins can self-register debug panels via
   * `ctx.devtools.registerPanel(...)` during their `register()` lifecycle.
   */
  setDevToolsAPI(api: ModuleDevToolsAPI): void {
    this._devtools = api;
  }

  get devtools(): ModuleDevToolsAPI {
    // Return the injected API, or a no-op stub if not set (so plugins that
    // call ctx.devtools.registerPanel() don't crash if devtools isn't wired).
    return this._devtools ?? NoopDevToolsAPI;
  }

  getRegistry(): ModuleRegistry {
    return this.registry;
  }

  async loadModule(pluginPath: string): Promise<Module> {
    const plugin = await this.tsLoader.load(pluginPath);
    this.activateModule(plugin);
    return plugin;
  }

  /**
   * Register and immediately activate a plugin.
   * For batch registration with dependency-ordered activation,
   * use `registerModuleDeferred()` + `activateAll()` instead.
   */
  registerModule(plugin: Module): void {
    this.registry.register(plugin);
    this.validateModule(plugin);
    this.activateModule(plugin);
  }

  /**
   * Register a plugin without activating it.
   * Call `activateAll()` after all plugins are registered
   * to activate them in dependency-resolved order (topological sort).
   */
  registerModuleDeferred(plugin: Module): void {
    this.registry.register(plugin);
    this.pending.set(plugin.name, plugin);
  }

  /**
   * Activate all plugins registered via `registerModuleDeferred()`
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
        this.activateModule(plugin);
      }
    }
  }

  /**
   * Register and activate multiple plugins in dependency-resolved order.
   * This is the standard batch registration pattern — equivalent to
   * calling `registerModuleDeferred()` for each plugin followed by
   * `activateAll()`. Use this when multiple plugins have interdependencies
   * (via `provides`/`requires` typed tokens).
   */
  useModules(plugins: Module[]): void {
    for (let i = 0; i < plugins.length; i++) {
      this.registerModuleDeferred(plugins[i]);
    }
    this.activateAll();
  }

  /**
   * Validate a single plugin's requires against already-active providers.
   * Used for immediate-activation (registerModule) path.
   */
  private validateModule(plugin: Module): void {
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
            `Module "${name}" provides "${token.key}" but it is already provided by "${allProviders.get(token.key)}". ` +
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

  private activateModule(plugin: Module): void {
    const active: ActiveModule = {
      plugin,
      disposeFns: [],
      sabChannels: new Map(),
      providedKeys: new Set(),
      systemNames: [],
    };
    this.active.set(plugin.name, active);
    this.currentModuleName = plugin.name;
    try {
      plugin.register(this);
    } catch (err) {
      // Roll back partial activation: the module must not stay "active"
      // with half-wired resources. Clean up anything it provided or
      // registered for disposal, then re-throw so the caller sees it.
      for (const key of active.providedKeys) {
        this.resources.delete(key);
        this.providers.delete(key);
      }
      for (let i = active.disposeFns.length - 1; i >= 0; i--) {
        try {
          active.disposeFns[i]();
        } catch (disposeErr) {
          log.error("ModuleHost", `Dispose error rolling back plugin "${plugin.name}": ${disposeErr}`);
        }
      }
      // Remove systems the module registered before throwing.
      for (const sysName of active.systemNames) {
        this.world.schedule.removeSystem(sysName);
      }
      this.active.delete(plugin.name);
      throw err;
    } finally {
      // Clear the attribution context — any provide/onDispose/registerSystem
      // call made outside a register() lifecycle (async callbacks, game code)
      // must not be silently attributed to this module.
      this.currentModuleName = "";
    }
  }

  unloadModule(name: string): void {
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
        log.error("ModuleHost", `Dispose error in plugin "${name}": ${err}`);
      }
    }
    // Remove the module's systems from the world schedule — otherwise they
    // keep running after unload (e.g. duplicated per hot-reload swap).
    for (const sysName of active.systemNames) {
      this.world.schedule.removeSystem(sysName);
    }
    this.active.delete(name);
    this.pending.delete(name);
    this.registry.unregister(name);
  }

  getModule(name: string): Module | undefined {
    return this.registry.get(name);
  }

  listModules(): string[] {
    return this.registry.getAll().map((p) => p.name);
  }

  /**
   * Produce a thread-tagged snapshot of all active modules for the
   * cross-thread report + doctor panel. `thread` identifies which side
   * this host lives on ("sim" | "renderer").
   *
   * Tokens created via `crossThreadToken()` carry a `__thread` tag; the
   * snapshot records it in `tokenThreads` so `buildCrossThreadReport()`
   * can flag tokens provided on the wrong thread.
   */
  snapshot(thread: ThreadTag): ModuleThreadInfo[] {
    const out: ModuleThreadInfo[] = [];
    for (const [name, active] of this.active) {
      const plugin = active.plugin;
      const tokenThreads: Record<string, ThreadTag> = {};
      const collectTags = (tokens?: ResourceToken<unknown>[]) => {
        for (const t of tokens ?? []) {
          const tag = (t as CrossThreadToken<unknown>).__thread;
          if (tag) tokenThreads[t.key] = tag;
        }
      };
      collectTags(plugin.provides);
      collectTags(plugin.requires);
      out.push({
        name,
        version: plugin.version,
        thread,
        provides: (plugin.provides ?? []).map((t) => t.key),
        requires: (plugin.requires ?? []).map((t) => t.key),
        active: true,
        tokenThreads: Object.keys(tokenThreads).length > 0 ? tokenThreads : undefined,
      });
    }
    return out;
  }

  disposeAll(): void {
    const order = this.registry.resolveOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      this.unloadModule(order[i]);
    }
    // Clean up unattributed registrations (made outside a register()
    // lifecycle — they were tracked globally so they don't leak).
    for (const sysName of this.unattributedSystemNames) {
      this.world.schedule.removeSystem(sysName);
    }
    this.unattributedSystemNames.length = 0;
    for (let i = this.unattributedDisposeFns.length - 1; i >= 0; i--) {
      try {
        this.unattributedDisposeFns[i]();
      } catch (err) {
        log.error("ModuleHost", `Unattributed dispose error: ${err}`);
      }
    }
    this.unattributedDisposeFns.length = 0;
  }

  registerComponent<T>(name: string, _schema: T): ComponentId {
    return getComponentId(name);
  }

  registerSystem(stage: Stage, system: SystemFn): void {
    if (!this.currentModuleName) {
      log.warn("ModuleHost", "registerSystem called outside a module register() lifecycle — the system will not be attributed to any module");
    }
    this.systemCounter++;
    const name = `module:${this.currentModuleName || "unattributed"}:${this.systemCounter}`;
    this.world.schedule.add({
      name,
      stage,
      fn: system,
      queries: [],
    });
    const active = this.active.get(this.currentModuleName);
    if (active) {
      active.systemNames.push(name);
    } else {
      this.unattributedSystemNames.push(name);
    }
  }

  registerSystemObject(system: System): void {
    if (!this.currentModuleName) {
      log.warn("ModuleHost", `registerSystemObject("${system.name}") called outside a module register() lifecycle — the system will not be attributed to any module`);
    }
    this.world.schedule.add(system);
    const active = this.active.get(this.currentModuleName);
    if (active) {
      active.systemNames.push(system.name);
    } else {
      this.unattributedSystemNames.push(system.name);
    }
  }

  allocateSABChannel(name: string, size: number): SABChannel {
    if (!this.currentModuleName) {
      log.warn("ModuleHost", `allocateSABChannel("${name}") called outside a module register() lifecycle — the channel is untracked and won't be cleaned up on unload`);
    }
    const buffer = new SharedArrayBuffer(size);
    const active = this.active.get(this.currentModuleName);
    if (active) {
      active.sabChannels.set(name, buffer);
    }
    return { name, buffer };
  }

  provide<T>(token: ResourceToken<T>, value: T): void {
    if (!this.currentModuleName) {
      log.warn("ModuleHost", `provide("${token.key}") called outside a module register() lifecycle — the resource won't be cleaned up on unload`);
    }
    if (isStrict()) {
      assertNoDuplicate(this.providers, token as ResourceToken<unknown>, this.currentModuleName);
    }
    this.resources.set(token.key, { token: token as ResourceToken<unknown>, value });
    this.providers.set(token.key, this.currentModuleName);
    const active = this.active.get(this.currentModuleName);
    if (active) {
      active.providedKeys.add(token.key);
    }
  }

  /**
   * Provide a typed resource from an external provider (e.g. the LibraryHost).
   * Unlike `provide()`, this does not require a current plugin context.
   * The `providerName` is used for diagnostics.
   */
  provideExternal<T>(providerName: string, token: ResourceToken<T>, value: T): void {
    if (isStrict()) {
      assertNoDuplicate(this.providers, token as ResourceToken<unknown>, providerName);
    }
    this.resources.set(token.key, { token: token as ResourceToken<unknown>, value });
    this.providers.set(token.key, providerName);
  }

  inject<T>(token: ResourceToken<T>): T {
    const entry = this.resources.get(token.key);
    if (!entry) {
      throw new Error(
        `Module "${this.currentModuleName}" injects "${token.key}" which is not provided. ` +
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
    const active = this.active.get(this.currentModuleName);
    if (active) {
      active.disposeFns.push(fn);
    } else {
      // Don't drop the callback silently — run it at disposeAll() so
      // resources registered outside a lifecycle still get cleaned up.
      log.warn("ModuleHost", "onDispose called outside a module register() lifecycle — the callback will run at disposeAll() instead of being attributed to a module");
      this.unattributedDisposeFns.push(fn);
    }
  }

  private currentModuleName: string = "";
  private systemCounter = 0;
  /** Systems registered outside a register() lifecycle — removed at disposeAll(). */
  private unattributedSystemNames: string[] = [];
  /** Dispose callbacks registered outside a register() lifecycle — run at disposeAll(). */
  private unattributedDisposeFns: Array<() => void> = [];

  setCurrentPlugin(name: string): void {
    this.currentModuleName = name;
  }
}

// No-op DevTools API stub — used when setDevToolsAPI() hasn't been called.
// Plugins that call ctx.devtools.registerPanel() will silently no-op.
const NoopDevToolsAPI: ModuleDevToolsAPI = {
  registerPanel: () => {},
  registerOverlayToggle: () => {},
  registerDataFeed: () => {},
  registerCommand: () => {},
  registerSABStat: () => {},
};
