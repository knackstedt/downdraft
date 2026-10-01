// ============================================================================
// GameRenderer — generic WebGPU render loop infrastructure
// Extracted from WebGPURenderer: device init, surface config, rAF loop,
// frame rate limiter, viewport management, telemetry, GPU UI pass, depth cache.
// Games register render passes via FrameGraph slots and provide game-specific
// logic through callback hooks.
// ============================================================================

import { LayoutEngine, UIInputRouter, UIRenderer, UIRoot } from "../imui";
import type { RendererModule } from "../module/renderer-module";
import type { RenderSurface, RenderSurfaceContext } from "../platform/render-surface";
import { getHostCapabilities, getNativeHost } from "../platform/runtime";
import { disableRendererIndexedDb } from "../profiling/iops/renderer-idb-disable";
import { TelemetryCollector } from "../telemetry/collector";
import { DebugOverlay as ProfilingOverlay } from "../telemetry/debug-overlay";
import type { GPUAdapterInfo as GPUAdapterInfoData } from "../telemetry/gpu-profiler";
import { GPUProfiler, type FrameGraphData, type GPUInfo } from "../telemetry/gpu-profiler";
import { GPUResourceTracker } from "../telemetry/gpu-resource-tracker";
import { createLogger } from "../util/logger";
import { CanvasResizeWatcher, type CanvasResizeHandler } from "./canvas-resize-watcher";
import { GPUDeviceManager } from "./device";
import type { RenderContext } from "./frame-graph";
import { FrameGraph, SlotRegistry, type TextureHandle } from "./frame-graph";
import { InputManager } from "./input-manager";
import { RendererModuleHost } from "./renderer-module-host";
import { installShaderValidationGuard } from "./shader-validator";
import { TrackedRenderPass } from "./tracked-render-pass";

const log = createLogger();

export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GameRendererConfig {
  /**
   * Pre-created device/adapter to borrow instead of requesting new ones.
   * On the native host a single wgpu device is shared between the host and
   * the renderer — this path avoids a second requestDevice() on the same
   * surface. When omitted, init() falls back to the native host's device
   * (getNativeHost()) before self-acquiring via navigator.gpu.
   */
  device?: GPUDevice;
  adapter?: GPUAdapter;
  /**
   * Configure the surface context at init. Defaults to true — set false
   * when the surface was already configured by the device owner (e.g. the
   * native host configures it at window creation). Automatically skipped
   * when the device was borrowed from the native host.
   */
  configureSurface?: boolean;
  depthFormat?: GPUTextureFormat;
  msaaSampleCount?: number;
  enableProfilingOverlay?: boolean;
  profilingOverlayConfig?: {
    position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    updateIntervalMs?: number;
    fontSize?: number;
    showGpuTime?: boolean;
    showPercentiles?: boolean;
    showMemory?: boolean;
  };
  /** Max number of cached depth textures (per resolution). Older entries are evicted. Default: 3. */
  depthTextureCacheSize?: number;
  /**
   * Whether clicking the canvas auto-requests pointer lock (hides + confines
   * the cursor). Default: false.
   *
   * Pointer lock is an opt-in FPS-style concern. 2D click-based games must
   * leave this off so the cursor stays visible and free-moving for
   * click-to-dig / click-to-place interactions. 3D games that want pointer
   * lock can either enable this or manage pointer lock themselves (e.g.
   * to-the-ocean uses its own RendererInputHandler and leaves this off).
   */
  enablePointerLock?: boolean;
  /**
   * Renderer mode:
   * - "3d" (default): Camera-based rendering with viewports. Each viewport
   *   requires camera info from onViewport callback or renderer plugins.
   * - "2d": No camera required. A default orthographic camera is used.
   *   The onViewport callback can return null (the default camera is used).
   *   Render passes receive a full-screen viewport with an identity-like
   *   camera. Depth texture is still provided but may be ignored by 2D passes.
   *   Set viewportCount to 0 and use the afterFrame callback for fully custom
   *   2D rendering (the FrameGraph viewport loop is skipped entirely).
   */
  mode?: "2d" | "3d";
  /**
   * Clear color for the canvas when viewportCount is 0 (2D mode with custom
   * rendering in afterFrame). Default: { r: 0, g: 0, b: 0, a: 1 }.
   * If null, the canvas is not cleared (the afterFrame callback must clear it).
   */
  clearColor?: GPUColor | null;
  /**
   * Whether to disable IndexedDB in the renderer thread by default.
   * The renderer should not do I/O — all persistence goes through the save
   * worker. Setting this to true (the default) patches IDBFactory.open to
   * throw, catching accidental IDB usage in renderer-side code early.
   * Set to false to allow renderer-side IDB (not recommended).
   * Default: true.
   */
  disableRendererIndexedDb?: boolean;
  /**
   * Emit console warnings when a renderFrame / getCurrentTexture call exceeds
   * 20ms. Off by default — the warnings themselves cause jank (console I/O in
   * the frame loop is self-amplifying). Enable when profiling.
   */
  debugTimingWarnings?: boolean;
  /**
   * Enable the TelemetryCollector (frame/draw/graph stats for the profiling
   * overlay + devtools). Default: true — set false in production builds that
   * never surface telemetry to skip the per-frame recording overhead.
   */
  enableTelemetry?: boolean;
  /**
   * GPU device-loss handling:
   * - "auto" (default): attempt in-place recovery — re-request the adapter/
   *   device, reconfigure the canvas, re-prepare UI + all registered frame
   *   graph passes, and recompile the graph's transient textures. Falls back
   *   to a page reload if recovery fails.
   * - "reload": reload the page after a short delay (legacy behavior). Use
   *   for games whose passes/modules can't recreate their GPU resources.
   *
   * Note: recovery recreates everything GameRenderer owns plus every
   * registered pass's `prepare()`. Renderer modules that cached
   * `ctx.getDevice()` at register time hold stale devices — modules should
   * call `getDevice()` lazily or re-create resources in a pass's `prepare()`.
   * Games can also hook `callbacks.onDeviceRecovered` for custom resources.
   */
  deviceLossRecovery?: "auto" | "reload";
}

export interface FrameCallbacks {
  beforeFrame?: (dt: number, elapsedTime: number) => void;
  beforeViewports?: (dt: number, elapsedTime: number) => void;
  onViewport?: (viewportIdx: number, dt: number, elapsedTime: number) => CameraViewportInfo | null;
  afterViewports?: (dt: number, elapsedTime: number) => void;
  afterFrame?: (dt: number, elapsedTime: number) => void;
  onResize?: (cssWidth: number, cssHeight: number, dpr: number) => void;
  getPostProcessInfo?: () => { pixelationEnabled: boolean; pixelSize: number; postProcessEffects: string[] };
  /** Fired when the GPU device is lost, before recovery is attempted. */
  onDeviceLost?: (info: GPUDeviceLostInfo) => void;
  /**
   * Fired after the engine re-acquired a device and re-prepared its own
   * resources (context, UI, frame-graph passes). Recreate any game-owned GPU
   * resources not held by a registered RenderPass here. Throwing (or a
   * rejected promise) aborts recovery and falls back to a page reload.
   */
  onDeviceRecovered?: (device: GPUDevice) => void | Promise<void>;
}

