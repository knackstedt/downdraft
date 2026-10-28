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
// This is the entry point for native app execution. DOM/browser polyfills
// live in dom/dom-polyfills.ts.
// ============================================================================

import { installShaderValidationGuard } from "@downdraft/engine/render/shader-validator";
import { createLogger } from "@downdraft/engine/util/logger";
import { ENGINE_VERSION } from "@downdraft/engine/version";
import { join } from "node:path";
import { installAssetGlob } from "./assets/native-assets";
import { createNativeBridge } from "./bridge/native-bridge";
import { resolveNativeUserDataDir } from "./bridge/user-data-dir";
import { initNativeController, startControllerEnrichment } from "./controller/index";
import { installDOMPolyfills } from "./dom/dom-polyfills";
import { acquireAdapterAndDevice, type AcquiredGpu } from "./gpu/adapter-boot";
import type { GpuBootPlan } from "./gpu/adapter-policy";
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

/**
 * Thrown by createNativeHost when a dev-shell restart superseded the boot
 * mid-flight. Entries treat it as expected teardown — like vite's
 * "transport was disconnected" rejection — never as a boot failure.
 */
export class HostBootSupersededError extends Error {
  constructor(stage: string) {
    super(`host boot superseded mid-flight (${stage})`);
    this.name = "HostBootSuperseded";
  }
}

// The ModuleRunner generation that evaluated this module — undefined outside
// the dev shell (packaged/direct runs disable the supersession checks). A
// Tier-3/4 restart closes+rebuilds the runner, but async continuations of
// old-generation modules still resume: their dynamic import()s route to the
// CLOSED runner and throw, and every persistent-layer global they install
// (window, rAF, the downdraft bridge) clobbers the live generation's host.
// createNativeHost checks this at every suspension point and rolls back.
const EVAL_RUNNER: { closed?: boolean } | undefined = (globalThis as any).__ddRunner;

/** True when the dev shell closed/replaced the runner that evaluated this
 *  module — the boot must stop at the next suspension point. */
function hostBootSuperseded(): boolean {
  if (EVAL_RUNNER == null || typeof EVAL_RUNNER !== "object") return false;
  if (EVAL_RUNNER.closed === true) return true;
  const current = (globalThis as any).__ddRunner;
  return current != null && current !== EVAL_RUNNER;
}

