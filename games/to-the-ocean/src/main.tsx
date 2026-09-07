// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from React DOM overlay to PixiJS worker overlay (@pixi/react).
// The UI is now rendered in a Web Worker on an OffscreenCanvas via
// @downdraft/library-pixi-ui. State flows through:
//   - UiStatsSAB (per-frame scalars: HUD, menu visibility, readiness)
//   - postMessage events (structured data: inventory, bookmarks, recipes)
//   - postAction (worker→main side effects: toggle menus, save, respawn)
// ============================================================================

// Fonts — statically bundled via @fontsource (woff2/woff embedded in build, no CDN requests)
import "@fontsource/doto/400.css";
import "@fontsource/linefont/400.css";
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/special-elite/400.css";
import "@fontsource/urbanist/400.css";
import "@fontsource/urbanist/700.css";
import "@fontsource/wavefont/400.css";

import { downdraft, startGame, type SimWorkerSeed } from "@downdraft/app/renderer";
import { ENGINE_VERSION, ENT, PLR, PLR_FLAG, SimBufferReader, isDevMode, startGCProfiler, useHotReloadStore, type GCProfilerHandle, type GCStats } from "@downdraft/core";
import { PixiUiHost, getEffectiveFontScale, loadUserFontScale, saveUserFontScale } from "@downdraft/library-pixi-ui";
import { WaterLib } from "@downdraft/library-water";
import { initDevTools, useDebugStore } from "@downdraft/module-devtools";
import { GAME_PLR } from "@shared/constants/buffer";
import { CameraMode, EntityType } from "@shared/types";
import { SceneInspector } from "./engine/scene-inspector";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { OCEAN_STATS_LAYOUT, type OceanAction } from "./pixi/bridge-protocol";
import { createSimBridge } from "./sim-bridge";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

(globalThis as any).__ddThreadTag = "R0";

// Intervals/handles tracked for hot-reload dispose.
let hudInterval: ReturnType<typeof setInterval> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
let rendererGcHandle: GCProfilerHandle | null = null;

