// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from bootstrapGame() to the declarative startGame() API. The
// mining-rpg renderer (MiningRenderer) manages its own MiningWorkerHost
// internally inside renderer.init() — it creates the worker, the SAB, the
// sim reader, and the input handler. The MiningGameSim adapter below
// satisfies the GameSimWorker interface that startGame() requires, but the
// actual sim worker lifecycle is owned by the renderer. The adapter's
// start() is a no-op (startGame() does not call it when onInit is provided)
// and onEvent is a no-op (sim→renderer events are handled by the renderer's
// internal worker host).
// ============================================================================

import { startGame, type GameSimWorker } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { MiningRenderer } from "./renderer/mining-renderer";
import { PLAYER, WORLD_SEED } from "./shared/constants";
import { allocateMiningSimBuffer } from "./shared/sim-buffer";
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

let solidHost: SolidHost | null = null;

/**
 * MiningGameSim — adapter that satisfies the GameSimWorker interface
 * required by startGame().
 *
 * The mining-rpg renderer creates and manages its own MiningWorkerHost
 * inside renderer.init() (it also creates the sim reader and input handler
 * there). This adapter provides the SAB that startGame() captures for
 * ctx.simSAB/ctx.inputSAB, but does NOT spawn a worker — the renderer's
 * internal worker is the real simulation.
 *
 * start() is never called by startGame() when an onInit hook is provided
 * (our onInit calls renderer.init() which starts the real worker). onEvent
 * is never called because no `events` map is declared in the GameModule.
 */
class MiningGameSim implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = allocateMiningSimBuffer();
  }

  async start(_config: unknown): Promise<void> {
    // No-op: the renderer creates and starts its own MiningWorkerHost
    // inside renderer.init(). This adapter only provides the SAB interface.
  }

  onEvent(_cb: (msg: any) => void): void {
    // No-op: sim→renderer events are handled by the renderer's internal
    // MiningWorkerHost. Mining-rpg does not use the GameModule declarative
    // events map.
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  getInputBuffer(): SharedArrayBuffer {
    // Mining-rpg's input region is embedded in the sim SAB (at INPUT_OFFSET),
    // not a separate buffer. Return the sim SAB — the renderer manages input
    // internally via its own worker host.
    return this.sab;
  }
}

startGame({
  // ── Renderer + Sim ──
  renderer: (canvas) => {
    const deterministic = (globalThis as any).downdraft?.deterministic === true;
    return new MiningRenderer(canvas, deterministic);
  },
  sim: () => new MiningGameSim(),
  simConfig: {},

  // ── UI (React fallback — only mounted if Solid failed) ──
  // mountUI is only called if we didn't mount Solid. We handle this in
  // onReady below, so we skip mountUI here unless USE_REACT_UI is set.
  mountUI: (overlay) => {
    if ((globalThis as any).__USE_REACT_UI === true) {
      const root = createRoot(overlay);
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      );
    }
    // Otherwise: Solid UI was mounted in onReady, skip.
  },

  // ── Renderer init (creates + starts the internal sim worker) ──
  onInit: async (ctx) => {
    const ok = await ctx.renderer.init();
    if (!ok) {
      console.error("WebGPU initialization failed");
      return false;
    }
    return true;
  },

  // ── Post-init wiring ──
  onReady: (ctx) => {
    useGameStore.getState().setRenderer(ctx.renderer);

    // --- UI mode: Solid-in-worker (default) or React fallback ---
    const useReactUI = (globalThis as any).__USE_REACT_UI === true;

    if (!useReactUI) {
      // --- Solid-in-worker path ---
      try {
        solidHost = new SolidHost({ renderer: ctx.renderer, reactStore: useGameStore });
        solidHost.start().then(() => {
          console.log("[main] Solid-in-worker UI started");
        }).catch((e) => {
          console.error("[main] Solid UI failed, falling back to React:", e);
          solidHost?.dispose();
          solidHost = null;
          // Fall back to React
          const root = createRoot(ctx.overlay);
          root.render(
            <React.StrictMode>
              <App />
            </React.StrictMode>,
          );
        });
      } catch (e) {
        console.error("[main] Solid UI failed, falling back to React:", e);
        solidHost?.dispose();
        solidHost = null;
        const root = createRoot(ctx.overlay);
        root.render(
          <React.StrictMode>
            <App />
          </React.StrictMode>,
        );
      }
    }
  },

  // ── DevTools ──
  devtools: {
    createSimStatsProvider: (renderer) => createSimStatsProvider({
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
    }),
    panels: [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra as any;
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
  },

  // ── Display info → frame rate limiter ──
  onDisplayInfo: (refreshRate, ctx) => {
    const renderer = ctx.renderer as MiningRenderer;
    renderer.setFrameRateLimit(refreshRate);
    solidHost?.setFrameRateLimit(refreshRate);
  },

  // ── FPS polling ──
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),

  // ── Hot reload dispose ──
  onDispose: async () => {
    solidHost?.dispose();
    const renderer = useGameStore.getState().renderer as MiningRenderer | null;
    if (renderer) await renderer.stop();
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
