// ============================================================================
// early-host.ts — slim early boot for the dev shell
//
// The biggest perceived-boot cost under `draft dev` is the ModuleRunner
// transform of the module graph — seconds before createNativeHost() can even
// start, with no window on screen. This module imports ONLY the window + wgpu
// slice (no bridge/services/mcp/polyfills), so its graph transforms in a
// fraction of that time:
//
//   1. window maps + event loop pumps  →  WM sees a live app immediately
//   2. adapter + device resolve on the async FFI path (JS thread stays free)
//   3. surface configures + splash attaches → first presented frame early
//   4. parts land on globalThis.__ddEarlyHost; the entry's OWN
//      createNativeHost() call awaits __ddEarlyHostPromise and adopts them —
//      exactly one createNativeHost call, zero duplicate windows/devices.
//
// Identity reconciliation (title/size/focus) happens in createNativeHost's
// adoption path — this file only knows downdraft.config.json's "native" block.
// ============================================================================

import { acquireSingleInstanceLock } from "../bridge/singleton-lock";
import { NativeWindow } from "../window/native-window";
import { SplashScreen } from "../window/splash-screen";
// wgpu-device + device-request stay DYNAMIC — they're the heavy end of the
// shim graph, and the whole point of this module is that the window maps
// before that graph finishes transforming. See bootEarlyHost below.
import type { WgpuAdapter, WgpuDevice, WgpuGPU } from "../gpu/wgpu-device";

export interface EarlyHostWindowConfig {
  title: string;
  width?: number;
  height?: number;
  focused?: boolean;
}

/** The pieces createNativeHost() may adopt instead of rebuilding. */
export interface EarlyHostParts {
  window: NativeWindow;
  gpu: WgpuGPU;
  adapter: WgpuAdapter | null;
  device: WgpuDevice | null;
  /** True when the surface ctx was configured + splash attached — the host
   *  skips its own configure when adopting. */
  surfaceConfigured: boolean;
}

/**
 * Boot the slim slice and stash the parts on globalThis.__ddEarlyHost.
 * Never throws — on failure returns null (and destroys any window it made)
 * so the entry's createNativeHost() falls back to a full fresh build.
 */
export async function bootEarlyHost(cfg: {
  window: EarlyHostWindowConfig;
  appId?: string;
  splash?: boolean;
}): Promise<EarlyHostParts | null> {
  // Single-instance BEFORE the window: a refused second instance must exit
  // without ever mapping one (an orphan window + a wedged process.exit was
  // the old failure shape). createNativeHost re-acquires — same PID is a
  // no-op reclaim.
  const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";
  if (cfg.appId && !deterministic && !acquireSingleInstanceLock(cfg.appId)) {
    return null;
  }
  let window: NativeWindow | null = null;
  try {
    window = new NativeWindow({
      title: cfg.window.title,
      width: cfg.window.width ?? 1280,
      height: cfg.window.height ?? 720,
      focused: cfg.window.focused,
    });
    const surface = window.getSurface();
    (globalThis as any).__nativeWindow = window;

    // Pump the event loop NOW — the window responds to the WM while the GPU
    // wait + remaining transforms run, instead of sitting dead-mapped.
    window.start();

    // The window is already live; only now pull the wgpu-device graph —
    // its transform overlaps the WM-visible window instead of blocking it.
    const { WgpuGPU } = await import("../gpu/wgpu-device");
    const { computeDeviceDescriptor } = await import("../gpu/device-request");
    const gpu = new WgpuGPU();
    (globalThis as any).__wgpuInstancePtr = gpu.getInstancePtr();

    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = adapter
      ? await adapter.requestDevice(computeDeviceDescriptor(adapter))
      : null;

    let surfaceConfigured = false;
    if (device) {
      const ctx = surface.getContext("webgpu")!;
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device: device as unknown as GPUDevice, format, usage: 0x0010 | 0x0002 | 0x0001 });
      surfaceConfigured = true;
      if (cfg.splash !== false) {
        try { window.attachSplash(new SplashScreen(window, surface)); } catch { /* best-effort */ }
      }
    }

    const parts: EarlyHostParts = { window, gpu, adapter, device, surfaceConfigured };
    (globalThis as any).__ddEarlyHost = parts;
    return parts;
  } catch {
    try { window?.destroy(); } catch { /* best-effort */ }
    return null;
  }
}
