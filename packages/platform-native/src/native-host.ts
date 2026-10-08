// ============================================================================
// native-host.ts — native host layer (runs under Bun, Node, or Deno)
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

import { installShaderValidationGuard } from "@downdraft/engine/render/shader-validator";
import { createLogger, setThreadTag } from "@downdraft/engine/util/logger";
import { ENGINE_VERSION } from "@downdraft/engine/version";
import { join } from "node:path";
import { installAssetGlob } from "./assets/native-assets";
import { createNativeBridge } from "./bridge/native-bridge";
import { resolveNativeUserDataDir } from "./bridge/user-data-dir";
import { installDOMPolyfills } from "./dom/dom-polyfills";
import { initNativeGamepad, startGamepadEnrichment } from "./gamepad/index";
import { computeDeviceDescriptor } from "./gpu/device-request";
import { installGPU } from "./gpu/install";
import { GpuPassMailbox } from "./gpu/pass-channel";
import { GpuShareBroker } from "./gpu/share-broker";
import { markAllSharedDevicesDead, retireAllSharedDevices } from "./gpu/shared-device";
import type { WgpuAdapter, WgpuDevice, WgpuGPU } from "./gpu/wgpu-device";
import { wgpu } from "./gpu/wgpu-ffi";
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
import { initNativeSecrets } from "./secrets/index";
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

/**
 * Align an adopted window (dev shell early-boot) with the caller's actual
 * window config — the early boot only knew downdraft.config.json's
 * "native" block.
 */
function reconcileWindowConfig(win: NativeWindow, w: NativeHostConfig["window"], splash?: boolean): void {
  if (w.title) win.setTitle(w.title);
  const sz = win.getWindowSize();
  if (w.width && w.height && (sz.width !== w.width || sz.height !== w.height)) {
    win.setWindowSize(w.width, w.height);
  }
  if (w.focused) win.requestFocus();
  if (splash === false) win.stopSplash();
}

export interface NativeHostContext {
  window: NativeWindow;
  surface: NativeSurface;
  gpu: any;
  adapter: any;
  device: any;
  /** The appId this host was created with (undefined for bespoke hosts). */
  appId?: string;
  /** Shared-GPU broker — one DeviceStateCells set for the host device.
   *  Workers attach via payload() (attachSharedDevice); retire() drains
   *  every attached view before destroy(). */
  gpuShare: GpuShareBroker;
  /** Mailbox for worker-produced command buffers — the renderer drains
   *  named slots into its submit batches (see gpu/pass-channel.ts). */
  passMailbox: GpuPassMailbox;
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
  // Startup profiling — DD_STARTUP_PROFILE=1 logs per-stage marks. The first
  // mark's absolute t doubles as "ms from process start to host entry"
  // (runtime boot + entry module-graph eval).
  const bootProf = process.env.DD_STARTUP_PROFILE === "1";
  const bootT0 = performance.now();
  let bootLast = bootT0;
  const mark = (label: string) => {
    if (!bootProf) return;
    const now = performance.now();
    log.info("startup", `${label}: +${(now - bootLast).toFixed(1)}ms t=${now.toFixed(1)}ms`);
    bootLast = now;
  };
  mark("createNativeHost");

  // Thread tag for log prefixes — the host entry IS the renderer thread.
  // Games used to set R0 at every entry top; a game override (e.g. a
  // non-R0 shell) still wins by setting it before calling us.
  if (!(globalThis as any).__ddThreadTag) setThreadTag("R0");

  // HMR session reuse — the dev shell keeps one host (window/device/bridge/
  // MCP) alive across session restarts. Entries re-call createNativeHost on
  // every session; reuse the live host instead of opening a second window.
  // A Tier-4 restart deletes __nativeHost first, so only live hosts hit this.
  const existing = (globalThis as any).__nativeHost;
  if (existing && typeof existing === "object" && !existing.destroyed && existing.window) {
    (globalThis as any).__ddSession?.attachHost?.(existing);
    return existing;
  }

