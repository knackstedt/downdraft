// ============================================================================
// RendererModuleHost — owns renderer-plugin lifecycle and dispatch
//
// Owned by `GameRenderer`. Holds the `RendererInputBus`, the active
// `CameraControllerLike`, and per-phase frame/resize/render-pass hook lists.
// Each plugin receives a per-plugin `RendererModuleContext` facade during
// `register()` so hooks/dispose fns are tracked per-plugin and cleaned up on
// `unloadModule`.
//
// Setters for offscreen/render-target/RAF are routed to the `GameRenderer`
// via callbacks supplied at construction — the host does not import
// `GameRenderer` directly (avoids a circular import).
// ============================================================================

import type { ResourceToken } from "../ecs/resource";
import type { UIInputRouter } from "../input/ui-router";
import type { CrossThreadToken, ModuleThreadInfo, ThreadTag } from "../module/cross-thread";
import { assertNoDuplicate, assertRequired, isStrict, warnLeak } from "../module/diagnostics";
import type { ModuleDevToolsAPI } from "../module/module";
import type {
    CameraControllerLike,
    FrameHook,
    FramePhase,
    RendererInputBus,
    RendererModule,
    RendererModuleContext,
    RenderPassHook,
    ResizeHook,
} from "../module/renderer-module";
import type { RenderSurface } from "../platform/render-surface";
import { createLogger } from "../util/logger";
import type { CameraState } from "./camera";
import type { FrameGraph, SlotRegistry } from "./frame-graph";
import type {
    CameraViewportInfo,
    CancelRAF,
    OffscreenMode,
    RAFSource,
    RenderTargetProvider
} from "./game-renderer";
import { RendererInputBusImpl } from "./renderer-input-bus";

const log = createLogger();

/** Callbacks the host owner (GameRenderer) supplies so plugin setters route through it. */
export interface RendererModuleHostCallbacks {
  getSurface: () => RenderSurface;
  /** @deprecated Use getSurface — kept so existing callback objects keep compiling. */
  getCanvas?: () => RenderSurface;
  getDevice: () => GPUDevice;
  getFormat: () => GPUTextureFormat;
  getGraph: () => FrameGraph;
  getSlotRegistry: () => SlotRegistry;
  setOffscreenMode: (mode: OffscreenMode | null) => void;
  setRenderTargetProvider: (provider: RenderTargetProvider | null) => void;
  setRAFSource: (src: RAFSource | null, cancel: CancelRAF | null) => void;
  setViewportCount: (count: number) => void;
  getUIInputRouter: () => UIInputRouter | null;
  registerUiCompositor?: (c: import("../module/renderer-module").ScreenUiCompositor) => () => void;
}

interface ActiveRendererModule {
  plugin: RendererModule;
  disposeFns: Array<() => void>;
  providedKeys: Set<string>;
  // Per-phase hook indices so unload can splice just this plugin's hooks.
  frameHookIds: Map<number, number>; // phase → index in that phase array (not tracked; we filter by owner instead)
}

interface ResourceEntry {
  token: ResourceToken<unknown>;
  value: unknown;
}

// We track hook ownership by tagging each registered hook with its owner name.
interface OwnedFrameHook { owner: string; fn: FrameHook; }
interface OwnedResizeHook { owner: string; fn: ResizeHook; }
interface OwnedRenderPassHook { owner: string; fn: RenderPassHook; }

export class RendererModuleHost {
  private canvas: RenderSurface;
  private callbacks: RendererModuleHostCallbacks;
  private inputBus: RendererInputBus;
  private plugins: Map<string, RendererModule> = new Map();
  private loadOrder: string[] = [];
  private active: Map<string, ActiveRendererModule> = new Map();
  /** Plugins registered via registerModuleDeferred() but not yet activated. */
  private pending: Map<string, RendererModule> = new Map();
  /** Typed resource store: tokenKey → { token, value } */
  private resources: Map<string, ResourceEntry> = new Map();
  /** Reverse map: tokenKey → provider plugin name */
  private providers: Map<string, string> = new Map();

  private frameHooks: Record<FramePhase, OwnedFrameHook[]> = {
    beforeFrame: [],
    beforeViewports: [],
    afterViewports: [],
    afterFrame: [],
  };
  private resizeHooks: OwnedResizeHook[] = [];
  private renderPassHooks: OwnedRenderPassHook[] = [];

