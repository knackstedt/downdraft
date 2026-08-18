import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { type IDevToolsDataRenderer } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { FallingSandDevToolsBridge } from "./devtools/devtools-bridge";
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

  // --- DevTools bridge: expose sim stats + controls to the DevTools panel ---
  // Falling-sand doesn't use the full 3D scene inspector, but the bridge
  // provides FPS, GC stats, GPU system info, and sim stats/controls
  // (pause/resume/step/speed/clear) to the DevTools panel.
  const dataRenderer: IDevToolsDataRenderer = {
    getFPS: () => renderer.getFPS(),
  };
  const devtoolsBridge = new FallingSandDevToolsBridge(renderer);
  devtoolsBridge.init(dataRenderer);

  // Start the render loop immediately — don't let a hung autosave load
  // (e.g. IndexedDB locked by another process) block the canvas from rendering.
  renderer.start();

  setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  // --- Autoload: restore last session (after the render loop is running,
  // so a hung/slow IndexedDB access doesn't leave the canvas black).
  // A 5s timeout prevents a locked IndexedDB from blocking the autosave
  // interval setup. ---
  if (!deterministic) {
    try {
      const saved = await Promise.race([
        loadAutosave(),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (saved) {
        await renderer.loadSave(saved.grids, saved.fields, saved.gridW, saved.gridH);
        console.log("[autosave] Restored last session");
      }
    } catch (e) {
      console.warn("[autosave] Failed to load:", e);
    }
  }

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
