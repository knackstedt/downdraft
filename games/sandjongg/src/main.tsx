import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider, initDevTools } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { setupSandjonggMcp } from "./mcp/setup";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { autosave, loadAutosave } from "./save-system";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

const AUTOSAVE_INTERVAL_MS = 3000;

async function bootstrap() {
  const root = createRoot(getOverlay(0));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  const canvas = getCanvas(0);
  const deterministic = downdraft?.deterministic === true;

  // Create a second canvas for the tile overlay (Canvas2D).
  // The framework generates one canvas by default; we create a second one
  // positioned on top for the tile overlay.
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

  const renderer = new SandjonggRenderer(canvas, tileCanvas);
  const ok = await renderer.init();
  if (!ok) {
    console.error("SandjonggRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  // --- MCP automation harness (for e2e tests) ---
  setupSandjonggMcp(() => useGameStore.getState().renderer);

  // --- DevTools: one-line wiring via initDevTools() ---
  const simStatsProvider = createSimStatsProvider({
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
  });
  await initDevTools(renderer, {
    simStatsProvider,
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
  });

  // Start the render loop immediately.
  renderer.start();

  setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  // Autoload (after the render loop is running, with a 5s timeout).
  if (!deterministic) {
    try {
      const saved = await Promise.race([
        loadAutosave(),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (saved) {
        await renderer.loadSave(
          new Uint32Array(saved.grid),
          new Uint8Array(saved.fields),
          saved.gridW,
          saved.gridH,
        );
        useGameStore.getState().loadFullState({
          score: saved.score,
          level: saved.level,
          combo: saved.combo,
        });
        console.log("[autosave] Restored last session");
      }
    } catch (e) {
      console.warn("[autosave] Failed to load:", e);
    }
  }

  // Autosave
  if (!deterministic) {
    setInterval(async () => {
      try {
        const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
        const s = useGameStore.getState();
        await autosave(gridW, gridH, grid, fields, {
          score: s.score,
          level: s.level,
          combo: s.combo,
        });
      } catch (e) {
        console.warn("[autosave] Failed to save:", e);
      }
    }, AUTOSAVE_INTERVAL_MS);
  }
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
