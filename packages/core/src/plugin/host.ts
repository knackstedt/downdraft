// ============================================================================
// PluginHost — discovers, validates, sandboxes, loads, and disposes plugins.
//
// Thread-agnostic: a renderer-side host and a sim-side host each manage the
// plugins targeted at their thread. The host:
//   1. Discovers plugin manifests from configured sources (local dir, workshop).
//   2. Validates each manifest (validatePluginManifest) + engine/game compat.
//   3. Resolves permissions (requested ∩ tier ∩ game allowlist).
//   4. Resolves load order (PluginRegistry topological sort).
//   5. For each plugin in order, asks the format-specific loader to load it,
//      passing a tiered PluginContext facade. Native-tier context bridges
//      into the provided ModuleHost's typed-DI graph.
//   6. Tracks active plugins, dispose fns, and snapshot for diagnostics.
//
// Loaders are pluggable (one per format). Phase 1 wires WorkerPluginLoader;
// asset/wasm/quickjs loaders are added in later phases.
// ============================================================================

import type { ComponentId } from "../ecs/component";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, SystemFn } from "../ecs/system";
import type { ModuleHost } from "../module/host";
import type { ModuleDevToolsAPI, SABChannel } from "../module/module";
import { createLogger } from "../util/logger";
import type {
    NativePluginContext,
    PluginContextBacking,
    PluginEventBus,
    PluginHostCalls,
    PluginLogger,
    PluginStateStore,
    PluginTickApi,
    ScriptPluginContext
} from "./context";
import { makeNativeContext, makeScriptContext } from "./context";
import {
    pluginInfoFromManifest,
    type PluginInfo,
    type PluginStatus,
} from "./diagnostics";
import { flattenExtensions, validatePluginManifest, type ModExtensionBucket, type PluginManifest, type PluginPermission } from "./manifest";
import {
    resolvePermissions,
    type PermissionGrant,
} from "./permissions";
import { PluginRegistry } from "./registry";

const log = createLogger("info");

// ── Loader interfaces ──

/**
 * A format-specific loader for the `logic` extension (code entry). The host
 * calls `load(manifest, ctx)` after sandboxing/permission resolution. The
 * loader is responsible for fetching the entry (worker spawn / wasm compile /
 * quickjs vm) and calling the plugin's `register(ctx)`.
 *
 * Returns a dispose fn (or void if none needed).
 */
export interface PluginLoader {
  readonly format: PluginManifest["format"];
  load(
    manifest: PluginManifest,
    ctx: ScriptPluginContext | NativePluginContext,
    granted: PermissionGrant,
  ): Promise<(() => void) | void>;
}

/**
 * A bucket-specific loader for declarative mod extensions (assets, maps,
 * physics, shaders). The host dispatches each flattened extension to the
 * loader registered for its bucket. The loader registers the extension's
 * data into the appropriate game registry (AssetManager, MapRegistry,
 * PostProcessStack, MaterialRegistry, etc.) and returns a dispose fn.
 *
 * One ExtensionLoader per bucket: "assets" | "maps" | "physics" |
 * "shader-postfx" | "shader-material".
 */
export interface ExtensionLoader {
  readonly bucket: ModExtensionBucket;
  load(
    manifest: PluginManifest,
    extension: Record<string, unknown>,
    ctx: ScriptPluginContext | NativePluginContext,
  ): Promise<(() => void) | void>;
}

// ── Active plugin record ──

interface ActivePlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  disposeFns: Array<() => void>;
  granted: PermissionGrant;
  error?: string;
  source: string;
}

// ── Host options ──

export interface PluginSource {
  kind: "local" | "workshop";
  /** local: dir path; workshop: opaque descriptor consumed by workshop.ts (Phase 2). */
  location: string;
}

export interface PluginHostOptions {
  /** The ModuleHost on this thread (for native-tier ECS/DI bridging). Optional
   *  for renderer-only hosts that never load native plugins. */
  moduleHost?: ModuleHost;
  /** Game-defined permission allowlist (further restricts tier). */
  gameAllow?: ReadonlySet<PluginPermission>;
  /** Game-defined event catalog (event names → payload types). */
  eventCatalog?: Record<string, unknown>;
  /** Discovery sources. Phase 1 supports `local`; `workshop` added in Phase 2. */
  sources?: PluginSource[];
  /** The appId of the game this host belongs to (for manifest game-field check). */
  gameId: string;
  /** Engine version for manifest engineVersion range checks. */
  engineVersion: string;
  /** DevTools API (for native-tier ctx.devtools). Optional. */
  devtools?: ModuleDevToolsAPI;
  /** Game-implemented host-call bridge (spawn/physics/impulse/asset-ref).
   *  Injected into NativePluginContext so logic extensions can mutate the
   *  game. Optional — a game that doesn't support mutation omits it, and
   *  host-call methods reject with a clear error. */
  hostCalls?: PluginHostCalls;
}

