// ============================================================================
// Shared GameModule — used by both desktop (main.tsx) and mobile (mobile.tsx)
// ============================================================================
//
// The renderer, sim, UI mount, and onReady wiring are identical across
// platforms. Desktop adds devtools + MCP + deterministic mode; mobile adds
// touch input + OSD. Those platform-specific bits are added by the
// respective entry points.
//
// Migrated from React DOM overlay to PixiJS-in-worker UI (@pixi/react via
// @downdraft/library-pixi-ui). The UI scene runs in a Web Worker on an
// OffscreenCanvas. State flows through UiStatsSAB + postMessage events;
// actions flow back via onAction.
//
// The overburden renderer (BlockheadsRenderer) manages its own
// BlockheadsWorkerHost internally inside renderer.init().
//

import { startGame, type GameModule, type GameSimWorker } from "@downdraft/app/renderer";
import {
    PixiUiHost,
    getEffectiveFontScale,
    loadUserFontScale,
    saveUserFontScale,
    type PixiUiAction,
} from "@downdraft/library-pixi-ui";
import { MapCanvas } from "./map-canvas";
import type { OverburdenAction, OverburdenEvent } from "./pixi/bridge-protocol";
import { OVERBURDEN_STATS_LAYOUT } from "./pixi/bridge-protocol";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { getBlockPalette } from "./shared/block-registry";
import { createMapSab } from "./shared/map-buffer";
import { createSimBuffer } from "./shared/sim-buffer";
import { getSeasonInfo } from "./simulation/season-system";
import { useGameStore, type BlockheadUIState } from "./stores/game-store";
import "./styles/globals.css";

class BlockheadsGameSim implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = createSimBuffer();
  }

  async start(_config: unknown): Promise<void> { }

  onEvent(_cb: (msg: any) => void): void { }

  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getInputBuffer(): SharedArrayBuffer { return this.sab; }
}

// ── Handles for hot-reload dispose ──
let pixiHost: PixiUiHost | null = null;
let mapCanvas: MapCanvas | null = null;
let statsRafId = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let markerInterval: ReturnType<typeof setInterval> | null = null;
let mapRegionInterval: ReturnType<typeof setInterval> | null = null;
let guiKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/**
 * Shared GameModule for overburden — used by both desktop and mobile.
 *
 * Desktop (main.tsx) adds: mcp, onDeterministic.
 * Mobile (mobile.tsx) adds: touchInput + OSD (via createDowndraftMobileApp).
 */
