import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider, initDevTools } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { MiningRenderer } from "./renderer/mining-renderer";
import { PLAYER, WORLD_SEED } from "./shared/constants";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

// --- Solid-in-worker UI host ---
// The SolidHost implementation lives in ./solid/host, which is part of the
// Solid tsconfig project (games/mining-rpg/src/solid/tsconfig.json). We use
// a static import so Vite bundles it correctly, and suppress the TS6307
// error (file not in web tsconfig's include) with @ts-ignore — the solid
// files are type-checked by their own tsconfig.
// @ts-ignore — solid/host.ts is in the solid tsconfig project, not web
import { SolidHost } from "./solid/host";

async function bootstrap() {
  const canvas = getCanvas(0);
  const deterministic = downdraft?.deterministic === true;

  const renderer = new MiningRenderer(canvas, deterministic);
  const ok = await renderer.init();
  if (!ok) {
    console.error("MiningRenderer init failed");
    // TEMP: Allow bypassing GPU init for browser preview testing
    if (!location.search.includes("nogpu")) return;
  }

  useGameStore.getState().setRenderer(renderer);

  // --- UI mode: Solid-in-worker (default) or React fallback ---
  // Set USE_REACT_UI=1 in the environment to fall back to the React UI.
  const useReactUI = (globalThis as any).__USE_REACT_UI === true;
  let solidHost: SolidHost | null = null;

  if (!useReactUI) {
    // --- Solid-in-worker path ---
    try {
      solidHost = new SolidHost({ renderer, reactStore: useGameStore });
      await solidHost.start();
      console.log("[main] Solid-in-worker UI started");
    } catch (e) {
      console.error("[main] Solid UI failed, falling back to React:", e);
      solidHost?.dispose();
      solidHost = null;
    }
  }

  if (!solidHost) {
    // --- React fallback path ---
    const root = createRoot(getOverlay(0));
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }

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

  // Hot reload: dispose the old renderer + solid host before re-running bootstrap.
  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      clearInterval(fpsInterval);
      solidHost?.dispose();
      await renderer.stop();
    });
  }
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
