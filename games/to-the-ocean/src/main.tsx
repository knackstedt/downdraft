// ============================================================================
// Renderer Entry Point — React app + WebGPU bootstrap
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

import { createSaveStore, downdraft, type SaveStoreMode } from "@downdraft/app/renderer";
import { startGCProfiler, useHotReloadStore, type GCProfilerHandle, type GCStats, type ISaveStore } from "@downdraft/core";
import { useDebugStore } from "@downdraft/plugin-devtools";
import { ENT, PLR, PLR_FLAG, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode, EntityType, SimToMainMessage } from "@shared/types";
import { SceneInspector } from "./engine/scene-inspector";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { createSimBridge } from "./sim-bridge";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

(globalThis as any).__ddThreadTag = "R0";

async function bootstrap() {
  // Undertow is enabled by default — the React UI runs in a Web Worker and
  // proxies DOM operations to the main thread via a SharedArrayBuffer.
  // Pass ?undertow=0 to disable and run React on the main thread directly.
  const undertowDisabled = new URLSearchParams(location.search).get("undertow") === "0";
  if (!undertowDisabled) {
    // Start the undertow UI worker — it renders React into #root via SAB.
    const { startUndertowHost } = await import("./undertow-host");
    startUndertowHost();
    // Don't return — the main thread still needs to init WebGPU + sim.
    // The worker owns the React UI; the main thread owns the canvas + game logic.
  } else {
    // Non-undertow mode: render React on the main thread directly.
    const root = createRoot(document.getElementById("root")!);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("No canvas element found — ensure <canvas id='game-canvas'> is in index.html");
    return;
  }

  // Initialize WebGPU renderer
  const renderer = new WebGPURenderer(canvas);
  let isDev = !!(downdraft?.isDev) || import.meta.env.DEV === true;

  // Register for sim-ready event from main process (carries isDev flag)
  if (downdraft?.onSimReady) {
    downdraft.onSimReady((data: any) => {
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

  // Save mode — determined later during save store init, but the event
  // handler needs to know it. Default to "ipc" until save store is initialized.
  let bridgeSaveMode: "inline" | "worker" | "ipc" = "ipc";

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
      case "gc_controller_stats":
        useDebugStore.getState().updateGCControllerStats(msg.data?.label ?? "sim-worker", msg.data);
        break;
      case "perf_stats":
        (window as any).__perfMetrics = (window as any).__perfMetrics ?? {};
        (window as any).__perfMetrics[msg.data.process] = msg.data;
        if (msg.data.process === "sim" && Array.isArray(msg.data.systems)) {
          const telemetry = renderer.getTelemetryCollector();
          if (telemetry) {
            for (let i = 0; i < msg.data.systems.length; i++) {
              const t = msg.data.systems[i];
              telemetry.recordSystemTiming(t.name, t.ms);
            }
          }
        }
        break;
      case "collision_log":
        useDebugStore.getState().setCollisionLog(msg.data);
        break;
      case "saved":
        // In inline/worker mode, the save is already written to OPFS by the
        // worker. Only forward to IPC in the fallback "ipc" mode.
        if (bridgeSaveMode === "ipc" && downdraft && msg.data?.stateJson) {
          downdraft.saveGameState(msg.data.slotName, msg.data.stateJson);
        }
        break;
      case "performance":
        // Command results etc. — could be forwarded to debug store if needed
        break;
      case "sim_speed_changed":
        useGameStore.getState().setCurrentSimSpeed(msg.data?.speed ?? 1.0);
        console.log(`[Renderer] Sim speed changed to ${msg.data?.speed}x`);
        break;
    }
  });

  // Start renderer init and sim worker in parallel — avoids 2.2s LUT generation
  // blocking sim worker setup (island spawning, physics field generation, etc.)
  // When DOWNDRAFT_DETERMINISTIC=1 is set (e.g. by the e2e test harness), use a
  // fixed seed and skip autosave so test runs are reproducible.
  const deterministic = !!(downdraft as any)?.deterministic;
  const seed = deterministic ? 99999 : 12345;

  const [rendererSuccess] = await Promise.all([
    renderer.init(),
    simWorker.start({
      seed,
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

  // Mark renderer as ready early — the UI (key handlers, HUD, etc.) can
  // activate before the save store finishes initializing. The save store
  // init can hang in some environments (e.g. SwiftShader test env), which
  // would prevent the UI from ever becoming interactive.
  useGameStore.getState().setRenderer(renderer);
  useGameStore.getState().setReady(true);

  // Register MCP automation harness early — before the save store init,
  // which can hang in test environments (OPFS not available under
  // SwiftShader). The harness exposes dispatch_key / get_ui_state (used by
  // e2e UI tests) which only need the renderer + store, not the sim SAB.
  // Tools that need the sim reader (get_world_state, get_player_state)
  // gracefully return "not available" until setBuffers() wires the SAB.
  const { setupTtolMcp } = await import("./mcp/setup");
  setupTtolMcp(renderer, simWorker);

  // --- Save store initialization (before autosave loading) ---
  // Detect save mode from config and create the appropriate ISaveStore.
  // "inline": OpfsSaveStore runs inside the sim worker (zero-copy saves).
  // "worker": Dedicated save Web Worker with OpfsSaveStore.
  // "auto":   Pick "worker" if OPFS available, else IPC fallback.
  const saveMode = "auto" as SaveStoreMode;
  let saveStore: ISaveStore | null = null;

  try {
    if (saveMode === "inline") {
      // Initialize OpfsSaveStore inside the sim worker
      await simWorker.initSaveStore({
        engineVersion: "0.1.0",
        maxGenerations: 3,
      });
      bridgeSaveMode = "inline";
    } else {
      // "worker" or "auto" — createSaveStore handles OPFS detection
      saveStore = await createSaveStore({
        mode: saveMode,
        opfsOptions: {
          engineVersion: "0.1.0",
          maxGenerations: 3,
        },
        bridge: downdraft,
      });
      bridgeSaveMode = saveStore ? "worker" : "ipc";
    }
  } catch (e) {
    console.warn("[Renderer] Save store initialization failed, falling back to IPC:", e);
    bridgeSaveMode = "ipc";
  }

  // Auto-load saved state if available (skip in deterministic/test mode).
  // Tries the save store (OPFS) first, falls back to IPC for legacy saves.
  if (!deterministic) {
    try {
      let savedState: string | null = null;
      if (bridgeSaveMode === "inline") {
        // Inline mode: worker loads from its own OPFS store
        const loaded = await simWorker.load("autosave");
        if (loaded) {
          console.log("[Renderer] Auto-loaded saved game state (inline OPFS)");
        }
      } else if (saveStore) {
        // Worker mode: load from the dedicated save store
        const loadResult = await saveStore.load("autosave");
        if (loadResult.state) {
          savedState = JSON.stringify(loadResult.state.components);
        }
      }
      // IPC fallback or worker mode with no OPFS save — try legacy IPC
      if (!savedState && downdraft?.loadGameState) {
        savedState = await downdraft.loadGameState("autosave");
      }
      if (savedState) {
        if (bridgeSaveMode !== "inline") {
          await simWorker.load("autosave", savedState);
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
          await simWorker.restoreFromState(hotReloadState);
          // Restore renderer meta if present
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

  // Listen for display refresh rate changes (multi-monitor frame rate fix)
  // Must be registered BEFORE renderer.start() so the initial display info
  // from the main process (sent on did-finish-load) isn't missed.
  try {
    if (downdraft?.onDisplayInfo) {
      downdraft.onDisplayInfo((data: { refreshRate: number }) => {
        console.log(`[Renderer] Display refresh rate: ${data.refreshRate}Hz`);
        renderer.setFrameRateLimit(data.refreshRate);
      });
    }
    // Query current display info — the did-finish-load push was missed because
    // bootstrap() was still awaiting renderer.init() when it fired.
    if (downdraft?.getDisplayInfo) {
      const info = await downdraft.getDisplayInfo();
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

  // In deterministic/test mode, start the renderer but immediately pause the
  // render loop. The simulation still ticks; frames are only rendered on
  // demand via captureScreenshot / renderOneFrame. This saves ~90% CPU when
  // running under SwiftShader software WebGPU.
  renderer.start();
  if (deterministic) {
    renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused (on-demand rendering only)");
  }

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

          // Create a dedicated OSR renderer (single high-res texture)
          osrManager.createRenderer({
            id: RENDERER_ID,
            mode: "dedicated",
            width: TEX_W,
            height: TEX_H,
            frameRate: 30,
          });

          // Load YouTube to test audio playback through OSR
          downdraft.osr.loadURL(RENDERER_ID, "https://www.youtube.com");

          // Add a world-space UI element — will be positioned each frame
          osrManager.addElement({
            id: "helm-google-billboard",
            position: [0, 0, 0],
            size: [2, 1.5],
            billboardMode: 0,
            textureIndex: 0,
            uvOffset: [0, 0],
            uvScale: [1, 1],
          });

          // Update billboard position to follow the ship's helm each frame
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
                shipHeading = es.f32[ENT.DATA + 3]; // SHIP_DATA.HEADING = data slot 3
                found = true;
                break;
              }
              if (found) {
                // Helm local offset: (0, 1.5, 1) — rotated by heading
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

          // F8: manually focus OSR billboard (bypasses raycast for mouse+keyboard)
          // F9: unfocus, return to raycast-based input
          window.addEventListener("keydown", (e) => {
            if (e.repeat) return;
            if (e.keyCode === 119) { // F8
              if (document.pointerLockElement) {
                useGameStore.getState().setSuppressPauseMenu(true);
                document.exitPointerLock();
              }
              const canvas = document.querySelector("canvas");
              const rect = canvas?.getBoundingClientRect();
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
  // Replaces the old window.__simWorker / window.__renderer service-locator pattern.
  // (saveStore and bridgeSaveMode were initialized earlier, before autosave loading)
  const bridge = createSimBridge({ worker: simWorker, renderer, downdraft, saveStore, saveMode: bridgeSaveMode });
  useGameStore.getState().setSimBridge(bridge);

  // Initialize Scene Inspector for DevTools integration
  const sceneInspector = new SceneInspector();
  sceneInspector.init(renderer);
  sceneInspector.setSimBridge(bridge);

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

  // Update store with renderer reference (already set early above)
  // useGameStore.getState().setRenderer(renderer); // moved up
  // useGameStore.getState().setReady(true); // moved up


  // --- HUD state polling (main thread) ---
  // The HUD component reads health/hunger/thirst/timeOfDay/weather/camera mode
  // etc. from the sim buffer. In undertow mode the React UI runs in a worker
  // where `renderer` (and thus the sim reader) is unavailable. We poll the sim
  // buffer here on the main thread and write the values into the game store;
  // the store bridge syncs them to the worker so the HUD can render. FPS is
  // also polled here (the worker's App never mounts on the main thread in
  // undertow mode, so its FPS useEffect never runs).
  const hudInterval = setInterval(() => {
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
    // Auto-unhide HUD when leaving freecam
    const camMode = playerSlot.u32[PLR.CAMERA_MODE];
    if (camMode !== CameraMode.FreeCam && useGameStore.getState().hudHidden) {
      useGameStore.getState().setHudHidden(false);
    }
  }, 100);

  // FPS polling — the worker's App useEffect never runs in undertow mode, so
  // poll FPS here and write to the store (synced to the worker).
  const fpsInterval = setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

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

      // Ack so the plugin doesn't trigger a fallback full-reload
      import.meta.hot!.send("sim:hot-reload:ack", {});

      console.log(`%c[HMR] Sim file changed: ${data.file}`, "color: cyan");
      store.setStatus("reloading");
      const t0 = performance.now();

      // Full worker swap (preserves state via HotReloadPipeline)
      try {
        await simWorker.hotReload(simConfig, store.preserveState);
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

      // Ack so the plugin doesn't trigger a fallback full-reload
      import.meta.hot!.send("renderer:hot-reload:ack", {});

      console.log(`%c[HMR] Renderer file changed: ${data.file}`, "color: yellow");
      store.setStatus("reloading");

      if (store.preserveState) {
        try {
          const result = await simWorker.save("hot-reload");
          if (result?.stateJson && downdraft?.saveGameState) {
            // Merge renderer meta into save state
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
