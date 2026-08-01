// ============================================================================
// Renderer Entry Point — React app + WebGPU bootstrap
// ============================================================================

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Fonts — statically bundled via @fontsource (woff2/woff embedded in build, no CDN requests)
import "@fontsource/doto/400.css";
import "@fontsource/linefont/400.css";
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/special-elite/400.css";
import "@fontsource/urbanist/400.css";
import "@fontsource/urbanist/700.css";
import "@fontsource/wavefont/400.css";

import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@downdraft/core";
import { PLR } from "@shared/sim-buffer";
import { SimToMainMessage } from "@shared/types";
import { SceneInspector } from "./engine/SceneInspector";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/SimWebWorker";
import { WebGPURenderer } from "./engine/WebGPURenderer";
import { simBridge } from "./simBridge";
import { useDebugStore } from "./stores/debugStore";
import { useGameStore } from "./stores/gameStore";
import { useHotReloadStore } from "./stores/hotReloadStore";
import "./styles/globals.css";

async function bootstrap() {
  const ocean = (window as any).ocean;

  // Render React UI immediately so the loading screen is visible during init
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("No canvas element found — ensure <canvas id='game-canvas'> is in index.html");
    return;
  }

  // Initialize WebGPU renderer
  const renderer = new WebGPURenderer(canvas);
  let isDev = !!(ocean?.isDev) || import.meta.env.DEV === true;

  // Register for sim-ready event from main process (carries isDev flag)
  if (ocean?.onSimReady) {
    ocean.onSimReady((data: any) => {
      if (data?.isDev) {
        isDev = true;
        useGameStore.getState().setIsDev(true);
      }
    });
  }

  // --- Spawn simulation Web Worker in renderer process ---
  // SharedArrayBuffers are shared directly between renderer and worker — zero-copy.
  // No IPC buffer copy loop needed.
  const simWorker = new SimWebWorker();
  const simSAB = simWorker.getSimBuffer();
  const inputSAB = simWorker.getInputBuffer();
  const waterSAB = simWorker.getWaterBuffer();
  const boatSAB = simWorker.getBoatBuffer();

  // Route sim events to the renderer
  simWorker.onEvent((msg: SimToMainMessage) => {
    switch (msg.kind) {
      case "ready":
        console.log("[Renderer] Sim Web Worker ready");
        useGameStore.getState().setSimReady(true);
        break;
      case "error":
        console.error(`[Renderer] Sim error: ${msg.data?.message ?? JSON.stringify(msg.data)}`);
        break;
      case "weather_changed":
        useGameStore.getState().setWeather(msg.data);
        break;
      case "player_died":
        useGameStore.getState().setPlayerDied(msg.data);
        break;
      case "fishing_result":
        if (msg.data?.message) {
          useGameStore.getState().addNotification(
            msg.data.message,
            msg.data.success ? "success" : "warning",
          );
        }
        break;
      case "boat_design_update":
        renderer.setBoatDesign(msg.data.entityId, msg.data.designJson);
        break;
      case "boat_design_remove":
        renderer.removeBoatDesign(msg.data.entityId);
        break;
      case "terrain_deformed":
        if (Array.isArray(msg.data)) {
          console.log(`[Renderer] Received ${msg.data.length} terrain deformations`);
          const er = renderer.getEntityRenderer();
          if (er) {
            for (let i = 0; i < msg.data.length; i++) {
              const d = msg.data[i];
              er.applyTerrainDeformation(
                d.chunkX, d.chunkZ, d.isPort,
                d.worldX, d.worldY, d.worldZ,
                d.entityWorldX, d.entityWorldY, d.entityWorldZ,
                d.radius, d.strength,
              );
            }
          }
        }
        break;
      case "terrain_lod_changed":
        if (Array.isArray(msg.data)) {
          const er = renderer.getEntityRenderer();
          if (er) {
            for (let i = 0; i < msg.data.length; i++) {
              const d = msg.data[i];
              er.handleTerrainLODChange(d.chunkX, d.chunkZ, d.newVoxelSize);
            }
          }
        }
        break;
      case "ship_hold_update":
        useGameStore.getState().setShipHoldData(msg.data);
        break;
      case "gc_stats":
        useDebugStore.getState().updateGCStats(msg.data);
        break;
      case "perf_stats":
        (window as any).__perfMetrics = (window as any).__perfMetrics ?? {};
        (window as any).__perfMetrics[msg.data.process] = msg.data;
        break;
      case "collision_log":
        useDebugStore.getState().setCollisionLog(msg.data);
        break;
      case "saved":
        // Forward save state to main process for DB persistence
        if (ocean && msg.data?.stateJson) {
          ocean.saveGameState(msg.data.slotName, msg.data.stateJson);
        }
        break;
      case "performance":
        // Command results etc. — could be forwarded to debug store if needed
        break;
      case "sim_speed_changed":
        (window as any).__currentSimSpeed = msg.data?.speed ?? 1.0;
        console.log(`[Renderer] Sim speed changed to ${msg.data?.speed}x`);
        break;
    }
  });

  // Start renderer init and sim worker in parallel — avoids 2.2s LUT generation
  // blocking sim worker setup (island spawning, physics field generation, etc.)
  const [rendererSuccess] = await Promise.all([
    renderer.init(),
    simWorker.start({
      seed: 12345,
      gamemode: 0,
      rules: {},
      isDev,
    }),
  ]);
  if (!rendererSuccess) {
    console.error("WebGPU initialization failed");
    return;
  }
  if (isDev) useGameStore.getState().setIsDev(true);

  // Wait for the PBR BRDF LUT to finish generating before starting the render
  // loop and spawning the player. The LUT computation is chunked across frames
  // to avoid blocking the main thread — this shows the loading screen during
  // that time for a smooth startup experience.
  await renderer.getLUTReady();
  useGameStore.getState().setLutReady(true);

  // Add default player
  simWorker.addPlayer(0, "Player 1");

  // Auto-load saved state if available
  if (ocean?.loadGameState) {
    try {
      const savedState = await ocean.loadGameState("autosave");
      if (savedState) {
        await simWorker.load("autosave", savedState);
        console.log("[Renderer] Auto-loaded saved game state");
      }
    } catch {
      console.log("[Renderer] No autosave found, starting fresh game");
    }
  }

  // Restore hot-reload state if pending (renderer was reloaded after sim/engine code change)
  if (sessionStorage.getItem("hot-reload-pending")) {
    sessionStorage.removeItem("hot-reload-pending");
    try {
      if (ocean?.loadGameState) {
        const hotReloadState = await ocean.loadGameState("hot-reload");
        if (hotReloadState) {
          await simWorker.restoreFromState(hotReloadState);
          console.log("[HMR] Restored state after page reload");
          if (ocean.deleteGameState) ocean.deleteGameState("hot-reload");
        }
      }
    } catch (err) {
      console.error(`[HMR] Failed to restore hot-reload state: ${err}. Starting fresh.`);
    }
  }

  // Listen for display refresh rate changes (multi-monitor frame rate fix)
  // Must be registered BEFORE renderer.start() so the initial display info
  // from the main process (sent on did-finish-load) isn't missed.
  try {
    if (ocean?.onDisplayInfo) {
      ocean.onDisplayInfo((data: { refreshRate: number }) => {
        console.log(`[Renderer] Display refresh rate: ${data.refreshRate}Hz`);
        renderer.setFrameRateLimit(data.refreshRate);
      });
    }
    // Query current display info — the did-finish-load push was missed because
    // bootstrap() was still awaiting renderer.init() when it fired.
    if (ocean?.getDisplayInfo) {
      const info = await ocean.getDisplayInfo();
      if (info?.refreshRate > 0) {
        console.log(`[Renderer] Display refresh rate (queried): ${info.refreshRate}Hz`);
        renderer.setFrameRateLimit(info.refreshRate);
      }
    }
  } catch (e) {
    console.warn("[Renderer] onDisplayInfo not available:", e);
  }

  // Set buffers on renderer — same SABs the sim worker writes to (zero-copy)
  renderer.setBuffers(simSAB, waterSAB, inputSAB, boatSAB);
  renderer.setupInputListeners();
  renderer.start();

  // Expose renderer for debugging (frame drop simulator, etc.)
  (window as any).__renderer = renderer;

  // Initialize Scene Inspector for DevTools integration
  const sceneInspector = new SceneInspector();
  sceneInspector.init(renderer);

  // Gizmo mouse interaction handlers on canvas
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (document.pointerLockElement) return;
    const handled = renderer.handleGizmoMouseDown(
      e.clientX, e.clientY,
      canvas.width, canvas.height,
    );
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (renderer.isGizmoDragging()) {
      renderer.handleGizmoMouseMove(
        e.clientX, e.clientY,
        canvas.width, canvas.height,
      );
      e.preventDefault();
    }
  });

  const gizmoMouseUpHandler = () => {
    renderer.handleGizmoMouseUp();
  };
  canvas.addEventListener("mouseup", gizmoMouseUpHandler);
  window.addEventListener("mouseup", gizmoMouseUpHandler);

  // Input is now zero-copy — the sim worker reads the input SAB directly.
  // No IPC round-trip needed. The renderer writes to the shared inputSAB
  // and the sim worker's InputBufferReader reads from the same SharedArrayBuffer.
  renderer.onInputProcessed = () => {
    // No-op: input is written directly to the shared SAB by the renderer's
    // InputBufferWriter. The sim worker reads from the same SharedArrayBuffer.
  };

  // Listen for display scale factor (DPR) changes
  try {
    if (ocean?.onDisplayMetricsChanged) {
      ocean.onDisplayMetricsChanged((data: { scaleFactor: number }) => {
        console.log(`[Renderer] Display scale factor changed: ${data.scaleFactor}`);
        renderer.handleDprChange(data.scaleFactor);
      });
    }
  } catch (e) {
    console.warn("[Renderer] onDisplayMetricsChanged not available:", e);
  }

  // Listen for main process performance stats
  try {
    if (ocean?.onPerfStats) {
      ocean.onPerfStats((data: any) => {
        (window as any).__perfMetrics = (window as any).__perfMetrics ?? {};
        (window as any).__perfMetrics[data.process] = data;
      });
    }
  } catch (e) {
    console.warn("[Renderer] onPerfStats not available:", e);
  }

  // Update store with renderer reference
  useGameStore.getState().setRenderer(renderer);
  useGameStore.getState().setReady(true);

  // Expose simWorker on window for gameStore/UI to send commands
  (window as any).__simWorker = simWorker;

  // Debug page lifecycle — start/stop GC profiler + notify sim worker
  let rendererGcHandle: GCProfilerHandle | null = null;
  let statsInterval: ReturnType<typeof setInterval> | null = null;
  useDebugStore.subscribe(
    (s) => s.showDebugPage,
    (show) => {
      if (show) {
        if (!rendererGcHandle) {
          rendererGcHandle = startGCProfiler('renderer', (stats: GCStats) => {
            useDebugStore.getState().updateGCStats(stats);
          });
        }
        renderer.setDebugMode(true);
        simBridge.setDebugMode(true);
        statsInterval = setInterval(() => {
          const sim = renderer.getSimReader();
          if (sim && sim.isValid()) {
            const playerSlot = sim.getPlayerSlot(0);
            if (playerSlot) {
              const f32 = playerSlot.f32;
              const u32 = playerSlot.u32;
              useDebugStore.getState().setRendererStats({
                fps: renderer.getFPS(),
                entityCount: sim.getEntityCount(),
                playerCount: sim.getPlayerCount(),
                tick: sim.getTick(),
                canvasW: renderer.getCanvasWidth(),
                canvasH: renderer.getCanvasHeight(),
                viewportW: renderer.getViewportWidth(0),
                viewportH: renderer.getViewportHeight(0),
                extra: {
                  waterValid: renderer.getWaterReader()?.isValid() ?? false,
                  waterGrid: renderer.getWaterReader()?.getGridSize() ?? 0,
                  cameraPos: [0, 0, 0],
                  cameraTarget: [0, 0, 0],
                  playerPos: [f32[PLR.POS_X], f32[PLR.POS_Y], f32[PLR.POS_Z]],
                  heading: f32[PLR.HEADING],
                  pitch: f32[PLR.PITCH] ?? 0,
                  cameraMode: u32[PLR.CAMERA_MODE],
                  keys: Array.from((renderer as any).keysDown as Set<number>).map((k) => String.fromCharCode(k)).join(","),
                },
              });
            }
          }
        }, 500);
      } else {
        rendererGcHandle?.stop();
        rendererGcHandle = null;
        renderer.setDebugMode(false);
        simBridge.setDebugMode(false);
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
      }
    },
  );

  // Hitbox visualization toggle
  useDebugStore.subscribe(
    (s) => s.showHitboxes,
    (show) => { renderer.setShowHitboxes(show); },
  );

  // Light gizmo visualization toggle
  useDebugStore.subscribe(
    (s) => s.showLightGizmos,
    (show) => { renderer.setShowLightGizmos(show); },
  );

  // Debug raycast visualization toggle
  useDebugStore.subscribe(
    (s) => s.showRaycast,
    (show) => { renderer.setShowRaycast(show); },
  );

  // --- Hot-Reload event handlers (dev only) ---
  if (import.meta.env.DEV && import.meta.hot) {
    const simConfig: SimWebWorkerConfig = { seed: 12345, gamemode: 0, rules: {}, isDev };

    import.meta.hot.on("sim:hot-reload", async (data: { file: string; timestamp: number }) => {
      const store = useHotReloadStore.getState();
      if (!store.enabled) return;

      console.log(`%c[HMR] Sim file changed: ${data.file}`, "color: cyan");
      store.setStatus("reloading");
      const t0 = performance.now();

      try {
        await simWorker.hotReload(simConfig, store.preserveState);
        const elapsed = (performance.now() - t0).toFixed(0);
        console.log(`%c[HMR] Sim hot-reload complete (${elapsed}ms)`, "color: cyan; font-weight: bold");
        store.setStatus("ready");
        store.setLastReload({ file: data.file, elapsed: Number(elapsed), timestamp: data.timestamp });
      } catch (err) {
        console.error(`%c[HMR] Sim hot-reload failed: ${(err as Error).message}`, "color: red; font-weight: bold");
        store.setStatus("error", (err as Error).message);
        console.warn("[HMR] Falling back to full page reload");
        window.location.reload();
      }
    });

    import.meta.hot.on("renderer:hot-reload", async (data: { file: string; timestamp: number }) => {
      const store = useHotReloadStore.getState();
      if (!store.enabled) return;

      console.log(`%c[HMR] Renderer file changed: ${data.file}`, "color: yellow");
      store.setStatus("reloading");

      if (store.preserveState) {
        try {
          const result = await simWorker.save("hot-reload");
          if (result?.stateJson && ocean?.saveGameState) {
            ocean.saveGameState("hot-reload", result.stateJson);
            sessionStorage.setItem("hot-reload-pending", "1");
            console.log("[HMR] State saved, reloading page...");
          }
        } catch (err) {
          console.warn(`[HMR] State save failed, reloading without preservation: ${err}`);
        }
      }

      window.location.reload();
    });

    import.meta.hot.on("shader:hot-reload", (data: { file: string }) => {
      console.log(`%c[HMR] Shader changed: ${data.file}`, "color: green");
      // MaterialHotReloader not yet wired into WebGPURenderer — will log for now
      console.warn("[HMR] Shader hot-reload not yet wired — requires MaterialHotReloader integration");
    });

    import.meta.hot.on("asset:hot-reload", (data: { file: string }) => {
      console.log(`%c[HMR] Asset changed: ${data.file}`, "color: green");
      console.warn("[HMR] Asset hot-reload not yet wired — requires MaterialHotReloader integration");
    });
  }

  // Hitbox line width
  useDebugStore.subscribe(
    (s) => s.hitboxLineWidth,
    (width) => { renderer.setHitboxLineWidth(width); },
  );
}

bootstrap();