export interface CameraViewportInfo {
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fov: number;
    near: number;
    far: number;
    aspect: number;
    projectionMatrix?: Float32Array;
    viewMatrix?: Float32Array;
  };
  viewport: ViewportRect;
}

export interface OffscreenMode {
  type: "none" | "pixelation" | "postprocess";
  getColorView: () => GPUTextureView;
  getDepthView: () => GPUTextureView;
  scaleViewport?: (v: ViewportRect) => ViewportRect;
  applyPostprocess?: (encoder: GPUCommandEncoder, canvasView: GPUTextureView, w: number, h: number) => void;
  ensureTargets?: (w: number, h: number) => void;
  getSceneColorView?: () => GPUTextureView;
  getSceneDepthView?: () => GPUTextureView;
}

export interface RenderTargetProvider {
  getColorView(viewportIdx: number): GPUTextureView;
  getDepthView(viewportIdx: number, w: number, h: number): GPUTextureView;
  getViewportCount(): number;
  getViewportRect(idx: number, screenW: number, screenH: number): ViewportRect;
  beginFrame(): void;
  endFrame(encoder: GPUCommandEncoder): void;
}

export type RAFSource = (callback: (time: number) => void) => number;
export type CancelRAF = (id: number) => void;

export class GameRenderer implements CanvasResizeHandler {
  private canvas: RenderSurface;
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private context: RenderSurfaceContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private config: GameRendererConfig;

  private depthFormat: GPUTextureFormat = "depth32float";
  private msaaSampleCount: number = 1;
  private mode: "2d" | "3d" = "3d";

  // Infrastructure
  private deviceManager: GPUDeviceManager;
  private resizeWatcher: CanvasResizeWatcher | null = null;
  private inputManager: InputManager;
  private frameGraph: FrameGraph;
  private rendererModuleHost: RendererModuleHost | null = null;

  // Telemetry & profiling
  gpuProfiler: GPUProfiler | null = null;
  gpuResourceTracker: GPUResourceTracker | null = null;
  telemetryCollector: TelemetryCollector | null = null;
  profilingOverlay: ProfilingOverlay | null = null;

  // GPU UI system
  uiRenderer: UIRenderer | null = null;
  uiRoot: UIRoot | null = null;
  uiLayoutEngine: LayoutEngine | null = null;
  uiInputRouter: UIInputRouter | null = null;
  /** Screen-space compositors (html-ui panels etc.) drawn in the UI pass. */
  private uiCompositors = new Set<import("../module/renderer-module").ScreenUiCompositor>();
  private uiNeedsLayout = false;

  // Render loop state
  private running = false;
  private deviceLost = false;
  /** True when init() borrowed the native host's device — the surface was
   *  already configured by the host, so the renderer must not reconfigure. */
  private hostConfiguredSurface = false;
  private lastTime = 0;
  private elapsedTime = 0;
  private fps = 0;
  private frameCount = 0;
  private fpsTimer = 0;
  private lastResourceStatsTime = 0;
  private static readonly RESOURCE_STATS_INTERVAL = 1000;

  // Frame rate limiter
  private targetFrameTime = 0;
  private limiterActive = false;
  private frameAccum = 0;
  private lastLimiterTick = 0;
  private rafInterval = 0;
  private rafSum = 0;
  private rafCount = 0;
  private lastRafTime = 0;

  // Viewport management
  private viewportCount = 1;
  private viewports: ViewportRect[] = [];

  // Transient surface/depth handles (imported into the frame graph each frame)
  private colorHandle: TextureHandle | null = null;
  private depthHandle: TextureHandle | null = null;
  private graphCompiled = false;

  // Reusable per-frame RenderContext (mutated per viewport — see renderViewport)
  private frameCtx: RenderContext | null = null;

  // Depth texture cache (used when the graph does not own depth)
  // LRU: Map insertion order = access order (delete + re-set on access).
  private depthTextures = new Map<string, GPUTexture>();
  private depthTextureCacheSize: number;

  // Frame stats
  private frameDrawCalls = 0;
  private frameTriangles = 0;

  // Callbacks
  private callbacks: FrameCallbacks = {};

  // Offscreen mode (set by game for postprocessing)
  private offscreenMode: OffscreenMode | null = null;

  // XR render target provider (overrides canvas surface when set)
  private renderTargetProvider: RenderTargetProvider | null = null;

  // rAF source override (for XR sessions)
  private rafSource: RAFSource | null = null;
  private cancelRaf: CancelRAF | null = null;
  private currentRafId: number = 0;
  // Dedup for the render chain: exactly one pending rAF may exist at a time.
  // renderFrame() is also called outside the loop by renderOnce() (native
  // screenshots, deterministic steps); letting it re-schedule leaked a
  // permanent second (third, ...) render chain per call — each chain ran
  // renderFrame() every pump tick, multiplying both real render work and the
  // FPS counter (the "1100 fps" badge after MCP screenshot calls).
  private rafPending = false;

  // Dpr
  private dpr = 1;

  constructor(canvas: RenderSurface, config: GameRendererConfig = {}) {
    this.canvas = canvas;
    this.config = config;
    this.depthFormat = config.depthFormat ?? "depth32float";
    this.msaaSampleCount = config.msaaSampleCount ?? 1;
    this.depthTextureCacheSize = config.depthTextureCacheSize ?? 3;
    this.mode = config.mode ?? "3d";
    this.deviceManager = new GPUDeviceManager();
    this.inputManager = new InputManager(canvas, config.enablePointerLock ?? false);
    this.frameGraph = new FrameGraph();
  }

  /** Build requiredLimits for the bindless binding model (clamped to adapter). */
  private buildRequiredLimits(adapter: GPUAdapter): Record<string, number> {
    const a = adapter.limits as unknown as Record<string, number>;
    const clamp = (key: string, want: number): [string, number] | null => {
      const have = a[key];
      if (have === undefined) return null;
      return [key, Math.min(want, Number(have))];
    };
    const entries: Array<[string, number]> = [];
    [
      clamp("maxTextureArrayLayers", 512),
      clamp("maxStorageBuffersPerShaderStage", 8),
      clamp("maxStorageBufferBindingSize", 64 * 1024 * 1024),
      clamp("maxSampledTexturesPerShaderStage", 16),
    ].forEach((e) => {
      if (e) entries.push(e);
    });
    return Object.fromEntries(entries);
  }