  private cameraController: CameraControllerLike | null = null;
  private viewportCameraProvider: ((viewportIdx: number, dt: number, elapsedTime: number) => CameraViewportInfo | null) | null = null;
  private _devtools: ModuleDevToolsAPI | null = null;

  constructor(canvas: RenderSurface, callbacks: RendererModuleHostCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.inputBus = new RendererInputBusImpl(canvas);
  }

  /**
   * Inject the DevTools API so renderer plugins can self-register debug
   * panels via `ctx.devtools.registerPanel(...)` during their `register()`.
   */
  setDevToolsAPI(api: ModuleDevToolsAPI): void {
    this._devtools = api;
  }

  // ── Registration ──

  registerModule(plugin: RendererModule): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Renderer plugin "${plugin.name}" already registered`);
    }
    if (plugin.dependencies) {
      for (let i = 0; i < plugin.dependencies.length; i++) {
        if (!this.plugins.has(plugin.dependencies[i])) {
          throw new Error(
            `Renderer plugin "${plugin.name}" requires "${plugin.dependencies[i]}" which is not registered`,
          );
        }
      }
    }
    // isStrict(): validate provides/requires against already-active plugins.
    if (isStrict()) {
      const selfProvides = new Set(plugin.provides?.map((t) => t.key) ?? []);
      // Check for duplicate provides
      (plugin.provides ?? []).forEach((token) => {
        if (this.providers.has(token.key)) {
          throw new Error(
            `Renderer plugin "${plugin.name}" provides "${token.key}" but it is already provided by "${this.providers.get(token.key)}". ` +
              `Duplicate provides are not allowed.`,
          );
        }
      });
      // Check requires
      (plugin.requires ?? []).forEach((token) => {
        if (!this.providers.has(token.key) && !selfProvides.has(token.key)) {
          assertRequired(this.providers, token, plugin.name);
        }
      });
    }
    this.plugins.set(plugin.name, plugin);
    this.loadOrder.push(plugin.name);
    this.activateModule(plugin);
  }

  /**
   * Register a renderer plugin without activating it.
   * Call `activateAll()` after all plugins are registered
   * to activate them in dependency-resolved order (topological sort).
   */
  registerModuleDeferred(plugin: RendererModule): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Renderer plugin "${plugin.name}" already registered`);
    }
    this.plugins.set(plugin.name, plugin);
    this.pending.set(plugin.name, plugin);
  }

  /**
   * Validate the full dependency graph across all pending + active renderer plugins.
   * Called before batch activation in activateAll().
   */
  private validateGraph(): void {
    if (!isStrict()) return;
    // Build a complete providers map from all pending + active plugins
    const allProviders = new Map<string, string>();
    for (const [name, active] of this.active.entries()) {
      (active.plugin.provides ?? []).forEach((token) => {
        allProviders.set(token.key, name);
      });
    }
    for (const [name, plugin] of this.pending.entries()) {
      (plugin.provides ?? []).forEach((token) => {
        if (allProviders.has(token.key)) {
          throw new Error(
            `Renderer plugin "${name}" provides "${token.key}" but it is already provided by "${allProviders.get(token.key)}". ` +
              `Duplicate provides are not allowed.`,
          );
        }
        allProviders.set(token.key, name);
      });
    }
    // Check all requires
    for (const [name, plugin] of this.pending.entries()) {
      if (!plugin.requires) continue;
      plugin.requires.forEach((token) => {
        if (!allProviders.has(token.key)) {
          assertRequired(allProviders, token, name);
        }
      });
    }
  }

  /**
   * Activate all plugins registered via `registerModuleDeferred()` in
   * dependency-resolved order (topological sort by `dependencies` AND
   * `requires` tokens — a plugin that requires a token activates after
   * whichever pending/active plugin provides it).
   * Plugins with no dependencies are activated first.
   *
   * In DOWNDRAFT_STRICT mode, validates the full dependency graph
   * (provides/requires) before activating any plugin.
   */
  activateAll(): void {
    this.validateGraph();
    // Provider map: token key → module name (across pending + active).
    const tokenProviders = new Map<string, string>();
    const collectProvides = (plugin: RendererModule) => {
      (plugin.provides ?? []).forEach((token) => {
        if (!tokenProviders.has(token.key)) tokenProviders.set(token.key, plugin.name);
      });
    };
    for (const [, active] of this.active.entries()) collectProvides(active.plugin);
    for (const [, plugin] of this.pending.entries()) collectProvides(plugin);

    // Topological sort by dependencies (string-based plugin names) and by
    // requires (typed tokens → provider module).
    const resolved: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const resolve = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular renderer plugin dependency detected at "${name}"`);
      }
      visiting.add(name);
      const plugin = this.pending.get(name);
      if (plugin) {
        if (plugin.dependencies) {
          plugin.dependencies.forEach((dep) => {
            if (!this.plugins.has(dep)) {
              throw new Error(
                `Renderer plugin "${name}" requires "${dep}" which is not registered`,
              );
            }
            if (this.pending.has(dep)) resolve(dep);
          });
        }
        if (plugin.requires) {
          plugin.requires.forEach((token) => {
            const providerName = tokenProviders.get(token.key);
            if (providerName && providerName !== name && this.pending.has(providerName)) {
              resolve(providerName);
            }
          });
        }
      }
      visiting.delete(name);
      visited.add(name);
      resolved.push(name);
    };
    for (const name of this.pending.keys()) {
      resolve(name);
    }
    resolved.forEach((name) => {
      if (this.pending.has(name) && !this.active.has(name)) {
        const plugin = this.pending.get(name)!;
        this.pending.delete(name);
        this.loadOrder.push(name);
        this.activateModule(plugin);
      }
    });
  }

  /**
   * Register and activate multiple renderer plugins in dependency-resolved order.
   * This is the standard batch registration pattern — equivalent to
   * calling `registerModuleDeferred()` for each plugin followed by
   * `activateAll()`. Use this when multiple plugins have interdependencies
   * (via `provides`/`requires` typed tokens or `dependencies` string arrays).
   */
  useModules(plugins: RendererModule[]): void {
    for (let i = 0; i < plugins.length; i++) {
      this.registerModuleDeferred(plugins[i]);
    }
    this.activateAll();
  }

  private activateModule(plugin: RendererModule): void {
    const active: ActiveRendererModule = {
      plugin,
      disposeFns: [],
      providedKeys: new Set(),
      frameHookIds: new Map(),
    };
    this.active.set(plugin.name, active);
    const ctx = this.makeContext(plugin.name, active);
    try {
      plugin.register(ctx);
    } catch (err) {
      // Roll back partial activation, then re-throw so the caller sees it —
      // mirrors ModuleHost semantics (a failed register() must not be silent).
      this.unloadModule(plugin.name);
      throw err;
    }
  }

  unloadModule(name: string): void {
    const active = this.active.get(name);
    if (!active) return;
    if (isStrict()) {
      warnLeak(name, {
        providedCount: active.providedKeys.size,
        sabCount: 0, // renderer plugins don't allocate SAB channels
        disposeFnCount: active.disposeFns.length,
      });
    }
    // Clean up provided resources
    for (const key of active.providedKeys.values()) {
      this.resources.delete(key);
      this.providers.delete(key);
    }
    for (let i = active.disposeFns.length - 1; i >= 0; i--) {
      try {
        active.disposeFns[i]();
      } catch (err) {
        log.error("RendererModuleHost", `Dispose error in plugin "${name}": ${err}`);
      }
    }
    // Remove this plugin's hooks.
    this.frameHooks.beforeFrame = this.frameHooks.beforeFrame.filter((h) => h.owner !== name);
    this.frameHooks.beforeViewports = this.frameHooks.beforeViewports.filter((h) => h.owner !== name);
    this.frameHooks.afterViewports = this.frameHooks.afterViewports.filter((h) => h.owner !== name);
    this.frameHooks.afterFrame = this.frameHooks.afterFrame.filter((h) => h.owner !== name);
    this.resizeHooks = this.resizeHooks.filter((h) => h.owner !== name);
    this.renderPassHooks = this.renderPassHooks.filter((h) => h.owner !== name);
    // If this plugin owned the camera controller, clear it.
    // (We can't tell who set it; clear conservatively if the plugin name
    // matches a convention. For now, leave the controller in place — a
    // well-behaved plugin should null it in its dispose fn. We also call
    // onDispose before clearing hooks, so the plugin's dispose fn can do it.)
    this.active.delete(name);
    this.plugins.delete(name);
    this.pending.delete(name);
    const idx = this.loadOrder.indexOf(name);
    if (idx >= 0) this.loadOrder.splice(idx, 1);
  }

  disposeAll(): void {
    // Unload in reverse registration order.
    const names = [...this.loadOrder].reverse();
    names.forEach((name) => { this.unloadModule(name);; });
    this.inputBus.destroy();
    this.cameraController = null;
  }

  // ── Getters ──

  getInputBus(): RendererInputBus {
    return this.inputBus;
  }

  getCameraController(): CameraControllerLike | null {
    return this.cameraController;
  }

  getModule(name: string): RendererModule | undefined {
    return this.plugins.get(name);
  }

  listModules(): string[] {
    return [...this.loadOrder];
  }

  /**
   * Produce a thread-tagged snapshot of all active renderer modules for the
   * cross-thread report + doctor panel. `thread` is normally "renderer" but
   * is parameterized for symmetry with `ModuleHost.snapshot()`.
   *
   * Tokens created via `crossThreadToken()` carry a `__thread` tag; the
   * snapshot records it in `tokenThreads` so `buildCrossThreadReport()`
   * can flag tokens provided on the wrong thread.
   */
  snapshot(thread: ThreadTag): ModuleThreadInfo[] {
    const out: ModuleThreadInfo[] = [];
    for (const [name, active] of this.active.entries()) {
      const plugin = active.plugin;
      const tokenThreads: Record<string, ThreadTag> = {};
      const collectTags = (tokens?: ResourceToken<unknown>[]) => {
        (tokens ?? []).forEach((t) => {
          const tag = (t as CrossThreadToken<unknown>).__thread;
          if (tag) tokenThreads[t.key] = tag;
        });
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

  // ── Dispatch (called by GameRenderer) ──

  dispatchFrame(phase: FramePhase, dt: number, elapsedTime: number): void {
    const hooks = this.frameHooks[phase];
    for (let i = 0; i < hooks.length; i++) {
      try {
        hooks[i].fn(dt, elapsedTime);
      } catch (err) {
        log.error("RendererModuleHost", `Frame hook error (${phase}) in "${hooks[i].owner}": ${err}`);
      }
    }
  }

  dispatchResize(cssWidth: number, cssHeight: number, dpr: number): void {
    for (let i = 0; i < this.resizeHooks.length; i++) {
      try {
        this.resizeHooks[i].fn(cssWidth, cssHeight, dpr);
      } catch (err) {
        log.error("RendererModuleHost", `Resize hook error in "${this.resizeHooks[i].owner}": ${err}`);
      }
    }
    this.cameraController?.setAspect(
      Math.round(cssWidth * dpr),
      Math.round(cssHeight * dpr),
    );
  }

  dispatchRenderPass(
    passEncoder: GPURenderPassEncoder,
    camera: CameraState,
    viewportIdx: number,
  ): void {
    for (let i = 0; i < this.renderPassHooks.length; i++) {
      try {
        this.renderPassHooks[i].fn(passEncoder, camera, viewportIdx);
      } catch (err) {
        log.error("RendererModuleHost", `Render-pass hook error in "${this.renderPassHooks[i].owner}": ${err}`);
      }
    }
  }

  /**
   * Returns the active camera controller's state for a viewport, or null if
   * no controller is registered. `GameRenderer` uses this as a fallback when
   * the game's `onViewport` callback returns null.
   */
  getCameraState(viewportIdx: number): CameraState | null {
    if (!this.cameraController) return null;
    try {
      return this.cameraController.getCameraState(viewportIdx);
    } catch (err) {
      log.error("RendererModuleHost", `Camera controller error: ${err}`);
      return null;
    }
  }

  /**
   * If a viewport camera provider is installed (e.g. by XR), call it for the
   * given viewport. Returns the provider's result or null. `GameRenderer`
   * calls this *before* the game's `onViewport` callback — a non-null result
   * takes priority.
   */
  getViewportCameraInfo(viewportIdx: number, dt: number, elapsedTime: number): CameraViewportInfo | null {
    if (!this.viewportCameraProvider) return null;
    try {
      return this.viewportCameraProvider(viewportIdx, dt, elapsedTime);
    } catch (err) {
      log.error("RendererModuleHost", `Viewport camera provider error: ${err}`);
      return null;
    }
  }

  // ── Typed DI (renderer-side) ──

  /**
   * Provide a typed resource to the renderer plugin graph. Called from the
   * per-plugin context facade.
   */
  private provideResource<T>(name: string, token: ResourceToken<T>, value: T, active: ActiveRendererModule): void {
    if (isStrict()) {
      assertNoDuplicate(this.providers, token as ResourceToken<unknown>, name);
    }
    this.resources.set(token.key, { token: token as ResourceToken<unknown>, value });
    this.providers.set(token.key, name);
    active.providedKeys.add(token.key);
  }

  /**
   * Provide a typed resource from an external provider (e.g. the LibraryHost).
   * Unlike `provideResource`, this does not require an active plugin context.
   * The `providerName` is used for diagnostics and cleanup tracking.
   */
  provideExternal<T>(providerName: string, token: ResourceToken<T>, value: T): void {
    if (isStrict()) {
      assertNoDuplicate(this.providers, token as ResourceToken<unknown>, providerName);
    }
    this.resources.set(token.key, { token: token as ResourceToken<unknown>, value });
    this.providers.set(token.key, providerName);
  }

  /**
   * Inject a typed resource from the renderer plugin graph. Public so the
   * LibraryHost can read resources provided by renderer plugins.
   */
  injectResource<T>(token: ResourceToken<T>): T {
    const entry = this.resources.get(token.key);
    if (!entry) {
      throw new Error(
        `Renderer plugin injects "${token.key}" which is not provided. ` +
          `Add a plugin that provides it, or use injectOptional() for safe reads.`,
      );
    }
    return entry.value as T;
  }

  /**
   * Inject a typed resource optionally. Public so the LibraryHost can read
   * resources provided by renderer plugins.
   */
  injectResourceOptional<T>(token: ResourceToken<T>): T | undefined {
    const entry = this.resources.get(token.key);
    return entry?.value as T | undefined;
  }

  // ── Per-plugin context facade ──

  private makeContext(name: string, active: ActiveRendererModule): RendererModuleContext {
    return {
      name,

      getSurface: () => this.callbacks.getSurface(),
      getCanvas: () => this.callbacks.getSurface(),
      getDevice: () => this.callbacks.getDevice(),
      getFormat: () => this.callbacks.getFormat(),
      getGraph: () => this.callbacks.getGraph(),
      getSlotRegistry: () => this.callbacks.getSlotRegistry(),

      getInputBus: () => this.inputBus,

      getUIInputRouter: () => this.callbacks.getUIInputRouter(),
      registerUiCompositor: this.callbacks.registerUiCompositor
        ? (c) => this.callbacks.registerUiCompositor!(c)
        : undefined,

      onFrame: (phase, fn) => {
        const entry: OwnedFrameHook = { owner: name, fn };
        this.frameHooks[phase].push(entry);
        return () => {
          const arr = this.frameHooks[phase];
          const idx = arr.indexOf(entry);
          if (idx >= 0) arr.splice(idx, 1);
        };
      },

      onResize: (fn) => {
        const entry: OwnedResizeHook = { owner: name, fn };
        this.resizeHooks.push(entry);
        return () => {
          const idx = this.resizeHooks.indexOf(entry);
          if (idx >= 0) this.resizeHooks.splice(idx, 1);
        };
      },

      onRenderPass: (fn) => {
        const entry: OwnedRenderPassHook = { owner: name, fn };
        this.renderPassHooks.push(entry);
        return () => {
          const idx = this.renderPassHooks.indexOf(entry);
          if (idx >= 0) this.renderPassHooks.splice(idx, 1);
        };
      },

      setCameraController: (controller) => {
        // Only one active controller at a time. Last writer wins; a plugin
        // should null this in its dispose fn if it wants to release the slot.
        this.cameraController = controller;
      },
      getCameraController: () => this.cameraController,

      setViewportCameraProvider: (provider) => {
        this.viewportCameraProvider = provider;
      },

      setViewportCount: (count) => this.callbacks.setViewportCount(count),

      setOffscreenMode: (mode) => this.callbacks.setOffscreenMode(mode),
      setRenderTargetProvider: (provider) => this.callbacks.setRenderTargetProvider(provider),
      setRAFSource: (src, cancel) => this.callbacks.setRAFSource(src, cancel),

      devtools: this._devtools ?? NoopRendererDevToolsAPI,

      provide: <T>(token: ResourceToken<T>, value: T) => this.provideResource(name, token, value, active),
      inject: <T>(token: ResourceToken<T>): T => this.injectResource(token),
      injectOptional: <T>(token: ResourceToken<T>): T | undefined => this.injectResourceOptional(token),

      onDispose: (fn) => {
        active.disposeFns.push(fn);
      },
    };
  }
}

// No-op DevTools API stub — used when setDevToolsAPI() hasn't been called.
const NoopRendererDevToolsAPI: ModuleDevToolsAPI = {
  registerPanel: () => {},
  registerOverlayToggle: () => {},
  registerDataFeed: () => {},
  registerCommand: () => {},
  registerSABStat: () => {},
};
