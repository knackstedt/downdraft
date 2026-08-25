import { bootstrapGame } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { NUM_LAYERS, PLAYER } from "./shared/sim-buffer";
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
  createRenderer: (canvas) => {
    const deterministic = (window as any).downdraft?.deterministic === true;
    return new FallingSandRenderer(canvas, deterministic);
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
      clearSim: () => renderer.clearAll(),
      getExtra: () => {
        const host = renderer.getWorkerHost();
        const player = host ? {
          px: host.getPlayerF32(PLAYER.PX),
          py: host.getPlayerF32(PLAYER.PY),
          vx: host.getPlayerF32(PLAYER.VX),
          vy: host.getPlayerF32(PLAYER.VY),
          health: host.getPlayerI32(PLAYER.HEALTH),
          onGround: host.getPlayerI32(PLAYER.ON_GROUND) !== 0,
          facing: host.getPlayerI32(PLAYER.FACING),
        } : null;
        return {
          grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
          layers: NUM_LAYERS,
          renderFPS: renderer.getFPS(),
          player,
        };
      },
    }),
    panels: [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra as any;
          if (!extra) return [];
          const rows: [string, string][] = [
            ["Grid", extra.grid ?? "—"],
            ["Layers", String(extra.layers ?? "—")],
            ["Render FPS", String(extra.renderFPS ?? "—")],
          ];
          if (extra.player) {
            const p = extra.player;
            rows.push(
              ["Player Pos", `(${p.px.toFixed(1)}, ${p.py.toFixed(1)})`],
              ["Player Vel", `(${p.vx.toFixed(2)}, ${p.vy.toFixed(2)})`],
              ["Player Health", String(p.health)],
              ["On Ground", p.onGround ? "Yes" : "No"],
              ["Facing", p.facing > 0 ? "Right" : "Left"],
            );
          }
          return rows;
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
      const { grids, fields, gridW, gridH } = renderer.snapshotGrids();
      await autosave(gridW, gridH, grids, fields);
    },
    onLoad: async (saved) => {
      const renderer = useGameStore.getState().renderer;
      if (!renderer) return;
      await renderer.loadSave(saved.grids, saved.fields, saved.gridW, saved.gridH);
      console.log("[autosave] Restored last session");
    },
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
