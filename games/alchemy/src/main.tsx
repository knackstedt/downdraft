import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { type IDevToolsDataRenderer } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { AlchemyDevToolsBridge } from "./devtools/devtools-bridge";
import { AlchemyRenderer } from "./renderer/alchemy-renderer";
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

  const renderer = new AlchemyRenderer(canvas);
  const ok = await renderer.init();
  if (!ok) {
    console.error("AlchemyRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  const dataRenderer: IDevToolsDataRenderer = {
    getFPS: () => renderer.getFPS(),
  };
  const devtoolsBridge = new AlchemyDevToolsBridge(renderer);
  devtoolsBridge.init(dataRenderer);

  // Start the render loop immediately — don't let a hung autosave load
  // (e.g. IndexedDB locked by another process) block the canvas from rendering.
  renderer.start();

  setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  // Autoload (after the render loop is running, with a 5s timeout so a
  // locked IndexedDB doesn't block the autosave interval setup)
  if (!deterministic) {
    try {
      const saved = await Promise.race([
        loadAutosave(),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (saved) {
        await renderer.loadSave(saved.grid, saved.fields, saved.gridW, saved.gridH);
        useGameStore.getState().loadFullState({
          money: saved.money,
          ingredientInventory: saved.ingredientInventory,
          potions: saved.potions,
          unlockedTiers: saved.unlockedTiers,
          discoveredRecipes: saved.discoveredRecipes,
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
          money: s.money,
          ingredientInventory: s.ingredientInventory,
          potions: s.potions,
          unlockedTiers: s.unlockedTiers,
          discoveredRecipes: s.discoveredRecipes,
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