export const overburdenModule: GameModule<BlockheadsGameSim> = {
  renderer: (canvas) => new BlockheadsRenderer(canvas),
  sim: () => new BlockheadsGameSim(),
  simConfig: {},

  mountUI: () => { /* pixi-ui handles UI */ },

  onInit: async (ctx) => {
    const ok = await ctx.renderer.init();
    if (!ok) {
      console.error("WebGPU initialization failed");
      return false;
    }
    return true;
  },

  onReady: (ctx) => {
    const renderer = ctx.renderer as BlockheadsRenderer;
    useGameStore.getState().setRenderer(renderer);

    // Limit render rate to 60fps. Without this, the setTimeout-based rAF
    // (monkey-patched on mobile) runs at ~230fps, calling getCurrentTexture()
    // + queue.submit() 230 times/sec. The Android WebView compositor can only
    // present at 60Hz, causing swap chain congestion that periodically blocks
    // the main thread for 80-150ms.
    renderer.setFrameRateLimit(30);

    // --- Allocate the map SAB (shared between sim worker + main thread) ---
    // The sim worker writes per-block map data into it; the MapCanvas reads
    // it directly and renders the bitmap at full block resolution.
    const mapSab = createMapSab();

    // Pass the map SAB to the sim worker so getMapRegion can write into it.
    const workerHost = renderer.getWorkerHost();
    if (workerHost) workerHost.setMapSab(mapSab);

    // --- Create the 2D canvas map overlay (main thread) ---
    // Reads the map SAB directly, composites 4 planes into a bitmap, draws
    // via putImageData. No pixi worker involved.
    mapCanvas = new MapCanvas(mapSab, getBlockPalette());
    mapCanvas.mount();

    // --- Start the PixiJS UI overlay (HUD/menus, NOT the map) ---
    pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: OVERBURDEN_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi-scene.tsx", import.meta.url).href,
      passThrough: true,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
      fontScale: getEffectiveFontScale(loadUserFontScale()),
    });

    pixiHost.start().then(() => {
      console.log("[main] PixiUI overlay started");
    }, (e) => console.error("[main] PixiUI overlay failed:", e));

    pixiHost.onAction = (action: PixiUiAction) => {
      const a = action as OverburdenAction;
      const s = useGameStore.getState();
      const host = s.renderer?.getWorkerHost();
      switch (a.kind) {
        case "startGame":
          s.setShowTitleScreen(false);
          break;
        case "setPaused":
          s.setPaused(a.paused);
          break;
        case "toggleInventoryPanel":
          s.setShowInventoryPanel(!s.showInventoryPanel);
          break;
        case "setInventoryTab":
          s.setInventoryTab(a.tab);
          break;
        case "toggleTaskQueue":
          s.setShowTaskQueue(!s.showTaskQueue);
          break;
        case "setTaskMode":
          s.setTaskMode(a.mode);
          renderer.setTaskMode(a.mode);
          break;
        case "closeStation":
          s.setSelectedStation(null);
          break;
        case "craft":
          host?.craft(a.recipeId, a.ax, a.ay, s.activeBhIndex);
          break;
        case "rushCraft":
          host?.rushCraft(a.ax, a.ay, a.jobId, s.activeBhIndex);
          break;
        case "abortCraft":
          host?.abortCraft(a.ax, a.ay, a.jobId);
          break;
        case "addFuel":
          host?.addFuel(a.ax, a.ay, a.itemId, 1, s.activeBhIndex);
          break;
        case "giveItem":
          host?.giveItem(a.itemId, 99, s.activeBhIndex);
          break;
        case "moveSlot":
          host?.moveSlot(a.from, a.to, s.activeBhIndex);
          break;
        case "spawnBlockhead":
          host?.spawnBlockhead();
          break;
        case "setActiveBhIndex":
          renderer.setActiveBhIndex(a.index);
          s.setActiveBhIndex(a.index);
          break;
        case "resetGame":
          renderer.resetGame();
          break;
        case "saveNow":
          host?.saveNow();
          break;
        case "queueTask":
          host?.queueTask(a.type as any, { targetX: a.targetX, targetY: a.targetY }, s.activeBhIndex);
          break;
        case "cancelTask":
          host?.cancelTask(a.type as any, a.targetX, a.targetY, s.activeBhIndex);
          break;
        case "mapZoom": {
          const input = renderer.getInput();
          if (input) input.zoomDelta += a.delta;
          break;
        }
          break;
        case "toggleCameraDetached":
          renderer.camera.detached = !renderer.camera.detached;
          break;
        case "setFontScale": {
          const scale = getEffectiveFontScale(a.scale);
          pixiHost?.setFontScale(scale);
          saveUserFontScale(a.scale);
          break;
        }
        default:
          break;
      }
    };

    // --- GUI keyboard shortcuts (migrated from the old React app.tsx) ---
    // These toggle panels and modes by updating the game store directly.
    // The input-handler.ts keydown listener handles game controls (WASD,
    // 1-9, etc.) and runs separately — both fire for the same key, matching
    // the old behavior where the React keydown and the input handler's
    // keydown were both on window.
    guiKeyHandler = (e: KeyboardEvent) => {
      const s = useGameStore.getState();
      if (s.showTitleScreen) return;
      if (e.key === "Escape") {
        // Esc closes the inventory panel first, then toggles pause
        if (s.showInventoryPanel) {
          s.setShowInventoryPanel(false);
        } else {
          s.setPaused(!s.paused);
        }
      } else if (e.key === "i" || e.key === "I") {
        s.setShowInventoryPanel(!s.showInventoryPanel);
      } else if (e.key === "c" || e.key === "C") {
        // C opens the inventory panel on the Crafting tab
        // (if already on the crafting tab, toggle it closed)
        if (s.showInventoryPanel && s.inventoryTab === "crafting") {
          s.setShowInventoryPanel(false);
        } else {
          s.setShowInventoryPanel(true);
          s.setInventoryTab("crafting");
        }
      } else if (e.key === "q" || e.key === "Q") {
        s.setShowTaskQueue(!s.showTaskQueue);
      } else if (e.key === "t" || e.key === "T") {
        const newMode = !s.taskMode;
        s.setTaskMode(newMode);
        renderer.setTaskMode(newMode);
        if (!newMode) renderer.taskMarkers = [];
      } else if (e.key === "f" || e.key === "F") {
        // F toggles camera detach/attach
        const cam = renderer.camera;
        if (cam.detached) {
          cam.detached = false;
          cam.endPan();
        } else {
          cam.detached = true;
        }
      } else if (e.key === "F1") {
        e.preventDefault();
        const next = !renderer.getDebugNoShadows();
        renderer.setDebugNoShadows(next);
        console.log(`[Overburden] Fog-of-war + shadows ${next ? "disabled" : "enabled"} (F1)`);
      }
    };
    window.addEventListener("keydown", guiKeyHandler);

    // --- Per-frame stats loop ---
    const statsLoop = () => {
      const s = useGameStore.getState();
      const bh = s.blockheads[s.activeBhIndex] ?? s.blockheads[0];
      const canvas = renderer.getCanvas();
      const seasonIdx = ["spring", "summer", "autumn", "winter"].indexOf(s.season);
      pixiHost?.writeStats({
        fps: s.fps ?? 0,
        health: bh?.health ?? 100,
        hunger: bh?.hunger ?? 100,
        energy: bh?.energy ?? 100,
        air: bh?.air ?? 100,
        happiness: bh?.happiness ?? 100,
        environment: bh?.environment ?? 100,
        activeBhIndex: s.activeBhIndex,
        blockheadCount: s.blockheadCount,
        selectedSlot: s.selectedSlot,
        inventoryTab: ["inventory", "crafting", "creative"].indexOf(s.inventoryTab),
        showTitleScreen: s.showTitleScreen ? 1 : 0,
        paused: s.paused ? 1 : 0,
        showInventoryPanel: s.showInventoryPanel ? 1 : 0,
        showCraftPanel: s.showCraftPanel ? 1 : 0,
        showTaskQueue: s.showTaskQueue ? 1 : 0,
        taskMode: s.taskMode ? 1 : 0,
        deterministic: s.deterministic ? 1 : 0,
        hasSelectedStation: s.selectedStation ? 1 : 0,
        selectedStationAx: s.selectedStation?.ax ?? 0,
        selectedStationAy: s.selectedStation?.ay ?? 0,
        season: seasonIdx,
        dayInSeason: s.dayInSeason,
        year: s.year,
        characterGender: s.characterGender === "female" ? 1 : 0,
        cameraDetached: renderer.camera.detached ? 1 : 0,
        debugNoShadows: renderer.getDebugNoShadows() ? 1 : 0,
        debugInspect: 0,
        canvasW: canvas?.width ?? window.innerWidth,
        canvasH: canvas?.height ?? window.innerHeight,
        // Map-mode per-frame scalars for the 2D overlay (camera world pos,
        // zoom, cross-fade opacity, player world pos + facing).
        camWorldX: renderer.getCamWorld().x,
        camWorldY: renderer.getCamWorld().y,
        camZoom: renderer.getCamera().zoom,
        mapOpacity: renderer.getMapOpacity(),
        playerWorldX: renderer.getPlayerWorld().x,
        playerWorldY: renderer.getPlayerWorld().y,
        playerFacing: renderer.getPlayerFacing(),
      });

      // Update the 2D canvas map overlay (reads SAB directly, draws via
      // putImageData). Runs every frame for smooth camera tracking.
      mapCanvas?.update({
        camWorldX: renderer.getCamWorld().x,
        camWorldY: renderer.getCamWorld().y,
        camZoom: renderer.getCamera().zoom,
        mapOpacity: renderer.getMapOpacity(),
        playerWorldX: renderer.getPlayerWorld().x,
        playerWorldY: renderer.getPlayerWorld().y,
        playerFacing: renderer.getPlayerFacing(),
        skyColor: renderer.getSkyColor(),
      });

      statsRafId = requestAnimationFrame(statsLoop);
    };
    statsRafId = requestAnimationFrame(statsLoop);

    // --- Subscribe to store changes → forward structured data to worker ---
    let lastInvRef = "";
    let lastBhRef = "";
    let lastRecipesRef = "";
    let lastPickupsRef = "";
    let lastNotifRef = "";
    let lastStationRef = "";
    useGameStore.subscribe((s) => {
      // Inventory
      const invKey = JSON.stringify(s.inventory);
      if (invKey !== lastInvRef) {
        lastInvRef = invKey;
        pixiHost?.postEvent({ kind: "setInventory", inventory: s.inventory } as OverburdenEvent);
      }
      // Blockheads
      const bhKey = JSON.stringify(s.blockheads);
      if (bhKey !== lastBhRef) {
        lastBhRef = bhKey;
        pixiHost?.postEvent({ kind: "setBlockheads", blockheads: s.blockheads } as OverburdenEvent);
      }
      // Recipes
      const recKey = JSON.stringify(s.recipes);
      if (recKey !== lastRecipesRef) {
        lastRecipesRef = recKey;
        pixiHost?.postEvent({ kind: "setRecipes", recipes: s.recipes } as OverburdenEvent);
      }
      // Pickups
      const pkKey = JSON.stringify(s.pickups);
      if (pkKey !== lastPickupsRef) {
        lastPickupsRef = pkKey;
        pixiHost?.postEvent({ kind: "setPickups", pickups: s.pickups } as OverburdenEvent);
      }
      // Notification
      if (s.notification !== lastNotifRef) {
        lastNotifRef = s.notification ?? "";
        pixiHost?.postEvent({ kind: "setNotification", message: s.notification } as OverburdenEvent);
      }
      // Selected station
      const stKey = s.selectedStation ? `${s.selectedStation.ax},${s.selectedStation.ay}` : "";
      if (stKey !== lastStationRef) {
        lastStationRef = stKey;
        if (s.selectedStation) {
          // Poll craft queue for this station
          pollCraftQueue(s.selectedStation.ax, s.selectedStation.ay);
        }
      }
    });

    // --- Poll craft queue + tasks (250ms) ---
    async function pollCraftQueue(ax: number, ay: number): Promise<void> {
      const host = renderer.getWorkerHost();
      if (!host) return;
      try {
        const queue = await host.getCraftQueue(ax, ay);
        const sim = renderer.getSimReader();
        if (!sim) return;
        const blockId = sim.foreground[ay * 2048 + ax] ?? 0;
        const stationName = blockId > 0 ? `Station #${blockId}` : "Station";
        const activeJob = queue.activeJob;
        pixiHost?.postEvent({
          kind: "setCraftQueue",
          queue: {
            active: activeJob ? { jobId: activeJob.id, recipeId: activeJob.recipeId, recipeName: activeJob.recipeName, progress: activeJob.progress ?? 0, status: activeJob.status, rushable: false } : null,
            queued: queue.queue.map((j: any) => ({ jobId: j.id, recipeId: j.recipeId, recipeName: j.recipeName, progress: 0, status: j.status, rushable: false })),
            fuelCount: queue.fuel ?? 0,
            fuelMax: 0,
            stationName,
            stationFueled: queue.fuel > 0,
          },
        } as OverburdenEvent);
      } catch { /* station may have been destroyed */ }
    }

    pollInterval = setInterval(async () => {
      const s = useGameStore.getState();
      // Poll craft queue if station is selected
      if (s.selectedStation) {
        await pollCraftQueue(s.selectedStation.ax, s.selectedStation.ay);
      }
      // Poll tasks
      const host = renderer.getWorkerHost();
      if (host) {
        try {
          const tasks = await host.getTasks(s.activeBhIndex);
          pixiHost?.postEvent({
            kind: "setTasks",
            tasks: tasks.map((t: any) => ({
              id: t.id, type: t.type, targetX: t.targetX, targetY: t.targetY, blockId: t.blockId ?? 0, status: t.status,
            })),
          } as OverburdenEvent);
        } catch { /* ignore */ }
      }
      // Poll blockhead stats from the sim reader SAB (migrated from the old
      // app.tsx 250ms polling loop). The worker writes hunger/health/etc.
      // into the SAB each tick; we read them here and update the game store
      // so the stats loop forwards them to the pixi-ui worker for display.
      const reader = renderer.getSimReader();
      if (reader) {
        const count = reader.getBlockheadCount();
        if (count > 0) {
          const activeIdx = Math.min(renderer.getActiveBhIndex(), count - 1);
          const allBhs: BlockheadUIState[] = [];
          for (let i = 0; i < count; i++) {
            const bh = reader.getBlockhead(i);
            allBhs.push({
              health: bh[7], hunger: bh[8], energy: bh[9], air: bh[10],
              happiness: bh[11], environment: bh[12],
            });
          }
          // Only update the store if stats actually changed (avoids
          // unnecessary postMessage traffic to the pixi-ui worker).
          const prev = useGameStore.getState().blockheads;
          let changed = prev.length !== allBhs.length;
          if (!changed) {
            for (let i = 0; i < allBhs.length; i++) {
              const a = prev[i], b = allBhs[i];
              if (a.health !== b.health || a.hunger !== b.hunger ||
                  a.energy !== b.energy || a.air !== b.air ||
                  a.happiness !== b.happiness || a.environment !== b.environment) {
                changed = true; break;
              }
            }
          }
          if (changed) useGameStore.getState().setBlockheads(allBhs);
          // Sync blockhead count
          if (useGameStore.getState().blockheadCount !== count) {
            useGameStore.getState().setBlockheadCount(count);
          }
          // Sync active index (Tab cycling may have changed it)
          if (useGameStore.getState().activeBhIndex !== activeIdx) {
            useGameStore.getState().setActiveBhIndex(activeIdx);
          }
        }
      }
      // Sync selectedSlot from input → store (so the pixi-ui hotbar
      // highlights the keyboard-selected slot). The input handler sets
      // input.selectedSlot on 1-9 keydown; the store feeds the SAB stats
      // that the pixi-ui worker reads.
      const input = renderer.getInput();
      if (input) {
        const prevSlot = useGameStore.getState().selectedSlot;
        if (prevSlot !== input.selectedSlot) {
          useGameStore.getState().setSelectedSlot(input.selectedSlot);
        }
      }
    }, 250);

    // --- Task marker interval (200ms) ---
    markerInterval = setInterval(async () => {
      const s = useGameStore.getState();
      const host = renderer.getWorkerHost();
      if (!host) return;
      try {
        const tasks = await host.getTasks(s.activeBhIndex);
        const reader = renderer.getSimReader();
        if (!reader) return;
        const originCx = reader.getOriginCx();
        const originCy = reader.getOriginCy();
        // Check for failed tasks and show a notification
        const failed = tasks.find((t: any) => t.status === "failed" && t.failReason === "stuck");
        if (failed) {
          useGameStore.getState().setNotification("Blockhead is stuck — can't reach the target!");
        }
        // Rebuild markers from the task queue (world coords → active-grid)
        const markers = tasks
          .filter((t: any) => t.type === "MINE_BLOCK" || t.type === "MOVE_TO")
          .map((t: any) => ({
            x: t.targetX,
            y: t.targetY,
            type: t.type,
            gridX: t.targetX - originCx * 64,
            gridY: t.targetY - originCy * 64,
          }));
        pixiHost?.postEvent({ kind: "setTaskMarkers", markers } as OverburdenEvent);
        // Also update renderer.taskMarkers for the 3D scene (grid coords)
        renderer.taskMarkers = markers.map((m: any) => ({
          gridX: m.gridX, gridY: m.gridY, action: m.type === "MINE_BLOCK" ? "mine" : "move",
        }));
      } catch { /* ignore */ }
    }, 200);

    // --- Map-region refresh (500ms) ---
    // The renderer fetches a map region from the sim worker (which writes
    // per-block data directly into the map SAB). We forward just the
    // stations + cx0 to the MapCanvas — the per-block bitmap data is read
    // directly from the map SAB by MapCanvas.update() each frame.
    let mapWasVisible = false;
    function postMapRegion(): void {
      const opacity = renderer.getMapOpacity();
      if (opacity <= 0) { mapWasVisible = false; return; }
      if (!mapWasVisible) {
        renderer.refreshMapRegion();
        mapWasVisible = true;
      }
      // If we have new data, forward it. DON'T kick off a new refresh in the
      // same call — that would make the sim worker write to the SAB while
      // the main thread is reading it (torn read). The next 500ms cycle
      // will kick off the refresh.
      if (!renderer.isMapRegionDirty()) {
        renderer.refreshMapRegion();
        return;
      }
      const region = renderer.getMapRegionData();
      renderer.clearMapRegionDirty();
      if (!region) return;
      mapCanvas?.setRegion(region.cx0, region.stations);
    }
    mapRegionInterval = setInterval(postMapRegion, 500);
  },

  onFpsUpdate: (fps) => {
    if (useGameStore.getState().fps !== fps) {
      useGameStore.getState().setFps(fps);
    }
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    const simReader = renderer?.getSimReader();
    if (simReader) {
      const tick = simReader.getTick();
      const info = getSeasonInfo(tick);
      const prev = useGameStore.getState();
      if (prev.season !== info.season || prev.dayInSeason !== info.dayInSeason || prev.year !== info.year) {
        useGameStore.getState().setSeasonInfo(info.season, info.dayInSeason, info.year);
      }
    }
  },

  onDispose: async () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (markerInterval) { clearInterval(markerInterval); markerInterval = null; }
    if (mapRegionInterval) { clearInterval(mapRegionInterval); mapRegionInterval = null; }
    if (statsRafId) { cancelAnimationFrame(statsRafId); statsRafId = 0; }
    if (guiKeyHandler) { window.removeEventListener("keydown", guiKeyHandler); guiKeyHandler = null; }
    if (pixiHost) { pixiHost.dispose(); pixiHost = null; }
    if (mapCanvas) { mapCanvas.dispose(); mapCanvas = null; }
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    if (renderer) await renderer.shutdown();
  },
};

// Re-export startGame so desktop main.tsx can import it from here if desired.
export { startGame };