export interface NativeHostConfig {
  window: NativeWindowConfig;
  /** Per-app application identifier (e.g. "my-app"). When set, the
   *  host installs `globalThis.downdraft` — the HostAPI impl that
   *  makes `startApp()`, saves, MCP, and the standard automation tools work
   *  with zero per-app wiring. Omit only for bespoke debug harnesses. */
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
  /** Boot splash — an animated spinner pass on the surface until the app's
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

  // Supersession bookkeeping — everything this boot builds lands in
  // `partial` so a bail can roll it back. A dev-shell restart that lands
  // while the boot is suspended closes the ModuleRunner that evaluated this
  // module; continuing would import on the dead runner AND keep installing
  // host globals over the live generation's persistent layer, so every
  // suspension point below is followed by liveOrBail(). Globals are only
  // removed while they still point at THIS boot's objects — a live
  // generation's installations must never be clobbered by a dead one's
  // cleanup.
  const partial = {
    window: null as NativeWindow | null,
    device: null as WgpuDevice | null,
    gpu: null as WgpuGPU | null,
    gpuShare: null as GpuShareBroker | null,
    gpuPlan: null as GpuBootPlan | null,
    services: null as HostServices | null,
    mcp: null as NativeMcpServer | null,
    controller: null as unknown,
    controllerDestroy: null as (() => void) | null,
    secrets: null as unknown,
    bridge: null as ReturnType<typeof createNativeBridge> | null,
    instanceLock: false,
  };
  let partialActive = true;
  const destroyPartial = async (): Promise<void> => {
    if (!partialActive) return;
    partialActive = false;
    const g = globalThis as any;
    try { await partial.mcp?.stop?.(); } catch { /* best-effort */ }
    try { partial.controllerDestroy?.(); } catch { /* best-effort */ }
    if (partial.controller && g.__ddController === partial.controller) delete g.__ddController;
    if (partial.secrets && g.__ddSecrets === partial.secrets) delete g.__ddSecrets;
    try { partial.bridge?.dispose(); } catch { /* best-effort */ }
    if (partial.bridge && g.downdraft === partial.bridge) {
      try { delete g.downdraft; } catch { g.downdraft = undefined; }
      try { if (g.window?.downdraft === partial.bridge) delete g.window.downdraft; } catch { /* best-effort */ }
    }
    try { await partial.services?.dispose?.(); } catch { /* best-effort */ }
    // Retire only THIS boot's shared-device cells — markAllSharedDevicesDead
    // would also poison a live generation's views.
    try { void partial.gpuShare?.retire?.(); } catch { /* best-effort */ }
    if (g.__nativeWindow === partial.window) {
      try { delete g.__nativeWindow; } catch { g.__nativeWindow = undefined; }
    }
    try { partial.window?.destroy(); } catch { /* best-effort */ }
    if (partial.device) {
      try { partial.device.destroy(); } catch { /* best-effort */ }
      const ptr = partial.gpu?.getInstancePtr?.();
      if (!partial.device.nativeHandlesLeaked && ptr) {
        try { wgpu.wgpu_shim_release_instance(ptr); } catch { /* best-effort */ }
      }
      if (ptr && g.__wgpuInstancePtr === ptr) g.__wgpuInstancePtr = 0;
    }
    if (partial.instanceLock) {
      try { releaseSingleInstanceLock(); } catch { /* best-effort */ }
      partial.instanceLock = false;
    }
    // Clean teardown isn't a GPU crash — disarm the boot sentinel.
    try { partial.gpuPlan?.markHealthy(); } catch { /* best-effort */ }
    if (installedRestartFn && g.__ddRequestRestart === installedRestartFn) {
      try { delete g.__ddRequestRestart; } catch { g.__ddRequestRestart = undefined; }
    }
    if (partial.gpuPlan && g.__ddGpuBootHealthy === partial.gpuPlan.markHealthy) {
      try { delete g.__ddGpuBootHealthy; } catch { g.__ddGpuBootHealthy = undefined; }
    }
  };
  const bailSuperseded = async (stage: string): Promise<never> => {
    try { await destroyPartial(); } catch { /* best-effort */ }
    throw new HostBootSupersededError(stage);
  };
  /** Bail when this boot's generation was superseded while suspended —
   *  resolves normally while the boot's own runner is still live. */
  const liveOrBail = (stage: string): Promise<void> | undefined =>
    hostBootSuperseded() ? bailSuperseded(stage) : undefined;
  // The function installed as __ddRequestRestart below — tracked so
  // destroyPartial only removes the global while it still points at THIS
  // boot's function.
  let installedRestartFn: ((reason: string) => boolean) | null = null;

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
    | { window?: NativeWindow; gpu?: WgpuGPU; adapter?: WgpuAdapter | null; device?: WgpuDevice | null; surfaceConfigured?: boolean; gpuPlan?: GpuBootPlan }
    | undefined;
  if (!early && earlyPromise && typeof earlyPromise.then === "function") {
    early = await Promise.resolve(earlyPromise).catch(() => null) as typeof early;
  }
  (globalThis as any).__ddEarlyHost = undefined;
  (globalThis as any).__ddEarlyHostPromise = undefined;
  // Consume-once stash — the adopted parts are this boot's to destroy if a
  // supersession bail fires: nothing else can ever adopt them, so skipping
  // the rollback would orphan a mapped window + wgpu device.
  partial.window = early?.window ?? null;
  partial.device = early?.device ?? null;
  partial.gpu = early?.gpu ?? null;
  await liveOrBail("early-host");
  const earlyWindowOk = early?.window != null && !early.window.closed;
  const earlyDeviceOk = earlyWindowOk && early?.device != null && early?.adapter != null;

  // 1. Install polyfills
  const gpu = installGPU(earlyWindowOk ? early?.gpu : undefined, { appId: config.appId });
  installImagePolyfills();
  installAssetGlob();
  mark("polyfills");

  // Single-instance lock — second instances quit. Deterministic/test
  // mode and DOWNDRAFT_MULTI_INSTANCE=1 opt out so e2e/dev can overlap.
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  if (config.appId && !deterministic) {
    let lockOk: boolean;
    try {
      lockOk = await acquireSingleInstanceLock(config.appId);
    } catch (e) {
      // The await can also reject with a dead-runner error — bail through
      // the same rollback path when this boot was superseded.
      if (hostBootSuperseded()) await bailSuperseded("instance-lock");
      throw e;
    }
    if (!lockOk) {
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
    partial.instanceLock = true;
    await liveOrBail("instance-lock");
  }

  // Export the userData dir so worker threads (env is inherited under Bun)
  // can reach persistence fallbacks — e.g. BinaryRecordStore's node:fs
  // Save/userData root override. An inherited override (test isolation) wins.
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
    partial.window = window;
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
  // AppRenderer's device-loss fallback, location.reload(), and bespoke
  // render loops all route through __ddRequestRestart. Under the HMR dev
  // shell the "reload" is a session restart (in-process) — much cheaper than
  // a detached respawn and it preserves the window.
  const hmrCtl = (globalThis as any).__ddHmr;
  if (typeof hmrCtl?.restartSession === "function") {
    installedRestartFn = (reason: string) => {
      hmrCtl.restartSession(reason);
      return true;
    };
    (globalThis as any).__ddRequestRestart = installedRestartFn;
  } else {
    installRestartHook(window);
  }

  // 2b. Start the event loop NOW — before the GPU wait, not after it. The
  //     window was created seconds ago; pumping here keeps it responsive
  //     (and lets the splash present the moment the surface is configured)
  //     instead of reading as hung to the WM for the whole boot stretch.
  window.start();
  mark("event-loop");

  // 2c. Kick the adapter+device acquire — the adapter wait is genuinely
  //     asynchronous on platform libs that export the _async exports (the
  //     GPU wait runs on a detached Rust thread), so the installs below
  //     overlap with it. Runs the adapter policy: denylist, software
  //     fallback, and the crash sentinel. An adopted early boot already
  //     resolved it (its own acquire armed the same sentinel).
  const acquiredPromise: Promise<AcquiredGpu | null> = earlyDeviceOk
    ? Promise.resolve({
        adapter: early!.adapter!, device: early!.device!, gpu: early!.gpu!,
        info: early!.adapter!.nativeInfo, softwareFallback: !!early!.adapter!.__ddSoftwareAdapter,
        plan: early!.gpuPlan!,
      })
    : acquireAdapterAndDevice(gpu, { appId: config.appId, window });

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
  log.info("platform-native", "bindings installed (gpu, image, assets, dom)");

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
  //    The renderer (AppRenderer) borrows it via getNativeHost(); it does
  //    not request a second device or reconfigure the surface. The limits/
  //    features below are the UNION of what the host and AppRenderer
  //    request (clamped to what the adapter supports).
  let acquired: AcquiredGpu | null;
  try {
    acquired = await acquiredPromise;
  } catch (e) {
    // Rejections caused by the runner closing mid-wait are supersession,
    // not a GPU failure.
    if (hostBootSuperseded()) await bailSuperseded("adapter+device");
    throw e;
  }
  mark("adapter+device");
  if (!acquired) throw new Error("No GPU adapter found");
  await liveOrBail("adapter+device");
  const { adapter, device, gpu: activeGpu } = acquired;
  partial.device = device;
  partial.gpu = activeGpu;
  // The GL fallback tier may have won on a second instance — use the
  // winner's WgpuGPU (installGPU's globals were already repointed by the
  // acquire's adopt step when the instances differ).
  const gpuPlan: GpuBootPlan | null = acquired.plan ?? null;
  partial.gpuPlan = gpuPlan;
  // First presented frame (or clean teardown) proves the GPU stack healthy —
  // disarms the crash sentinel planGpuBoot armed before the adapter request.
  if (gpuPlan) {
    (globalThis as any).__ddGpuBootHealthy = gpuPlan.markHealthy;
    if (acquired.softwareFallback) {
      (globalThis as any).__ddGpuSoftwareFallback = true;
    }
  }

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
  partial.gpuShare = gpuShare;
  const passMailbox = new GpuPassMailbox();

  // 4. Configure the surface context — the early boot already configured
  //    it (splash presenting) when its parts were adopted.
  const ctx = surface.getContext("webgpu")!;
  const format = activeGpu.getPreferredCanvasFormat();
  if (!(earlyDeviceOk && early?.surfaceConfigured)) {
    ctx.configure({ device: gpuDevice, format, usage: 0x0010 | 0x0002 | 0x0001 }); // RENDER_ATTACHMENT | COPY_DST | COPY_SRC
  }
  mark("surface-configure");

  // 4b. Surface pixel readback — invoked from the context's pre-present hook
  // (see NativeSurface.captureNextFrame), the only point where the swapchain
  // texture is guaranteed valid for a copy. There is exactly one device in
  // the process — AppRenderer borrows it, it does not reconfigure.
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
  //     running). Runs until the app's render loop registers its first rAF.
  if (config.splash !== false && !deterministic && !config.screenshotPath && config.screenshotAfterFrames === undefined) {
    try { window.attachSplash(new SplashScreen(window, surface)); }
    catch (e) { log.warn("platform-native", `splash unavailable: ${e}`); }
  }
  mark("splash");

  // 6b. Click synthesis lives in NativeWindow.dispatchInputEvent (DD_EVENT_
  // MOUSEBUTTONUP → click/dblclick with proper click counting). Do NOT
  // synthesize or forward pointer events here — dispatchInputEvent already
  // delivers them to the surface, and a second synthesis double-fires
  // `click` on surface listeners.

  // 6c. Install the `downdraft` bridge — the single-process HostAPI
  // implementation. The lazy accessor in app/main picks it up whenever
  // `startApp()` (or app code) first touches `downdraft.*`.
  // Services worker owns FileSaveStore + the SQLite import cache so save
  // serialization and sync sqlite calls stay off the frame thread. Same
  // process shape the plugin sandbox will use. Spawned in step 2e — its
  // init overlapped the adapter/device wait.
  let services: HostServices | null;
  try {
    services = await servicesPromise;
  } catch (e) {
    // createWorkerServices' internal dynamic import rejects when the runner
    // closed mid-wait — supersession, not a services failure.
    if (hostBootSuperseded()) await bailSuperseded("services");
    throw e;
  }
  mark("services");
  await liveOrBail("services");
  partial.services = services;
  // 6c-2. Controller backend — optional downdraft_controller cdylib (gilrs).
  //   Owns the 'controller-devices' SAB channel; ControllerLib picks the buffer
  //   up via globalThis.__ddController. Absent library / gilrs failure → null,
  //   controller support just isn't available. Disabled via DOWNDRAFT_NO_CONTROLLER.
  let controllerDestroyFn: (() => void) | null = null;
  const controller = process.env.DOWNDRAFT_NO_CONTROLLER !== "1" ? initNativeController() : null;
  if (controller) {
    (globalThis as any).__ddController = controller;
    let stopEnrich: (() => void) | null = null;
    void startControllerEnrichment(controller.sab).then((stop) => { stopEnrich = stop; });
    controllerDestroyFn = () => { stopEnrich?.(); controller.destroy(); };
    partial.controller = controller;
    partial.controllerDestroy = controllerDestroyFn;
  }

  // 6c-3. OS keychain — optional downdraft_secrets cdylib (keyring). Exposed
  //   as globalThis.__ddSecrets so engine/worker code can reach it without
  //   importing platform-native; null when no credential backend exists.
  const secrets = process.env.DOWNDRAFT_NO_SECRETS !== "1" ? initNativeSecrets() : null;
  if (secrets) {
    (globalThis as any).__ddSecrets = secrets;
    partial.secrets = secrets;
  }
  mark("controller+secrets");

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
  partial.bridge = bridge;
  if (bridge) {
    (globalThis as any).downdraft = bridge;
    // App code reads `globalThis.downdraft` too (e.g. renderer factories that
    // check `globalThis.downdraft?.deterministic`) — mirror it on the polyfill.
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
  let mcp: NativeMcpServer | null = null;
  if (mcpEnabled && bridge) {
    try {
      mcp = await (await import("./mcp/native-mcp")).startNativeMcpServer(bridge, {
        ...mcpOpts,
        artifactDir: mcpOpts.artifactDir ?? join(resolveNativeUserDataDir(config.appId!), "debug-artifacts"),
      });
    } catch (e) {
      // The dynamic import routes through the ModuleRunner that evaluated
      // this module — a restart that closed it mid-boot surfaces here as
      // "Vite module runner has been closed". Bail through rollback, not
      // the entry's fatal handler.
      if (hostBootSuperseded()) await bailSuperseded("mcp");
      throw e;
    }
    partial.mcp = mcp;
  }
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
    gpu: activeGpu,
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
      // Re-entrant: the app entry's finally and the dev supervisor both call
      // this on window close — a second pass would double-release the boxed
      // instance/device handles (use-after-free in the shim).
      if (host.destroyed) return;
      host.destroyed = true;
      // Clean teardown isn't a GPU crash — disarm the boot sentinel.
      gpuPlan?.markHealthy();
      // Sync kill-switch for attached worker views: mark every shared-device
      // cell set dead so workers stop *starting* FFI calls on handles we're
      // about to free. The broker's retire() writes the same cells (it also
      // drains attached views asynchronously — the event loop is still live
      // here so workers can observe the request before the process exits;
      // the dev supervisor additionally runs retireAllSharedDevices first).
      void gpuShare.retire();
      markAllSharedDevicesDead();
      void mcp?.stop();
      controllerDestroyFn?.();
      delete (globalThis as any).__ddController;
      delete (globalThis as any).__ddSecrets;
      bridge?.dispose();
      window.destroy();
      // GPU teardown, strictly after window.destroy() released the surface:
      // device first — destroy() marks every SharedArrayBuffer view dead
      // (markDeviceLost) so attached workers stop issuing FFI calls against
      // it — then the instance, so late-arriving finalizer polls still have
      // a live pump target until the very end.
      try { device.destroy(); } catch { /* best-effort */ }
      // If destroy() leaked the device because workers are still attached, a
      // worker may also be mid-call inside wgpu_shim_process_events, which
      // derefs the instance box directly — freeing it here would dangle that
      // borrow. Leak the instance alongside; the SAB-dead views still can't
      // start new calls.
      if (!device.nativeHandlesLeaked) {
        try { wgpu.wgpu_shim_release_instance(gpu.getInstancePtr()); } catch { /* best-effort */ }
      }
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
  // The live host owns teardown from here — a throw in the tail below must
  // not run destroyPartial over a host the next generation may adopt.
  partialActive = false;
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
