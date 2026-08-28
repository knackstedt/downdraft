// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from bootstrapGame() callback-soup to the declarative startGame()
// API. The common sequence (UI mount, renderer create+init, sim worker spawn,
// SAB capture, event routing, render loop, FPS polling, hot-reload dispose,
// deterministic mode) is handled by startGame(). Game-specific wiring
// (autosave, DevTools stats) lives in the onReady hook and devtools config.
// ============================================================================

import { getCanvas, startGame, type GameSimWorker } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { AlchemyRenderer } from "./renderer/alchemy-renderer";
import { computeGridDims } from "./shared/constants";
import { AlchemyWorkerHost } from "./simulation/alchemy-worker-host";
import { useGameStore } from "./stores/game-store";
import { autosave, loadAutosave } from "./stores/save-system";
import "./styles/globals.css";

// ── Sim worker adapter ──
// AlchemyWorkerHost extends BaseWorkerHost, which has a protected onEvent(kind,
// data) method with a different signature than GameSimWorker.onEvent(cb). This
// adapter bridges the gap so the worker host can be used with startGame().
// Alchemy uses a single combined SAB for sim + input + stats; there are no
// sim→renderer events to forward (the renderer reads the grid directly from
// the SAB each frame).
class AlchemySimAdapter implements GameSimWorker {
  readonly host: AlchemyWorkerHost;

  constructor(gridW: number, gridH: number) {
    this.host = new AlchemyWorkerHost(gridW, gridH);
  }

  async start(_config: unknown): Promise<void> {
    await this.host.start();
  }

  onEvent(_cb: (msg: any) => void): void {
    // Alchemy uses a shared SAB for sim→renderer communication;
    // there are no sim→renderer events to forward.
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.host.getSimBuffer();
  }

  getInputBuffer(): SharedArrayBuffer {
    // Alchemy uses a single combined SAB; the input region is within it.
    return this.host.getSimBuffer();
  }
}

startGame<AlchemySimAdapter>({
  // ── Renderer + Sim ──
  renderer: (canvas) => new AlchemyRenderer(canvas),
  sim: () => {
    const canvas = getCanvas(0);
    const dims = computeGridDims(canvas.width, canvas.height);
    return new AlchemySimAdapter(dims.w, dims.h);
  },
  simConfig: {},

  // ── UI (React) ──
  mountUI: (overlay) => {
    const root = createRoot(overlay);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  },

  // ── Renderer init + sim start ──
  onInit: async (ctx) => {
    // Start the sim worker first so the proxy is available for resize.
    await ctx.sim.start({});
    // Inject the pre-created worker host into the renderer.
    ctx.renderer.setWorkerHost(ctx.sim.host);
    // Init the renderer (uses the pre-set worker host, resizes if needed).
    const ok = await ctx.renderer.init();
    return ok;
  },

  // ── Post-init wiring (bespoke game setup) ──
  onReady: async (ctx) => {
    const { renderer, deterministic } = ctx;

    // Mark renderer as ready — the UI can now interact with it.
    useGameStore.getState().setRenderer(renderer);

    // --- Autosave (skip in deterministic/test mode) ---
    if (!deterministic) {
      // Load with 5s timeout so a locked IndexedDB doesn't block startup.
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
        console.warn("[autosave] Load failed:", e);
      }

      // Autosave interval (with overlap guard).
      let saveInProgress = false;
      setInterval(async () => {
        if (saveInProgress) return;
        saveInProgress = true;
        try {
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
        } catch (e) {
          console.warn("[autosave] Save failed:", e);
        } finally {
          saveInProgress = false;
        }
      }, 3000);
    }
  },

  // ── DevTools ──
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

  // ── Hot-reload cleanup ──
  onDispose: (ctx) => {
    ctx.renderer.stop();
  },

  // ── FPS polling ──
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
