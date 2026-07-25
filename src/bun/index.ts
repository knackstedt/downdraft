import { defineElectrobunRPC, GpuWindow } from "electrobun";
import type { DownDraftRPC } from "../rpc-schema.ts";

const WIDTH = 1280;
const HEIGHT = 720;
const X = 100;
const Y = 100;
const TITLEBAR_HEIGHT = 38;

const rpc = defineElectrobunRPC<DownDraftRPC, "bun">("bun", {
  handlers: {
    requests: {
      getTelemetry: () => ({ frameTime: 0, p95: 0, p99: 0 }),
      getEntityCount: () => 1,
    },
    messages: {},
  },
});

// GpuWindow: native window with WGPUView for GPU rendering
const gpuWin = new GpuWindow({
  title: "DownDraft Engine",
  frame: { x: X, y: Y, width: WIDTH, height: HEIGHT },
  titleBarStyle: "default",
  transparent: false,
});

gpuWin.show();

// Trigger WGPUView rendering by accessing the native handle
try {
  const handle = gpuWin.wgpuView.getNativeHandle();
  console.log("[DownDraft] WGPUView native handle:", handle);
} catch (e) {
  console.error("[DownDraft] Failed to get WGPU native handle:", e);
}

/* overlay disabled for testing
// BrowserWindow: transparent CEF overlay on top of GpuWindow (offset below titlebar)
const overlayWin = new BrowserWindow({
  title: "DownDraft Overlay",
  frame: { x: X, y: Y + TITLEBAR_HEIGHT, width: WIDTH, height: HEIGHT - TITLEBAR_HEIGHT },
  url: "views://index/index.html",
  preload: null,
  viewsRoot: join(import.meta.dir, "..", "views"),
  renderer: "cef",
  transparent: true,
  titleBarStyle: "hidden",
  rpc,
  navigationRules: null,
  sandbox: false,
});

overlayWin.show();

// Keep overlay on top of GPU window
overlayWin.setAlwaysOnTop(true);
*/

console.log("[DownDraft] GpuWindow only mode (no overlay)");