// ── Host ──

export class PluginHost {
  private registry = new PluginRegistry();
  private active = new Map<string, ActivePlugin>();
  private loaders: Map<PluginManifest["format"], PluginLoader> = new Map();
  private extensionLoaders: Map<ModExtensionBucket, ExtensionLoader> = new Map();
  private opts: PluginHostOptions;
  /** Manifests discovered but not yet loaded (id → manifest + source). */
  private discovered: Map<string, { manifest: PluginManifest; source: string }> = new Map();

  constructor(opts: PluginHostOptions) {
    this.opts = opts;
  }

  /** Register a format-specific loader for the `logic` extension. */
  registerLoader(loader: PluginLoader): void {
    this.loaders.set(loader.format, loader);
  }

  /** Register a bucket-specific loader for a declarative extension kind. */
  registerExtensionLoader(loader: ExtensionLoader): void {
    this.extensionLoaders.set(loader.bucket, loader);
  }

  // ── Discovery ──

  /**
   * Register a discovered manifest (from a local dir scan or workshop fetch).
   * Validates the manifest + engine/game compatibility. Does NOT load yet.
   */
  discover(manifest: PluginManifest, source: string): { ok: boolean; errors: string[] } {
    const v = validatePluginManifest(manifest);
    if (!v.valid) return { ok: false, errors: v.errors };
    const m = v.normalized!;
    if (m.game !== this.opts.gameId) {
      return { ok: false, errors: [`game "${m.game}" does not match host game "${this.opts.gameId}"`] };
    }
    if (!satisfiesEngine(this.opts.engineVersion, m.engineVersion)) {
      return {
        ok: false,
        errors: [`engineVersion "${m.engineVersion}" not satisfied by engine "${this.opts.engineVersion}"`],
      };
    }
    this.discovered.set(m.id, { manifest: m, source });
    return { ok: true, errors: [] };
  }

  /**
   * Load all discovered plugins in dependency-resolved order.
   * Plugins that fail validation/loading are marked `error` and skipped;
   * dependents of an errored plugin are also skipped.
   */
  async loadAll(): Promise<void> {
    // Register all discovered manifests with the registry for topo sort.
    for (const [id, d] of this.discovered) {
      if (!this.registry.has(id)) this.registry.register(d.manifest);
    }
    let order: string[];
    try {
      order = this.registry.resolveOrder();
    } catch (e) {
      log.error("PluginHost", `Dependency resolution failed: ${(e as Error).message}`);
      // Mark all discovered as errored.
      for (const [id, d] of this.discovered) {
        this.active.set(id, {
          manifest: d.manifest,
          status: "error",
          disposeFns: [],
          granted: { granted: new Set(), denied: [] },
          error: (e as Error).message,
          source: d.source,
        });
      }
      return;
    }
    for (const id of order) {
      const d = this.discovered.get(id);
      if (!d) continue;
      if (this.active.has(id)) continue; // already loaded (reload path)
      // Skip if any dependency errored.
      const m = d.manifest;
      const depFailed = (m.dependencies ?? []).some((dep) => {
        const depId = dep.split("@")[0];
        const a = this.active.get(depId);
        return a?.status === "error";
      });
      if (depFailed) {
        this.active.set(id, {
          manifest: m,
          status: "error",
          disposeFns: [],
          granted: { granted: new Set(), denied: [] },
          error: "a dependency failed to load",
          source: d.source,
        });
        log.warn("PluginHost", `Skipping "${id}" — dependency failed`);
        continue;
      }
      await this.loadOne(id);
    }
  }

