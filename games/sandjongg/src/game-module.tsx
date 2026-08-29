// ============================================================================
// Shared GameModule — used by both desktop (main.tsx) and mobile (mobile.tsx)
// ============================================================================
//
// The renderer, sim, UI mount, and onReady wiring are identical across
// platforms. Desktop adds devtools + MCP; mobile adds touch input. Those
// platform-specific bits are added by the respective entry points.
//

import type { GameModule, GameSimWorker } from "@downdraft/app/renderer";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { autosave, saveHighScore } from "./save-system";
import { allocateSimBuffer } from "./shared/sim-buffer";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

/**
 * SandjonggGameSim — adapter that satisfies the GameSimWorker interface.
 *
 * The sandjongg renderer creates and manages its own SandjonggWorkerHost
 * inside renderer.init() (it also creates the grid pass and tile canvas pass
 * there). This adapter provides the SAB that startGame()/createDowndraftMobileApp()
 * captures for ctx.simSAB/ctx.inputSAB, but does NOT spawn a worker — the
 * renderer's internal worker is the real simulation.
 *
 * start() is never called when an onInit hook is provided (our onInit calls
 * renderer.init() which starts the real worker). onEvent is never called
 * because no `events` map is declared in the GameModule.
 *
 * The input region is embedded in the sim SAB (at INPUT_OFFSET), not a
 * separate buffer. Return the sim SAB for both getSimBuffer() and
 * getInputBuffer() — the renderer manages input internally via its own
 * worker host.
 */
export class SandjonggGameSim implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = allocateSimBuffer();
  }

  async start(_config: unknown): Promise<void> {
    // No-op: the renderer creates and starts its own SandjonggWorkerHost
    // inside renderer.init(). This adapter only provides the SAB interface.
  }

  onEvent(_cb: (msg: any) => void): void {
    // No-op: sim→renderer events are handled by the renderer's internal
    // SandjonggWorkerHost. Sandjongg does not use the GameModule declarative
    // events map.
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  getInputBuffer(): SharedArrayBuffer {
    // Sandjongg's input region is embedded in the sim SAB (at INPUT_OFFSET),
    // not a separate buffer. Return the sim SAB — the renderer manages input
    // internally via its own worker host.
    return this.sab;
  }
}

/**
 * Shared GameModule for sandjongg — used by both desktop and mobile.
 *
 * Desktop (main.tsx) adds: devtools, MCP, onDeterministic.
 * Mobile (mobile.tsx) adds: touchInput (via createDowndraftMobileApp).
 */
export const sandjonggModule: GameModule<SandjonggGameSim> = {
  // ── Renderer + Sim ──
  // Create a second canvas for the tile overlay (Canvas2D) before constructing
  // the renderer, which takes ownership of it.
  renderer: (canvas) => {
    let tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
    if (!tileCanvas) {
      tileCanvas = document.createElement("canvas");
      tileCanvas.id = "sandjongg-tile-canvas";
      tileCanvas.style.position = "absolute";
      tileCanvas.style.top = "0";
      tileCanvas.style.left = "0";
      tileCanvas.style.width = "100%";
      tileCanvas.style.height = "100%";
      tileCanvas.style.pointerEvents = "auto";
      tileCanvas.style.zIndex = "50";
      document.body.appendChild(tileCanvas);
    }
    return new SandjonggRenderer(canvas, tileCanvas);
  },
  sim: () => new SandjonggGameSim(),
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
    const renderer = ctx.renderer as SandjonggRenderer;
    useGameStore.getState().setRenderer(renderer);

    // ── Autosave (manual) ──
    // Loading is deferred to the main menu: the player picks a mode, then
    // continueMode()/startNewGame() (in save-load.ts) load that mode's save.
    // Here we only set up the periodic save interval (skipped in deterministic
    // mode, matching the bootstrap autosave behavior).
    if (!ctx.deterministic) {
      let saveInProgress = false;
      setInterval(async () => {
        if (saveInProgress) return;
        saveInProgress = true;
        try {
          const s = useGameStore.getState();
          // Don't save while in menus or paused.
          if (s.paused || s.showMainMenu || s.showPauseMenu) return;
          // Skip saving during level transitions. When the board is cleared
          // (tilesLeft === 0) the game is about to auto-advance; the board is
          // empty and saving it would persist a stuck state on reload (the
          // hasSeenTiles guard in app.tsx prevents auto-advance from firing on
          // an empty board, so the player would be stuck with no tiles). Also
          // skip when an advance/restart/mode-change is pending — the worker is
          // generating a new board and the grid/board/score state is inconsistent.
          if (s.tilesLeft === 0 || s._pendingAdvance || s._pendingNewGame || s._pendingModeChange) return;
          const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
          const board = await renderer.getWorkerHost()?.getBoardState();
          if (s.highScore > 0) saveHighScore(s.mode, s.highScore);
          await autosave({
            gridW, gridH, grid, fields,
            score: s.score,
            level: s.level,
            combo: s.combo,
            highScore: s.highScore,
            board: board ?? null,
            mode: s.mode,
            tileset: s.tileset,
            tileTheme: s.tileTheme,
          });
        } catch (e) {
          console.warn("[main] Autosave save failed:", e);
        } finally {
          saveInProgress = false;
        }
      }, 3000);
    }

    // ── Normal startup: show the main menu and pause the sim ──
    // In deterministic mode this is overridden by onDeterministic in main.tsx.
    if (!ctx.deterministic) {
      // Show the main menu and pause the sim so no sand falls while the
      // player picks a mode. startNewGame()/continueMode() resume it once
      // a mode is chosen.
      useGameStore.setState({ showMainMenu: true });
      renderer?.getWorkerHost()?.pause();
      useGameStore.getState().setPaused(true);
    }
  },

  // ── FPS polling ──
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
};
