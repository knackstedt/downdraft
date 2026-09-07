// ============================================================================
// native-entry.ts — Bun-native entry point for to-the-ocean
//
// Replaces Electron + Vite + browser with:
//   - createNativeHost() for window + GPU + polyfills
//   - Direct WebGPURenderer + SimWebWorker instantiation
//   - No UI (PixiUI, React, DOM overlay all skipped)
//   - Real-time animation loop with SDL event polling
//   - Screenshot capture via F12 or on exit
//
// Run: bun run games/to-the-ocean/src/native-entry.ts
// ============================================================================

import { createNativeHost } from "@downdraft/platform-native";
import { writeFileSync } from "node:fs";
import { encodePNG } from "../../../packages/platform-native/src/screenshot/screenshot";

// These imports use tsconfig path aliases which Bun resolves natively
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { NativeHud } from "./native-hud";

const WIDTH = 1280;
const HEIGHT = 720;

async function main() {
  console.log("[native-entry] Creating native host...");
  const host = await createNativeHost({
    window: { title: "To The Ocean — Native (Bun + wgpu-native)", width: WIDTH, height: HEIGHT },
  });

  const { surface, device, window } = host;
  console.log("[native-entry] Native host ready");

  // ── Create sim worker ──
  console.log("[native-entry] Creating sim worker...");
  const sim = new SimWebWorker();
  const simSAB = sim.getSimBuffer();
  const inputSAB = sim.getInputBuffer();
  const waterSAB = sim.getWaterBuffer();
  const boatSAB = sim.getBoatBuffer();

  // ── Create renderer ──
  console.log("[native-entry] Creating WebGPU renderer...");
  const renderer = new WebGPURenderer(surface as any);

  // ── Initialize renderer ──
  console.log("[native-entry] Initializing renderer...");
  const initSuccess = await renderer.init();
  if (!initSuccess) {
    console.error("[native-entry] Renderer init failed");
    host.destroy();
    process.exit(1);
  }
  console.log("[native-entry] Renderer initialized");

  // ── Start sim worker ──
  console.log("[native-entry] Starting sim worker...");
  const simConfig: SimWebWorkerConfig = {
    seed: 12345,
    gamemode: 0,
    rules: {},
    isDev: false,
  };
  await sim.start(simConfig);
  console.log("[native-entry] Sim worker started");

  // ── Add player ──
  sim.addPlayer(0, "Player 1");
  console.log("[native-entry] Player added");

  // ── Wire buffers to renderer ──
  (renderer as any).setBuffers(simSAB, waterSAB, inputSAB, boatSAB);
  console.log("[native-entry] Buffers wired");

  // ── Set up input listeners ──
  // This wires keyboard/mouse events from the global window/canvas polyfills
  // to the renderer's input handler (pointer lock, key tracking, mouse delta).
  (renderer as any).setupInputListeners?.();
  // Input is grabbed at the SDL level on window creation. Set pointer lock
  // state so the input handler knows it's locked and processes mouse delta.
  const canvas = surface as any;
  canvas.requestPointerLock();
  console.log("[native-entry] Input listeners set up");

  // ── Set up native HUD (IMUI) ──
  const uiRoot = renderer.getUIRoot?.();
  const uiInputRouter = renderer.getUIInputRouter?.();
  let hud: NativeHud | null = null;
  if (uiRoot && uiInputRouter) {
    hud = new NativeHud(uiRoot, uiInputRouter);
    // Wire the sim reader so the HUD can display live game state
    const simReader = renderer.getSimReader?.() ?? (renderer as any).simReader;
    if (simReader) hud.setSimReader(simReader);
    renderer.markUILayoutDirty?.();
    console.log("[native-entry] Native HUD created");
  } else {
    console.warn("[native-entry] UI root or input router not available — HUD disabled");
  }
  // Expose exit hook for the HUD's exit button (wired after running is declared)

  // ── Wait for LUTs to load ──
  try {
    await (renderer as any).getLUTReady?.();
    console.log("[native-entry] LUTs ready");
  } catch (e) {
    console.warn("[native-entry] LUT loading failed (non-fatal):", e);
  }

  // ── Real-time render loop ──
  console.log("[native-entry] Starting real-time render loop (ESC or close window to exit, F12 for screenshot)...");

  let frameCount = 0;
  let running = true;
  let lastFpsTime = performance.now();
  let fpsFrameCount = 0;
  let currentFps = 0;
  let screenshotCaptured = false;
  let screenshotPath = "./to-the-ocean-native.png";

  // Wire the exit hook now that `running` is in scope
  (globalThis as any).__nativeExit = () => { running = false; };

  // Listen for window close
  window.addEventListener("close", () => {
    console.log("[native-entry] Window close requested");
    running = false;
  });

  // Listen for keydown to handle ESC and F12
  // ESC: release input grab and quit.
  // F12: capture screenshot.
  window.addEventListener("keydown", (event: any) => {
    const key = event.key;
    if (key === "Escape") {
      console.log("[native-entry] ESC pressed — exiting");
      running = false;
    } else if (key === "F12") {
      captureScreenshotNow();
    }
  });

  // Screenshot capture function (can be triggered by F12)
  function captureScreenshotNow(): void {
    try {
      const rendererDevice = (renderer as any).getDevice?.() ?? (renderer as any).device ?? device;
      const format = (renderer as any).getFormat?.() ?? (renderer as any).format ?? "bgra8unorm";
      const bytesPerPixel = 4;
      const bytesPerRow = Math.ceil((WIDTH * bytesPerPixel) / 256) * 256;
      const paddedBufferSize = bytesPerRow * HEIGHT;
      const screenshotBuffer = rendererDevice.createBuffer({
        size: paddedBufferSize,
        usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
      });

      // Set up the screenshot callback to copy the surface texture before submit
      (renderer as any).suppressPresent = true;
      (renderer as any).screenshotCallback = (encoder: any) => {
        const ctx = surface.getContext("webgpu")!;
        const texture = ctx.getCurrentTexture();
        if (texture) {
          (encoder as any).copyTextureToBuffer(
            { texture },
            { buffer: screenshotBuffer, layout: { offset: 0, bytesPerRow, rowsPerImage: HEIGHT } },
            { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          );
        }
      };

      // Render one frame with the screenshot copy encoded
      (renderer as any).renderOneFrame?.();
      (renderer as any).suppressPresent = false;
      (renderer as any).screenshotCallback = null;

      // Map the buffer and read back the pixels
      screenshotBuffer.mapAsync(1, 0, paddedBufferSize); // 1 = READ
      const mappedRange = screenshotBuffer.getMappedRange(0, paddedBufferSize);
      const pixels = new Uint8Array(mappedRange);

      const isBGRA = format === "bgra8unorm" || format === "bgra8unorm-srgb";
      const unpadded = new Uint8Array(WIDTH * HEIGHT * bytesPerPixel);
      for (let y = 0; y < HEIGHT; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * WIDTH * bytesPerPixel;
        for (let x = 0; x < WIDTH; x++) {
          const src = srcOffset + x * 4;
          const dst = dstOffset + x * 4;
          if (isBGRA) {
            unpadded[dst] = pixels[src + 2];     // R ← B
            unpadded[dst + 1] = pixels[src + 1]; // G ← G
            unpadded[dst + 2] = pixels[src];     // B ← R
            unpadded[dst + 3] = pixels[src + 3]; // A ← A
          } else {
            unpadded[dst] = pixels[src];
            unpadded[dst + 1] = pixels[src + 1];
            unpadded[dst + 2] = pixels[src + 2];
            unpadded[dst + 3] = pixels[src + 3];
          }
        }
      }
      screenshotBuffer.unmap();
      screenshotBuffer.destroy();

      const png = encodePNG(WIDTH, HEIGHT, unpadded);
      writeFileSync(screenshotPath, png);
      console.log(`[screenshot] Saved ${WIDTH}x${HEIGHT} to ${screenshotPath} (${png.length} bytes)`);

      // Present the surface now that the copy is done
      const ctx = surface.getContext("webgpu")!;
      if ((ctx as any).present) (ctx as any).present();
    } catch (e) {
      console.error("[screenshot] Capture failed:", e);
    }
  }

  // The NativeWindow's runLoop already polls SDL events and dispatches them
  // via addEventListener. It also processes wgpu events. We just need to
  // drive the render loop here. Using setImmediate to yield to the event loop
  // between frames so SDL events get processed — no artificial FPS cap.
  function renderLoop() {
    if (!running) {
      console.log(`[native-entry] Render loop ended after ${frameCount} frames`);
      cleanup();
      return;
    }

    try {
      (renderer as any).renderOneFrame?.();
      frameCount++;
      fpsFrameCount++;

      // Update HUD with current game state
      if (hud) {
        hud.state.fps = currentFps;
        hud.state.frameCount = frameCount;
        hud.update(0.016);
      }

      // Auto-capture a screenshot after a few frames for verification
      if (frameCount === 120 && !screenshotCaptured) {
        screenshotCaptured = true;
        captureScreenshotNow();
        console.log("[native-entry] Auto-screenshot captured for HUD verification");
      }

      // Log FPS every 2 seconds
      const now = performance.now();
      if (now - lastFpsTime >= 2000) {
        currentFps = Math.round((fpsFrameCount * 1000) / (now - lastFpsTime));
        if (hud) hud.state.fps = currentFps;
        console.log(`[native-entry] Frame ${frameCount} — ${currentFps} FPS`);
        lastFpsTime = now;
        fpsFrameCount = 0;
      }
    } catch (e) {
      console.error(`[native-entry] Render error on frame ${frameCount}:`, e);
      running = false;
      cleanup();
      return;
    }

    // Yield to the event loop so SDL events (input, close, etc.) get processed,
    // then immediately render the next frame — uncapped framerate.
    setImmediate(renderLoop);
  }

  function cleanup() {
    console.log("[native-entry] Cleaning up...");
    try {
      // Capture a final screenshot
      captureScreenshotNow();
    } catch {}
    try {
      sim.stop?.();
    } catch {}
    host.destroy();
    console.log("[native-entry] Cleaned up");
    process.exit(0);
  }

  // Start the render loop
  renderLoop();
}

main().catch((err) => {
  console.error("[native-entry] Fatal error:", err);
  process.exit(1);
});
