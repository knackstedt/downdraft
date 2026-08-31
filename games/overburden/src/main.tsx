// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from React DOM overlay to PixiJS-in-worker UI (@pixi/react via
// @downdraft/library-pixi-ui). The UI scene runs in a Web Worker on an
// OffscreenCanvas. State flows through UiStatsSAB + postMessage events;
// actions flow back via onAction.
//
// The overburden renderer (BlockheadsRenderer) manages its own
// BlockheadsWorkerHost internally inside renderer.init().
// ============================================================================

import { startGame, type GameSimWorker } from "@downdraft/app/renderer";
import {
    PixiUiHost,
    type PixiUiAction,
} from "@downdraft/library-pixi-ui";
import { setupBlockheadsMcp } from "./mcp/setup";
import type { OverburdenAction, OverburdenEvent } from "./pixi/bridge-protocol";
import { OVERBURDEN_STATS_LAYOUT } from "./pixi/bridge-protocol";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { getBlockDef } from "./shared/block-registry";
import { REGION_BLOCK_H, REGION_BLOCK_W, THUMB_H, THUMB_W } from "./shared/map-buffer";
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
let statsRafId = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let markerInterval: ReturnType<typeof setInterval> | null = null;
let mapRegionInterval: ReturnType<typeof setInterval> | null = null;
let guiKeyHandler: ((e: KeyboardEvent) => void) | null = null;

startGame({
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

    // --- Start the PixiJS UI overlay ---
    pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: OVERBURDEN_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi-scene.tsx", import.meta.url).href,
      passThrough: true,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
    });

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
        default:
          break;
      }
    };

    pixiHost.start().then(
      () => console.log("[main] PixiUI overlay started"),
      (e) => console.error("[main] PixiUI overlay failed:", e),
    );

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

    // --- Map-region → pixi-ui worker (500ms) ---
    // The renderer fetches a downsampled map region from the sim worker every
    // 2s and caches it (getMapRegionData / isMapRegionDirty). Here we convert
    // the cached region into a dense packed-color Uint32Array + station markers
    // and forward it to the pixi-ui worker so the 2D map overlay can render the
    // bitmap. Only posted when the map is visible (mapOpacity > 0) and the
    // region has changed since the last post — avoids wasted postMessage
    // traffic while in pure 3D block mode.
    const SKY_COLOR = 0x1a1a2e; // explored air (matches the 3D clear color)
    const STATION_COLOR = 0xffd700; // gold marker for crafting stations
    const expectedCells = REGION_BLOCK_W * REGION_BLOCK_H;
    // Track whether the map was visible last cycle — when it first appears,
    // clear stale region data and force a fresh fetch so the bitmap is
    // centered on the current camera position, not a stale fetch from a
    // previous visibility period.
    let mapWasVisible = false;
    function postMapRegion(): void {
      if (!pixiHost) return;
      const opacity = renderer.getMapOpacity();
      if (opacity <= 0) { mapWasVisible = false; return; }
      // On first appearance (or re-appearance), clear the store's stale
      // mapRegion so the MapOverview doesn't render the bitmap with a wrong
      // cx0 (which would position it off-screen). The background still
      // renders for the crossfade; the bitmap appears once fresh data
      // arrives (~500ms when the async fetch completes).
      if (!mapWasVisible) {
        pixiHost.postEvent({
          kind: "setMapRegion",
          cells: new Uint32Array(0),
          cx0: 0,
          stations: [],
        } as OverburdenEvent);
        renderer.refreshMapRegion();
        mapWasVisible = true;
      }
      // Always kick off a refresh so the region stays current while the map
      // is visible (the renderer's own 2s timer is too slow during active
      // panning). refreshMapRegion is a no-op if a fetch is already in flight.
      renderer.refreshMapRegion();
      if (!renderer.isMapRegionDirty()) return;
      const region = renderer.getMapRegionData();
      renderer.clearMapRegionDirty();
      if (!region) return;
      // Build the dense packed-color bitmap in image order (row-major over
      // the REGION_BLOCK_W × REGION_BLOCK_H pixel grid) so the overlay can
      // blit cells[i] straight into ImageData pixel i. The source grids are
      // laid out as ((chunkRow * cols + chunkCol) * THUMB_H + thumbTy) *
      // THUMB_W + thumbTx (see shared/map-buffer.ts thumbIndex), so we iterate
      // in that order and compute the matching image index.
      const cols = region.cols;
      const rows = region.rows;
      const cells = new Uint32Array(expectedCells);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          for (let ty = 0; ty < THUMB_H; ty++) {
            const imgY = row * THUMB_H + ty;
            const imgRowBase = imgY * REGION_BLOCK_W + col * THUMB_W;
            const srcRowBase = ((row * cols + col) * THUMB_H + ty) * THUMB_W;
            for (let tx = 0; tx < THUMB_W; tx++) {
              const ti = srcRowBase + tx;
              if (region.explored[ti] === 0) continue; // 0 = fog (unexplored)
              const repBlock = region.blockIds[ti];
              let packed: number;
              if (repBlock === 0) {
                packed = SKY_COLOR;
              } else {
                const def = getBlockDef(repBlock);
                const c = def?.color ?? [0, 0, 0];
                packed = (c[0] << 16) | (c[1] << 8) | c[2];
              }
              cells[imgRowBase + tx] = packed;
            }
          }
        }
      }
      const stations = region.stations.map((s) => ({
        x: s.wx, y: s.wy, color: STATION_COLOR,
      }));
      pixiHost.postEvent({
        kind: "setMapRegion",
        cells,
        cx0: region.cx0,
        stations,
      } as OverburdenEvent);
    }
    mapRegionInterval = setInterval(postMapRegion, 500);
  },

  mcp: () => setupBlockheadsMcp(() => useGameStore.getState().renderer as BlockheadsRenderer | null),

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
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    if (renderer) await renderer.shutdown();
  },

  onDeterministic: (ctx) => {
    ctx.renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused");
    useGameStore.getState().setDeterministic(true);
    useGameStore.getState().setShowTitleScreen(false);
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
