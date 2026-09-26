// ============================================================================
// main.mjs — Minimal Electron main process for the pixi-polyfill browser
// reference renderer.
//
// Applies the same WebGPU command-line switches the engine uses (swiftshader
// for software WebGPU, or hardware GPU otherwise), creates a hidden
// BrowserWindow, and loads the harness URL passed via HARNESS_URL.
//
// Launched by Playwright's _electron support (see browser/render.ts). The
// renderer page (page.html + entry.js) signals readiness via
// `window.__PIXI_READY__`; Playwright then screenshots the canvas region.
// ============================================================================

import { app, BrowserWindow } from "electron";

// ── WebGPU switches (must be applied before app.whenReady) ──
const useSwiftshader = process.env.DOWNDRAFT_GPU === "swiftshader";

const switches = [
  ["enable-unsafe-webgpu"],
  ["ignore-gpu-blocklist"],
  ["enable-gpu-rasterization"],
  ["enable-zero-copy"],
];
if (useSwiftshader) {
  switches.push(
    ["enable-unsafe-swiftshader"],
    ["use-vulkan", "swiftshader"],
    ["use-angle", "swiftshader"],
    ["use-webgpu-adapter", "swiftshader"],
    ["enable-features", "Vulkan,UseSkiaRenderer"],
    ["disable-vulkan-surface"],
    ["ozone-platform-hint", "auto"],
    ["disable-gpu-sandbox"],
  );
} else {
  // Hardware GPU (Linux): force NVIDIA Vulkan ICD to avoid llvmpipe fallback.
  if (process.platform === "linux") {
    process.env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
  }
  switches.push(
    ["enable-features", "Vulkan,UseSkiaRenderer"],
    ["ozone-platform-hint", "auto"],
    ["disable-gpu-sandbox"],
  );
}
switches.forEach(([name, value]) => {
  app.commandLine.appendSwitch(name, value);
});

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:0/";
const WIN_W = parseInt(process.env.HARNESS_W ?? "1024", 10);
const WIN_H = parseInt(process.env.HARNESS_H ?? "1024", 10);

async function createWindow() {
  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: true, // WebGPU canvas needs a visible compositor to render
    webPreferences: {
      sandbox: false, // required for WebGPU + SharedArrayBuffer
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  await win.loadURL(HARNESS_URL);
}

app.whenReady().then(createWindow).catch((e) => {
  console.error("[electron-main] failed:", e);
  app.quit(1);
});

app.on("window-all-closed", () => app.quit());
