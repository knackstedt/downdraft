import { bootstrapGame, downdraft } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { setupSandjonggMcp } from "./mcp/setup";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { autosave, decodeFields, decodeGrid, loadAutosave, loadHighScore, saveHighScore } from "./save-system";
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
  autosave: {
    load: loadAutosave,
    save: async () => {
      const renderer = useGameStore.getState().renderer;
      if (!renderer) return;
      const s = useGameStore.getState();
      if (s.paused) return;
      // Skip saving during level transitions. When the board is cleared
      // (tilesLeft === 0) the game is about to auto-advance; the board is
      // empty and saving it would persist a stuck state on reload (the
      // hasSeenTiles guard in app.tsx prevents auto-advance from firing on
      // an empty board, so the player would be stuck with no tiles). Also
      // skip when an advance/restart is pending — the worker is generating
      // a new board and the grid/board/score state is inconsistent.
      if (s.tilesLeft === 0 || s._pendingAdvance || s._pendingNewGame) return;
      const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
      const board = await renderer.getWorkerHost()?.getBoardState();
      if (s.highScore > 0) saveHighScore(s.highScore);
      await autosave(gridW, gridH, grid, fields, {
        score: s.score,
        level: s.level,
        combo: s.combo,
        highScore: s.highScore,
      }, board ?? null);
    },
    onLoad: async (saved) => {
      const renderer = useGameStore.getState().renderer;
      if (!renderer) return;
      const grid = decodeGrid(saved);
      const fields = decodeFields(saved);
      await renderer.loadSave(grid, fields, saved.gridW, saved.gridH);
      if (saved.board) {
        await renderer.getWorkerHost()?.loadBoardState(saved.board);
      }
      // Restore the worker's progress variables (level, score, combo) so
      // writeStats() reports the correct values to the SAB. Without this,
      // the worker keeps its init values (level=1, score=0) and the next
      // updateStatsFromSAB() overwrites the store back to level 1.
      await renderer.getWorkerHost()?.setProgress(saved.level, saved.score, saved.combo);
      useGameStore.getState().loadFullState({
        score: saved.score,
        level: saved.level,
        combo: saved.combo,
      });
      if (saved.highScore > 0) {
        useGameStore.getState().setHighScore(saved.highScore);
      }
      console.log("[autosave] Restored last session");
    },
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),

  // --- Deterministic mode: load high score in non-deterministic only ---
  onDeterministic: () => {
    // In deterministic mode, skip high score load
  },
}).then(() => {
  // Load high score from localStorage (non-deterministic only)
  const deterministic = downdraft?.deterministic === true;
  if (!deterministic) {
    const hs = loadHighScore();
    if (hs > 0) useGameStore.getState().setHighScore(hs);
  }
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