  private async loadOne(id: string): Promise<void> {
    const d = this.discovered.get(id)!;
    const m = d.manifest;

    // Resolve the logic loader. For a mod.json the loader is keyed by
    // `logic.format`; for a legacy plugin.json it's keyed by `format`. A
    // pure-data mod (no logic) has no logic loader and skips straight to
    // extension dispatch.
    const logicFormat = m.logic?.format ?? m.format;
    const hasLogic = !!m.logic || (m.format && m.format !== "asset");
    const loader = hasLogic ? this.loaders.get(logicFormat) : undefined;
    if (hasLogic && !loader) {
      this.active.set(id, {
        manifest: m,
        status: "error",
        disposeFns: [],
        granted: { granted: new Set(), denied: [] },
        error: `no loader registered for format "${logicFormat}"`,
        source: d.source,
      });
      log.error("PluginHost", `No loader for "${id}" (format ${logicFormat})`);
      return;
    }
    const granted = resolvePermissions(
      m.logic?.permissions ?? m.permissions ?? [],
      m.tier,
      this.opts.gameAllow,
    );
    this.active.set(id, {
      manifest: m,
      status: "loading",
      disposeFns: [],
      granted,
      source: d.source,
    });
    try {
      const ctx = this.buildContext(m, granted);
      // 1. Load the logic extension (code entry) if present.
      if (loader) {
        const dispose = await loader.load(m, ctx, granted);
        if (dispose) {
          const a = this.active.get(id)!;
          a.disposeFns.push(dispose);
        }
      }
      // 2. Dispatch declarative extensions (assets, maps, physics, shaders).
      //    Each is loaded by its bucket-specific ExtensionLoader. Failures are
      //    recorded on the plugin snapshot but do not abort the whole mod —
      //    a bad shader shouldn't prevent the mod's assets from loading.
      const exts = flattenExtensions(m);
      for (const ext of exts) {
        const extLoader = this.extensionLoaders.get(ext.bucket);
        if (!extLoader) {
          log.warn("PluginHost", `No extension loader for bucket "${ext.bucket}" (mod "${id}") — skipping`);
          continue;
        }
        try {
          const dispose = await extLoader.load(m, ext.extension, ctx);
          if (dispose) {
            const a = this.active.get(id)!;
            a.disposeFns.push(dispose);
          }
        } catch (e) {
          log.error("PluginHost", `Extension load error in "${id}" (${ext.bucket}): ${(e as Error).message}`);
        }
      }
      const a = this.active.get(id)!;
      a.status = "active";
      log.info("PluginHost", `Loaded mod "${id}" (${logicFormat ?? "data"}/${m.tier})`);
    } catch (e) {
      const a = this.active.get(id)!;
      a.status = "error";
      a.error = (e as Error).message;
      log.error("PluginHost", `Failed to load mod "${id}": ${(e as Error).message}`);
    }
  }

  /** Build the tiered context facade for a plugin. */
  private buildContext(
    m: PluginManifest,
    _granted: PermissionGrant,
  ): ScriptPluginContext | NativePluginContext {
    const host = this;
    const events = makeEventBus(m.id, this.opts.eventCatalog);
    const state = makeStateStore(m.id);
    const tick = makeTickApi(m.id);
    const pluginLog = makeLogger(m.id);
    const onDispose = (fn: () => void) => {
      const a = host.active.get(m.id);
      if (a) a.disposeFns.push(fn);
    };

    const backing: PluginContextBacking = {
      id: m.id,
      events,
      state,
      tick,
      log: pluginLog,
      onDispose,
    };

    if (m.tier === "native") {
      const mh = this.opts.moduleHost;
      if (!mh) {
        throw new Error(
          `Plugin "${m.id}" is native-tier but no ModuleHost is configured on this thread.`,
        );
      }
      // Bridge into the real ModuleHost. setCurrentPlugin so provide/inject
      // attribute resources to this plugin.
      backing.registerComponent = <T>(name: string, schema: T): ComponentId =>
        mh.registerComponent(name, schema);
      backing.registerSystem = (stage: Stage, system: SystemFn): void => {
        mh.setCurrentPlugin(`plugin:${m.id}`);
        mh.registerSystem(stage, system);
      };
      backing.allocateSABChannel = (name: string, size: number): SABChannel => {
        mh.setCurrentPlugin(`plugin:${m.id}`);
        return mh.allocateSABChannel(name, size);
      };
      backing.provide = <T>(token: ResourceToken<T>, value: T): void => {
        mh.setCurrentPlugin(`plugin:${m.id}`);
        mh.provide(token, value);
      };
      backing.inject = <T>(token: ResourceToken<T>): T => mh.inject(token);
      backing.injectOptional = <T>(token: ResourceToken<T>): T | undefined =>
        mh.injectOptional(token);
      backing.devtools = this.opts.devtools ?? mh.devtools;
      backing.hostCalls = this.opts.hostCalls;
      return makeNativeContext(backing);
    }
    return makeScriptContext(backing);
  }

  // ── Unload / dispose ──

  unload(id: string): void {
    const a = this.active.get(id);
    if (!a) return;
    for (let i = a.disposeFns.length - 1; i >= 0; i--) {
      try {
        a.disposeFns[i]();
      } catch (e) {
        log.error("PluginHost", `Dispose error in plugin "${id}": ${(e as Error).message}`);
      }
    }
    this.active.delete(id);
    this.discovered.delete(id);
    this.registry.unregister(id);
  }

  disposeAll(): void {
    let order: string[] = [];
    try {
      order = this.registry.resolveOrder();
    } catch {
      order = [...this.active.keys()];
    }
    for (let i = order.length - 1; i >= 0; i--) this.unload(order[i]);
  }

