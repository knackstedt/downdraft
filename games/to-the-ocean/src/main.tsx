// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from bootstrapGame() callback-soup to the declarative startGame()
// API. The common sequence (UI mount, renderer create+init, sim worker spawn,
// SAB capture, event routing, save store init, render loop, FPS polling,
// display info, hot-reload dispose, deterministic mode) is handled by
// startGame(). Game-specific wiring (OSR billboard, DevTools/SceneInspector,
// HUD polling, debug store subscriptions, hot-reload handlers) lives in the
// onReady hook.
// ============================================================================

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";

// Fonts — statically bundled via @fontsource (woff2/woff embedded in build, no CDN requests)
import "@fontsource/doto/400.css";
import "@fontsource/linefont/400.css";
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/special-elite/400.css";
import "@fontsource/urbanist/400.css";
import "@fontsource/urbanist/700.css";
import "@fontsource/wavefont/400.css";

import { downdraft, startGame } from "@downdraft/app/renderer";
import { ENT, PLR, PLR_FLAG, SimBufferReader, startGCProfiler, useHotReloadStore, type GCProfilerHandle, type GCStats } from "@downdraft/core";
import { initDevTools, useDebugStore } from "@downdraft/plugin-devtools";
import { CameraMode, EntityType } from "@shared/types";
import { SceneInspector } from "./engine/scene-inspector";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { createSimBridge } from "./sim-bridge";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

(globalThis as any).__ddThreadTag = "R0";

// Intervals/handles tracked for hot-reload dispose.
let hudInterval: ReturnType<typeof setInterval> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
let rendererGcHandle: GCProfilerHandle | null = null;