  // Early-boot adoption — under the dev shell, native-dev-runtime kicked the
  // slim early boot (early-host.ts) as soon as the session started, storing
  // its in-flight EarlyHostParts promise on __ddEarlyHostPromise. The window
  // + GPU device are usually already resolved by the time the entry's module
  // graph finishes transforming — adopt the parts rather than building a
  // second window/device. Consume the stash immediately so a second call
  // can never double-adopt.
  const earlyPromise = (globalThis as any).__ddEarlyHostPromise;
  let early = (globalThis as any).__ddEarlyHost as
    | { window?: NativeWindow; gpu?: WgpuGPU; adapter?: WgpuAdapter | null; device?: WgpuDevice | null; surfaceConfigured?: boolean }
    | undefined;
  if (!early && earlyPromise && typeof earlyPromise.then === "function") {
    early = await Promise.resolve(earlyPromise).catch(() => null) as typeof early;
  }
  (globalThis as any).__ddEarlyHost = undefined;
  (globalThis as any).__ddEarlyHostPromise = undefined;
  const earlyWindowOk = early?.window != null && !early.window.closed;
  const earlyDeviceOk = earlyWindowOk && early?.device != null && early?.adapter != null;

  // 1. Install polyfills
  const gpu = installGPU(earlyWindowOk ? early?.gpu : undefined);
  installImagePolyfills();
  installAssetGlob();
  mark("polyfills");

  // Single-instance lock — second instances quit. Deterministic/test
  // mode and DOWNDRAFT_MULTI_INSTANCE=1 opt out so e2e/dev can overlap.
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  if (config.appId && !deterministic && !acquireSingleInstanceLock(config.appId)) {
    log.error("native", `Another ${config.appId} instance is already running — exiting.`);
    // Under the dev shell this code runs inside the ModuleRunner, where
    // process.exit can fail to terminate — the supervisor's shutdown path
    // owns the real exit there. Never resolve afterwards: the process is
    // going down (bounded by the supervisor's force-exit) and letting
    // createNativeHost continue would build a doomed host.
    const sup = (globalThis as any).__ddSupervisor;
    if (typeof sup?.shutdown === "function") {
      sup.shutdown();
      await new Promise<never>(() => {});
    }
    process.exit(0);
  }

  // Export the userData dir so worker threads (env is inherited under Bun)
  // can reach persistence fallbacks — e.g. BinaryRecordStore's node:fs
  // OPFS replacement. An inherited override (test isolation) wins.
  if (config.appId && !process.env.DOWNDRAFT_USER_DATA) {
    process.env.DOWNDRAFT_USER_DATA = resolveNativeUserDataDir(config.appId);
  }

  // 2. Create native window — adopt the early-boot window when present
  //    (reconcile title/size/focus against the caller's real config).
  let window: NativeWindow;
  if (earlyWindowOk) {
    window = early!.window!;
    reconcileWindowConfig(window, config.window, config.splash);
  } else {
    window = new NativeWindow(config.window);
  }
  mark("window");
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

  // 2b. Start the event loop NOW — before the GPU wait, not after it. The
  //     window was created seconds ago; pumping here keeps it responsive
  //     (and lets the splash present the moment the surface is configured)
  //     instead of reading as hung to the WM for the whole boot stretch.
  window.start();
  mark("event-loop");

  // 2c. Kick the adapter request — genuinely asynchronous on platform libs
  //     that export wgpu_shim_request_adapter_async (the GPU wait runs on a
  //     detached Rust thread), so the installs below overlap with it. An
  //     adopted early boot already resolved it.
  const adapterPromise = earlyDeviceOk
    ? Promise.resolve(early!.adapter)
    : gpu.requestAdapter({ powerPreference: "high-performance" });

  // 2d. rAF globals + DOM polyfills — the Worker polyfill must exist before
  //     the services worker spawns under Node (Bun has a native Worker).
  const rafSource = {
    request: (callback: (time: number) => void) => window.requestAnimationFrame(callback),
    cancel: (id: number) => window.cancelAnimationFrame(id),
  };
  (globalThis as any).requestAnimationFrame = rafSource.request.bind(window);
  (globalThis as any).cancelAnimationFrame = rafSource.cancel.bind(window);
  installDOMPolyfills(window, surface, {
    storagePath: config.appId
      ? join(resolveNativeUserDataDir(config.appId), "localstorage.json")
      : undefined,
  });
  mark("dom-polyfills");

  // 2e. Host services — the worker spawn + init RPC overlaps with the
  //     adapter/device wait instead of serializing after it.
  const servicesPromise: Promise<HostServices | null> = config.appId
    ? createHostServices({
        appId: config.appId,
        engineVersion: config.engineVersion ?? ENGINE_VERSION,
        mode: config.services,
      })
    : Promise.resolve(null);

