// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from bootstrapGame() to the declarative startGame() API. The common
// sequence (UI mount, renderer create+init, render loop, FPS polling, DevTools,
// hot-reload dispose) is handled by startGame(). Game-specific wiring (autosave
// load/interval, renderer→store handoff) lives in the onReady/onDispose hooks.
//
// Note: The falling-sand renderer creates and manages its own SandWorkerHost
// internally (in renderer.init()). The FallingSandSimAdapter below satisfies
// the GameSimWorker interface required by startGame() without spawning a
// duplicate worker — its start() is a no-op and the SABs it exposes are never
// used by the renderer (which has its own). The real simulation lifecycle is
// owned by the renderer.
// ============================================================================

import { startGame, type GameSimWorker } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { NUM_LAYERS, PLAYER, allocateSimBuffer } from "./shared/sim-buffer";
import { useGameStore } from "./stores/game-store";
import { autosave, loadAutosave } from "./stores/save-system";
import "./styles/globals.css";

// --- GameSimWorker adapter ---
// The falling-sand renderer creates and manages its own SandWorkerHost
// internally (in renderer.init()). This adapter satisfies the GameSimWorker
// interface required by startGame() without spawning a duplicate worker.
class FallingSandSimAdapter implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = allocateSimBuffer();
  }

  async start(_config: unknown): Promise<void> {
    // No-op: the FallingSandRenderer creates and starts its own SandWorkerHost
    // internally during renderer.init(). This adapter exists only to satisfy
    // the GameSimWorker interface for startGame().
  }

  onEvent(_cb: (msg: any) => void): void {
    // The falling-sand sim does not emit events to the renderer.
  }

  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getInputBuffer(): SharedArrayBuffer { return this.sab; }
}

// Track the autosave interval for hot-reload dispose.
let autosaveInterval: ReturnType<typeof setInterval> | null = null;

startGame({
  // --- Renderer + Sim ---
  renderer: (canvas) => {
    const deterministic = (window as any).downdraft?.deterministic === true;
    return new FallingSandRenderer(canvas, deterministic);
  },
  sim: () => new FallingSandSimAdapter(),
  simConfig: {},

  // --- UI (React) ---
  mountUI: (overlay) => {
    const root = createRoot(overlay);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
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

  // --- Renderer init ---
  // Override onInit so startGame() does NOT call sim.start() (the adapter is
  // a no-op). The renderer creates + starts its own SandWorkerHost internally.
  onInit: async (ctx) => {
    const ok = await ctx.renderer.init();
    if (!ok) {
      console.error("FallingSandRenderer initialization failed");
      return false;
    }
    return true;
  },

  // --- Post-init wiring ---
  onReady: async (ctx) => {
    const { renderer, deterministic } = ctx;

    // Wire renderer to the game store (was onRendererInit in bootstrapGame).
    useGameStore.getState().setRenderer(renderer);

    // --- Autosave (skip in deterministic/test mode) ---
    if (!deterministic) {
      // Load previous session
      try {
        const saved = await loadAutosave();
        if (saved) {
          await renderer.loadSave(saved.grids, saved.fields, saved.gridW, saved.gridH);
          console.log("[autosave] Restored last session");
        }
      } catch {
        console.log("[autosave] No autosave found, starting fresh");
      }

      // Set up autosave interval (every 3s, matching bootstrap default)
      autosaveInterval = setInterval(async () => {
        const r = useGameStore.getState().renderer;
        if (!r) return;
        const { grids, fields, gridW, gridH } = r.snapshotGrids();
        await autosave({ gridW, gridH, grids, fields });
      }, 3000);
    }
  },

  // --- Cleanup (hot-reload dispose) ---
  onDispose: () => {
    if (autosaveInterval) {
      clearInterval(autosaveInterval);
      autosaveInterval = null;
    }
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