startGame({
  // ── Renderer + Sim ──
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: () => new SimWebWorker(),
  simConfig: { seed: 12345, gamemode: 0, rules: {}, isDev: !!(downdraft?.isDev) || import.meta.env.DEV },

  // ── UI (React) ──
  mountUI: (overlay) => {
    const root = createRoot(overlay);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  },

  // ── Sim→Renderer event routing (declarative) ──
  events: {
    ready: (_data, ctx) => {
      console.log("[Renderer] Sim Web Worker ready");
      useGameStore.getState().setSimReady(true);
      // Mark isDev if the sim reports it
      if (ctx.isDev) useGameStore.getState().setIsDev(true);
    },
    error: (data) => {
      console.error(`[Renderer] Sim error: ${data?.message ?? JSON.stringify(data)}`);
    },
    weather_changed: (data) => useGameStore.getState().setWeather(data),
    player_died: (data) => useGameStore.getState().setPlayerDied(data),
    fishing_result: (data) => {
      if (data?.message) {
        useGameStore.getState().addNotification(data.message, data.success ? "success" : "warning");
      }
    },
    boat_design_update: (data, ctx) => ctx.renderer.setBoatDesign(data.entityId, data.designJson),
    boat_design_remove: (data, ctx) => ctx.renderer.removeBoatDesign(data.entityId),
    terrain_deformed: (data, ctx) => {
      if (Array.isArray(data)) {
        console.log(`[Renderer] Received ${data.length} terrain deformations`);
        const er = ctx.renderer.getEntityRenderer();
        if (er) {
          for (let i = 0; i < data.length; i++) {
            const d = data[i];
            er.applyTerrainDeformation(
              d.chunkX, d.chunkZ, d.isPort,
              d.worldX, d.worldY, d.worldZ,
              d.entityWorldX, d.entityWorldY, d.entityWorldZ,
              d.radius, d.strength,
            );
          }
        }
      }
    },
    terrain_lod_changed: (data, ctx) => {
      if (Array.isArray(data)) {
        const er = ctx.renderer.getEntityRenderer();
        if (er) {
          for (let i = 0; i < data.length; i++) {
            const d = data[i];
            er.handleTerrainLODChange(d.chunkX, d.chunkZ, d.newVoxelSize);
          }
        }
      }
    },
    ship_hold_update: (data) => useGameStore.getState().setShipHoldData(data),
    gc_stats: (data) => useDebugStore.getState().updateGCStats(data),
    gc_controller_stats: (data) => useDebugStore.getState().updateGCControllerStats(data?.label ?? "sim-worker", data),
    perf_stats: (data, ctx) => {
      (window as any).__perfMetrics = (window as any).__perfMetrics ?? {};
      (window as any).__perfMetrics[data.process] = data;
      if (data.process === "sim" && Array.isArray(data.systems)) {
        const telemetry = ctx.renderer.getTelemetryCollector();
        if (telemetry) {
          for (let i = 0; i < data.systems.length; i++) {
            const t = data.systems[i];
            telemetry.recordSystemTiming(t.name, t.ms);
          }
        }
      }
    },
    collision_log: (data) => useDebugStore.getState().setCollisionLog(data),
    saved: (data, ctx) => {
      // In inline/worker mode, the save is already written to OPFS by the
      // worker. Only forward to IPC in the fallback "ipc" mode.
      if (ctx.saveMode === "ipc" && ctx.bridge && data?.stateJson) {
        ctx.bridge.saveGameState(data.slotName, data.stateJson);
      }
    },
    performance: () => { /* Command results — no-op */ },
    sim_speed_changed: (data) => {
      useGameStore.getState().setCurrentSimSpeed(data?.speed ?? 1.0);
      console.log(`[Renderer] Sim speed changed to ${data?.speed}x`);
    },
  },

  // ── Save ──
  save: {
    mode: "auto",
    engineVersion: "0.1.0",
    maxGenerations: 3,
  },

  // ── Renderer init (parallel with sim worker start) ──
  onInit: async (ctx) => {
    const seed = ctx.deterministic ? 99999 : 12345;
    const config: SimWebWorkerConfig = { seed, gamemode: 0, rules: {}, isDev: ctx.isDev };

    const [rendererSuccess] = await Promise.all([
      ctx.renderer.init(),
      ctx.sim.start(config),
    ]);
    if (!rendererSuccess) {
      console.error("WebGPU initialization failed");
      return false;
    }
    if (ctx.isDev) useGameStore.getState().setIsDev(true);

    // Wait for the PBR BRDF LUT to finish generating before starting the render
    // loop and spawning the player. The LUT computation is chunked across frames
    // to avoid blocking the main thread — this shows the loading screen during
    // that time for a smooth startup experience.
    await ctx.renderer.getLUTReady();
    useGameStore.getState().setLutReady(true);

    // Add default player
    await ctx.sim.addPlayer?.(0, "Player 1");
    return true;
  },

  // ── Post-init wiring (bespoke game setup) ──
  onReady: async (ctx) => {
    const { renderer, sim, simSAB, inputSAB, extraBuffers } = ctx;

    // Mark renderer as ready early — the UI (key handlers, HUD, etc.) can
    // activate before the save store finishes initializing.
    useGameStore.getState().setRenderer(renderer);
    useGameStore.getState().setReady(true);

    // Register MCP automation harness early — before the save store init,
    // which can hang in test environments (OPFS not available under
    // SwiftShader). The harness exposes dispatch_key / get_ui_state (used by
    // e2e UI tests) which only need the renderer + store, not the sim SAB.
    // Tools that need the sim reader (get_world_state, get_player_state)
    // gracefully return "not available" until setBuffers() wires the SAB.
    const { setupTtolMcp } = await import("./mcp/setup");
    setupTtolMcp(renderer, sim as SimWebWorker);

    // Auto-load saved state if available (skip in deterministic/test mode).
    if (!ctx.deterministic) {
      try {
        let savedState: string | null = null;
        if (ctx.saveStore) {
          const loadResult = await ctx.saveStore.load("autosave");
          if (loadResult.state) {
            savedState = JSON.stringify(loadResult.state.components);
          }
        }
        // IPC fallback or worker mode with no OPFS save — try legacy IPC
        if (!savedState && downdraft?.loadGameState) {
          savedState = await downdraft.loadGameState("autosave");
        }
        if (savedState) {
          if (ctx.saveMode !== "inline") {
            await sim.load?.("autosave", savedState);
          }
          // Restore renderer meta if present
          try {
            const components = JSON.parse(savedState);
            if (components.renderer?.data && renderer.restoreRendererMeta) {
              renderer.restoreRendererMeta(components.renderer.data);
            }
          } catch { /* ignore */ }
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
        if (downdraft?.loadGameState) {
          const hotReloadState = await downdraft.loadGameState("hot-reload");
          if (hotReloadState) {
            await sim.restoreFromState?.(hotReloadState);
            try {
              const components = JSON.parse(hotReloadState);
              if (components.renderer?.data && renderer.restoreRendererMeta) {
                renderer.restoreRendererMeta(components.renderer.data);
              }
            } catch { /* ignore */ }
            console.log("[HMR] Restored state after page reload");
            if (downdraft.deleteGameState) downdraft.deleteGameState("hot-reload");
          }
        }
      } catch (err) {
        console.error(`[HMR] Failed to restore hot-reload state: ${err}. Starting fresh.`);
      }
    }

    // Set buffers on renderer — same SABs the sim worker writes to (zero-copy)
    renderer.setBuffers(simSAB, extraBuffers.water, inputSAB, extraBuffers.boat);
    renderer.setupInputListeners();

    // --- Debug: Electron OSR billboard at helm position ---
    // Creates a dedicated OSR renderer loading google.com and places a
    // world-space billboard at the helm cell of the player's ship.
    {
      if (downdraft?.osr) {
        try {
          const osrManager = renderer.initOSR(downdraft.osr);
          if (osrManager) {
            const RENDERER_ID = "debug-helm-google";
            const TEX_W = 1920;
            const TEX_H = 1080;

            osrManager.createRenderer({
              id: RENDERER_ID,
              mode: "dedicated",
              width: TEX_W,
              height: TEX_H,
              frameRate: 30,
            });

            downdraft.osr.loadURL(RENDERER_ID, "https://www.youtube.com");

            osrManager.addElement({
              id: "helm-google-billboard",
              position: [0, 0, 0],
              size: [2, 1.5],
              billboardMode: 0,
              textureIndex: 0,
              uvOffset: [0, 0],
              uvScale: [1, 1],
            });

            const sim = renderer.getSimReader();
            if (sim) {
              let helmLogDone = false;
              const updateHelmBillboard = () => {
                if (!sim.isValid()) { requestAnimationFrame(updateHelmBillboard); return; }
                const entityCount = sim.getEntityCount();
                let shipX = 0, shipY = 0, shipZ = 0, shipHeading = 0;
                let found = false;
                for (let i = 0; i < entityCount; i++) {
                  const es = sim.getEntitySlot(i);
                  if (!es) continue;
                  if (es.u32[ENT.TYPE] !== EntityType.Ship) continue;
                  shipX = es.f32[ENT.POS_X];
                  shipY = es.f32[ENT.POS_Y];
                  shipZ = es.f32[ENT.POS_Z];
                  shipHeading = es.f32[ENT.DATA + 3];
                  found = true;
                  break;
                }
                if (found) {
                  const helmX = shipX + Math.sin(shipHeading) * 1;
                  const helmZ = shipZ + Math.cos(shipHeading) * 1;
                  if (!helmLogDone) {
                    console.log(`[OSR Debug] Ship found at (${shipX}, ${shipY}, ${shipZ}) heading=${shipHeading}, billboard at (${helmX}, ${shipY + 5.0}, ${helmZ})`);
                    helmLogDone = true;
                  }
                  osrManager.updateElements([{
                    id: "helm-google-billboard",
                    position: [helmX, shipY + 5.0, helmZ],
                    size: [10, 5.625],
                    billboardMode: 0,
                    textureIndex: 0,
                    uvOffset: [0, 0],
                    uvScale: [1, 1],
                  }]);
                }
                requestAnimationFrame(updateHelmBillboard);
              };
              requestAnimationFrame(updateHelmBillboard);
            }

            console.log("[OSR Debug] Helm billboard initialized (google.com)");

            window.addEventListener("keydown", (e) => {
              if (e.repeat) return;
              if (e.keyCode === 119) { // F8
                if (document.pointerLockElement) {
                  useGameStore.getState().setSuppressPauseMenu(true);
                  document.exitPointerLock();
                }
                const cv = document.querySelector("canvas");
                const rect = cv?.getBoundingClientRect();
                const id = osrManager.focusBillboard(rect?.width, rect?.height);
                if (id) {
                  renderer.setOSRForcedFocus(true);
                  window.dispatchEvent(new CustomEvent("osr-forced-focus-change", { detail: true }));
                }
              } else if (e.keyCode === 120) { // F9
                osrManager.unfocusBillboard();
                renderer.setOSRForcedFocus(false);
                window.dispatchEvent(new CustomEvent("osr-forced-focus-change", { detail: false }));
              }
            });
          }
        } catch (e) {
          console.warn("[OSR Debug] Failed to initialize:", e);
        }
      }
    }

    // Create the sim bridge with typed dependencies and store it for UI access.
    const bridge = createSimBridge({ worker: sim as SimWebWorker, renderer, downdraft, saveStore: ctx.saveStore, saveMode: ctx.saveMode });
    useGameStore.getState().setSimBridge(bridge);

    // Initialize Scene Inspector for DevTools integration via initDevTools().
    const devtoolsProxy = (sim as SimWebWorker).getDevToolsProxy();
    const sceneInspector = await initDevTools(renderer, {
      bridgeClass: SceneInspector,
      workerHosts: devtoolsProxy ? [{ prefix: "sim", proxy: devtoolsProxy }] : [],
    }) as SceneInspector;
    sceneInspector.setSimBridge(bridge);

    // Gizmo mouse interaction handlers on canvas
    const canvas = ctx.canvas;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (document.pointerLockElement) return;
      const handled = renderer.handleGizmoMouseDown(e.clientX, e.clientY, canvas.width, canvas.height);
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
    canvas.addEventListener("mousemove", (e) => {
      if (renderer.isGizmoDragging()) {
        renderer.handleGizmoMouseMove(e.clientX, e.clientY, canvas.width, canvas.height);
        e.preventDefault();
      }
    });
    const gizmoMouseUpHandler = () => renderer.handleGizmoMouseUp();
    canvas.addEventListener("mouseup", gizmoMouseUpHandler);
    window.addEventListener("mouseup", gizmoMouseUpHandler);

    // Input is zero-copy — the sim worker reads the input SAB directly.
    renderer.onInputProcessed = () => { /* no-op */ };

    // Listen for display scale factor (DPR) changes
    try {
      if (downdraft?.onDisplayMetricsChanged) {
        downdraft.onDisplayMetricsChanged((data: { scaleFactor: number }) => {
          console.log(`[Renderer] Display scale factor changed: ${data.scaleFactor}`);
          renderer.handleDprChange(data.scaleFactor);
        });
      }
    } catch (e) {
      console.warn("[Renderer] onDisplayMetricsChanged not available:", e);
    }

    // Listen for main process performance stats
    try {
      if (downdraft?.onPerfStats) {
        downdraft.onPerfStats((data: any) => {
          (window as any).__perfMetrics = (window as any).__perfMetrics ?? {};
          (window as any).__perfMetrics[data.process] = data;
        });
      }
    } catch (e) {
      console.warn("[Renderer] onPerfStats not available:", e);
    }

    // --- HUD state polling (main thread) ---
    hudInterval = setInterval(() => {
      const simReader = renderer.getSimReader() as SimBufferReader | null;
      if (!simReader || !simReader.isValid()) return;
      const playerSlot = simReader.getPlayerSlot(0);
      if (!playerSlot) return;
      const flags = playerSlot.u32[PLR.FLAGS];
      useGameStore.getState().setHudState({
        health: playerSlot.f32[PLR.HEALTH],
        maxHealth: playerSlot.f32[PLR.MAX_HEALTH],
        hunger: playerSlot.f32[PLR.HUNGER],
        thirst: playerSlot.f32[PLR.THIRST],
        oxygen: playerSlot.f32[PLR.OXYGEN],
        maxOxygen: playerSlot.f32[PLR.MAX_OXYGEN],
        temperature: playerSlot.f32[PLR.TEMPERATURE],
        timeOfDay: simReader.getTimeOfDay(),
        weatherType: simReader.getWeatherType(),
        cameraMode: playerSlot.u32[PLR.CAMERA_MODE] as CameraMode,
        isFishing: (flags & PLR_FLAG.FISHING) !== 0,
        fishingTension: playerSlot.f32[PLR.FISHING_TENSION] ?? 50,
        fishingProgress: playerSlot.f32[PLR.FISHING_PROGRESS] ?? 0,
        activeSlot: playerSlot.u32[PLR.ACTIVE_SLOT] ?? 0,
        isPiloting: (flags & PLR_FLAG.PILOTING) !== 0,
        isOnboard: (flags & PLR_FLAG.ONBOARD) !== 0,
        gold: playerSlot.f32[PLR.GOLD] ?? 0,
        playerX: playerSlot.f32[PLR.POS_X],
        playerZ: playerSlot.f32[PLR.POS_Z],
        heading: playerSlot.f32[PLR.HEADING],
      });
      const camMode = playerSlot.u32[PLR.CAMERA_MODE];
      if (camMode !== CameraMode.FreeCam && useGameStore.getState().hudHidden) {
        useGameStore.getState().setHudHidden(false);
      }
    }, 100);

    // Debug page lifecycle — start/stop GC profiler + notify sim worker
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
          useGameStore.getState().simBridge?.setDebugMode(true);
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
          useGameStore.getState().simBridge?.setDebugMode(false);
          if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
        }
      },
    );

    // Debug visualization toggles
    useDebugStore.subscribe((s) => s.showHitboxes, (show) => renderer.setShowHitboxes(show));
    useDebugStore.subscribe((s) => s.showLightGizmos, (show) => renderer.setShowLightGizmos(show));
    useDebugStore.subscribe((s) => s.showRaycast, (show) => renderer.setShowRaycast(show));
    useDebugStore.subscribe((s) => s.hitboxLineWidth, (width) => renderer.setHitboxLineWidth(width));

    // --- Hot-Reload event handlers (dev only) ---
    if (import.meta.env.DEV && import.meta.hot) {
      const simConfig: SimWebWorkerConfig = { seed: 12345, gamemode: 0, rules: {}, isDev: ctx.isDev };

      import.meta.hot.on("sim:hot-reload", async (data: { file: string; timestamp: number }) => {
        const store = useHotReloadStore.getState();
        if (!store.enabled) return;
        import.meta.hot!.send("sim:hot-reload:ack", {});
        console.log(`%c[HMR] Sim file changed: ${data.file}`, "color: cyan");
        store.setStatus("reloading");
        const t0 = performance.now();
        try {
          await sim.hotReload?.(simConfig, store.preserveState);
          const elapsed = (performance.now() - t0).toFixed(0);
          console.log(`%c[HMR] Sim worker swap complete (${elapsed}ms)`, "color: cyan; font-weight: bold");
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
        import.meta.hot!.send("renderer:hot-reload:ack", {});
        console.log(`%c[HMR] Renderer file changed: ${data.file}`, "color: yellow");
        store.setStatus("reloading");
        if (store.preserveState) {
          try {
            const result = await sim.save?.("hot-reload");
            if (result?.stateJson && downdraft?.saveGameState) {
              let components = JSON.parse(result.stateJson);
              if (renderer.serializeRendererMeta) {
                components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
              }
              downdraft.saveGameState("hot-reload", JSON.stringify(components));
              sessionStorage.setItem("hot-reload-pending", "1");
              console.log("[HMR] State saved, reloading page...");
            }
          } catch (err) {
            console.warn(`[HMR] State save failed, reloading without preservation: ${err}`);
          }
        }
        window.location.reload();
      });
    }
  },

  // ── FPS polling (write to store for HUD/debug panels) ──
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),

  // ── Display info (refresh rate → frame rate limit) ──
  onDisplayInfo: (refreshRate, ctx) => {
    console.log(`[Renderer] Display refresh rate: ${refreshRate}Hz`);
    ctx.renderer.setFrameRateLimit(refreshRate);
  },

  // ── Deterministic mode: pause render loop (on-demand rendering only) ──
  onDeterministic: (ctx) => {
    ctx.renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused (on-demand rendering only)");
  },

  // ── Hot-reload dispose: clean up tracked intervals/handles ──
  onDispose: () => {
    if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    rendererGcHandle?.stop();
    rendererGcHandle = null;
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
