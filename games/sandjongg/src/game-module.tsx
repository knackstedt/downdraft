// ============================================================================
// Shared GameModule — used by both desktop (main.tsx) and mobile (mobile.tsx)
// ============================================================================
//
// The renderer, sim, UI mount, and onReady wiring are identical across
// platforms. Desktop adds devtools + MCP; mobile adds touch input. Those
// platform-specific bits are added by the respective entry points.
//
// Migrated from PixiJS-in-worker UI to the engine-native imui stack
// (@downdraft/core/imui) — the UI renders onto the game canvas as part of
// the renderer's UI pass; no worker or extra overlay canvas is needed.
//

import type { GameModule } from "@downdraft/app/renderer";
import { AutosaveManager } from "@downdraft/app/renderer";
import { attachProfilerOverlay, wireProfilingBridge, type ProfilerOverlayHandle } from "@downdraft/module-devtools";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { refreshSaveAvailability } from "./save-load";
import { autosave, saveHighScore } from "./save-system";
import type { SandjonggWorkerHost } from "./simulation/sandjongg-worker-host";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";
import { createSandjonggUi } from "./ui/game-ui";

// ── Module-scoped handles (shared between onReady and onDispose) ──
let profilerOverlay: ProfilerOverlayHandle | null = null;
let autosaveManager: AutosaveManager | null = null;

// ── Auto-advance state (ported from the old React app.tsx useEffects) ──
// The UI shows a "Level Cleared! Advancing..." overlay when tilesLeft hits
// 0, but the actual advance request is game logic — reimplemented here as a
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
export const sandjonggModule: GameModule<SandjonggWorkerHost> = {
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
      tileCanvas.style.zIndex = "10"; // above the game canvas (imui hit-tests from window-level input)
      document.body.appendChild(tileCanvas);
    }
    return new SandjonggRenderer(canvas, tileCanvas);
  },
  // The renderer creates + starts its own SandjonggWorkerHost inside init()
  // (it also creates the grid pass and tile canvas pass there) — resolve it
  // after renderer init instead of declaring a sim factory.
  simFromRenderer: (r: SandjonggRenderer) => r.getWorkerHost() ?? undefined,

  // ── UI (engine-native imui, mounted in onReady) ──
  mountUI: () => { /* imui renders onto the game canvas — no DOM overlay needed */ },

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
    const profilingBridge = wireProfilingBridge({
      renderer,
      workerHosts: [{ host: renderer.getWorkerHost(), workerTag: "sandjongg-sim" }],
    });
    if (profilingBridge) {
      // --- Start the Profiler overlay (in-game profiling UI) ---
      // A second PixiUiHost on canvas layer 2 (above the game's pixi-ui layer 1)
      // that renders the ProfilerScene (memory/CPU/IOPS/flame-graph views +
      // warning toasts + record/export bar). Toggle with F10.
      profilerOverlay = attachProfilerOverlay({
        bridge: profilingBridge,
        sceneModuleUrl: new URL("./profiler-scene.ts", import.meta.url).href,
      });
    }

    // --- Mount the engine-native UI (imui draws onto the game canvas) ---
    renderer.useRendererModule(createSandjonggUi());

    // --- Subscribe to store changes for game-logic side effects ---
    useGameStore.subscribe((s) => {
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
    autosaveManager = new AutosaveManager({
      deterministic: ctx.deterministic === true,
      intervalMs: 3000,
      shouldSave: () => {
        const s = useGameStore.getState();
        if (s.paused || s.showMainMenu || s.showPauseMenu) return false;
        if (s.tilesLeft === 0 || s._pendingAdvance || s._pendingNewGame || s._pendingModeChange) return false;
        return true;
      },
      save: async () => {
        const s = useGameStore.getState();
        const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
        const board = await renderer.getWorkerHost()?.getBoardState();
        if (s.highScore > 0) saveHighScore(s.mode, s.highScore);
        await autosave({
          gridW, gridH, grid, fields,
          score: s.score, level: s.level, combo: s.combo, highScore: s.highScore,
          board: board ?? null, mode: s.mode, tileset: s.tileset, tileTheme: s.tileTheme,
        });
      },
    });
    autosaveManager.start();

    // --- Normal startup: show the main menu and pause the sim ---
    if (!ctx.deterministic) {
      useGameStore.setState({ showMainMenu: true });
      renderer?.getWorkerHost()?.pause();
      useGameStore.getState().setPaused(true);
      void refreshSaveAvailability();
    }
  },

  // ── Cleanup (hot-reload dispose) ──
  onDispose: () => {
    autosaveManager?.stop();
    autosaveManager = null;
    clearAdvanceTimers();
    hasSeenTiles = false;
    if (profilerOverlay) {
      profilerOverlay.dispose();
      profilerOverlay = null;
    }
  },

  // ── FPS polling ──
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
};
