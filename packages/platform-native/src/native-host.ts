// ============================================================================
// native-host.ts — Bun-native host layer
//
// Ties together:
//   - GPU binding (wgpu via FFI)
//   - Native window (winit)
//   - Image polyfills (image crate)
//   - Asset glob (filesystem-based)
//   - requestAnimationFrame (vsync-driven)
//   - Screenshot capture
//
// This is the entry point for native game execution. DOM/browser polyfills
// live in dom/dom-polyfills.ts.
// ============================================================================

import { ENGINE_VERSION, installShaderValidationGuard } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
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
import type { NativeMcpOptions, NativeMcpServer } from "./mcp/native-mcp";
import { installRestartHook } from "./native-restart";
import { isPackaged } from "./packaged";
import { captureScreenshot, captureScreenshotPixels } from "./screenshot/screenshot";
import { createHostServices, type HostServices } from "./services/host-services";
import { NativeSurface } from "./window/native-surface";
import { NativeWindow, type NativeWindowConfig } from "./window/native-window";
import { SplashScreen } from "./window/splash-screen";

const log = createLogger("info");

// Defined by scripts/package-native.mjs (draft release) to strip the in-
// process MCP endpoint from distributed binaries; absent in dev.
declare const __DD_MCP_STRIP__: boolean | undefined;

export interface NativeHostConfig {
  window: NativeWindowConfig;
  /** Per-game application identifier (e.g. "to-the-ocean"). When set, the
   *  host installs `globalThis.downdraft` — the HostAPI impl that
   *  makes `startGame()`, saves, MCP, and the standard automation tools work
   *  with zero per-game wiring. Omit only for bespoke debug harnesses. */
  appId?: string;
  /** Engine version stamped into save files / feature log. */
  engineVersion?: string;
  /** Start the in-process MCP HTTP server (PID-file discoverable).
   *  Default: enabled when `appId` is set, port ephemeral. Pass `false` to
   *  disable, or options to configure. */
  mcp?: boolean | NativeMcpOptions;
  /** Where host services (save I/O, SQLite import cache) run. Default
   *  "worker" — a dedicated services thread keeps blocking I/O off the
   *  frame loop. "inline" runs in-process (debug/tests). Env override:
   *  DOWNDRAFT_SERVICES=inline. */
  services?: "inline" | "worker";
  screenshotPath?: string;
  screenshotAfterFrames?: number;
  /** Boot splash — an animated spinner pass on the surface until the game's
   *  render loop registers its first rAF. Default on; force-disabled in
   *  deterministic mode and for screenshot harnesses (a splash frame must
   *  never land in a captured image). */
  splash?: boolean;
}

export interface NativeHostContext {
  window: NativeWindow;
  surface: NativeSurface;
  gpu: any;
  adapter: any;
  device: any;
  /** The installed `downdraft` bridge, when `appId` was provided. */
  bridge: (ReturnType<typeof createNativeBridge>) | null;
  /** Host services handle (worker-backed save store + import cache). */
  services: HostServices | null;
  mcp: NativeMcpServer | null;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  captureScreenshot: (path: string, texture?: any) => void;
  /** True after destroy() ran — the dev shell checks this before reusing the
   *  host across HMR session restarts. */
  destroyed: boolean;
  destroy: () => void;
}

