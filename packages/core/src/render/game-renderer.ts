// ============================================================================
// GameRenderer — generic WebGPU render loop infrastructure
// Extracted from WebGPURenderer: device init, surface config, rAF loop,
// frame rate limiter, viewport management, telemetry, GPU UI pass, depth cache.
// Games register render passes via FrameGraph slots and provide game-specific
// logic through callback hooks.
// ============================================================================

import type { RendererPlugin } from "../plugin/renderer-plugin";
import { TelemetryCollector } from "../telemetry/collector";
import { DebugOverlay as ProfilingOverlay } from "../telemetry/debug-overlay";
import type { GPUAdapterInfo as GPUAdapterInfoData } from "../telemetry/gpu-profiler";
import { GPUProfiler, type FrameGraphData, type GPUInfo } from "../telemetry/gpu-profiler";
import { GPUResourceTracker } from "../telemetry/gpu-resource-tracker";
import { UIRoot } from "../ui/element";
import { UIInputRouter } from "../ui/input";
import { LayoutEngine } from "../ui/layout";
import { UIRenderer } from "../ui/renderer";
import { CanvasResizeWatcher, type CanvasResizeHandler } from "./canvas-resize-watcher";
import { GPUDeviceManager } from "./device";
import type { RenderContext } from "./frame-graph";
import { FrameGraph, SlotRegistry, type TextureHandle } from "./frame-graph";
import { InputManager } from "./input-manager";
import { RendererPluginHost } from "./renderer-plugin-host";
import { SurfaceManager } from "./surface";
import { TrackedRenderPass } from "./tracked-render-pass";

export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GameRendererConfig {
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
}

export interface FrameCallbacks {
  beforeFrame?: (dt: number, elapsedTime: number) => void;
  beforeViewports?: (dt: number, elapsedTime: number) => void;
  onViewport?: (viewportIdx: number, dt: number, elapsedTime: number) => CameraViewportInfo | null;
  afterViewports?: (dt: number, elapsedTime: number) => void;
  afterFrame?: (dt: number, elapsedTime: number) => void;
  onResize?: (cssWidth: number, cssHeight: number, dpr: number) => void;
  getPostProcessInfo?: () => { pixelationEnabled: boolean; pixelSize: number; postProcessEffects: string[] };
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
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private config: GameRendererConfig;

  private depthFormat: GPUTextureFormat = "depth32float";
  private msaaSampleCount: number = 1;
  private mode: "2d" | "3d" = "3d";

  // Infrastructure
  private deviceManager: GPUDeviceManager;
  private surface: SurfaceManager | null = null;
  private resizeWatcher: CanvasResizeWatcher | null = null;
  private inputManager: InputManager;
  private frameGraph: FrameGraph;
  private rendererPluginHost: RendererPluginHost | null = null;

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
  private uiNeedsLayout = false;

  // Render loop state
  private running = false;
  private deviceLost = false;
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

