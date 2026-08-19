import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider, initDevTools } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { MiningRenderer } from "./renderer/mining-renderer";
import { PLAYER, WORLD_SEED } from "./shared/constants";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

async function bootstrap() {
  const root = createRoot(getOverlay(0));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  const canvas = getCanvas(0);
  const deterministic = downdraft?.deterministic === true;

  const renderer = new MiningRenderer(canvas, deterministic);
  const ok = await renderer.init();
  if (!ok) {
    console.error("MiningRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  // --- DevTools: one-line wiring via initDevTools() ---
  const simStatsProvider = createSimStatsProvider({
    getWorkerHost: () => renderer.getWorkerHost(),
    getStorePaused: () => useGameStore.getState().paused,
    setStorePaused: (paused) => useGameStore.getState().setPaused(paused),
    getExtra: () => {
      const host = renderer.getWorkerHost();
      const store = useGameStore.getState();
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
        depth: store.depth,
        loadedChunks: store.loadedChunks,
        activeChunks: store.activeChunks,
        frozenChunks: store.loadedChunks - store.activeChunks,
        terrainSeed: WORLD_SEED,
        renderFPS: renderer.getFPS(),
        inventoryCount: store.inventory.reduce((sum, e) => sum + e.count, 0),
        inventoryTypes: store.inventory.length,
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
            ["Depth", String(extra.depth ?? "—")],
            ["Loaded Chunks", String(extra.loadedChunks ?? "—")],
            ["Active Chunks", String(extra.activeChunks ?? "—")],
            ["Frozen Chunks", String(extra.frozenChunks ?? "—")],
            ["Terrain Seed", String(extra.terrainSeed ?? "—")],
            ["Render FPS", String(extra.renderFPS ?? "—")],
            ["Inventory Items", String(extra.inventoryCount ?? "—")],
            ["Inventory Types", String(extra.inventoryTypes ?? "—")],
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

  const fpsInterval = setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  renderer.start();

  // Hot reload: dispose the old renderer before re-running bootstrap.
  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      clearInterval(fpsInterval);
      await renderer.stop();
    });
  }
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
