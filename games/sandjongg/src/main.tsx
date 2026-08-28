import { bootstrapGame, downdraft } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { setupSandjonggMcp } from "./mcp/setup";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { applySave } from "./save-load";
import { autosave, loadHighScore, saveHighScore } from "./save-system";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

bootstrapGame({
  // --- UI (React) ---
  mountUI: (overlay) => {
    const root = createRoot(overlay);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  },

  // --- Renderer (creates a second canvas for tile overlay) ---
  createRenderer: (canvas) => {
    // Create a second canvas for the tile overlay (Canvas2D).
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
      tileCanvas.style.zIndex = "50";
      document.body.appendChild(tileCanvas);
    }
    return new SandjonggRenderer(canvas, tileCanvas);
  },
  initRenderer: (renderer) => renderer.init(),
  onRendererInit: (renderer) => {
    useGameStore.getState().setRenderer(renderer);
  },

  // --- DevTools ---
  devtools: {
    createSimStatsProvider: (renderer) => createSimStatsProvider({
      getWorkerHost: () => renderer.getWorkerHost(),
      getStorePaused: () => useGameStore.getState().paused,
      setStorePaused: (paused) => useGameStore.getState().setPaused(paused),
      clearSim: () => renderer.getWorkerHost()?.requestClearSand(),
      getExtra: () => {
        const store = useGameStore.getState();
        return {
          grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
          renderFPS: renderer.getFPS(),
          score: store.score,
          level: store.level,
          tilesLeft: store.tilesLeft,
          combo: store.combo,
        };
      },
    }),
    panels: [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra as any;
          if (!extra) return [];
          return [
            ["Grid", extra.grid ?? "—"],
            ["Render FPS", String(extra.renderFPS ?? "—")],
            ["Score", String(extra.score ?? "—")],
            ["Level", String(extra.level ?? "—")],
            ["Tiles Left", String(extra.tilesLeft ?? "—")],
            ["Combo", String(extra.combo ?? "—")],
          ] as [string, string][];
        },
      }),
    ],
  },

  // --- MCP ---
  mcp: () => setupSandjonggMcp(() => useGameStore.getState().renderer),

  // --- Autosave ---
  // Loading is deferred to the main menu: the player picks a mode, then
  // continueMode()/startNewGame() (in save-load.ts) load that mode's save.
  // Here `load` returns null so bootstrap doesn't auto-restore anything.
  autosave: {
    load: async () => null,
    save: async () => {
      const renderer = useGameStore.getState().renderer;
      if (!renderer) return;
      const s = useGameStore.getState();
      // Don't save while in menus or paused.
      if (s.paused || s.showMainMenu || s.showPauseMenu) return;
      // Skip saving during level transitions. When the board is cleared
      // (tilesLeft === 0) the game is about to auto-advance; the board is
      // empty and saving it would persist a stuck state on reload (the
      // hasSeenTiles guard in app.tsx prevents auto-advance from firing on
      // an empty board, so the player would be stuck with no tiles). Also
      // skip when an advance/restart/mode-change is pending — the worker is
      // generating a new board and the grid/board/score state is inconsistent.
      if (s.tilesLeft === 0 || s._pendingAdvance || s._pendingNewGame || s._pendingModeChange) return;
      const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
      const board = await renderer.getWorkerHost()?.getBoardState();
      if (s.highScore > 0) saveHighScore(s.mode, s.highScore);
      await autosave({
        gridW, gridH, grid, fields,
        score: s.score,
        level: s.level,
        combo: s.combo,
        highScore: s.highScore,
        board: board ?? null,
        mode: s.mode,
        tileset: s.tileset,
        tileTheme: s.tileTheme,
      });
    },
    onLoad: async (saved) => {
      // Not reached (load returns null), but kept for completeness — if the
      // bootstrap contract ever calls onLoad, apply the save in the saved mode.
      await applySave(saved);
    },
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),

  // --- Deterministic mode: load high score in non-deterministic only ---
  onDeterministic: () => {
    // In deterministic mode, skip high score load (per-mode loads happen on
    // mode select in save-load.ts).
  },
}).then(() => {
  const deterministic = downdraft?.deterministic === true;
  if (deterministic) {
    // E2E / deterministic mode: skip the main menu and boot straight into
    // the default sandjongg mode so existing smoke tests keep working. The
    // worker has already generated level 1 in sandjongg mode at init.
    useGameStore.setState({ showMainMenu: false, mode: "sandjongg" });
  } else {
    // Normal startup: show the main menu and pause the sim so no sand
    // falls while the player picks a mode. startNewGame()/continueMode()
    // resume it once a mode is chosen.
    useGameStore.setState({ showMainMenu: true });
    const r = useGameStore.getState().renderer;
    r?.getWorkerHost()?.pause();
    useGameStore.getState().setPaused(true);
  }
  void loadHighScore;
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
