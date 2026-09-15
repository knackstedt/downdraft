// ============================================================================
// Shared GameModule — used by both desktop (main.tsx) and mobile (mobile.tsx)
// ============================================================================
//
// The renderer, sim, UI mount, and onReady wiring are identical across
// platforms. Desktop adds devtools + MCP; mobile adds touch input. Those
// platform-specific bits are added by the respective entry points.
//
// Migrated from React DOM overlay to PixiJS-in-worker UI
// (@downdraft/library-pixi-ui). The UI scene runs in a Web Worker on an
// OffscreenCanvas stacked above the game canvas.
//

import type { GameModule, GameSimWorker } from "@downdraft/app/renderer";
import { PixiUiHost, getEffectiveFontScale, loadUserFontScale, saveUserFontScale, type PixiUiAction } from "@downdraft/library-pixi-ui";
import type { SandjonggAction } from "./pixi/bridge-protocol";
import { SANDJONGG_STATS_LAYOUT } from "./pixi/bridge-protocol";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { continueMode, returnToMainMenu, startNewGame } from "./save-load";
import { autosave, saveHighScore } from "./save-system";
import { allocateSimBuffer } from "./shared/sim-buffer";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

/**
 * SandjonggGameSim — adapter that satisfies the GameSimWorker interface.
 *
 * The sandjongg renderer creates and manages its own SandjonggWorkerHost
 * inside renderer.init() (it also creates the grid pass and tile canvas pass
 * there). This adapter provides the SAB that startGame()/createDowndraftMobileApp()
 * captures for ctx.simSAB/ctx.inputSAB, but does NOT spawn a worker — the
 * renderer's internal worker is the real simulation.
 */
export class SandjonggGameSim implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = allocateSimBuffer();
  }

  async start(_config: unknown): Promise<void> {
    // No-op: the renderer creates and starts its own SandjonggWorkerHost
    // inside renderer.init(). This adapter only provides the SAB interface.
  }

  onEvent(_cb: (msg: any) => void): void {
    // No-op: sim→renderer events are handled by the renderer's internal
    // SandjonggWorkerHost. Sandjongg does not use the GameModule declarative
    // events map.
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  getInputBuffer(): SharedArrayBuffer {
    return this.sab;
  }
}

// ── PixiUI host handle (shared between onReady and onDispose) ──
let pixiHost: PixiUiHost | null = null;
let profilerHost: PixiUiHost | null = null;
let statsRafId = 0;
let autosaveInterval: ReturnType<typeof setInterval> | null = null;

// ── Auto-advance state (ported from the old React app.tsx useEffects) ──
// The PixiJS UI scene shows a "Level Cleared! Advancing..." overlay when
// tilesLeft hits 0, but the actual advance request must come from the main
// thread. This was previously a pair of useEffects in app.tsx; it was lost
// in the migration to the PixiJS-in-worker UI and is reimplemented here as a
// store subscription.
let hasSeenTiles = false;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let advanceRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearAdvanceTimers(): void {
  if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  if (advanceRetryTimer) { clearTimeout(advanceRetryTimer); advanceRetryTimer = null; }
}

/**
 * Shared GameModule for sandjongg — used by both desktop and mobile.
 *
 * Desktop (main.tsx) adds: devtools, MCP, onDeterministic.
 * Mobile (mobile.tsx) adds: touchInput (via createDowndraftMobileApp).
 */