  /** Reload a single plugin (dispose + re-discover + reload). */
  async reload(id: string): Promise<void> {
    const d = this.discovered.get(id);
    if (!d) {
      log.warn("PluginHost", `reload: "${id}" not discovered`);
      return;
    }
    this.unload(id);
    this.discovered.set(id, d);
    if (!this.registry.has(id)) this.registry.register(d.manifest);
    await this.loadOne(id);
  }

  // ── Snapshot ──

  snapshot(): PluginInfo[] {
    const out: PluginInfo[] = [];
    for (const [, a] of this.active) {
      out.push(
        pluginInfoFromManifest(a.manifest, a.status, {
          error: a.error,
          deniedPermissions: a.granted.denied,
          source: a.source,
        }),
      );
    }
    // Include discovered-but-not-loaded (pending) for diagnostics.
    for (const [id, d] of this.discovered) {
      if (!this.active.has(id)) {
        out.push(pluginInfoFromManifest(d.manifest, "pending", { source: d.source }));
      }
    }
    return out;
  }

  getActiveIds(): string[] {
    return [...this.active.entries()].filter(([, a]) => a.status === "active").map(([id]) => id);
  }
}

// ── Engine version range check (minimal) ──

function satisfiesEngine(engine: string, range: string): boolean {
  if (range === "*") return true;
  const eParts = engine.split(".").map((n) => parseInt(n, 10));
  // Strip comparator prefix
  const r = range.replace(/^[\^~>==]+/, "").split(".");
  const rParts = r.map((n) => (n === "x" || n === "X" ? NaN : parseInt(n, 10)));
  if (range.startsWith("^")) {
    // ^1.2.3 → >=1.2.3 <2.0.0
    if (eParts[0] !== rParts[0]) return false;
    if (eParts[1] < rParts[1]) return false;
    if (eParts[1] === rParts[1] && eParts[2] < (rParts[2] || 0)) return false;
    return true;
  }
  if (range.startsWith("~")) {
    if (eParts[0] !== rParts[0]) return false;
    if (eParts[1] !== rParts[1]) return false;
    if (eParts[2] < (rParts[2] || 0)) return false;
    return true;
  }
  if (range.startsWith(">=")) {
    for (let i = 0; i < 3; i++) {
      if (eParts[i] > rParts[i]) return true;
      if (eParts[i] < rParts[i]) return false;
    }
    return true;
  }
  // plain / = / exact-ish (ignore missing minor/patch → treat as x)
  for (let i = 0; i < 3; i++) {
    if (Number.isNaN(rParts[i])) continue;
    if (eParts[i] !== rParts[i]) return false;
  }
  return true;
}

// ── Context backing factories ──
//
// These are simple in-process implementations. For worker-js/wasm/quickjs
// plugins that run off-thread / in a VM, the loader replaces these with
// MessageChannel-/marshal-backed proxies that forward to the host. The
// in-process versions are used for renderer-thread (quickjs/asset) plugins
// and for tests.

function makeEventBus(_pluginId: string, _catalog?: Record<string, unknown>): PluginEventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    subscribe(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (data: unknown) => void);
      return () => set!.delete(handler as (data: unknown) => void);
    },
    publish(event, data) {
      const set = handlers.get(event);
      if (set) for (const h of set) h(data);
    },
  };
}

function makeStateStore(_pluginId: string): PluginStateStore {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => {
      store.set(key, value);
    },
    delete: (key: string): void => {
      store.delete(key);
    },
    keys: (): string[] => [...store.keys()],
    save: async (): Promise<void> => {
      /* OPFS persistence wired in Phase 2 (storage permission) */
    },
    load: async (): Promise<void> => {
      /* OPFS load wired in Phase 2 */
    },
  };
}

function makeTickApi(_pluginId: string): PluginTickApi {
  const callbacks = new Set<(dt: number, elapsedTime: number) => void>();
  // The host's render/sim loop calls `runTicks(dt, t)` each frame; we expose
  // registration here and the host drains the set. Stored on the api object
  // so the host can access it.
  const api: PluginTickApi & { _drain: (dt: number, t: number) => void } = {
    onTick(fn) {
      callbacks.add(fn);
      return () => callbacks.delete(fn);
    },
    _drain(dt, t) {
      for (const cb of callbacks) cb(dt, t);
    },
  };
  return api;
}

function fmt(msg: string, args: unknown[]): string {
  return args.length > 0 ? `${msg} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}` : msg;
}

function makeLogger(_pluginId: string): PluginLogger {
  const prefix = `[plugin:${_pluginId}]`;
  return {
    info: (msg, ...args) => log.info(prefix, fmt(msg, args)),
    warn: (msg, ...args) => log.warn(prefix, fmt(msg, args)),
    error: (msg, ...args) => log.error(prefix, fmt(msg, args)),
    debug: (msg, ...args) => log.debug(prefix, fmt(msg, args)),
  };
}
