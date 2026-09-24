// ============================================================================
// native-host.ts — Bun-native host layer
//
// Ties together:
//   - GPU binding (wgpu-native via FFI)
//   - Native window (SDL2)
//   - Image polyfills (stb_image)
//   - Asset glob (filesystem-based)
//   - requestAnimationFrame (vsync-driven)
//   - Screenshot capture
//
// This is the entry point for native game execution. DOM/browser polyfills
// live in dom/dom-polyfills.ts.
// ============================================================================

import { installShaderValidationGuard } from "@downdraft/engine";
import { join } from "node:path";
import { installAssetGlob } from "./assets/native-assets";
import { createNativeBridge } from "./bridge/native-bridge";
import { resolveNativeUserDataDir } from "./bridge/user-data-dir";
import { installDOMPolyfills } from "./dom/dom-polyfills";
import { installGPU } from "./gpu/install";
import {
    acquireSingleInstanceLock,
    installNativeErrorHandlers,
    installWindowStatePersistence,
    releaseSingleInstanceLock,
} from "./host-lifecycle";
import { installImagePolyfills } from "./image/native-image";
import { startNativeMcpServer, type NativeMcpOptions, type NativeMcpServer } from "./mcp/native-mcp";
import { captureScreenshot, captureScreenshotPixels } from "./screenshot/screenshot";
import { NativeSurface } from "./window/native-surface";
import { NativeWindow, type NativeWindowConfig } from "./window/native-window";

export interface NativeHostConfig {
  window: NativeWindowConfig;
  /** Per-game application identifier (e.g. "to-the-ocean"). When set, the
   *  host installs `globalThis.downdraft` — the DowndraftBridgeAPI impl that
   *  makes `startGame()`, saves, MCP, and the standard automation tools work
   *  with zero per-game wiring. Omit only for bespoke debug harnesses. */
  appId?: string;
  /** Engine version stamped into save files / feature log. */
  engineVersion?: string;
  /** Start the in-process MCP HTTP server (PID-file discoverable).
   *  Default: enabled when `appId` is set, port ephemeral. Pass `false` to
   *  disable, or options to configure. */
  mcp?: boolean | NativeMcpOptions;
  screenshotPath?: string;
  screenshotAfterFrames?: number;
}

export interface NativeHostContext {
  window: NativeWindow;
  surface: NativeSurface;
  gpu: any;
  adapter: any;
  device: any;
  /** The installed `downdraft` bridge, when `appId` was provided. */
  bridge: (ReturnType<typeof createNativeBridge>) | null;
  mcp: NativeMcpServer | null;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  captureScreenshot: (path: string, texture?: any) => void;
  destroy: () => void;
}