export const sandjonggModule: GameModule<SandjonggGameSim> = {
  // ── Renderer + Sim ──
  // Create a second canvas for the tile overlay (Canvas2D) before constructing
  // the renderer, which takes ownership of it.
  renderer: (canvas) => {
    let tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
    if (!tileCanvas) {
      tileCanvas = document.createElement("canvas");
      tileCanvas.id = "sandjongg-tile-canvas";
      tileCanvas.style.position = "absolute";
      tileCanvas.style.top = "0";
      tileCanvas.style.left = "0";
      tileCanvas.style.width = "100%";
      tileCanvas.style.height = "100%";
      tileCanvas.style.pointerEvents = "auto";
      tileCanvas.style.zIndex = "10"; // below pixi-ui canvas (z-index: 50)
      document.body.appendChild(tileCanvas);
    }
    return new SandjonggRenderer(canvas, tileCanvas);
  },
  sim: () => new SandjonggGameSim(),
  simConfig: {},

  // ── UI (PixiJS-in-worker, mounted in onReady) ──
  mountUI: () => { /* pixi-ui handles UI — no DOM overlay needed */ },

  // ── Renderer init (creates + starts the internal sim worker) ──
  onInit: async (ctx) => {
    const ok = await ctx.renderer.init();
    if (!ok) {
      console.error("WebGPU initialization failed");
      return false;
    }
    return true;
  },

  // ── Post-init wiring ──
  onReady: (ctx) => {
    const renderer = ctx.renderer as SandjonggRenderer;
    useGameStore.getState().setRenderer(renderer);

    // --- Wire the ProfilingBridge into the render loop (if profiling is enabled) ---
    // The ProfilingBridge is created by initDevTools({ profiling: true }) in
    // bootstrapGame. It's exposed on window.__sceneInspector.__getProfilingBridge().
    const profilingBridge = (window as any).__sceneInspector?.__getProfilingBridge?.();
    if (profilingBridge) {
      const prevCallbacks = renderer.getCallbacks?.() ?? {};
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
      // Share the ProfilingSAB with the sandjongg sim worker
      const profilingSAB = profilingBridge.getProfilingSAB();
      const profilingLayout = profilingBridge.getLayoutParams?.();
      renderer.getWorkerHost()?.attachProfilingSAB?.(profilingSAB, profilingLayout);

      // --- Start the Profiler overlay (in-game profiling UI) ---
      // A second PixiUiHost on canvas layer 2 (above the game's pixi-ui layer 1)
      // that renders the ProfilerScene (memory/CPU/IOPS/flame-graph views +
      // warning toasts + record/export bar). Toggle with F12.
      profilerHost = new PixiUiHost({
        backend: "webgl2",
        sceneModuleUrl: new URL("./profiler-scene.ts", import.meta.url).href,
        sceneConfig: {
          views: (window as any).__sceneInspector?.__getViews?.() ?? [],
          layout: profilingBridge.getLayoutParams?.(),
        },
        extraSharedBuffers: { profiling: profilingSAB },
        passThrough: true,
        canvasLayer: 2,
        canvasId: "profiler-canvas",
      });
      profilerHost.start().then(() => {
        console.log("[profiler] Profiler overlay started — press F10 to toggle");
        // Hide the profiler canvas by default (toggle with F10)
        const canvas = document.getElementById("profiler-canvas") as HTMLCanvasElement | null;
        if (canvas) canvas.style.display = "none";
      }, (e) => console.error("[profiler] Profiler overlay failed to start:", e));

      // F10 toggles the profiler overlay visibility
      const toggleProfiler = (e: KeyboardEvent) => {
        if (e.key === "F10") {
          e.preventDefault();
          const canvas = document.getElementById("profiler-canvas") as HTMLCanvasElement | null;
          if (canvas) {
            const isHidden = canvas.style.display === "none";
            canvas.style.display = isHidden ? "block" : "none";
          }
        }
      };
      window.addEventListener("keydown", toggleProfiler);
    }

    // --- Start the PixiJS UI overlay ---
    pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: SANDJONGG_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
      passThrough: true, // interactive UI regions + tile-canvas clicks
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
      fontScale: getEffectiveFontScale(loadUserFontScale()),
    });

    // Handle worker→main actions (buttons, menu nav, game requests).
    pixiHost.onAction = (action: PixiUiAction) => {
      const a = action as SandjonggAction;
      const s = useGameStore.getState();
      switch (a.kind) {
        case "startNewGame":
          startNewGame(a.mode);
          break;
        case "continueMode":
          void continueMode(a.mode);
          break;
        case "openPauseMenu": {
          const r = s.renderer;
          r?.getWorkerHost()?.pause();
          s.setPaused(true);
          s.setShowPauseMenu(true);
          break;
        }
        case "closePauseMenu": {
          const r = s.renderer;
          r?.getWorkerHost()?.resume();
          s.setPaused(false);
          s.setShowPauseMenu(false);
          break;
        }
        case "restartLevel":
          s.requestNewGame(s.level);
          s.setShowPauseMenu(false);
          s.renderer?.getWorkerHost()?.resume();
          s.setPaused(false);
          break;
        case "clearPit":
          s.requestClearSand();
          s.setShowPauseMenu(false);
          s.renderer?.getWorkerHost()?.resume();
          s.setPaused(false);
          break;
        case "toggleNoAdjacent":
          s.toggleNoAdjacentSame();
          break;
        case "toggleSand":
          s.toggleSandEnabled();
          break;
        case "openSettings":
          s.setShowPauseMenu(false);
          s.toggleSettings();
          break;
        case "openHelp":
          s.setShowPauseMenu(false);
          s.toggleHelp();
          break;
        case "returnToMainMenu":
          returnToMainMenu();
          break;
        case "requestHint":
          s.requestHint();
          break;
        case "requestShuffle":
          s.requestShuffle();
          break;
        case "toggleDebugMode":
          s.toggleDebugMode();
          break;
        case "setTileset":
          s.setTileset(a.tileset);
          break;
        case "setTileTheme":
          s.setTileTheme(a.theme);
          break;
        case "setCustomDims":
          s.setCustomDims(a.cols, a.rows);
          break;
        case "closePanel":
          if (a.panel === "help") useGameStore.setState({ showHelp: false });
          else if (a.panel === "settings") useGameStore.setState({ showSettings: false });
          break;
        case "setFontScale": {
          const scale = getEffectiveFontScale(a.scale);
          pixiHost?.setFontScale(scale);
          saveUserFontScale(a.scale);
          break;
        }
      }
    };

    // Start the host (async, but we don't need to await in onReady)
    pixiHost.start().then(
      () => console.log("[main] PixiUI overlay started"),
      (e) => console.error("[main] PixiUI overlay failed to start:", e),
    );

    // --- Per-frame stats loop (writes UiStatsSAB from the game store) ---
    const statsLoop = () => {
      const s = useGameStore.getState();
      const canvas = renderer.getCanvas();
      pixiHost?.writeStats({
        fps: s.fps ?? 0,
        score: s.score,
        combo: s.combo,
        level: s.level,
        tilesLeft: s.tilesLeft,
        highScore: s.highScore,
        paused: s.paused ? 1 : 0,
        mode: s.mode === "mahjongg" ? 1 : 0,
        sandEnabled: s.sandEnabled ? 1 : 0,
        showMainMenu: s.showMainMenu ? 1 : 0,
        showPauseMenu: s.showPauseMenu ? 1 : 0,
        showHelp: s.showHelp ? 1 : 0,
        showSettings: s.showSettings ? 1 : 0,
        debugMode: s.debugMode ? 1 : 0,
        noAdjacentSame: s.noAdjacentSame ? 1 : 0,
        tileset: s.tileset === "riichi" ? 1 : 0,
        tileTheme: s.tileTheme === "dark" ? 1 : 0,
        customCols: s.customCols,
        customRows: s.customRows,
        lastMatchTime: s.lastMatchTime,
        canvasW: canvas?.clientWidth ?? window.innerWidth,
        canvasH: canvas?.clientHeight ?? window.innerHeight,
      });
      statsRafId = requestAnimationFrame(statsLoop);
    };
    statsRafId = requestAnimationFrame(statsLoop);

    // --- Subscribe to store changes → forward structured data to worker ---
    let lastToastId = -1;
    let lastDebugTileRef: unknown = null;
    let lastHasSaveRef = "";
    useGameStore.subscribe((s) => {
      // Toast
      if (s.toast && s.toast.id !== lastToastId) {
        lastToastId = s.toast.id;
        pixiHost?.postEvent({ kind: "showToast", message: s.toast.message, id: s.toast.id });
      } else if (!s.toast && lastToastId !== -1) {
        lastToastId = -1;
        pixiHost?.postEvent({ kind: "showToast", message: "", id: -1 });
      }
      // Debug tile
      if (s.debugTile !== lastDebugTileRef) {
        lastDebugTileRef = s.debugTile;
        pixiHost?.postEvent({ kind: "setDebugTile", tile: s.debugTile });
      }
      // Has save
      const hasSaveKey = `${s.hasSave.sandjongg}|${s.hasSave.mahjongg}`;
      if (hasSaveKey !== lastHasSaveRef) {
        lastHasSaveRef = hasSaveKey;
        pixiHost?.postEvent({ kind: "setHasSave", hasSave: s.hasSave });
      }

      // Auto-advance to next level when the board is cleared.
      // Uses requestAdvance (not requestNewGame) so the score is preserved.
      // Only fire after the game has initialized (hasSeenTiles) so we don't
      // auto-advance through empty levels during startup (the store starts
      // with tilesLeft=0). Skipped while any menu is open, and while a
      // pending advance/new-game/mode-change is already in flight (prevents
      // the stuck-pending-flag retry loop that originally plagued startup).
      if (s.tilesLeft > 0) hasSeenTiles = true;
      const shouldAdvance =
        s.tilesLeft === 0 && s.level > 0 && hasSeenTiles &&
        !s.showMainMenu && !s.showPauseMenu &&
        !s._pendingAdvance && !s._pendingNewGame && !s._pendingModeChange;
      if (shouldAdvance) {
        // Board cleared — wait a moment for sand to fall, then advance.
        if (!advanceTimer) {
          advanceTimer = setTimeout(() => {
            advanceTimer = null;
            const cur = useGameStore.getState();
            if (cur.tilesLeft === 0 && !cur.showMainMenu && !cur.showPauseMenu) {
              cur.requestAdvance(cur.level + 1);
            }
          }, 2000);
        }
        // Safety net: if tilesLeft is still 0 after 6s (advance didn't take
        // effect — e.g. the SAB action was lost or the worker was busy),
        // retry the advance.
        if (!advanceRetryTimer) {
          advanceRetryTimer = setTimeout(() => {
            advanceRetryTimer = null;
            const cur = useGameStore.getState();
            if (cur.tilesLeft === 0) {
              console.warn("[sandjongg] auto-advance retry: tilesLeft still 0 after 6s");
              cur.requestAdvance(cur.level + 1);
            }
          }, 6000);
        }
      } else {
        clearAdvanceTimers();
      }
    });

    // --- Autosave (manual) ---
    // Loading is deferred to the main menu: the player picks a mode, then
    // continueMode()/startNewGame() (in save-load.ts) load that mode's save.
    // Here we only set up the periodic save interval (skipped in deterministic
    // mode, matching the bootstrap autosave behavior).
    if (!ctx.deterministic) {
      let saveInProgress = false;
      autosaveInterval = setInterval(async () => {
        if (saveInProgress) return;
        saveInProgress = true;
        try {
          const s = useGameStore.getState();
          if (s.paused || s.showMainMenu || s.showPauseMenu) return;
          if (s.tilesLeft === 0 || s._pendingAdvance || s._pendingNewGame || s._pendingModeChange) return;
          const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
          const board = await renderer.getWorkerHost()?.getBoardState();
          if (s.highScore > 0) saveHighScore(s.mode, s.highScore);
          await autosave({
            gridW, gridH, grid, fields,
            score: s.score, level: s.level, combo: s.combo, highScore: s.highScore,
            board: board ?? null, mode: s.mode, tileset: s.tileset, tileTheme: s.tileTheme,
          });
        } catch (e) {
          console.warn("[main] Autosave save failed:", e);
        } finally {
          saveInProgress = false;
        }
      }, 3000);
    }

    // --- Normal startup: show the main menu and pause the sim ---
    if (!ctx.deterministic) {
      useGameStore.setState({ showMainMenu: true });
      renderer?.getWorkerHost()?.pause();
      useGameStore.getState().setPaused(true);
    }
  },

  // ── Cleanup (hot-reload dispose) ──
  onDispose: () => {
    if (autosaveInterval) {
      clearInterval(autosaveInterval);
      autosaveInterval = null;
    }
    clearAdvanceTimers();
    hasSeenTiles = false;
    if (statsRafId) {
      cancelAnimationFrame(statsRafId);
      statsRafId = 0;
    }
    if (pixiHost) {
      pixiHost.dispose();
      pixiHost = null;
    }
    if (profilerHost) {
      profilerHost.dispose();
      profilerHost = null;
    }
  },

  // ── FPS polling ──
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
};
