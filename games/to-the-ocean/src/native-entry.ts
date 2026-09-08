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

import { createLogger, setThreadTag } from "@downdraft/core";
import { NativePixiUiHost } from "@downdraft/library-pixi-ui-native";
import { createNativeHost } from "@downdraft/platform-native";
import { writeFileSync } from "node:fs";
import { getFreeTypeTextRenderer } from "../../../packages/platform-native/src/image/native-image";
import { encodePNG } from "../../../packages/platform-native/src/screenshot/screenshot";

// These imports use tsconfig path aliases which Bun resolves natively
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { NativeHud } from "./native-hud";
import { NativeOceanDataBridge } from "./pixi/native-data-bridge";
import { NativeInputRouter } from "./pixi/native-input-router";
import { createNativeOceanScene, type NativeOceanScene } from "./pixi/native-scene";
import { useGameStore } from "./stores/game-store";

setThreadTag("R0");
const log = createLogger();

const WIDTH = 1280;
const HEIGHT = 720;

async function main() {
  log.info("native-entry", "Creating native host...");
  const host = await createNativeHost({
    window: { title: "To The Ocean — Native (Bun + wgpu-native)", width: WIDTH, height: HEIGHT },
  });

  const { surface, device, window } = host;
  log.info("native-entry", "Native host ready");

  // ── Create sim worker ──
  log.info("native-entry", "Creating sim worker...");
  const sim = new SimWebWorker();
  const simSAB = sim.getSimBuffer();
  const inputSAB = sim.getInputBuffer();
  const waterSAB = sim.getWaterBuffer();
  const boatSAB = sim.getBoatBuffer();

  // ── Create renderer ──
  log.info("native-entry", "Creating WebGPU renderer...");
  const renderer = new WebGPURenderer(surface as any);

  // ── Initialize renderer ──
  log.info("native-entry", "Initializing renderer...");
  const initSuccess = await renderer.init();
  if (!initSuccess) {
    log.error("native-entry", "Renderer init failed");
    host.destroy();
    process.exit(1);
  }
  log.info("native-entry", "Renderer initialized");

  // ── Wire FreeType text renderer into the IMUI text atlas ──
  // This bypasses the Canvas2D polyfill and renders text directly via
  // FreeType, producing crisp anti-aliased TrueType text.
  const ftRenderer = getFreeTypeTextRenderer();
  if (ftRenderer) {
    const uiRenderer = (renderer as any).getUIRenderer?.();
    const textCache = uiRenderer?.getTextCache?.();
    if (textCache) {
      textCache.setDirectRenderer(ftRenderer);
      log.info("native-entry", "FreeType text renderer wired into IMUI");
    } else {
      log.warn("native-entry", "Could not find TextAtlasCache — FreeType text not wired");
    }
  }

  // ── Native PixiJS UI (in-process, shared wgpu-native device) ──
  // PixiJS v8 WebGPU runs on the renderer's own GPUDevice (the same device the
  // 3D pipeline uses), rendering the UI into a GPUTexture the renderer blits
  // over the frame. No Chromium, no worker. This is the native replacement
  // for the browser pixi-ui worker + OffscreenCanvas path.
  const rendererDevice = renderer.getDevice?.() ?? (renderer as any).device ?? device;
  const rendererAdapter = renderer.getAdapter?.() ?? (renderer as any).adapter ?? host.adapter;
  const pixiUi = new NativePixiUiHost({
    device: rendererDevice,
    adapter: rendererAdapter,
    targetFormat: "bgra8unorm",
    width: WIDTH,
    height: HEIGHT,
  });
  try {
    await pixiUi.ready;
    log.info("native-entry", "PixiJS Application initialized on shared wgpu-native device");
  } catch (e) {
    log.error("native-entry", `PixiJS init failed (UI disabled): ${e}`);
  }
  // ── Native data bridge: sim reader + game store → worker-store ──
  // Feeds the reactive store that @pixi/react components consume via
  // useWorkerState, and routes UI actions back to the store/simBridge.
  // Created before the scene so the scene's postAction can reference it.
  const dataBridge = new NativeOceanDataBridge({
    renderer,
    canvasW: WIDTH,
    canvasH: HEIGHT,
  });
  dataBridge.start();
  log.info("native-entry", "Native data bridge started");

  // ── Native @pixi/react scene (reuses the browser OceanApp) ──
  // The NativeOceanDataBridge feeds state into worker-store; React re-renders
  // automatically via useWorkerState. This replaces the Phase 2 smoke-test.
  let oceanScene: NativeOceanScene | null = null;
  if (pixiUi && !pixiUi["disposed"]) {
    try {
      oceanScene = await createNativeOceanScene({
        app: pixiUi.app,
        width: WIDTH,
        height: HEIGHT,
        fontScale: 1,
        postAction: (action: any) => dataBridge.handleAction(action),
      });
      renderer.nativePixiUi = pixiUi;
      log.info("native-entry", "Native OceanApp scene attached");
    } catch (e) {
      log.error("native-entry", `Native scene setup failed: ${e}`);
    }
  }

  // ── Native input router: SDL mouse → PixiJS EventSystem when menus open ──
  // Intercepts mouse events on the canvas (capture phase) before the game's
  // input handler. When a menu/overlay is open and the click hits a PixiJS
  // element, the event is routed to PixiJS and stopped from reaching the game.
  let inputRouter: NativeInputRouter | null = null;
  if (pixiUi && !pixiUi["disposed"]) {
    try {
      inputRouter = new NativeInputRouter(pixiUi, WIDTH, HEIGHT);
      const surfaceEl = surface as any;
      // Capture-phase listeners: run before the game's input handler (bubble).
      surfaceEl.addEventListener("mousedown", (e: any) => {
        const mods = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
        if (inputRouter!.handlePointerDown(e.clientX, e.clientY, e.button, mods)) {
          e.stopPropagation?.();
          e.preventDefault?.();
        }
      }, true);
      surfaceEl.addEventListener("mousemove", (e: any) => {
        const mods = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
        if (inputRouter!.handlePointerMove(e.clientX, e.clientY, e.button, mods)) {
          e.stopPropagation?.();
        }
      }, true);
      surfaceEl.addEventListener("mouseup", (e: any) => {
        const mods = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
        if (inputRouter!.handlePointerUp(e.clientX, e.clientY, e.button, mods)) {
          e.stopPropagation?.();
          e.preventDefault?.();
        }
      }, true);
      log.info("native-entry", "Native input router attached");
    } catch (e) {
      log.error("native-entry", `Input router setup failed: ${e}`);
    }
  }

  // ── Start sim worker ──
  log.info("native-entry", "Starting sim worker...");
  const simConfig: SimWebWorkerConfig = {
    seed: 12345,
    gamemode: 0,
    rules: {},
    isDev: false,
  };
  await sim.start(simConfig);
  log.info("native-entry", "Sim worker started");

  // ── Add player ──
  sim.addPlayer(0, "Player 1");
  log.info("native-entry", "Player added");

  // ── Wire buffers to renderer ──
  (renderer as any).setBuffers(simSAB, waterSAB, inputSAB, boatSAB);
  log.info("native-entry", "Buffers wired");

  // ── Set up input listeners ──
  // This wires keyboard/mouse events from the global window/canvas polyfills
  // to the renderer's input handler (pointer lock, key tracking, mouse delta).
  (renderer as any).setupInputListeners?.();
  // Mark the input handler as native mode — skips builder wheel, pointer lock exit on right-click
  const ih = (renderer as any).inputHandler;
  if (ih) ih.nativeMode = true;
  // Do NOT auto-request pointer lock — let the user click the window to
  // engage mouse look. Auto-grabbing steals focus from the user's IDE/terminal.
  const canvas = surface as any;
  // The start island for seed 12345 is at chunk (0,1) = positive Z.
  // The camera convention: heading 0 = -Z, heading π = +Z.
  // We'll inject the correct yaw after the first frame when we can read
  // the sim's initial heading. For now, set a flag.
  let needsInitialYaw = true;
  log.info("native-entry", "Input listeners set up");

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
    // Critical: set the UI renderer's screen size so the text/quad shaders
    // convert pixel coordinates to NDC correctly. Without this, screenSize
    // defaults to (0,0) and all text renders at NaN/Inf clip positions.
    renderer.refreshUIScreenSize?.();
    log.info("native-entry", "Native HUD created");
  } else {
    log.warn("native-entry", "UI root or input router not available — HUD disabled");
  }

  // ── Wire renderer into the game store so toggle methods work ──
  // The game store's toggleInventory/toggleCraftMenu/etc. call
  // renderer.lockPointer() and document.exitPointerLock() — both are safe
  // in native mode (exitPointerLock is optional-chained).
  useGameStore.getState().setRenderer(renderer);
  useGameStore.getState().setReady(true);
  useGameStore.getState().setSimReady(true); // sim worker started below
  useGameStore.getState().setLutReady(true); // LUTs loaded below

  // ── Wait for LUTs to load ──
  try {
    await (renderer as any).getLUTReady?.();
    log.info("native-entry", "LUTs ready");
  } catch (e) {
    log.warn("native-entry", `LUT loading failed (non-fatal): ${e}`);
  }

  // ── Real-time render loop ──
  log.info("native-entry", "Starting real-time render loop (close window or Exit button to quit, F12 for screenshot)...");

  let frameCount = 0;
  let running = true;
  let lastFpsTime = performance.now();
  let fpsFrameCount = 0;
  let currentFps = 0;
  let screenshotCaptured = false;
  let screenshotPath = "./to-the-ocean-native.png";

  // Wire the exit hook now that `running` is in scope
  (globalThis as any).__nativeExit = () => { running = false; };
  (globalThis as any).__nativeScreenshot = () => { captureScreenshotNow(); };

  // Listen for window close
  window.addEventListener("close", () => {
    log.info("native-entry", "Window close requested");
    running = false;
  });

  // ── Keyboard shortcuts ──
  // In the browser version, the PixiUI worker handles menu toggles via UI
  // buttons. In native mode, we wire keyboard shortcuts directly to the game
  // store's toggle methods. The NativeHud reads the store state to show/hide
  // the corresponding IMUI panels.
  window.addEventListener("keydown", (event: any) => {
    const key = event.key;
    const keyCode = event.keyCode;
    if (event.repeat) return;

    if (key === "Escape") {
      const gs = useGameStore.getState();
      // If settings is open, ESC goes back to pause menu
      if (gs.showSettings) {
        gs.toggleSettings();
      } else if (gs.showInventory || gs.showCraftMenu || gs.showMap || gs.showBuildMenu) {
        // Close any open overlay first
        if (gs.showInventory) gs.toggleInventory();
        if (gs.showCraftMenu) gs.toggleCraftMenu();
        if (gs.showMap) gs.toggleMap();
        if (gs.showBuildMenu) gs.toggleBuildMenu();
      } else {
        gs.togglePauseMenu();
      }
      // Release pointer lock when any overlay opens so UI is clickable
      const anyOverlay = gs.showPauseMenu || gs.showSettings || gs.showInventory ||
        gs.showCraftMenu || gs.showMap || gs.showBuildMenu;
      if (anyOverlay && document.pointerLockElement) {
        document.exitPointerLock?.();
      }
      renderer.markUILayoutDirty?.();
    } else if (key === "F12") {
      captureScreenshotNow();
    } else if (keyCode === 73) { // I → Inventory
      useGameStore.getState().toggleInventory();
      renderer.markUILayoutDirty?.();
    } else if (keyCode === 9) { // Tab → Crafting
      useGameStore.getState().toggleCraftMenu();
      renderer.markUILayoutDirty?.();
    } else if (keyCode === 77) { // M → Map
      useGameStore.getState().toggleMap();
      renderer.markUILayoutDirty?.();
    } else if (keyCode === 66) { // B → Build menu
      useGameStore.getState().toggleBuildMenu();
      renderer.markUILayoutDirty?.();
    } else if (keyCode === 67) { // C → Character customization
      useGameStore.getState().toggleCharacterCustomization();
      renderer.markUILayoutDirty?.();
    } else if (keyCode === 80) { // P → Pause menu
      useGameStore.getState().togglePauseMenu();
      renderer.markUILayoutDirty?.();
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
      log.info("screenshot", `Saved ${WIDTH}x${HEIGHT} to ${screenshotPath} (${png.length} bytes)`);

      // Present the surface now that the copy is done
      const ctx = surface.getContext("webgpu")!;
      if ((ctx as any).present) (ctx as any).present();
    } catch (e) {
      log.error("screenshot", `Capture failed: ${e}`);
    }
  }

  // The NativeWindow's runLoop already polls SDL events and dispatches them
  // via addEventListener. It also processes wgpu events. We just need to
  // drive the render loop here. Using setImmediate to yield to the event loop
  // between frames so SDL events get processed — no artificial FPS cap.
  function renderLoop() {
    if (!running) {
      log.info("native-entry", `Render loop ended after ${frameCount} frames`);
      cleanup();
      return;
    }

    try {
      // Inject initial yaw to face the island (positive Z) after first frame
      if (needsInitialYaw) {
        const simReader = (renderer as any).getSimReader?.() ?? (renderer as any).simReader;
        if (simReader?.isValid()) {
          const slot = simReader.getPlayerSlot(0);
          if (slot) {
            const currentHeading = slot.f32[3] ?? 0; // PLR.HEADING
            // Camera convention: heading 0 = -Z, heading π = +Z
            // Island is at +Z, so we want lookHeading = π
            const targetHeading = Math.PI;
            // Directly set the camera system's look heading instead of using
            // mouse delta injection (which drifts due to SDL relative mouse mode).
            // We set lookHeading and mark it as synced (lookSyncedTick >= 0) so
            // updateLook() doesn't reinitialize from the sim's heading.
            const camSys = (renderer as any).cameraSystem;
            if (camSys) {
              camSys.lookHeading = targetHeading;
              camSys.lookPitch = 0;
              camSys.lookSyncedTick = 0; // prevent reinitialization from sabHeading
              log.info("native-entry", `Initial yaw set: current=${currentHeading.toFixed(2)} target=${targetHeading.toFixed(2)} lookHeading=${camSys.getLookHeading?.().toFixed(2)}`);
            }
          }
        }
        needsInitialYaw = false;
      }
      // Feed the native data bridge (sim reader + store → worker-store) before
      // the frame renders so the UI sees fresh state.
      try { dataBridge.update(); } catch (e) { log.error("native-entry", `dataBridge.update failed: ${e}`); }
      try { oceanScene?.update(); } catch (e) { log.error("native-entry", `oceanScene.update failed: ${e}`); }
      (renderer as any).renderOneFrame?.();
      frameCount++;
      fpsFrameCount++;

      // Update HUD with current game state
      if (hud) {
        hud.state.fps = currentFps;
        hud.state.frameCount = frameCount;
        hud.update(0.016);
      }

      // Auto-capture a screenshot after enough frames for mesh generation
      if (frameCount === 600 && !screenshotCaptured) {
        screenshotCaptured = true;
        captureScreenshotNow();
        log.info("native-entry", "Auto-screenshot captured for HUD verification");
      }

      // Log FPS every 2 seconds
      const now = performance.now();
      if (now - lastFpsTime >= 2000) {
        currentFps = Math.round((fpsFrameCount * 1000) / (now - lastFpsTime));
        if (hud) hud.state.fps = currentFps;
        // Debug: check sim state
        const simReader = (renderer as any).getSimReader?.() ?? (renderer as any).simReader;
        if (simReader?.isValid()) {
          const seq = simReader.getSequence();
          const entityCount = simReader.getEntityCount();
          const slot = simReader.getPlayerSlot(0);
          const px = slot?.f32[0] ?? 0, py = slot?.f32[1] ?? 0, pz = slot?.f32[2] ?? 0;
          const heading = slot?.f32[3] ?? 0;
          const camMode = slot?.u32[15] ?? 0; // PLR.CAMERA_MODE
          const camSys = (renderer as any).cameraSystem;
          const camLookHeading = camSys?.getLookHeading?.() ?? -999;
          const camLookPitch = camSys?.getLookPitch?.() ?? -999;
          const camLookSyncedTick = camSys?.lookSyncedTick ?? -999;
          const mdx = ih?.mouseDelta?.dx ?? -999;
          // Count entity types (ENT.TYPE is at u32 index 16)
          let islandCount = 0, portCount = 0, shipCount = 0, playerCount = 0, otherCount = 0;
          const typeCounts: Record<number, number> = {};
          for (let i = 0; i < entityCount; i++) {
            const es = simReader.getEntitySlot(i);
            if (!es) continue;
            const type = es.u32[16]; // ENT.TYPE = 16
            typeCounts[type] = (typeCounts[type] ?? 0) + 1;
            if (type === 16) islandCount++; // EntityType.Island
            else if (type === 17) portCount++; // EntityType.Port
            else if (type === 1 || type === 2) shipCount++; // Ship/SmallCraft
            else if (type === 0) playerCount++; // Player
            else otherCount++;
          }
          // Check island meshes
          const entityRenderer = (renderer as any).entityRenderer;
          const islandRenderer = entityRenderer?.islandTerrainRenderer;
          const islandMeshCount = islandRenderer?.islandMeshes?.size ?? -1;
          const islandChunkMeshCount = islandRenderer?.islandChunkMeshes?.size ?? -1;
          const islandEmptyCount = islandRenderer?.islandEmptyKeys?.size ?? -1;
          const meshPoolFallback = islandRenderer?.meshPool?.isFallback?.() ?? "none";
          // Count actual chunk meshes and in-flight jobs
          let totalChunkMeshes = 0;
          if (islandRenderer?.islandChunkMeshes) {
            for (const m of islandRenderer.islandChunkMeshes.values()) totalChunkMeshes += m.size;
          }
          const inFlightChunks = islandRenderer?.inFlightChunks?.size ?? -1;
          const pendingChunks = islandRenderer?.islandChunkPending?.size ?? -1;
          // Check island entity position
          let islandPos = "none";
          for (let i = 0; i < entityCount; i++) {
            const es = simReader.getEntitySlot(i);
            if (!es) continue;
            if (es.u32[16] === 16) { // EntityType.Island
              islandPos = `(${es.f32[0].toFixed(1)},${es.f32[1].toFixed(1)},${es.f32[2].toFixed(1)}) scale=${es.f32[3].toFixed(1)} chunk=(${es.u32[20]},${es.u32[21]})`;
            }
          }
          const frameTris = (renderer as any)._frameTriangles ?? -1;
          const lastFrameTris = (renderer as any).entityRenderer?.getLastFrameTriangles?.() ?? -1;
          log.info("native-entry", `Frame ${frameCount} — ${currentFps} FPS | simSeq=${seq} entities=${entityCount} (islands=${islandCount} ports=${portCount} ships=${shipCount} players=${playerCount} other=${otherCount}) types=${JSON.stringify(typeCounts)} pos=(${px.toFixed(1)},${py.toFixed(1)},${pz.toFixed(1)}) heading=${heading.toFixed(2)} camMode=${camMode} camLook=${camLookHeading.toFixed(2)} camPitch=${camLookPitch.toFixed(2)} camSyncedTick=${camLookSyncedTick} mdx=${mdx.toFixed(1)} | islandMeshes=${islandMeshCount} chunkMeshes=${islandChunkMeshCount} totalChunkMeshes=${totalChunkMeshes} empty=${islandEmptyCount} inFlight=${inFlightChunks} pending=${pendingChunks} meshPoolFallback=${meshPoolFallback} island=${islandPos} frameTris=${frameTris} entityTris=${lastFrameTris}`);
        } else {
          log.info("native-entry", `Frame ${frameCount} — ${currentFps} FPS | sim invalid`);
        }
        lastFpsTime = now;
        fpsFrameCount = 0;
      }
    } catch (e) {
      log.error("native-entry", `Render error on frame ${frameCount}: ${e}`);
      running = false;
      cleanup();
      return;
    }

    // Yield to the event loop so SDL events (input, close, etc.) get processed,
    // then immediately render the next frame — uncapped framerate.
    setImmediate(renderLoop);
  }

  function cleanup() {
    log.info("native-entry", "Cleaning up...");
    try {
      // Capture a final screenshot
      captureScreenshotNow();
    } catch {}
    try {
      sim.stop?.();
    } catch {}
    try {
      pixiUi?.dispose();
    } catch {}
    try {
      oceanScene?.dispose();
    } catch {}
    try {
      dataBridge.stop();
    } catch {}
    host.destroy();
    log.info("native-entry", "Cleaned up");
    process.exit(0);
  }

  // Start the render loop
  renderLoop();
}

main().catch((err) => {
  log.error("native-entry", `Fatal error: ${err}`);
  process.exit(1);
});