export async function createNativeHost(config: NativeHostConfig): Promise<NativeHostContext> {
  // HMR session reuse — the dev shell keeps one host (window/device/bridge/
  // MCP) alive across session restarts. Entries re-call createNativeHost on
  // every session; reuse the live host instead of opening a second window.
  // A Tier-4 restart deletes __nativeHost first, so only live hosts hit this.
  const existing = (globalThis as any).__nativeHost;
  if (existing && typeof existing === "object" && !existing.destroyed && existing.window) {
    (globalThis as any).__ddSession?.attachHost?.(existing);
    return existing;
  }

  // 1. Install polyfills
  const gpu = installGPU();
  installImagePolyfills();
  installAssetGlob();

  // Single-instance lock — second instances quit. Deterministic/test
  // mode and DOWNDRAFT_MULTI_INSTANCE=1 opt out so e2e/dev can overlap.
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  if (config.appId && !deterministic && !acquireSingleInstanceLock(config.appId)) {
    log.error("native", `Another ${config.appId} instance is already running — exiting.`);
    process.exit(0);
  }

  // Export the userData dir so worker threads (env is inherited under Bun)
  // can reach persistence fallbacks — e.g. BinaryRecordStore's node:fs
  // OPFS replacement. An inherited override (test isolation) wins.
  if (config.appId && !process.env.DOWNDRAFT_USER_DATA) {
    process.env.DOWNDRAFT_USER_DATA = resolveNativeUserDataDir(config.appId);
  }

  // 2. Create native window
  const window = new NativeWindow(config.window);
  if (config.appId && !deterministic) {
    installWindowStatePersistence(config.appId, window);
    installNativeErrorHandlers(window, config.appId);
  }
  const surface = window.getSurface();
  (globalThis as any).__nativeWindow = window;

  // Process-restart recovery hook — the native equivalent of
  // window.location.reload() for unrecoverable GPU/renderer failures.
  // GameRenderer's device-loss fallback, location.reload(), and bespoke
  // render loops all route through __ddRequestRestart. Under the HMR dev
  // shell the "reload" is a session restart (in-process) — much cheaper than
  // a detached respawn and it preserves the window.
  const hmrCtl = (globalThis as any).__ddHmr;
  if (typeof hmrCtl?.restartSession === "function") {
    (globalThis as any).__ddRequestRestart = (reason: string) => {
      hmrCtl.restartSession(reason);
      return true;
    };
  } else {
    installRestartHook(window);
  }

  // 3. Get adapter + device — THE single wgpu device for this process.
  //    The renderer (GameRenderer) borrows it via getNativeHost(); it does
  //    not request a second device or reconfigure the surface. The limits/
  //    features below are the UNION of what the host and GameRenderer
  //    request (clamped to what the adapter supports).
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter found");

  const adapterLimits = adapter.limits as unknown as Record<string, number>;
  // Request the min of what we want and what the adapter reports. If the
  // adapter doesn't advertise the limit (non-finite / 0), don't request it —
  // requesting a limit above the adapter's reported max fails requestDevice.
  const requiredLimits: Record<string, number> = {};
  const requestLimit = (key: string, want: number): void => {
    const have = Number(adapterLimits[key]);
    if (Number.isFinite(have) && have > 0) requiredLimits[key] = Math.min(want, have);
  };
  requestLimit("maxStorageBufferBindingSize", 256 * 1024 * 1024);
  requestLimit("maxStorageBuffersPerShaderStage", 16);
  requestLimit("maxSampledTexturesPerShaderStage", 32);
  requestLimit("maxSamplersPerShaderStage", 32);
  requestLimit("maxTextureArrayLayers", 512);
  // Timestamp queries are opt-in on native: the wgpu timestamp path loses
  // the device on lavapipe-class rasterizers AND has been observed to lose
  // real discrete Vulkan devices under sustained in-game use — keep it behind
  // DOWNDRAFT_GPU_TIMESTAMPS until the driver-level issue is resolved
  // upstream. The base feature is still requested unconditionally (harmless
  // while unused; consumers gate on isGpuTimestampSafe).
  const adapterType = (adapter as unknown as { nativeInfo?: { deviceType?: string } | null }).nativeInfo?.deviceType;
  const wantTimestampExtensions =
    !!process.env.DOWNDRAFT_GPU_TIMESTAMPS && adapterType !== "cpu";
  const timestampFeatures = [
    "timestamp-query",
    ...(wantTimestampExtensions
      ? ["timestamp-query-inside-passes", "timestamp-query-inside-encoders"]
      : []),
  ].filter((f) => adapter.features.has(f as GPUFeatureName));
  const device = await adapter.requestDevice({
    requiredFeatures: timestampFeatures as GPUFeatureName[],
    requiredLimits,
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
  // texture is guaranteed valid for a copy. There is exactly one device in
  // the process — GameRenderer borrows it, it does not reconfigure.
  surface.setReadbackHook(() => {
    const tex = ctx.getCurrentTexture();
    if (!tex) { log.error("native-host", "readback hook: no surface texture"); return null; }
    try {
      return captureScreenshotPixels(device, tex, surface.width, surface.height, ctx.getFormat() ?? format);
    } catch (e) {
      log.error("native-host", `readback hook failed: ${e}`);
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

  // 6b. Click synthesis lives in NativeWindow.dispatchInputEvent (SDL_EVENT_
  // MOUSEBUTTONUP → click/dblclick with proper click counting). Do NOT
  // synthesize or forward pointer events here — dispatchInputEvent already
  // delivers them to the surface, and a second synthesis double-fires
  // `click` on surface listeners.

  // 6c. Install the `downdraft` bridge — the single-process HostAPI
  // implementation. The lazy accessor in app/renderer picks it up whenever
  // `startGame()` (or game code) first touches `downdraft.*`.
  // Services worker owns FileSaveStore + the SQLite import cache so save
  // serialization and sync sqlite calls stay off the frame thread. Same
  // process shape the plugin sandbox will use.
  const services = config.appId
    ? await createHostServices({
        appId: config.appId,
        engineVersion: config.engineVersion ?? ENGINE_VERSION,
        mode: config.services,
      })
    : null;
  const bridge = config.appId && services
    ? createNativeBridge({
        appId: config.appId,
        window,
        surface,
        device,
        adapter,
        services,
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
  // PID discovery). artifactDir enables the tracing/heap-snapshot tools +
  // the /mcp/artifact/ download endpoint, stored under
  // ${userData}/debug-artifacts.
  //
  // The endpoint is dev/test infrastructure — it must not ship in packaged
  // binaries. __DD_MCP_STRIP__ folds this whole block to dead code in
  // `bun build --compile` output; builds that retain MCP (package --mcp)
  // still default off at runtime unless DOWNDRAFT_MCP=1 is set.
  const MCP_STRIPPED = typeof __DD_MCP_STRIP__ !== "undefined" && __DD_MCP_STRIP__;
  const mcpEnabled = !MCP_STRIPPED
    && config.mcp !== false
    && config.appId != null
    && (!isPackaged() || process.env.DOWNDRAFT_MCP === "1");
  const mcpOpts: NativeMcpOptions = typeof config.mcp === "object" ? config.mcp : {};
  const mcp = mcpEnabled && bridge
    ? await (await import("./mcp/native-mcp")).startNativeMcpServer(bridge, {
        ...mcpOpts,
        artifactDir: mcpOpts.artifactDir ?? join(resolveNativeUserDataDir(config.appId!), "debug-artifacts"),
      })
    : null;

  // 7. Start the event loop
  window.start();

  // 7b. Boot splash — the window would otherwise show an unpresented (black)
  //  swapchain for the whole module-load + renderer-init stretch (seconds
  //  under the dev shell). Runs until the game's rAF loop registers.
  if (config.splash !== false && !deterministic && !config.screenshotPath && config.screenshotAfterFrames === undefined) {
    try { window.attachSplash(new SplashScreen(window, surface)); }
    catch (e) { log.warn("platform-native", `splash unavailable: ${e}`); }
  }

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
    services,
    mcp,
    requestAnimationFrame: rafSource.request.bind(window),
    cancelAnimationFrame: rafSource.cancel.bind(window),
    captureScreenshot: screenshotFn,
    destroyed: false,
    destroy: () => {
      host.destroyed = true;
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
  // HMR session tracking — wraps this host's window/surface listeners,
  // RAF + Worker globals, and snapshots the device baseline. No-op without
  // the dev shell.
  (globalThis as any).__ddSession?.attachHost?.(host);
  return host;
}