  // Dpr
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, config: GameRendererConfig = {}) {
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
      return [key, Math.min(want, have)];
    };
    const entries: Array<[string, number]> = [];
    for (const e of [
      clamp("maxTextureArrayLayers", 512),
      clamp("maxStorageBuffersPerShaderStage", 8),
      clamp("maxStorageBufferBindingSize", 64 * 1024 * 1024),
      clamp("maxSampledTexturesPerShaderStage", 16),
    ]) {
      if (e) entries.push(e);
    }
    return Object.fromEntries(entries);
  }

  async init(): Promise<boolean> {
    try {
      // Adapter fallback chain: high-performance → low-power → any
      let adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance",
      });
      if (!adapter) {
        console.warn("No high-performance GPU adapter, trying low-power...");
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: "low-power",
        });
      }
      if (!adapter) {
        console.warn("No low-power adapter, trying any...");
        adapter = await navigator.gpu.requestAdapter({});
      }
      if (!adapter) {
        console.error("No GPU adapter found — check GPU drivers and /dev/dri permissions");
        return false;
      }

      // Request timestamp-query features for GPU-side per-pass timing
      const requiredFeatures: GPUFeatureName[] = [];
      if (adapter.features.has("timestamp-query")) {
        requiredFeatures.push("timestamp-query");
      }
      if (adapter.features.has("chromium-experimental-timestamp-query-inside-passes" as GPUFeatureName)) {
        requiredFeatures.push("chromium-experimental-timestamp-query-inside-passes" as GPUFeatureName);
      }
      this.device = await adapter.requestDevice({
        requiredFeatures,
        requiredLimits: this.buildRequiredLimits(adapter),
      });

      // Wrap device with GPU resource tracker for VRAM visibility
      this.gpuResourceTracker = new GPUResourceTracker();
      this.gpuResourceTracker.wrapDevice(this.device);

      // GPU profiler
      const adapterInfo = adapter.info ?? null;
      this.context = this.canvas.getContext("webgpu")!;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.gpuProfiler = new GPUProfiler();
      this.gpuProfiler.init(this.device, adapterInfo, this.format, 32);
      console.log("[GameRenderer] GPU timer pool supported:", this.gpuProfiler.isGpuTimerSupported(),
        "features:", Array.from(this.device.features));

      // Device lost handler
      this.device.lost.then((info: GPUDeviceLostInfo) => {
        this.deviceLost = true;
        console.error(`[GameRenderer] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        setTimeout(() => {
          console.warn("[GameRenderer] Attempting page reload for GPU recovery...");
          window.location.reload();
        }, 2000);
      });

      // Configure surface
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });

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
      this.telemetryCollector = new TelemetryCollector(true);
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
      this.rendererPluginHost = new RendererPluginHost(this.canvas, {
        getCanvas: () => this.canvas,
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
      });

      // Initial viewport layout
      this.updateViewports(1);

      console.log("[GameRenderer] initialized");
      return true;
    } catch (err) {
      console.error("[GameRenderer] Init failed:", err);
      return false;
    }
  }

  // --- CanvasResizeHandler ---

  onResize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    const w = Math.round(cssWidth * dpr);
    const h = Math.round(cssHeight * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.updateViewports(this.viewportCount);
    this.updateUIScreenSize();
    this.callbacks.onResize?.(cssWidth, cssHeight, dpr);
    this.rendererPluginHost?.dispatchResize(cssWidth, cssHeight, dpr);
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
    this.frameAccum = 0;
  }

  // --- Render loop ---

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    this.render();
  }

  stop(): void {
    this.running = false;
    if (this.cancelRaf && this.currentRafId) {
      this.cancelRaf(this.currentRafId);
      this.currentRafId = 0;
    }
  }

  private render = (): void => {
    if (!this.running || !this.device || !this.context) {
      this.currentRafId = this.rafSource ? this.rafSource(this.render) : requestAnimationFrame(this.render);
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
      return;
    }

    try {
      this.renderFrame();
    } catch (err) {
      console.error(`[GameRenderer] Render loop error: ${(err as Error).message}\n${(err as Error).stack}`);
      if (this.device?.lost) {
        this.device.lost.then((info: GPUDeviceLostInfo) => {
          this.deviceLost = true;
          console.error(`[GameRenderer] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
        });
      }
      this.currentRafId = this.rafSource ? this.rafSource(this.render) : requestAnimationFrame(this.render);
    }
  };

  private renderFrame(): void {
    const now = performance.now();

    // Frame rate limiter: phase accumulator (skip during XR — XR drives its own cadence)
    if (!this.renderTargetProvider && this.limiterActive && this.targetFrameTime > 0) {
      this.frameAccum += this.rafInterval / this.targetFrameTime;
      if (this.frameAccum < 1) {
        this.currentRafId = this.rafSource ? this.rafSource(this.render) : requestAnimationFrame(this.render);
        return;
      }
      this.frameAccum -= 1;
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
    this.rendererPluginHost?.dispatchFrame("beforeFrame", dt, this.elapsedTime);

    // Before viewports callback (game-specific: particle ticks, pre-viewport setup)
    this.callbacks.beforeViewports?.(dt, this.elapsedTime);
    this.rendererPluginHost?.dispatchFrame("beforeViewports", dt, this.elapsedTime);

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
        const clearEncoder = this.device.createCommandEncoder();
        const clearPass = clearEncoder.beginRenderPass({
          colorAttachments: [{
            view: this.context.getCurrentTexture().createView(),
            clearValue: this.config.clearColor ?? { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
          }],
        });
        clearPass.end();
        frameCommandBuffers.push(clearEncoder.finish());
      }

      for (let v = 0; v < this.viewportCount; v++) {
        const cb = this.renderViewport(v, dt, offscreen);
        if (cb) frameCommandBuffers.push(cb);
      }

      // Apply postprocessing
      if (offscreen && useOffscreen && offscreen.applyPostprocess) {
        const canvasView = this.context!.getCurrentTexture().createView();
        const postEncoder = this.device!.createCommandEncoder();
        offscreen.applyPostprocess(postEncoder, canvasView, this.canvas.width, this.canvas.height);
        frameCommandBuffers.push(postEncoder.finish());
      }
    }

    // After viewports callback
    this.callbacks.afterViewports?.(dt, this.elapsedTime);
    this.rendererPluginHost?.dispatchFrame("afterViewports", dt, this.elapsedTime);

    // Render GPU UI on top of final image (skip on GPU error to avoid cascade)
    if (!gpuError && this.uiRenderer && this.uiRoot && this.device && this.context) {
      if (this.uiNeedsLayout && this.uiLayoutEngine) {
        this.uiLayoutEngine.layout(this.uiRoot);
        this.uiNeedsLayout = false;
      }
      const drawables = this.uiRoot.getDrawable();
      if (drawables.length > 0) {
        const canvasView = this.context.getCurrentTexture().createView();
        const uiEncoder = this.device.createCommandEncoder();
        const uiPass = uiEncoder.beginRenderPass({
          colorAttachments: [{
            view: canvasView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "load" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
          }],
        });
        this.uiRenderer.render({ device: this.device, pass: new TrackedRenderPass(uiPass) } as unknown as RenderContext, drawables);
        uiPass.end();
        frameCommandBuffers.push(uiEncoder.finish());
      }
    }

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
    this.rendererPluginHost?.dispatchFrame("afterFrame", dt, this.elapsedTime);

    this.currentRafId = this.rafSource ? this.rafSource(this.render) : requestAnimationFrame(this.render);
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
    const providerInfo = this.rendererPluginHost?.getViewportCameraInfo(viewportIdx, dt, this.elapsedTime) ?? null;
    const gameInfo = this.callbacks.onViewport?.(viewportIdx, dt, this.elapsedTime) ?? null;
    let camInfo = providerInfo ?? gameInfo;
    if (!camInfo && this.rendererPluginHost) {
      const camState = this.rendererPluginHost.getCameraState(viewportIdx);
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
    const colorView = xrProvider
      ? xrProvider.getColorView(viewportIdx)
      : (useOffscreen && offscreen)
      ? (offscreen.type === "pixelation"
        ? offscreen.getColorView()
        : offscreen.type === "postprocess"
        ? (offscreen.getSceneColorView?.() ?? this.context!.getCurrentTexture().createView())
        : this.context!.getCurrentTexture().createView())
      : this.context!.getCurrentTexture().createView();

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

    const ctx: RenderContext = {
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

  // --- Renderer plugins ---

  useRendererPlugin(plugin: RendererPlugin): void {
    if (!this.rendererPluginHost) {
      throw new Error("RendererPluginHost not initialized — call init() first");
    }
    this.rendererPluginHost.registerPlugin(plugin);
  }

  getRendererPluginHost(): RendererPluginHost | null {
    return this.rendererPluginHost;
  }

  // --- Getters ---

  getDevice(): GPUDevice | null {
    return this.device;
  }

  getContext(): GPUCanvasContext | null {
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

  getCanvas(): HTMLCanvasElement {
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
    this.rendererPluginHost?.disposeAll();
    this.rendererPluginHost = null;
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
