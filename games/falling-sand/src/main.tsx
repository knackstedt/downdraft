import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider, initDevTools } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { NUM_LAYERS, PLAYER } from "./shared/sim-buffer";
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

  // --- DevTools: one-line wiring via initDevTools() ---
  // The sim stats provider handles 10Hz polling + pause/resume/step/speed/clear.
  // The Sim panel is declared via createSimStatsPanelExtension().
  const simStatsProvider = createSimStatsProvider({
    getWorkerHost: () => renderer.getWorkerHost(),
    getStorePaused: () => useGameStore.getState().paused,
    setStorePaused: (paused) => useGameStore.getState().setPaused(paused),
    clearSim: () => renderer.clearAll(),
    getExtra: (cached) => {
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
  });
  await initDevTools(renderer, {
    simStatsProvider,
    panels: [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra;
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
  });

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