startGame({
  // ── Engine libraries (declarative SAB allocation + DI tokens) ──
  libraries: [WaterLib],

  // ── Renderer + Sim ──
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (seed?: SimWorkerSeed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345, gamemode: 0, rules: {}, isDev: !!(downdraft?.isDev) || isDevMode },

  // ── UI (pixi-ui handles UI in a worker; DOM overlay is a no-op) ──
  mountUI: () => { /* pixi-ui handles UI */ },

  // ── Sim→Renderer event routing (declarative) ──
  events: {
    ready: (_data, ctx) => {
      console.log("[Renderer] Sim Web Worker ready");
      useGameStore.getState().setSimReady(true);
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
    engineVersion: ENGINE_VERSION,
    maxGenerations: 3,
  },

  // ── Renderer init (parallel with sim worker start) ──
  onInit: async (ctx) => {
    const seed = ctx.deterministic ? 99999 : 12345;
    const config: SimWebWorkerConfig = { seed, gamemode: 0, rules: {}, isDev: ctx.isDev };

    const [rendererSuccess] = await Promise.all([
      ctx.renderer.init(),
      ctx.sim!.start(config),
    ]);
    if (!rendererSuccess) {
      console.error("WebGPU initialization failed");
      return false;
    }
    if (ctx.isDev) useGameStore.getState().setIsDev(true);

    await ctx.renderer.getLUTReady();
    useGameStore.getState().setLutReady(true);

    await ctx.sim!.addPlayer?.(0, "Player 1");
    return true;
  },

  // ── Post-init wiring (bespoke game setup) ──
  onReady: async (ctx) => {
    const { renderer, extraBuffers } = ctx;
    const sim = ctx.sim!;
    const simSAB = ctx.simSAB!;
    const inputSAB = ctx.inputSAB!;

    useGameStore.getState().setRenderer(renderer);
    useGameStore.getState().setReady(true);

    // ── Start PixiUI overlay (escape hatch: manual PixiUiHost) ──
    const pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: OCEAN_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi-scene.tsx", import.meta.url).href,
      passThrough: true,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
      fontScale: getEffectiveFontScale(loadUserFontScale()),
    });
    await pixiHost.start();

    // Forward opaque UI panel rects to the renderer so it can skip 3D + postfx
    // under opaque panels (the overlay composites on top, so the game canvas
    // under an opaque panel is never seen by the user).
    pixiHost.onOpaqueChange = (regions) => {
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      const uvRects = regions.map(r => ({
        x: r.x / cssW, y: r.y / cssH, w: r.width / cssW, h: r.height / cssH,
      }));
      renderer.setOccluderRects(uvRects);
    };

    // Handle actions from the worker (menu toggles, save, respawn, etc.)
    const store = useGameStore.getState();
    pixiHost.onAction = ((action: any) => {
      const a = action as OceanAction;
      const s = useGameStore.getState();
      switch (a.kind) {
        case "toggleMenu":
          switch (a.menu) {
            case "inventory": s.toggleInventory(); break;
            case "map": s.toggleMap(); break;
            case "buildMenu": s.toggleBuildMenu(); break;
            case "craftMenu": s.toggleCraftMenu(); break;
            case "fishingMinigame": s.toggleFishingMinigame(); break;
            case "tradeMenu": s.toggleTradeMenu(); break;
            case "settings": s.toggleSettings(); break;
            case "pauseMenu": s.togglePauseMenu(); break;
            case "characterCustomization": s.toggleCharacterCustomization(); break;
            case "credits": s.toggleCredits(); break;
            case "builderWheel": s.setShowBuilderWheel(!s.showBuilderWheel); break;
          }
          break;
        case "closeMenu":
          switch (a.menu) {
            case "inventory": if (s.showInventory) s.toggleInventory(); break;
            case "map": if (s.showMap) s.toggleMap(); break;
            case "buildMenu": if (s.showBuildMenu) s.toggleBuildMenu(); break;
            case "craftMenu": if (s.showCraftMenu) s.toggleCraftMenu(); break;
            case "fishingMinigame": if (s.showFishingMinigame) s.toggleFishingMinigame(); break;
            case "tradeMenu": if (s.showTradeMenu) s.toggleTradeMenu(); break;
            case "settings": if (s.showSettings) s.toggleSettings(); break;
            case "pauseMenu": if (s.showPauseMenu) s.togglePauseMenu(); break;
            case "characterCustomization": if (s.showCharacterCustomization) s.toggleCharacterCustomization(); break;
            case "credits": if (s.showCredits) s.toggleCredits(); break;
            case "builderWheel": s.setShowBuilderWheel(false); break;
          }
          break;
        case "equipItem": s.equipItem(a.slot, a.itemId); break;
        case "addBookmark": s.addBookmark(a.x, a.z, a.label); break;
        case "removeBookmark": s.removeBookmark(a.id); break;
        case "setWaypoint": s.setWaypoint(a.waypoint); break;
        case "sendCommand": s.simBridge?.sendCommand(a.data); break;
        case "saveGame": s.simBridge?.saveGame("autosave"); break;
        case "loadGame": s.simBridge?.loadGame("autosave"); break;
        case "resetGame": s.simBridge?.resetGame(); break;
        case "quit": s.simBridge?.quit(); break;
        case "respawn": s.simBridge?.respawnPlayer(s.playerDied?.playerId ?? 0); s.setPlayerDied(null); break;
        case "setSetting": s.simBridge?.setSetting(a.key, a.value); break;
        case "setBuilderCellType": s.setBuilderCellType(a.idx); break;
        case "setBuilderRotation": s.setBuilderRotation(a.rotation); break;
        case "setReticleSize": s.setReticleSize(a.size); break;
        case "lockPointer": renderer.lockPointer(); break;
        case "craft": s.simBridge?.sendCommand({ type: "craft", recipeId: a.recipeId }); break;
        case "abortCraft": s.simBridge?.sendCommand({ type: "abortCraft", jobId: a.jobId }); break;
        case "trade": s.simBridge?.sendCommand({ type: "trade", itemId: a.itemId, quantity: a.quantity, buy: a.buy }); break;
        case "build": s.simBridge?.sendCommand({ type: "build", moduleId: a.moduleId }); break;
        case "transferItem": s.simBridge?.sendCommand({ type: `transfer_to_${a.direction === "to_ship" ? "ship" : "from_ship"}`, itemId: a.itemId, quantity: a.quantity }); break;
        case "openExternal": downdraft?.openExternal?.(a.url); break;
        case "setFontScale": {
          const scale = getEffectiveFontScale(a.scale);
          pixiHost.setFontScale(scale);
          saveUserFontScale(a.scale);
          break;
        }
      }
    }) as any;

    // ── Forward store changes to the worker via postMessage ──
    // Subscribe to key store fields and post events when they change.
    let lastShipHold = store.shipHoldData;
    let lastBookmarks = store.bookmarks;
    let lastWaypoint = store.waypoint;
    let lastPlayerDied = store.playerDied;
    let lastWeather = store.weather;
    let lastEquipment = store.equipment;
    let lastNotifications = store.notifications;

    useGameStore.subscribe((s) => {
      if (s.shipHoldData !== lastShipHold) {
        lastShipHold = s.shipHoldData;
        pixiHost.postEvent({ kind: "setShipHold", data: s.shipHoldData });
      }
      if (s.bookmarks !== lastBookmarks) {
        lastBookmarks = s.bookmarks;
        pixiHost.postEvent({ kind: "setBookmarks", bookmarks: s.bookmarks });
      }
      if (s.waypoint !== lastWaypoint) {
        lastWaypoint = s.waypoint;
        pixiHost.postEvent({ kind: "setWaypoint", waypoint: s.waypoint });
      }
      if (s.playerDied !== lastPlayerDied) {
        lastPlayerDied = s.playerDied;
        pixiHost.postEvent({ kind: "setPlayerDied", data: s.playerDied });
      }
      if (s.weather !== lastWeather) {
        lastWeather = s.weather;
        pixiHost.postEvent({ kind: "setWeather", data: s.weather });
      }
      if (s.equipment !== lastEquipment) {
        lastEquipment = s.equipment;
        pixiHost.postEvent({ kind: "setEquipment", equipment: s.equipment });
      }
      if (s.notifications !== lastNotifications) {
        lastNotifications = s.notifications;
        pixiHost.postEvent({ kind: "setNotifications", notifications: s.notifications });
      }
    });

    // Register MCP automation harness early
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
        if (!savedState && downdraft?.loadGameState) {
          savedState = await downdraft.loadGameState("autosave");
        }
        if (savedState) {
          if (ctx.saveMode !== "inline") {
            await sim.load?.("autosave", savedState);
          }
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

    // Restore hot-reload state if pending
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

    // Set buffers on renderer
    renderer.setBuffers(simSAB, extraBuffers.water, inputSAB, extraBuffers.boat);
    renderer.setupInputListeners();

    // --- Debug: Electron OSR billboard at helm position ---
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

            const simReader = renderer.getSimReader();
            if (simReader) {
              let helmLogDone = false;
              const updateHelmBillboard = () => {
                if (!simReader.isValid()) { requestAnimationFrame(updateHelmBillboard); return; }
                const entityCount = simReader.getEntityCount();
                let shipX = 0, shipY = 0, shipZ = 0, shipHeading = 0;
                let found = false;
                for (let i = 0; i < entityCount; i++) {
                  const es = simReader.getEntitySlot(i);
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

    // Create the sim bridge
    const bridge = createSimBridge({ worker: sim as SimWebWorker, renderer, downdraft, saveStore: ctx.saveStore, saveMode: ctx.saveMode });
    useGameStore.getState().setSimBridge(bridge);

    // Initialize Scene Inspector for DevTools integration
    const devtoolsProxy = (sim as SimWebWorker).getDevToolsProxy();
    const sceneInspector = await initDevTools(renderer, {
      bridgeClass: SceneInspector,
      workerHosts: devtoolsProxy ? [{ prefix: "sim", proxy: devtoolsProxy }] : [],
      profiling: true,
    }) as SceneInspector;
    sceneInspector.setSimBridge(bridge);

    // Wire the ProfilingBridge into the render loop (tick at frame start,
    // endFrame at frame end). The bridge drains the warning ring from the
    // ProfilingSAB + fires auto-trace + ingests snapshots into the trace writer.
    const profilingBridge = (sceneInspector as any)._profilingBridge;
    if (profilingBridge) {
      const prevCallbacks = renderer.callbacks ?? {};
      renderer.setCallbacks({
        ...prevCallbacks,
        beforeFrame: (dt: number, elapsedTime: number) => {
          profilingBridge.tick();
          prevCallbacks.beforeFrame?.(dt, elapsedTime);
        },
        afterFrame: (dt: number, elapsedTime: number) => {
          prevCallbacks.afterFrame?.(dt, elapsedTime);
          profilingBridge.endFrame();
        },
      });
      // Share the ProfilingSAB with the sim worker (so it can claim a slot)
      const profilingSAB = profilingBridge.getProfilingSAB();
      (sim as SimWebWorker).attachProfilingSAB?.(profilingSAB);
    }

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

    renderer.onInputProcessed = () => { /* no-op */ };

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

    // --- HUD state polling (main thread) → write to PixiUI SAB + store ---
    hudInterval = setInterval(() => {
      const simReader = renderer.getSimReader() as SimBufferReader | null;
      if (!simReader || !simReader.isValid()) return;
      const playerSlot = simReader.getPlayerSlot(0);
      if (!playerSlot) return;
      const flags = playerSlot.u32[PLR.FLAGS];
      const s = useGameStore.getState();

      // Write to the zustand store (for main-thread consumers + change detection)
      s.setHudState({
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
        fishingTension: playerSlot.f32[GAME_PLR.FISHING_TENSION] ?? 50,
        fishingProgress: playerSlot.f32[GAME_PLR.FISHING_PROGRESS] ?? 0,
        activeSlot: playerSlot.u32[PLR.ACTIVE_SLOT] ?? 0,
        isPiloting: (flags & PLR_FLAG.PILOTING) !== 0,
        isOnboard: (flags & PLR_FLAG.ONBOARD) !== 0,
        gold: playerSlot.f32[GAME_PLR.GOLD] ?? 0,
        playerX: playerSlot.f32[PLR.POS_X],
        playerZ: playerSlot.f32[PLR.POS_Z],
        heading: playerSlot.f32[PLR.HEADING],
      });

      // Write to PixiUI SAB (per-frame scalars for the worker)
      const hud = s.hudState;
      pixiHost.writeStats({
        fps: s.fps,
        ready: s.ready ? 1 : 0,
        simReady: s.simReady ? 1 : 0,
        lutReady: s.lutReady ? 1 : 0,
        health: hud.health, maxHealth: hud.maxHealth,
        hunger: hud.hunger, thirst: hud.thirst,
        oxygen: hud.oxygen, maxOxygen: hud.maxOxygen,
        temperature: hud.temperature, timeOfDay: hud.timeOfDay,
        weatherType: hud.weatherType, biome: 0, security: 0,
        cameraMode: hud.cameraMode,
        isFishing: hud.isFishing ? 1 : 0,
        fishingTension: hud.fishingTension,
        fishingProgress: hud.fishingProgress,
        activeSlot: hud.activeSlot,
        isPiloting: hud.isPiloting ? 1 : 0,
        isOnboard: hud.isOnboard ? 1 : 0,
        gold: hud.gold,
        playerX: hud.playerX, playerZ: hud.playerZ, heading: hud.heading,
        showInventory: s.showInventory ? 1 : 0,
        showMap: s.showMap ? 1 : 0,
        showBuildMenu: s.showBuildMenu ? 1 : 0,
        showCraftMenu: s.showCraftMenu ? 1 : 0,
        showFishingMinigame: s.showFishingMinigame ? 1 : 0,
        showTradeMenu: s.showTradeMenu ? 1 : 0,
        showSettings: s.showSettings ? 1 : 0,
        showPauseMenu: s.showPauseMenu ? 1 : 0,
        showCharacterCustomization: s.showCharacterCustomization ? 1 : 0,
        showCredits: s.showCredits ? 1 : 0,
        showBuilderWheel: s.showBuilderWheel ? 1 : 0,
        hudHidden: s.hudHidden ? 1 : 0,
        pointerLocked: document.pointerLockElement ? 1 : 0,
        playerDied: s.playerDied ? 1 : 0,
        isDev: s.isDev ? 1 : 0,
        suppressPauseMenu: s.suppressPauseMenu ? 1 : 0,
        builderCellType: s.builderCellType,
        builderRotation: s.builderRotation,
        reticleSize: s.reticleSize,
        canvasW: canvas.width,
        canvasH: canvas.height,
      });

      const camMode = playerSlot.u32[PLR.CAMERA_MODE];
      if (camMode !== CameraMode.FreeCam && s.hudHidden) {
        s.setHudHidden(false);
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
    if (isDevMode && import.meta.hot) {
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
