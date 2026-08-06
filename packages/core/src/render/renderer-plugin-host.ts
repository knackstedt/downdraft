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

import type {
    CameraControllerLike,
    FrameHook,
    FramePhase,
    RenderPassHook,
    RendererInputBus,
    RendererPlugin,
    RendererPluginContext,
    ResizeHook,
} from "../plugin/renderer-plugin";
import { createLogger } from "../util/logger";
import type { CameraState } from "./camera";
import type {
    CameraViewportInfo,
    CancelRAF,
    OffscreenMode,
    RAFSource,
    RenderTargetProvider
} from "./game-renderer";
import type { RenderPipeline } from "./render-pipeline";
import { RendererInputBusImpl } from "./renderer-input-bus";

const log = createLogger();

/** Callbacks the host owner (GameRenderer) supplies so plugin setters route through it. */
export interface RendererPluginHostCallbacks {
  getCanvas: () => HTMLCanvasElement;
  getDevice: () => GPUDevice;
  getFormat: () => GPUTextureFormat;
  getPipeline: () => RenderPipeline;
  setOffscreenMode: (mode: OffscreenMode | null) => void;
  setRenderTargetProvider: (provider: RenderTargetProvider | null) => void;
  setRAFSource: (src: RAFSource | null, cancel: CancelRAF | null) => void;
  setViewportCount: (count: number) => void;
}

interface ActiveRendererPlugin {
  plugin: RendererPlugin;
  disposeFns: Array<() => void>;
  // Per-phase hook indices so unload can splice just this plugin's hooks.
  frameHookIds: Map<number, number>; // phase → index in that phase array (not tracked; we filter by owner instead)
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

  constructor(canvas: HTMLCanvasElement, callbacks: RendererPluginHostCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.inputBus = new RendererInputBusImpl(canvas);
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
    this.plugins.set(plugin.name, plugin);
    this.loadOrder.push(plugin.name);
    this.activatePlugin(plugin);
  }

  private activatePlugin(plugin: RendererPlugin): void {
    const active: ActiveRendererPlugin = {
      plugin,
      disposeFns: [],
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

  // ── Per-plugin context facade ──

  private makeContext(name: string, active: ActiveRendererPlugin): RendererPluginContext {
    return {
      name,

      getCanvas: () => this.callbacks.getCanvas(),
      getDevice: () => this.callbacks.getDevice(),
      getFormat: () => this.callbacks.getFormat(),
      getPipeline: () => this.callbacks.getPipeline(),

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

      onDispose: (fn) => {
        active.disposeFns.push(fn);
      },
    };
  }
}