  // 3. Get adapter + device — THE single wgpu device for this process.
  //    The renderer (GameRenderer) borrows it via getNativeHost(); it does
  //    not request a second device or reconfigure the surface. The limits/
  //    features below are the UNION of what the host and GameRenderer
  //    request (clamped to what the adapter supports).
  const adapter = await adapterPromise;
  mark("adapter");
  if (!adapter) throw new Error("No GPU adapter found");

  // Limits/features are the union of host + GameRenderer needs, clamped to
  // the adapter — shared with the dev shell's early boot so an adopted
  // device was requested with the identical descriptor.
  const device = earlyDeviceOk
    ? early!.device!
    : await adapter.requestDevice(computeDeviceDescriptor(adapter));
  mark("device");

  // Install the shader validation guard so all createShaderModule calls
  // route through getCompilationInfo() validation. This catches malformed
  // shaders at startup/bake time before they reach the render pipeline.
  const gpuDevice = device as unknown as GPUDevice;
  installShaderValidationGuard(gpuDevice);

  // 3b. Shared-device broker — THE DeviceStateCells set for this device.
  //     shareDevice() overwrites device.sharedState on each call, so every
  //     consumer (ui workers, grid builders, pass producers) must attach
  //     through this single broker or earlier consumers lose the death
  //     signal. retire() is invoked in destroy() before the device frees.
  const gpuShare = new GpuShareBroker(device);
  const passMailbox = new GpuPassMailbox();

  // 4. Configure the surface context — the early boot already configured
  //    it (splash presenting) when its parts were adopted.
  const ctx = surface.getContext("webgpu")!;
  const format = gpu.getPreferredCanvasFormat();
  if (!(earlyDeviceOk && early?.surfaceConfigured)) {
    ctx.configure({ device: gpuDevice, format, usage: 0x0010 | 0x0002 | 0x0001 }); // RENDER_ATTACHMENT | COPY_DST | COPY_SRC
  }
  mark("surface-configure");

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

  // 4c. Boot splash — attach as soon as the surface is configured so the
  //     first presented frame lands immediately (the event loop is already
  //     running). Runs until the game's render loop registers its first rAF.
  if (config.splash !== false && !deterministic && !config.screenshotPath && config.screenshotAfterFrames === undefined) {
    try { window.attachSplash(new SplashScreen(window, surface)); }
    catch (e) { log.warn("platform-native", `splash unavailable: ${e}`); }
  }
  mark("splash");

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
  // process shape the plugin sandbox will use. Spawned in step 2e — its
  // init overlapped the adapter/device wait.
  const services = await servicesPromise;
  mark("services");
  // 6c-2. Gamepad backend — optional downdraft_gamepad cdylib (gilrs).
  //   Owns the 'gamepad-devices' SAB channel; GamepadLib picks the buffer
  //   up via globalThis.__ddGamepad. Absent library / gilrs failure → null,
  //   gamepad support just isn't available. Disabled via DOWNDRAFT_NO_GAMEPAD.
  let gamepadDestroyFn: (() => void) | null = null;
  const gamepad = process.env.DOWNDRAFT_NO_GAMEPAD !== "1" ? initNativeGamepad() : null;
  if (gamepad) {
    (globalThis as any).__ddGamepad = gamepad;
    let stopEnrich: (() => void) | null = null;
    void startGamepadEnrichment(gamepad.sab).then((stop) => { stopEnrich = stop; });
    gamepadDestroyFn = () => { stopEnrich?.(); gamepad.destroy(); };
  }

  // 6c-3. OS keychain — optional downdraft_secrets cdylib (keyring). Exposed
  //   as globalThis.__ddSecrets so engine/worker code can reach it without
  //   importing platform-native; null when no credential backend exists.
  const secrets = process.env.DOWNDRAFT_NO_SECRETS !== "1" ? initNativeSecrets() : null;
  if (secrets) (globalThis as any).__ddSecrets = secrets;
  mark("gamepad+secrets");

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
  mark("bridge");

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
  mark("mcp");