  async init(): Promise<boolean> {
    try {
      // Disable IndexedDB in the renderer thread by default on DOM hosts —
      // the renderer should not do I/O. Single-process hosts (native) have
      // no renderer sandbox to protect; all persistence goes through the
      // save path anyway. Games can opt out via
      // config.disableRendererIndexedDb = false.
      if (this.config.disableRendererIndexedDb !== false && getHostCapabilities().hasDom) {
        disableRendererIndexedDb();
      }

      // Device resolution order: explicit config → native host's device →
      // self-acquire. On native the host owns the only wgpu device and the
      // surface context — borrowing it avoids a second requestDevice() and
      // a reconfigure race on the same surface. In-process there is
      // exactly one device.
      const nativeHost = getNativeHost();
      const borrowedDevice = this.config.device ?? nativeHost?.device;
      const borrowedAdapter = this.config.adapter ?? nativeHost?.adapter;
      // An adapter is only required when we must acquire the device ourselves;
      // a borrowed device is already usable (adapter.info is null-tolerated
      // below).
      const adapter = borrowedAdapter ?? await this.requestAdapterWithFallback();
      if (!adapter && !borrowedDevice) {
        log.error("GameRenderer", "No GPU adapter found — check GPU drivers and /dev/dri permissions");
        return false;
      }
      this.device = borrowedDevice ?? await this.requestDeviceFromAdapter(adapter!);
      this.adapter = adapter;
      // The host configured the surface with its own usage set at creation —
      // reconfiguring here would tear down the swapchain and race the host's
      // readback hook. Skip when borrowing the host's device.
      this.hostConfiguredSurface =
        borrowedDevice !== undefined && borrowedDevice === nativeHost?.device;

      // Install the shader validation guard so all createShaderModule calls
      // route through getCompilationInfo() validation.
      installShaderValidationGuard(this.device);

      // Wrap device with GPU resource tracker for VRAM visibility
      this.gpuResourceTracker = new GPUResourceTracker();
      this.gpuResourceTracker.wrapDevice(this.device);

      // GPU profiler
      const adapterInfo = adapter?.info ?? null;
      this.context = this.canvas.getContext("webgpu")!;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.gpuProfiler = new GPUProfiler();
      this.gpuProfiler.init(this.device, adapterInfo, this.format, 32);
      log.info("GameRenderer", `GPU timer pool supported: ${this.gpuProfiler.isGpuTimerSupported()} features: ${Array.from(this.device.features).join(", ")}`);

      // Device lost handler
      this.device.lost.then((info: GPUDeviceLostInfo) => {
        this.handleDeviceLost(info);
      });

      // Configure surface — skipped when the surface was already configured
      // by the device owner (native host) or the caller opted out. A borrowed
      // host surface is never reconfigured: the host's usage set and
      // pre-present readback hook are bound to its configure call.
      if (!this.hostConfiguredSurface && (this.config.configureSurface ?? true)) {
        this.context.configure({
          device: this.device,
          format: this.format,
          alphaMode: "premultiplied",
        });
      }

      // Initialize GPU UI system
      this.uiRenderer = new UIRenderer(this.format);
      this.uiRenderer.prepare(this.device);
      this.uiRenderer.setScreenSize(this.canvas.width, this.canvas.height);
      this.uiRoot = new UIRoot(this.canvas.width, this.canvas.height);
      this.uiLayoutEngine = new LayoutEngine();
      this.uiLayoutEngine.setTextCache(this.uiRenderer.getTextCache());
      this.uiInputRouter = new UIInputRouter();
      this.uiInputRouter.setRoot(this.uiRoot);
      this.inputManager.setUIInputRouter(this.uiInputRouter);

      // Telemetry + profiling overlay
      this.telemetryCollector = new TelemetryCollector(this.config.enableTelemetry ?? true);
      if (this.config.enableProfilingOverlay) {
        this.dpr = window.devicePixelRatio || 1;
        this.profilingOverlay = new ProfilingOverlay(this.telemetryCollector, {
          position: this.config.profilingOverlayConfig?.position ?? "top-left",
          updateIntervalMs: this.config.profilingOverlayConfig?.updateIntervalMs ?? 100,
          fontSize: this.config.profilingOverlayConfig?.fontSize ?? Math.round(16 * this.dpr),
          showGpuTime: this.config.profilingOverlayConfig?.showGpuTime ?? false,
          showPercentiles: this.config.profilingOverlayConfig?.showPercentiles ?? false,
          showMemory: this.config.profilingOverlayConfig?.showMemory ?? false,
        });
        this.profilingOverlay.setScreenSize(this.canvas.width, this.canvas.height);
      }

      // Canvas resize watcher
      this.resizeWatcher = new CanvasResizeWatcher(this.canvas, this);

      // Input listeners
      this.inputManager.setupListeners();

      // Renderer plugin host — owns renderer-thread plugins (camera
      // controllers, gizmos, XR frame loops, OSR). Created after InputManager
      // so the host's input bus coexists with the FPS/pointer-lock layer.
      this.rendererModuleHost = new RendererModuleHost(this.canvas, {
        getSurface: () => this.canvas,
        getDevice: () => this.device!,
        getFormat: () => this.format,
        getGraph: () => this.frameGraph,
        getSlotRegistry: () => this.frameGraph.getSlotRegistry(),
        setOffscreenMode: (mode) => this.setOffscreenMode(mode),
        setRenderTargetProvider: (provider) => this.setRenderTargetProvider(provider),
        setRAFSource: (src, cancel) => {
          if (src && cancel) this.setRAFSource(src, cancel);
          else this.clearRAFSource();
        },
        setViewportCount: (count) => this.setViewportCount(count),
        getUIRoot: () => {
          if (!this.uiRoot) throw new Error("UIRoot not initialized — call init() first");
          return this.uiRoot;
        },
        getUIInputRouter: () => this.uiInputRouter,
        invalidateUILayout: () => { this.uiNeedsLayout = true; },
        registerUiCompositor: (c) => {
          this.uiCompositors.add(c);
          return () => this.uiCompositors.delete(c);
        },
      });

      // Initial viewport layout
      this.updateViewports(1);

      log.info("GameRenderer", "initialized");
      return true;
    } catch (err) {
      log.error("GameRenderer", `Init failed: ${err}`);
      return false;
    }
  }

  // --- Device acquisition + loss recovery ---

