import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { DevToolsDataBridge, type IDevToolsDataRenderer } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { useGameStore } from "./stores/game-store";
import { autosave, loadAutosave } from "./stores/save-system";
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

  const renderer = new FallingSandRenderer(canvas, deterministic);
  const ok = await renderer.init();
  if (!ok) {
    console.error("FallingSandRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  // --- DevTools data bridge: expose perf/GC/GPU metrics to the DevTools panel ---
  // Falling-sand doesn't use the full 3D scene inspector, but the data bridge
  // provides FPS, GC stats, and GPU system info to the DevTools panel.
  const dataRenderer: IDevToolsDataRenderer = {
    getFPS: () => renderer.getFPS(),
  };
  const devtoolsBridge = new DevToolsDataBridge();
  devtoolsBridge.init(dataRenderer);

  // --- Autoload: restore last session before starting the render loop ---
  if (!deterministic) {
    try {
      const saved = await loadAutosave();
      if (saved) {
        await renderer.loadSave(saved.grids, saved.fields, saved.gridW, saved.gridH);
        console.log("[autosave] Restored last session");
      }
    } catch (e) {
      console.warn("[autosave] Failed to load:", e);
    }
  }

  setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  renderer.start();

  // --- Autosave: persist game state every 3s (skip in deterministic/e2e mode) ---
  if (!deterministic) {
    setInterval(async () => {
      try {
        const { grids, fields, gridW, gridH } = renderer.snapshotGrids();
        await autosave(gridW, gridH, grids, fields);
      } catch (e) {
        console.warn("[autosave] Failed to save:", e);
      }
    }, AUTOSAVE_INTERVAL_MS);
  }
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