  // 6e. Memory probe — DD_MEM_TRACE=<seconds> logs process.memoryUsage() +
  //     V8 heap stats to the console (logcat on Android). Dynamic v8 import
  //     keeps this Node-only; absent API → process stats only.
  const memTraceSecs = Number(process.env.DD_MEM_TRACE ?? 0);
  if (memTraceSecs > 0) {
    void import("node:v8").then((v8) => {
      const fmt = (n?: number) => Math.round((n ?? 0) / 1048576);
      const t = setInterval(() => {
        const m = process.memoryUsage() as ReturnType<typeof process.memoryUsage> & { arrayBuffers?: number };
        const h = v8.getHeapStatistics();
        log.info("mem", `rss=${fmt(m.rss)}MB ext=${fmt(m.external)}MB ab=${fmt(m.arrayBuffers)}MB heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)}MB v8=${fmt(h.used_heap_size)}/${fmt(h.total_heap_size)}MB v8ext=${fmt(h.external_memory)}MB`);
      }, memTraceSecs * 1000);
      t.unref?.();
    }).catch(() => {});
  }

  // 8. Create the screenshot capture function
  // The caller must pass the texture from getCurrentTexture() — we don't
  // re-acquire it because wgpu only allows one outstanding surface texture.
  const screenshotFn = (path: string, texture?: any) => {
    if (texture) {
      // Pass the surface format so captureScreenshot can swap BGRA→RGBA.
      // Use the surface's real size, not the requested window size — the WM
      // may have resized before/when the swapchain was configured, and a
      // copy wider than the texture is a wgpu validation error.
      captureScreenshot(device, texture, surface.width, surface.height, path, format);
    }
  };

  const host: NativeHostContext = {
    window,
    surface,
    gpu,
    adapter,
    device,
    appId: config.appId,
    gpuShare,
    passMailbox,
    bridge,
    services,
    mcp,
    requestAnimationFrame: rafSource.request.bind(window),
    cancelAnimationFrame: rafSource.cancel.bind(window),
    captureScreenshot: screenshotFn,
    destroyed: false,
    destroy: () => {
      // Re-entrant: the game entry's finally and the dev supervisor both call
      // this on window close — a second pass would double-release the boxed
      // instance/device handles (use-after-free in the shim).
      if (host.destroyed) return;
      host.destroyed = true;
      // Sync kill-switch for attached worker views: mark every shared-device
      // cell set dead so workers stop *starting* FFI calls on handles we're
      // about to free. The broker's retire() writes the same cells (it also
      // drains attached views asynchronously — the event loop is still live
      // here so workers can observe the request before the process exits;
      // the dev supervisor additionally runs retireAllSharedDevices first).
      void gpuShare.retire();
      markAllSharedDevicesDead();
      void mcp?.stop();
      gamepadDestroyFn?.();
      delete (globalThis as any).__ddGamepad;
      delete (globalThis as any).__ddSecrets;
      bridge?.dispose();
      window.destroy();
      // GPU teardown, strictly after window.destroy() released the surface:
      // device first — destroy() marks every SharedArrayBuffer view dead
      // (markDeviceLost) so attached workers stop issuing FFI calls against
      // it — then the instance, so late-arriving finalizer polls still have
      // a live pump target until the very end.
      try { device.destroy(); } catch { /* best-effort */ }
      try { wgpu.wgpu_shim_release_instance(gpu.getInstancePtr()); } catch { /* best-effort */ }
      // The instance box is freed — clear the global NOW, not in the
      // destroyHostLayer sweep the dev runtime runs after us: the
      // supervisor's Tier-4 fallback path never reaches destroyHostLayer,
      // and a stale ptr is a use-after-free the next generation's
      // NativeWindow hands straight to create_surface (SIGSEGV).
      (globalThis as any).__wgpuInstancePtr = 0;
      releaseSingleInstanceLock();
    },
  };
  // Bespoke entries (model-viewer, visual-test-bench) run their own loops and
  // need the shared device — expose the host so they can reuse it instead of
  // opening a second wgpu device on the same surface.
  (globalThis as any).__nativeHost = host;
  // The dev-shell supervisor (.mjs — can't import this module's TS) uses this
  // to retire shared-device views before calling host.destroy().
  (globalThis as any).__ddRetireSharedDevices = retireAllSharedDevices;
  // HMR session tracking — wraps this host's window/surface listeners,
  // RAF + Worker globals, and snapshots the device baseline. No-op without
  // the dev shell.
  (globalThis as any).__ddSession?.attachHost?.(host);
  mark("host-ready");
  return host;
}