  /** Adapter fallback chain: high-performance → low-power → any. */
  private async requestAdapterWithFallback(): Promise<GPUAdapter | null> {
    let adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      log.warn("GameRenderer", "No high-performance GPU adapter, trying low-power...");
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: "low-power",
      });
    }
    if (!adapter) {
      log.warn("GameRenderer", "No low-power adapter, trying any...");
      adapter = await navigator.gpu.requestAdapter({});
    }
    return adapter;
  }

  private async requestDeviceFromAdapter(adapter: GPUAdapter): Promise<GPUDevice> {
    // Request timestamp-query features for GPU-side per-pass timing
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has("timestamp-query")) {
      requiredFeatures.push("timestamp-query");
    }
    return adapter.requestDevice({
      requiredFeatures,
      requiredLimits: this.buildRequiredLimits(adapter),
    });
  }

  private recoveringDevice = false;

  private handleDeviceLost(info: GPUDeviceLostInfo): void {
    if (this.deviceLost || this.recoveringDevice) return; // already handled
    this.deviceLost = true;
    log.error("GameRenderer", `WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
    try { this.callbacks.onDeviceLost?.(info); } catch (err) {
      log.error("GameRenderer", `onDeviceLost callback threw: ${err}`);
    }

    if (
      (this.config.deviceLossRecovery ?? "auto") === "reload" ||
      info?.reason === "destroyed" ||
      this.hostConfiguredSurface
    ) {
      // "destroyed" = device.destroy() was called deliberately — a new device
      // can't help, the app is tearing down or opted out. A borrowed host
      // device can't be recovered in place either: the host's surface
      // configure and readback hook are bound to the dead device, and every
      // other holder of it (bridge, PixiJS, devtools) would still point at
      // the old handle. Restart instead.
      this.reloadForDeviceLoss();
      return;
    }
    this.recoverDevice();
  }

  private reloadForDeviceLoss(): void {
    setTimeout(() => {
      // Host already tearing down (host.destroy() destroys the device,
      // which resolves .lost with reason "destroyed") — restarting now
      // would respawn a session on top of a dead window.
      if ((globalThis as any).__nativeHost?.destroyed) return;
      // Native runtime: window.location.reload() is a no-op. Route through
      // the host's first-class restart hook (detached self-respawn — the
      // real reload equivalent), then fall back to a dialog + clean quit if
      // the restart budget is exhausted.
      const req = (globalThis as any).downdraft?.requestRestart;
      if (typeof req === "function" && req("GPU device lost")) return;
      const nativeWin = (globalThis as any).__nativeWindow;
      if (nativeWin?.showMessageBox) {
        try {
          nativeWin.showMessageBox(
            "GPU Device Lost",
            "The GPU device was lost and could not be recovered. The application will now close.",
          );
        } catch { /* window may be gone */ }
        try { nativeWin.requestQuit?.(); } catch { /* best-effort */ }
        return;
      }
      log.warn("GameRenderer", "Attempting page reload for GPU recovery...");
      window.location.reload();
    }, 2000);
  }

  /**
   * Attempt in-place device recovery: re-acquire adapter+device, reconfigure
   * the surface, re-prepare UI/profiler and every registered frame-graph
   * pass, then recompile the graph (transient textures get fresh allocations
   * on the new device). Falls back to a page reload on any failure.
   */
  private async recoverDevice(): Promise<void> {
    this.recoveringDevice = true;
    try {
      const adapter = await this.requestAdapterWithFallback();
      if (!adapter) throw new Error("no GPU adapter after device loss");
      const device = await this.requestDeviceFromAdapter(adapter);
      device.lost.then((info) => this.handleDeviceLost(info));
      this.device = device;
      this.adapter = adapter;

      installShaderValidationGuard(device);
      this.gpuResourceTracker = new GPUResourceTracker();
      this.gpuResourceTracker.wrapDevice(device);

      this.context!.configure({
        device,
        format: this.format,
        alphaMode: "premultiplied",
      });

      const adapterInfo = adapter.info ?? null;
      this.gpuProfiler?.init(device, adapterInfo, this.format, 32);
      if (this.uiRenderer) {
        this.uiRenderer.prepare(device);
        this.uiRenderer.setScreenSize(this.canvas.width, this.canvas.height);
      }

      // Re-prepare every registered pass — pipelines/bind groups built on the
      // dead device are invalid. Passes that can't recreate resources should
      // throw here so we fall back to reload.
      for (const pass of this.frameGraph.getPasses()) {
        pass.prepare(device);
      }

      // Force graph recompile so transient textures are re-allocated on the
      // new device — pooled physical textures and cached views all belong to
      // the dead device and must not be reused.
      this.frameGraph.invalidatePhysicalResources();
      this.graphCompiled = false;

      await this.onDeviceRecovered(device);
      await this.callbacks.onDeviceRecovered?.(device);

      this.deviceLost = false;
      log.warn("GameRenderer", "GPU device recovered — rendering resumed without reload");
    } catch (err) {
      log.error("GameRenderer", `Device recovery failed: ${err}`);
      this.reloadForDeviceLoss();
    } finally {
      this.recoveringDevice = false;
    }
  }

  /**
   * Subclass hook — called during device-loss recovery after the engine has
   * re-prepared its own resources and all registered passes. Recreate
   * subclass-owned GPU resources here. Throwing aborts recovery → reload.
   */
  protected async onDeviceRecovered(_device: GPUDevice): Promise<void> {}

  // --- CanvasResizeHandler ---

  private resolutionScale = 1;
  private lastCssW = 0;
  private lastCssH = 0;
  private lastRawDpr = 1;

  /**
   * Render-resolution scale [0.25..1]. Multiplies the effective DPR so the
   * swap chain renders fewer pixels (performance) and the compositor
   * upscales. Re-applies the last known canvas size immediately.
   */
  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.max(0.25, Math.min(1, scale));
    if (this.lastCssW > 0) this.onResize(this.lastCssW, this.lastCssH, this.lastRawDpr);
  }

  getResolutionScale(): number {
    return this.resolutionScale;
  }

  onResize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.lastCssW = cssWidth;
    this.lastCssH = cssHeight;
    this.lastRawDpr = dpr;
    // Render at the display's real DPR — resolutionScale is the opt-in
    // performance knob when fill rate is a concern.
    const cappedDpr = dpr * this.resolutionScale;
    this.dpr = cappedDpr;
    const w = Math.round(cssWidth * cappedDpr);
    const h = Math.round(cssHeight * cappedDpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.updateViewports(this.viewportCount);
    this.updateUIScreenSize();
    this.callbacks.onResize?.(cssWidth, cssHeight, dpr);
    this.rendererModuleHost?.dispatchResize(cssWidth, cssHeight, dpr);
  }

  // --- Viewport management ---

  setViewportCount(count: number): void {
    this.updateViewports(count);
  }

  getViewportCount(): number {
    return this.viewportCount;
  }

  getViewport(idx: number): ViewportRect | null {
    return this.viewports[idx] ?? null;
  }

  getViewports(): ViewportRect[] {
    return this.viewports;
  }

  private updateViewports(count: number): void {
    this.viewportCount = count;
    this.viewports = [];
    const w = this.canvas.width;
    const h = this.canvas.height;

    if (count === 1) {
      this.viewports.push({ x: 0, y: 0, w, h });
    } else if (count === 2) {
      this.viewports.push({ x: 0, y: 0, w: w / 2, h });
      this.viewports.push({ x: w / 2, y: 0, w: w / 2, h });
    } else if (count === 3) {
      this.viewports.push({ x: 0, y: 0, w, h: h / 2 });
      this.viewports.push({ x: 0, y: h / 2, w: w / 2, h: h / 2 });
      this.viewports.push({ x: w / 2, y: h / 2, w: w / 2, h: h / 2 });
    } else if (count >= 4) {
      this.viewports.push({ x: 0, y: 0, w: w / 2, h: h / 2 });
      this.viewports.push({ x: w / 2, y: 0, w: w / 2, h: h / 2 });
      this.viewports.push({ x: 0, y: h / 2, w: w / 2, h: h / 2 });
      this.viewports.push({ x: w / 2, y: h / 2, w: w / 2, h: h / 2 });
    }
  }

  // --- Frame rate limiter ---

  setFrameRateLimit(refreshRate: number): void {
    if (refreshRate > 0) {
      this.targetFrameTime = 1000 / refreshRate;
      this.updateLimiterState();
    } else {
      this.targetFrameTime = 0;
      this.limiterActive = false;
    }
  }

  private updateLimiterState(): void {
    if (this.targetFrameTime <= 0 || this.rafInterval <= 0) {
      this.limiterActive = this.targetFrameTime > 0;
      return;
    }
    this.limiterActive = this.rafInterval < this.targetFrameTime * 0.85;
  }

  // --- Render loop ---

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    // Go through scheduleRender() rather than invoking render() inline — a
    // pending rAF (loop already primed) would otherwise survive alongside the
    // new registration and double the chain.
    this.scheduleRender();
  }

  stop(): void {
    this.running = false;
    // cancelRaf only exists when a rAF source override (XR) is installed —
    // fall back to the global so the pending callback is actually removed.
    const cancel = this.cancelRaf ?? (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
    if (cancel && this.currentRafId) {
      cancel(this.currentRafId);
      this.currentRafId = 0;
    }
    this.rafPending = false;
  }

  /** Render a single frame on demand — deterministic/test mode and native
   *  screenshot capture call this while the loop is stopped. Bypasses the
   *  frame limiter; safe to call with the loop running or stopped. */
  renderOnce(): void {
    if (!this.device || !this.context || this.deviceLost) return;
    const savedLimiter = this.limiterActive;
    this.limiterActive = false;
    try {
      this.prepareForcedFrame();
      this.renderFrame();
    } finally {
      this.limiterActive = savedLimiter;
    }
  }

  /** Subclass hook: clear internal dirty-tracking so renderOnce() actually
   *  draws. Renderers that skip unchanged frames (e.g. MiningRenderer's
   *  forceDirty check) override this to force the next frame out. */
  protected prepareForcedFrame(): void {}

  /** Schedule the next render() invocation. Centralized here so renderFrame()
   *  stays scheduling-free — renderOnce() and test paths call renderFrame()
   *  directly and must never grow a parallel loop. */
  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    this.currentRafId = this.rafSource ? this.rafSource(this.render) : requestAnimationFrame(this.render);
  }

  private render = (): void => {
    this.rafPending = false;
    this.currentRafId = 0;
    if (!this.running) return;
    if (!this.device || !this.context) {
      // init() hasn't finished — keep the chain alive until it has.
      this.scheduleRender();
      return;
    }

    // Measure rAF interval (rolling average over 60 samples)
    const rafNow = performance.now();
    if (this.lastRafTime > 0) {
      this.rafSum += rafNow - this.lastRafTime;
      this.rafCount++;
      if (this.rafCount >= 60) {
        this.rafInterval = this.rafSum / this.rafCount;
        this.rafSum = 0;
        this.rafCount = 0;
        this.updateLimiterState();
      }
    }
    this.lastRafTime = rafNow;

    if (this.deviceLost) {
      // Keep the loop alive while the device is lost — handleDeviceLost()
      // re-creates the device and clears this flag; returning without
      // re-scheduling would permanently stop rendering after a transient
      // GPU crash.
      this.scheduleRender();
      return;
    }

    try {
      this.renderFrame();
    } catch (err) {
      log.error("GameRenderer", `Render loop error: ${(err as Error).message}\n${(err as Error).stack}`);
      if (this.device?.lost) {
        this.device.lost.then((info: GPUDeviceLostInfo) => {
          this.handleDeviceLost(info);
        });
      }
    }
    this.scheduleRender();
  };

  private renderFrame(): void {
    const now = performance.now();

    // Frame rate limiter: phase accumulator (skip during XR — XR drives its own cadence)
    // Accumulate real elapsed time in frame units — NOT rafInterval ratios.
    // The ratio variant starved on hosts with a faster-than-vsync rAF pump
    // (native SDL loop ticks at ~µs cadence): updateLimiterState() resets
    // frameAccum every 60 rAF samples, and 60 × rafInterval/targetFrameTime
    // never reached 1, so present() was never called.
    if (!this.renderTargetProvider && this.limiterActive && this.targetFrameTime > 0) {
      if (this.lastLimiterTick === 0) this.lastLimiterTick = now;
      this.frameAccum += (now - this.lastLimiterTick) / this.targetFrameTime;
      this.lastLimiterTick = now;
      if (this.frameAccum < 1) {
        // render() owns re-scheduling — just skip the frame's work.
        return;
      }
      // Cap carry at one frame — a stale lastLimiterTick (limiter toggled
      // off→on) would otherwise burst-render to drain a huge accumulator.
      this.frameAccum = Math.min(this.frameAccum - 1, 1);
    }
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsedTime += dt;

    // FPS counter
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    // Profiling overlay update
    if (this.profilingOverlay) {
      this.profilingOverlay.update(dt);
    }

    // Before frame callback (game-specific: camera updates, input processing)
    this.callbacks.beforeFrame?.(dt, this.elapsedTime);
    this.rendererModuleHost?.dispatchFrame("beforeFrame", dt, this.elapsedTime);

    // Before viewports callback (game-specific: particle ticks, pre-viewport setup)
    this.callbacks.beforeViewports?.(dt, this.elapsedTime);
    this.rendererModuleHost?.dispatchFrame("beforeViewports", dt, this.elapsedTime);

    // If an uncaptured GPU error has fired, skip all GPU work this frame to
    // avoid the per-frame cascade of native "is invalid due to a previous
    // error" validation warnings. Game logic callbacks still run so the
    // simulation stays responsive. The flag is cleared by recovery code that
    // recreates the invalid resources.
    const gpuError = this.gpuProfiler?.hasUncapturedError() ?? false;

    // XR render target provider beginFrame hook
    if (this.renderTargetProvider && !gpuError) {
      this.renderTargetProvider.beginFrame();
    }

    // Render each viewport
    const offscreen = this.offscreenMode;
    const useOffscreen = offscreen && offscreen.type !== "none";

    if (offscreen && useOffscreen && offscreen.ensureTargets && !gpuError) {
      offscreen.ensureTargets(this.canvas.width, this.canvas.height);
    }

    // Collect command buffers from all phases and submit once at the end
    // (reduces CPU→GPU sync points from 3+ per frame to 1).
    const frameCommandBuffers: GPUCommandBuffer[] = [];
    if (!gpuError) {
      // 2D mode with viewportCount=0: clear the canvas if a clearColor is
      // configured, then let the afterFrame callback do custom rendering.
      if (this.viewportCount === 0 && this.device && this.context && this.config.clearColor !== null) {
        const clearTex = this.getSurfaceTexture();
        if (clearTex) {
          const clearEncoder = this.device.createCommandEncoder();
          const clearPass = clearEncoder.beginRenderPass({
            colorAttachments: [{
              view: clearTex.createView(),
              clearValue: this.config.clearColor ?? { r: 0, g: 0, b: 0, a: 1 },
              loadOp: "clear" as GPULoadOp,
              storeOp: "store" as GPUStoreOp,
            }],
          });
          clearPass.end();
          frameCommandBuffers.push(clearEncoder.finish());
        }
      }

      for (let v = 0; v < this.viewportCount; v++) {
        const cb = this.renderViewport(v, dt, offscreen);
        if (cb) frameCommandBuffers.push(cb);
      }

      // Apply postprocessing
      if (offscreen && useOffscreen && offscreen.applyPostprocess) {
        const canvasView = this.getSurfaceTexture()?.createView();
        if (canvasView) {
          const postEncoder = this.device!.createCommandEncoder();
          offscreen.applyPostprocess(postEncoder, canvasView, this.canvas.width, this.canvas.height);
          frameCommandBuffers.push(postEncoder.finish());
        }
      }
    }

    // After viewports callback
    this.callbacks.afterViewports?.(dt, this.elapsedTime);
    this.rendererModuleHost?.dispatchFrame("afterViewports", dt, this.elapsedTime);

    // Submit all command buffers for this frame in a single queue.submit() call
    if (frameCommandBuffers.length > 0) {
      this.device!.queue.submit(frameCommandBuffers);
    }

    // Read GPU timer results asynchronously (1-frame latency).
    // Must be called AFTER queue.submit() — readGpuTimers() calls mapAsync on
    // the read buffer, and a mapped/mapping-pending buffer cannot be used in a
    // submitted command buffer (the copy-to-readBuffer was encoded above).
    if (this.gpuProfiler) {
      this.gpuProfiler.readGpuTimers().then(() => {
        // Results available for next frame
      }).catch(() => {});
    }

    // Record telemetry
    if (this.telemetryCollector) {
      this.telemetryCollector.recordFrame(dt * 1000);
      this.telemetryCollector.recordDrawStats(this.frameDrawCalls, this.frameTriangles);
      this.telemetryCollector.recordGraphSample(dt * 1000);

      if (this.gpuProfiler) {
        for (const timing of this.gpuProfiler.getPassTimings()) {
          this.telemetryCollector.recordPassTiming(timing);
        }
      }

      if (this.gpuResourceTracker && now - this.lastResourceStatsTime > GameRenderer.RESOURCE_STATS_INTERVAL) {
        this.lastResourceStatsTime = now;
        const resStats = this.gpuResourceTracker.getStats();
        this.telemetryCollector.recordResourceStats({
          textureCount: resStats.textureCount,
          bufferCount: resStats.bufferCount,
          totalBytes: resStats.totalBytes,
          textureBytes: resStats.textureBytes,
          bufferBytes: resStats.bufferBytes,
          resources: resStats.resources.map((r) => ({
            id: r.id,
            type: r.type,
            label: r.label,
            size: r.size,
            callsite: r.callsite,
            width: r.width,
            height: r.height,
            format: r.format,
          })),
        });
      }

      this.frameDrawCalls = 0;
      this.frameTriangles = 0;
    }

    // XR render target provider endFrame hook (skip on GPU error)
    if (!gpuError && this.renderTargetProvider && this.device) {
      this.renderTargetProvider.endFrame(this.device.createCommandEncoder());
    }

    // After frame callback
    this.callbacks.afterFrame?.(dt, this.elapsedTime);
    this.rendererModuleHost?.dispatchFrame("afterFrame", dt, this.elapsedTime);

    // Render GPU UI on top of final image (skip on GPU error to avoid cascade).
    // This must run AFTER afterFrame — 2D games (viewportCount=0) do their
    // custom rendering in the afterFrame callback, so drawing UI earlier would
    // put it underneath their clear pass.
    if (!gpuError && this.uiRenderer && this.uiRoot && this.device && this.context) {
      if (this.uiNeedsLayout && this.uiLayoutEngine) {
        this.uiLayoutEngine.layout(this.uiRoot);
        this.uiNeedsLayout = false;
      }
      const drawables = this.uiRoot.getDrawable();
      const compositors = [...this.uiCompositors].filter((c) => c.hasContent());
      const uiCanvasView = (drawables.length > 0 || compositors.length > 0)
        ? this.getSurfaceTexture()?.createView()
        : undefined;
      if (uiCanvasView) {
        const uiEncoder = this.device.createCommandEncoder();
        const uiPass = uiEncoder.beginRenderPass({
          colorAttachments: [{
            view: uiCanvasView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "load" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
          }],
        });
        if (drawables.length > 0 && this.uiRenderer) {
          this.uiRenderer.render({ device: this.device, pass: new TrackedRenderPass(uiPass) } as unknown as RenderContext, drawables);
        }
        compositors.forEach((c) => { c.render(uiPass, this.canvas.width, this.canvas.height);; });
        uiPass.end();
        this.device.queue.submit([uiEncoder.finish()]);
      }
    }

    // Present the surface (native wgpu requires explicit presentation;
    // in browsers this is automatic at the end of the frame). Must be last —
    // all submissions targeting the surface texture happen above.
    if (this.context && (this.context as any).present) {
      (this.context as any).present();
    }

    const __rfTotal = performance.now() - now;
    if (this.config.debugTimingWarnings && __rfTotal > 20) log.warn("GameRenderer", `renderFrame took ${__rfTotal.toFixed(1)}ms`);
    // NOTE: renderFrame() intentionally does NOT schedule the next frame —
    // render() owns the rAF chain so one-shot callers (renderOnce, MCP
    // screenshot capture) can't leak parallel loops.
  }

  /**
   * Acquire this frame's swapchain texture. May return null on the native
   * runtime while the surface can't produce a frame (in-flight resize,
   * occluded window, transient swapchain failure) — callers must skip the
   * canvas-targeted GPU work for that frame instead of crashing on
   * `null.createView()`.
   */
  private getSurfaceTexture(): GPUTexture | null {
    try {
      return (this.context?.getCurrentTexture() as unknown as GPUTexture | null) ?? null;
    } catch {
      return null;
    }
  }

  private renderViewport(viewportIdx: number, dt: number, offscreen: OffscreenMode | null): GPUCommandBuffer | null {
    if (!this.device || !this.context) return null;

    const xrProvider = this.renderTargetProvider;
    const useOffscreen = !xrProvider && offscreen && offscreen.type !== "none";

    const origViewport = xrProvider
      ? xrProvider.getViewportRect(viewportIdx, this.canvas.width, this.canvas.height)
      : this.viewports[viewportIdx];
    if (!origViewport) return null;

    const viewport = (useOffscreen && offscreen?.scaleViewport)
      ? offscreen.scaleViewport(origViewport)
      : origViewport;

    // Get camera info: viewport camera provider (XR) takes priority, then
    // game callback, then renderer plugin host's camera controller fallback.
    // The game callback is always called (even when the provider returns
    // non-null) so side effects like per-eye uniform updates still run.
    const providerInfo = this.rendererModuleHost?.getViewportCameraInfo(viewportIdx, dt, this.elapsedTime) ?? null;
    const gameInfo = this.callbacks.onViewport?.(viewportIdx, dt, this.elapsedTime) ?? null;
    let camInfo = providerInfo ?? gameInfo;
    if (!camInfo && this.rendererModuleHost) {
      const camState = this.rendererModuleHost.getCameraState(viewportIdx);
      if (camState) {
        camInfo = { camera: camState, viewport };
      }
    }
    // 2D mode: if no camera info was provided, use a default orthographic
    // camera that covers the full viewport. This allows 2D-only renderers
    // (sand games, tile games) to use GameRenderer without a camera system.
    if (!camInfo && this.mode === "2d") {
      camInfo = {
        camera: {
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          fov: 90,
          near: 0.1,
          far: 100,
          aspect: viewport.w / viewport.h,
        },
        viewport,
      };
    }
    if (!camInfo) return null;

    const isFirst = viewportIdx === 0;
    const isLast = viewportIdx === this.viewportCount - 1;

    // Determine color/depth views — XR provider takes precedence, then offscreen, then canvas
    const __ctStart = performance.now();
    const colorView = xrProvider
      ? xrProvider.getColorView(viewportIdx)
      : (useOffscreen && offscreen)
      ? (offscreen.type === "pixelation"
        ? offscreen.getColorView()
        : offscreen.type === "postprocess"
        ? (offscreen.getSceneColorView?.() ?? this.getSurfaceTexture()?.createView())
        : this.getSurfaceTexture()?.createView())
      : this.getSurfaceTexture()?.createView();
    const __ctMs = performance.now() - __ctStart;
    // Swapchain couldn't produce a frame (native resize in flight, occluded
    // window, transient failure) — skip this viewport's GPU work; game
    // callbacks already ran above and the loop stays alive for next frame.
    if (!colorView) return null;
    if (this.config.debugTimingWarnings && __ctMs > 20) log.warn("GameRenderer", `getCurrentTexture took ${__ctMs.toFixed(1)}ms`);

    const depthView = xrProvider
      ? xrProvider.getDepthView(viewportIdx, origViewport.w, origViewport.h)
      : (useOffscreen && offscreen)
      ? (offscreen.type === "pixelation"
        ? offscreen.getDepthView()
        : offscreen.type === "postprocess"
        ? (offscreen.getSceneDepthView?.() ?? this.createDepthTexture(origViewport.w, origViewport.h))
        : this.createDepthTexture(origViewport.w, origViewport.h))
      : this.createDepthTexture(origViewport.w, origViewport.h);

    // Ensure graph handles exist for the imported color/depth views.
    if (!this.colorHandle) {
      this.colorHandle = this.frameGraph.importTextureView("color", null);
      this.frameGraph.markDirty();
    }
    if (!this.depthHandle) {
      this.depthHandle = this.frameGraph.importTextureView("depth", null);
      this.frameGraph.markDirty();
    }
    this.frameGraph.setImportedTextureView(this.colorHandle, colorView);
    this.frameGraph.setImportedTextureView(this.depthHandle, depthView);

    if (isFirst) {
      this.gpuProfiler!.beginFrame();
    }

    if (this.frameGraph.isDirty() || !this.graphCompiled) {
      this.frameGraph.compile(this.device, this.canvas.width, this.canvas.height);
      this.graphCompiled = true;
    }

    const encoder = this.device.createCommandEncoder();

    // Reuse a single RenderContext across viewports/frames — allocating the
    // ~35-field literal per viewport per frame was pure GC churn. Fields that
    // vary per viewport are reassigned below; the closures capture `this` and
    // are created once.
    if (!this.frameCtx) {
      this.frameCtx = {
        device: this.device,
        encoder,
        pass: null,
        camera: camInfo.camera,
        viewport,
        viewportIdx,
        viewportCount: this.viewportCount,
        dt,
        elapsedTime: this.elapsedTime,
        isFirstViewport: isFirst,
        isLastViewport: isLast,
        width: viewport.w,
        height: viewport.h,
        viewProj: undefined,
        invViewProj: undefined,
        prevViewProj: undefined,
        cameraPos: camInfo.camera.position,
        lightData: null,
        lightViewProj: undefined,
        mesh: null,
        modelMatrix: undefined,
        shadowsEnabled: false,
        bloomEnabled: false,
        shadowSampler: null,
        debugQueue: null,
        opaqueVertexBuffer: null,
        opaqueIndexBuffer: null,
        opaqueIndexCount: 0,
        opaqueIndexFormat: "uint32",
        getView: (h: TextureHandle) => this.frameGraph.getTextureView(h),
        getTexture: (h: TextureHandle) => this.frameGraph.getTexture(h),
        addDrawCalls: (n: number) => { this.frameDrawCalls += n; },
        addTriangles: (n: number) => { this.frameTriangles += n; },
      };
    }
    const ctx = this.frameCtx;
    ctx.device = this.device;
    ctx.encoder = encoder;
    ctx.camera = camInfo.camera;
    ctx.viewport = viewport;
    ctx.viewportIdx = viewportIdx;
    ctx.viewportCount = this.viewportCount;
    ctx.dt = dt;
    ctx.elapsedTime = this.elapsedTime;
    ctx.isFirstViewport = isFirst;
    ctx.isLastViewport = isLast;
    ctx.width = viewport.w;
    ctx.height = viewport.h;
    ctx.cameraPos = camInfo.camera.position;

    this.frameGraph.execute(ctx);

    // Resolve GPU timestamp queries on first viewport.
    // NOTE: readGpuTimers() (which calls mapAsync on the read buffer) must NOT
    // be called here — the command buffer containing the copy-to-readBuffer
    // hasn't been submitted yet. Calling mapAsync before submit puts the buffer
    // in a mapped-pending state, and the subsequent queue.submit() fails with
    // "Buffer used in submit while mapped." readGpuTimers() is called after
    // submit in renderFrame().
    if (isFirst) {
      this.gpuProfiler!.resolveGpuTimers(encoder);
    }

    return encoder.finish();
  }

  // --- Depth texture cache ---

  private createDepthTexture(w: number, h: number): GPUTextureView {
    if (!this.device) throw new Error("No device");
    const key = `${w}x${h}`;
    let tex = this.depthTextures.get(key);
    if (tex) {
      // LRU: move to most-recently-used by re-inserting.
      this.depthTextures.delete(key);
      this.depthTextures.set(key, tex);
    } else {
      tex = this.device.createTexture({
        size: [w, h],
        format: this.depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthTextures.set(key, tex);
      // Evict oldest entries if over cap.
      while (this.depthTextures.size > this.depthTextureCacheSize) {
        const oldestKey = this.depthTextures.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = this.depthTextures.get(oldestKey);
        this.depthTextures.delete(oldestKey);
        oldest?.destroy();
      }
    }
    return tex.createView();
  }

  // --- UI ---

  private updateUIScreenSize(): void {
    if (this.uiRenderer && this.uiRoot) {
      this.uiRenderer.setScreenSize(this.canvas.width, this.canvas.height);
      this.uiRoot.width = this.canvas.width;
      this.uiRoot.height = this.canvas.height;
      this.uiNeedsLayout = true;
    }
    this.profilingOverlay?.setScreenSize(this.canvas.width, this.canvas.height);
  }

  markUILayoutDirty(): void {
    this.uiNeedsLayout = true;
  }

  toggleProfilingOverlay(): void {
    if (!this.profilingOverlay || !this.uiRoot) return;
    this.profilingOverlay.toggle();
    if (this.profilingOverlay.isVisible()) {
      this.uiRoot.addChild(this.profilingOverlay.getPanel());
    } else {
      this.uiRoot.removeChild(this.profilingOverlay.getPanel());
    }
    this.uiNeedsLayout = true;
  }

  isProfilingOverlayVisible(): boolean {
    return this.profilingOverlay?.isVisible() ?? false;
  }

  // --- Offscreen mode ---

  setOffscreenMode(mode: OffscreenMode | null): void {
    this.offscreenMode = mode;
  }

  getOffscreenMode(): OffscreenMode | null {
    return this.offscreenMode;
  }

  // --- XR render target provider ---

  setRenderTargetProvider(provider: RenderTargetProvider | null): void {
    this.renderTargetProvider = provider;
  }

  getRenderTargetProvider(): RenderTargetProvider | null {
    return this.renderTargetProvider;
  }

  // --- rAF source override (for XR sessions) ---

  setRAFSource(request: RAFSource, cancel: CancelRAF): void {
    this.rafSource = request;
    this.cancelRaf = cancel;
  }

  clearRAFSource(): void {
    this.rafSource = null;
    this.cancelRaf = null;
  }

  // --- Callbacks ---

  setCallbacks(callbacks: FrameCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Get the current frame callbacks (for wrapping/extending). */
  getCallbacks(): FrameCallbacks {
    return this.callbacks;
  }

  // --- Renderer plugins ---

  useRendererModule(plugin: RendererModule): void {
    if (!this.rendererModuleHost) {
      throw new Error("RendererModuleHost not initialized — call init() first");
    }
    this.rendererModuleHost.registerModule(plugin);
  }

  getRendererModuleHost(): RendererModuleHost | null {
    return this.rendererModuleHost;
  }

  // --- Getters ---

  getDevice(): GPUDevice | null {
    return this.device;
  }

  getAdapter(): GPUAdapter | null {
    return this.adapter;
  }

  getContext(): RenderSurfaceContext | null {
    return this.context;
  }

  getFormat(): GPUTextureFormat {
    return this.format;
  }

  getDepthFormat(): GPUTextureFormat {
    return this.depthFormat;
  }

  getMSAASampleCount(): number {
    return this.msaaSampleCount;
  }

  /** The render surface this renderer draws into. Canonical accessor. */
  getSurface(): RenderSurface {
    return this.canvas;
  }

  /** @deprecated Use getSurface() — the surface is not necessarily a DOM canvas. */
  getCanvas(): RenderSurface {
    return this.canvas;
  }

  getCanvasWidth(): number {
    return this.canvas.width;
  }

  getCanvasHeight(): number {
    return this.canvas.height;
  }

  getFPS(): number {
    return this.fps;
  }

  getElapsedTime(): number {
    return this.elapsedTime;
  }

  getInputManager(): InputManager {
    return this.inputManager;
  }

  getGraph(): FrameGraph {
    return this.frameGraph;
  }

  getSlotRegistry(): SlotRegistry {
    return this.frameGraph.getSlotRegistry();
  }

  getUIRenderer(): UIRenderer | null {
    return this.uiRenderer;
  }

  getUIRoot(): UIRoot | null {
    return this.uiRoot;
  }

  getUILayoutEngine(): LayoutEngine | null {
    return this.uiLayoutEngine;
  }

  getUIInputRouter(): UIInputRouter | null {
    return this.uiInputRouter;
  }

  getTelemetryCollector(): TelemetryCollector | null {
    return this.telemetryCollector;
  }

  getGPUProfiler(): GPUProfiler | null {
    return this.gpuProfiler;
  }

  getFrameGraph(): FrameGraphData | null {
    if (!this.gpuProfiler) return null;
    const passTimings = this.gpuProfiler.getPassTimings();
    const ppInfo = this.callbacks.getPostProcessInfo?.() ?? {
      pixelationEnabled: false, pixelSize: 4, postProcessEffects: [],
    };
    const passNames = this.frameGraph.getPassOrder();
    return GPUProfiler.buildFrameGraphData(passTimings, ppInfo, passNames);
  }

  getGPUResourceTracker(): GPUResourceTracker | null {
    return this.gpuResourceTracker;
  }

  getGPUInfo(): GPUInfo | null {
    if (!this.gpuProfiler) return null;
    return this.gpuProfiler.getGPUInfo(this.canvas, this.msaaSampleCount);
  }

  getAdapterInfo(): GPUAdapterInfoData | null {
    return this.gpuProfiler?.getAdapterInfo() ?? null;
  }

  getGPUErrors(): Array<{ timestamp: number; message: string; label?: string }> {
    return this.gpuProfiler?.getGPUErrors() ?? [];
  }

  clearGPUErrors(): void {
    this.gpuProfiler?.clearGPUErrors();
  }

  getDpr(): number {
    return this.dpr;
  }

  // --- Frame stats (for game passes to update) ---

  addDrawCalls(n: number): void {
    this.frameDrawCalls += n;
  }

  addTriangles(n: number): void {
    this.frameTriangles += n;
  }

  // --- Destroy ---

  destroy(): void {
    this.running = false;
    this.resizeWatcher?.destroy();
    this.resizeWatcher = null;
    this.rendererModuleHost?.disposeAll();
    this.rendererModuleHost = null;
    this.inputManager.destroy();
    this.profilingOverlay?.destroy();
    this.profilingOverlay = null;
    this.gpuProfiler?.destroy();
    this.gpuProfiler = null;
    this.telemetryCollector = null;
    this.device = null;
    for (const tex of this.depthTextures.values()) {
      tex.destroy();
    }
    this.depthTextures.clear();
  }
}