export async function createNativeHost(config: NativeHostConfig): Promise<NativeHostContext> {
  // 1. Install polyfills
  const gpu = installGPU();
  installImagePolyfills();
  installAssetGlob();

  // Single-instance lock — the Electron app calls requestSingleInstanceLock
  // before creating the window; second instances quit. Deterministic/test
  // mode and DOWNDRAFT_MULTI_INSTANCE=1 opt out so e2e/dev can overlap.
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  if (config.appId && !deterministic && !acquireSingleInstanceLock(config.appId)) {
    console.error(`[native] Another ${config.appId} instance is already running — exiting.`);
    process.exit(0);
  }

  // 2. Create native window
  const window = new NativeWindow(config.window);
  if (config.appId && !deterministic) {
    installWindowStatePersistence(config.appId, window);
    installNativeErrorHandlers(window);
  }
  const surface = window.getSurface();
  (globalThis as any).__nativeWindow = window;

  // 3. Get adapter + device
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter found");

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: 256 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 16,
      maxSampledTexturesPerShaderStage: 32,
      maxSamplersPerShaderStage: 32,
      maxTextureArrayLayers: 256,
    },
  });

  // Install the shader validation guard so all createShaderModule calls
  // route through getCompilationInfo() validation. This catches malformed
  // shaders at startup/bake time before they reach the render pipeline.
  const gpuDevice = device as unknown as GPUDevice;
  installShaderValidationGuard(gpuDevice);

  // 4. Configure the surface context
  const ctx = surface.getContext("webgpu")!;
  const format = gpu.getPreferredCanvasFormat();
  ctx.configure({ device: gpuDevice, format, usage: 0x0010 | 0x0002 | 0x0001 }); // RENDER_ATTACHMENT | COPY_DST | COPY_SRC

  // 4b. Surface pixel readback — invoked from the context's pre-present hook
  // (see NativeSurface.captureNextFrame), the only point where the swapchain
  // texture is guaranteed valid for a copy. IMPORTANT: the copy must run on
  // the device that last configured the surface — GameRenderer.init()
  // creates its own device and reconfigures, so we read it dynamically.
  surface.setReadbackHook(() => {
    const tex = ctx.getCurrentTexture();
    const dev = ctx.getDevice() ?? device;
    if (!tex) { console.error("[native-host] readback hook: no surface texture"); return null; }
    try {
      return captureScreenshotPixels(dev, tex, surface.width, surface.height, ctx.getFormat() ?? format);
    } catch (e) {
      console.error("[native-host] readback hook failed:", e);
      return null;
    }
  });

  // 5. Install requestAnimationFrame on globalThis
  const rafSource = {
    request: (callback: (time: number) => void) => window.requestAnimationFrame(callback),
    cancel: (id: number) => window.cancelAnimationFrame(id),
  };
  (globalThis as any).requestAnimationFrame = rafSource.request.bind(window);
  (globalThis as any).cancelAnimationFrame = rafSource.cancel.bind(window);

  // 6. Install other DOM polyfills (file-backed localStorage under the
  // per-game userData dir when appId is set).
  installDOMPolyfills(window, surface, {
    storagePath: config.appId
      ? join(resolveNativeUserDataDir(config.appId), "localstorage.json")
      : undefined,
  });

  // 6b. Forward mouse/click/wheel events from the window to the surface (canvas).
  // The renderer's input handler listens on `canvas` for these events, but
  // SDL events are dispatched to the NativeWindow. We bridge them here.
  // Also synthesize `click` events from mousedown+mouseup pairs.
  let lastMouseDown: { x: number; y: number; button: number; time: number } | null = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  const forwardToSurface = (type: string, event: any) => {
    surface.dispatchEvent({ ...event, type });
  };
  window.addEventListener("mousemove", (e: any) => {
    // SDL already provides relative motion (xrel/yrel) via movementX/movementY
    // when relative mouse mode is enabled. Prefer those over recomputing from
    // absolute positions, which gives wrong deltas under pointer lock.
    const movementX = (typeof e.movementX === "number") ? e.movementX : e.clientX - lastMouseX;
    const movementY = (typeof e.movementY === "number") ? e.movementY : e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    forwardToSurface("mousemove", { ...e, movementX, movementY });
  });
  window.addEventListener("mousedown", (e: any) => {
    lastMouseDown = { x: e.clientX, y: e.clientY, button: e.button, time: performance.now() };
    forwardToSurface("mousedown", e);
  });
  window.addEventListener("mouseup", (e: any) => {
    forwardToSurface("mouseup", e);
    // Synthesize a click event if mouseup is close to the last mousedown
    if (lastMouseDown && lastMouseDown.button === e.button &&
        Math.abs(e.clientX - lastMouseDown.x) < 5 &&
        Math.abs(e.clientY - lastMouseDown.y) < 5 &&
        performance.now() - lastMouseDown.time < 500) {
      forwardToSurface("click", { ...e, type: "click" });
    }
    lastMouseDown = null;
  });
  window.addEventListener("wheel", (e: any) => {
    forwardToSurface("wheel", e);
  });
  window.addEventListener("contextmenu", (e: any) => {
    forwardToSurface("contextmenu", e);
  });

  // 6c. Install the `downdraft` bridge — the single-process implementation
  // of the same API the Electron preload exposes over IPC. The lazy accessor
  // in app/renderer picks it up whenever `startGame()` (or game code) first
  // touches `downdraft.*`.
  const bridge = config.appId
    ? createNativeBridge({
        appId: config.appId,
        window,
        surface,
        device,
        adapter,
        engineVersion: config.engineVersion,
        isDev: !config.screenshotPath, // dev hosts don't pass a screenshot path
      })
    : null;
  if (bridge) {
    (globalThis as any).downdraft = bridge;
    // Game code reads `window.downdraft` too (e.g. renderer factories that
    // check `window.downdraft?.deterministic`) — mirror it on the polyfill.
    const win = (globalThis as any).window;
    if (win) win.downdraft = bridge;
  }

  // 6d. Start the in-process MCP server (tools/list, tools/call, artifacts,
  // PID discovery — identical endpoints to the Electron proxy). artifactDir
  // enables the tracing/heap-snapshot tools + the /mcp/artifact/ download
  // endpoint, mirroring Electron's ${userData}/debug-artifacts layout.
  const mcpEnabled = config.mcp !== false && config.appId != null;
  const mcpOpts: NativeMcpOptions = typeof config.mcp === "object" ? config.mcp : {};
  const mcp = mcpEnabled && bridge
    ? await startNativeMcpServer(bridge, {
        ...mcpOpts,
        artifactDir: mcpOpts.artifactDir ?? join(resolveNativeUserDataDir(config.appId!), "debug-artifacts"),
      })
    : null;

  // 7. Start the event loop
  window.start();

  // 8. Create the screenshot capture function
  // The caller must pass the texture from getCurrentTexture() — we don't
  // re-acquire it because wgpu only allows one outstanding surface texture.
  const screenshotFn = (path: string, texture?: any) => {
    if (texture) {
      // Pass the surface format so captureScreenshot can swap BGRA→RGBA.
      captureScreenshot(device, texture, config.window.width, config.window.height, path, format);
    }
  };

  const host: NativeHostContext = {
    window,
    surface,
    gpu,
    adapter,
    device,
    bridge,
    mcp,
    requestAnimationFrame: rafSource.request.bind(window),
    cancelAnimationFrame: rafSource.cancel.bind(window),
    captureScreenshot: screenshotFn,
    destroy: () => {
      void mcp?.stop();
      bridge?.dispose();
      window.destroy();
      releaseSingleInstanceLock();
    },
  };
  // Bespoke entries (model-viewer, visual-test-bench) run their own loops and
  // need the shared device — expose the host so they can reuse it instead of
  // opening a second wgpu device on the same surface.
  (globalThis as any).__nativeHost = host;
  return host;
}
