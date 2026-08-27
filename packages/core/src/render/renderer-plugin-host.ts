// ============================================================================
// RendererPluginHost — owns renderer-plugin lifecycle and dispatch
//
// Owned by `GameRenderer`. Holds the `RendererInputBus`, the active
// `CameraControllerLike`, and per-phase frame/resize/render-pass hook lists.
// Each plugin receives a per-plugin `RendererPluginContext` facade during
// `register()` so hooks/dispose fns are tracked per-plugin and cleaned up on
// `unloadPlugin`.
//
// Setters for offscreen/render-target/RAF are routed to the `GameRenderer`
// via callbacks supplied at construction — the host does not import
// `GameRenderer` directly (avoids a circular import).
// ============================================================================

import type { ResourceToken } from "../ecs/resource";
import { assertNoDuplicate, assertRequired, isStrict, warnLeak } from "../plugin/diagnostics";
import type { PluginDevToolsAPI } from "../plugin/plugin";
import type {
    CameraControllerLike,
    FrameHook,
    FramePhase,
    RendererInputBus,
    RendererPlugin,
    RendererPluginContext,
    RenderPassHook,
    ResizeHook,
} from "../plugin/renderer-plugin";
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
export interface RendererPluginHostCallbacks {
  getCanvas: () => HTMLCanvasElement;
  getDevice: () => GPUDevice;
  getFormat: () => GPUTextureFormat;
  getGraph: () => FrameGraph;
  getSlotRegistry: () => SlotRegistry;
  setOffscreenMode: (mode: OffscreenMode | null) => void;
  setRenderTargetProvider: (provider: RenderTargetProvider | null) => void;
  setRAFSource: (src: RAFSource | null, cancel: CancelRAF | null) => void;
  setViewportCount: (count: number) => void;
}

interface ActiveRendererPlugin {
  plugin: RendererPlugin;
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

export class RendererPluginHost {
  private canvas: HTMLCanvasElement;
  private callbacks: RendererPluginHostCallbacks;
  private inputBus: RendererInputBus;
  private plugins: Map<string, RendererPlugin> = new Map();
  private loadOrder: string[] = [];
  private active: Map<string, ActiveRendererPlugin> = new Map();
  /** Plugins registered via registerPluginDeferred() but not yet activated. */
  private pending: Map<string, RendererPlugin> = new Map();
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
  private _devtools: PluginDevToolsAPI | null = null;

  constructor(canvas: HTMLCanvasElement, callbacks: RendererPluginHostCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.inputBus = new RendererInputBusImpl(canvas);
  }

  /**
   * Inject the DevTools API so renderer plugins can self-register debug
   * panels via `ctx.devtools.registerPanel(...)` during their `register()`.
   */
  setDevToolsAPI(api: PluginDevToolsAPI): void {
    this._devtools = api;
  }

  // ── Registration ──

  registerPlugin(plugin: RendererPlugin): void {
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
      for (const token of plugin.provides ?? []) {
        if (this.providers.has(token.key)) {
          throw new Error(
            `Renderer plugin "${plugin.name}" provides "${token.key}" but it is already provided by "${this.providers.get(token.key)}". ` +
              `Duplicate provides are not allowed.`,
          );
        }
      }
      // Check requires
      for (const token of plugin.requires ?? []) {
        if (!this.providers.has(token.key) && !selfProvides.has(token.key)) {
          assertRequired(this.providers, token, plugin.name);
        }
      }
    }
    this.plugins.set(plugin.name, plugin);
    this.loadOrder.push(plugin.name);
    this.activatePlugin(plugin);
  }

