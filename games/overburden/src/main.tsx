// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from bootstrapGame() to the declarative startGame() API. The
// overburden renderer (BlockheadsRenderer) manages its own BlockheadsWorkerHost
// internally inside renderer.init() — it creates the worker, the SAB, the
// grid-builder worker, and the sim reader. The BlockheadsGameSim adapter
// below satisfies the GameSimWorker interface that startGame() requires, but
// the actual sim worker lifecycle is owned by the renderer. The adapter's
// start() is a no-op (startGame() does not call it when onInit is provided)
// and onEvent is a no-op (sim→renderer events are handled by the renderer's
// internal worker host).
// ============================================================================

import { startGame, type GameSimWorker } from "@downdraft/app/renderer";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { setupBlockheadsMcp } from "./mcp/setup";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { createSimBuffer } from "./shared/sim-buffer";
import { getSeasonInfo } from "./simulation/season-system";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

/**
 * BlockheadsGameSim — adapter that satisfies the GameSimWorker interface
 * required by startGame().
 *
 * The overburden renderer creates and manages its own BlockheadsWorkerHost
 * inside renderer.init() (it also creates the grid-builder worker, sim reader,
 * and input handler there). This adapter provides the SAB that startGame()
 * captures for ctx.simSAB/ctx.inputSAB, but does NOT spawn a worker — the
 * renderer's internal worker is the real simulation.
 *
 * start() is never called by startGame() when an onInit hook is provided
 * (our onInit calls renderer.init() which starts the real worker). onEvent
 * is never called because no `events` map is declared in the GameModule.
 */
class BlockheadsGameSim implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = createSimBuffer();
  }

  async start(_config: unknown): Promise<void> {
    // No-op: the renderer creates and starts its own BlockheadsWorkerHost
    // inside renderer.init(). This adapter only provides the SAB interface.
  }

  onEvent(_cb: (msg: any) => void): void {
    // No-op: sim→renderer events (ready, pickups) are handled by the
    // renderer's internal BlockheadsWorkerHost. Overburden does not use
    // the GameModule declarative events map.
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  getInputBuffer(): SharedArrayBuffer {
    // Overburden's input region is embedded in the sim SAB (at INPUT_OFFSET),
    // not a separate buffer. Return the sim SAB — the renderer manages input
    // internally via its own worker host.
    return this.sab;
  }
}

startGame({
  // ── Renderer + Sim ──
  renderer: (canvas) => new BlockheadsRenderer(canvas),
  sim: () => new BlockheadsGameSim(),
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
  },

  // ── MCP ──
  mcp: () => setupBlockheadsMcp(() => useGameStore.getState().renderer as BlockheadsRenderer | null),

  // ── FPS + season polling ──
  onFpsUpdate: (fps) => {
    if (useGameStore.getState().fps !== fps) {
      useGameStore.getState().setFps(fps);
    }
    // Poll the current season from the sim tick (deterministic from tick count)
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    const simReader = renderer?.getSimReader();
    if (simReader) {
      const tick = simReader.getTick();
      const info = getSeasonInfo(tick);
      const prev = useGameStore.getState();
      if (prev.season !== info.season || prev.dayInSeason !== info.dayInSeason || prev.year !== info.year) {
        useGameStore.getState().setSeasonInfo(info.season, info.dayInSeason, info.year);
      }
    }
  },

  // ── Hot reload dispose ──
  onDispose: async () => {
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    if (renderer) await renderer.shutdown();
  },

  // ── Deterministic mode: pause render loop + skip title screen ──
  onDeterministic: (ctx) => {
    // Pause the render loop. The simulation still ticks; frames are only
    // rendered on demand via captureScreenshot / renderOneFrame.
    // This saves CPU when running under SwiftShader software WebGPU.
    ctx.renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused (on-demand rendering only)");
    useGameStore.getState().setDeterministic(true);
    useGameStore.getState().setShowTitleScreen(false);
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
