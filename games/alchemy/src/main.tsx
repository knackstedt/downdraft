import { bootstrapGame } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { AlchemyRenderer } from "./renderer/alchemy-renderer";
import { useGameStore } from "./stores/game-store";
import { autosave, loadAutosave } from "./stores/save-system";
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

  // --- Renderer ---
  createRenderer: (canvas) => new AlchemyRenderer(canvas),
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
      clearSim: () => renderer.clearAll(),
      getExtra: () => {
        const store = useGameStore.getState();
        return {
          grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
          renderFPS: renderer.getFPS(),
          money: store.money,
          potions: store.potions.length,
          activeStation: store.activeStation,
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
            ["Money", String(extra.money ?? "—")],
            ["Potions", String(extra.potions ?? "—")],
            ["Station", extra.activeStation ?? "none"],
          ] as [string, string][];
        },
      }),
    ],
  },

  // --- Autosave ---
  autosave: {
    load: loadAutosave,
    save: async () => {
      const renderer = useGameStore.getState().renderer;
      if (!renderer) return;
      const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
      const s = useGameStore.getState();
      await autosave({
        gridW, gridH, grid, fields,
        money: s.money,
        ingredientInventory: s.ingredientInventory,
        potions: s.potions,
        unlockedTiers: s.unlockedTiers,
        discoveredRecipes: s.discoveredRecipes,
      });
    },
    onLoad: async (saved) => {
      const renderer = useGameStore.getState().renderer;
      if (!renderer) return;
      await renderer.loadSave(saved.grid, saved.fields, saved.gridW, saved.gridH);
      useGameStore.getState().loadFullState({
        money: saved.money,
        ingredientInventory: saved.ingredientInventory,
        potions: saved.potions,
        unlockedTiers: saved.unlockedTiers,
        discoveredRecipes: saved.discoveredRecipes,
      });
      console.log("[autosave] Restored last session");
    },
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