  /**
   * Register a renderer plugin without activating it.
   * Call `activateAll()` after all plugins are registered
   * to activate them in dependency-resolved order (topological sort).
   */
  registerPluginDeferred(plugin: RendererPlugin): void {
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
    for (const [name, active] of this.active) {
      for (const token of active.plugin.provides ?? []) {
        allProviders.set(token.key, name);
      }
    }
    for (const [name, plugin] of this.pending) {
      for (const token of plugin.provides ?? []) {
        if (allProviders.has(token.key)) {
          throw new Error(
            `Renderer plugin "${name}" provides "${token.key}" but it is already provided by "${allProviders.get(token.key)}". ` +
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

  /**
   * Activate all plugins registered via `registerPluginDeferred()` in
   * dependency-resolved order (topological sort by `dependencies`).
   * Plugins with no dependencies are activated first.
   *
   * In DOWNDRAFT_STRICT mode, validates the full dependency graph
   * (provides/requires) before activating any plugin.
   */
  activateAll(): void {
    this.validateGraph();
    // Topological sort by dependencies (string-based plugin names).
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
      if (plugin?.dependencies) {
        for (const dep of plugin.dependencies) {
          if (this.pending.has(dep) || this.active.has(dep)) {
            resolve(dep);
          }
        }
      }
      visiting.delete(name);
      visited.add(name);
      resolved.push(name);
    };
    for (const name of this.pending.keys()) {
      resolve(name);
    }
    for (const name of resolved) {
      if (this.pending.has(name) && !this.active.has(name)) {
        const plugin = this.pending.get(name)!;
        this.pending.delete(name);
        this.loadOrder.push(name);
        this.activatePlugin(plugin);
      }
    }
  }

  /**
   * Register and activate multiple renderer plugins in dependency-resolved order.
   * This is the standard batch registration pattern — equivalent to
   * calling `registerPluginDeferred()` for each plugin followed by
   * `activateAll()`. Use this when multiple plugins have interdependencies
   * (via `provides`/`requires` typed tokens or `dependencies` string arrays).
   */
  usePlugins(plugins: RendererPlugin[]): void {
    for (let i = 0; i < plugins.length; i++) {
      this.registerPluginDeferred(plugins[i]);
    }
    this.activateAll();
  }

  private activatePlugin(plugin: RendererPlugin): void {
    const active: ActiveRendererPlugin = {
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
      log.error("RendererPluginHost", `Register error in plugin "${plugin.name}": ${err}`);
      // Roll back registration on failure.
      this.unloadPlugin(plugin.name);
    }
  }

  unloadPlugin(name: string): void {
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
    for (const key of active.providedKeys) {
      this.resources.delete(key);
      this.providers.delete(key);
    }
    for (let i = active.disposeFns.length - 1; i >= 0; i--) {
      try {
        active.disposeFns[i]();
      } catch (err) {
        log.error("RendererPluginHost", `Dispose error in plugin "${name}": ${err}`);
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
    for (const name of names) this.unloadPlugin(name);
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

  getPlugin(name: string): RendererPlugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): string[] {
    return [...this.loadOrder];
  }

  // ── Dispatch (called by GameRenderer) ──

  dispatchFrame(phase: FramePhase, dt: number, elapsedTime: number): void {
    const hooks = this.frameHooks[phase];
    for (let i = 0; i < hooks.length; i++) {
      try {
        hooks[i].fn(dt, elapsedTime);
      } catch (err) {
        log.error("RendererPluginHost", `Frame hook error (${phase}) in "${hooks[i].owner}": ${err}`);
      }
    }
  }

  dispatchResize(cssWidth: number, cssHeight: number, dpr: number): void {
    for (let i = 0; i < this.resizeHooks.length; i++) {
      try {
        this.resizeHooks[i].fn(cssWidth, cssHeight, dpr);
      } catch (err) {
        log.error("RendererPluginHost", `Resize hook error in "${this.resizeHooks[i].owner}": ${err}`);
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
        log.error("RendererPluginHost", `Render-pass hook error in "${this.renderPassHooks[i].owner}": ${err}`);
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
      log.error("RendererPluginHost", `Camera controller error: ${err}`);
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
      log.error("RendererPluginHost", `Viewport camera provider error: ${err}`);
      return null;
    }
  }

  // ── Typed DI (renderer-side) ──

  /**
   * Provide a typed resource to the renderer plugin graph. Called from the
   * per-plugin context facade.
   */
  private provideResource<T>(name: string, token: ResourceToken<T>, value: T, active: ActiveRendererPlugin): void {
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

  private makeContext(name: string, active: ActiveRendererPlugin): RendererPluginContext {
    return {
      name,

      getCanvas: () => this.callbacks.getCanvas(),
      getDevice: () => this.callbacks.getDevice(),
      getFormat: () => this.callbacks.getFormat(),
      getGraph: () => this.callbacks.getGraph(),
      getSlotRegistry: () => this.callbacks.getSlotRegistry(),

      getInputBus: () => this.inputBus,

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
const NoopRendererDevToolsAPI: PluginDevToolsAPI = {
  registerPanel: () => {},
  registerOverlayToggle: () => {},
  registerDataFeed: () => {},
  registerCommand: () => {},
  registerSABStat: () => {},
};
