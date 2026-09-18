// ============================================================================
// PixiUI Demo — Renderer Entry Point
//
// Demonstrates the @downdraft/engine/libraries/pixi-ui engine library: a PixiJS UI
// overlay rendered inside a Web Worker on an OffscreenCanvas, stacked above
// a trivial game canvas. The game feeds per-frame scalars (health, fps) via
// a SharedArrayBuffer and events via postMessage. MCP tools verify the
// overlay renders and is interactive.
//
// This example uses the escape hatch (direct PixiUiHost construction in
// onReady) because the TrivialRenderer doesn't have a renderer plugin host
// for DI. Real games with a full renderer use the declarative
// `libraries: [PixiUiLib]` approach instead (see AGENTS.md).
// ============================================================================

import {
    createMcpHarness,
    getCanvas,
    startGame,
    type GameContext,
    type GameSimWorker,
} from "@downdraft/engine/app/renderer";
import "@downdraft/engine/app/renderer/downdraft-base.css";
import {
    createPixiUiMcpTools,
    PixiUiHost,
    type PixiUiHost as PixiUiHostType,
} from "@downdraft/engine/libraries/pixi-ui";

// ── Trivial sim worker (no-op — this demo is UI-only) ──

class NoopSim implements GameSimWorker {
  private sab = new SharedArrayBuffer(64);
  async start(): Promise<void> {}
  onEvent(): void {}
  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getInputBuffer(): SharedArrayBuffer { return this.sab; }
}

// ── Trivial renderer (Canvas2D — just clears the game canvas) ──

class TrivialRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  async init(): Promise<boolean> {
    return true;
  }

  render(): void {
    if (!this.ctx) return;
    this.frame++;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const t = this.frame * 0.01;
    const grad = this.ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `rgb(${20 + Math.sin(t) * 10}, 10, 30)`);
    grad.addColorStop(1, `rgb(10, ${20 + Math.cos(t) * 10}, 40)`);
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, w, h);
    this.ctx.fillStyle = "#fff";
    this.ctx.font = "20px monospace";
    this.ctx.fillText("Game canvas (layer 0) — PixiUI overlay is above", 16, h - 32);
  }

  resize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
  }
}

// ── Game loop state ──

let pixiHost: PixiUiHostType | null = null;
let renderer: TrivialRenderer | null = null;
let gameFrame = 0;
let lastFpsUpdate = 0;
let fpsFrameCount = 0;
let currentFps = 60;
let health = 100;
const maxHealth = 100;
let healthDir = -1;

// ── Start the game ──

startGame({
  renderer: (canvas) => {
    renderer = new TrivialRenderer(canvas);
    return renderer as any;
  },
  sim: () => new NoopSim(),
  simConfig: {},

  // No DOM UI overlay — the PixiJS overlay IS the UI.
  mountUI: () => {},

  // No declarative libraries — we use the escape hatch (direct PixiUiHost
  // construction) because the TrivialRenderer has no plugin host for DI.
  // Real games use `libraries: [[PixiUiLib, config]]` instead.

  onInit: async (ctx) => {
    const ok = await (ctx.renderer as any).init();
    return ok;
  },

  onReady: async (ctx: GameContext<any>) => {
    // Escape hatch: construct the PixiUiHost directly.
    pixiHost = new PixiUiHost({
      backend: "webgl2",
      sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
    });

    // Handle worker→game actions (pause/resume from the button).
    pixiHost.onAction = (action) => {
      if (action.kind === "pause") {
        console.log("[demo] Game paused via PixiUI button");
      } else if (action.kind === "resume") {
        console.log("[demo] Game resumed via PixiUI button");
      }
    };

    // Start the UI worker (transfers canvas control + spawns the worker).
    try {
      await pixiHost.start();
      console.log("[demo] PixiUI host started");
    } catch (e) {
      const err = e as Error & { name?: string };
      console.error("[demo] PixiUI host failed to start:", err.name, err.message, err.stack);
      return;
    }

    // Register MCP automation tools for e2e testing.
    const tools = createPixiUiMcpTools(pixiHost);
    createMcpHarness({
      serverName: "downdraft-pixi-ui-demo-automation",
      tools,
    });

    // Start the game loop.
    let lastTime = performance.now();
    function frame(): void {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      gameFrame++;
      fpsFrameCount++;

      // Update FPS counter every 500ms.
      if (now - lastFpsUpdate > 500) {
        currentFps = Math.round(fpsFrameCount / ((now - lastFpsUpdate) / 1000));
        lastFpsUpdate = now;
        fpsFrameCount = 0;
      }

      // Animate health: drain to 0, then refill to max.
      health += healthDir * dt * 20;
      if (health <= 0) { health = 0; healthDir = 1; }
      if (health >= maxHealth) { health = maxHealth; healthDir = -1; }

      // Write per-frame scalars to the UiStatsSAB.
      pixiHost?.writeStats({
        fps: currentFps,
        health,
        maxHealth,
        tick: gameFrame,
      });

      // Render the trivial game canvas.
      renderer?.render();

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // Handle canvas resize.
    function resize(): void {
      const canvas = getCanvas(0);
      if (canvas && renderer) {
        renderer.resize(window.innerWidth, window.innerHeight);
      }
    }
    window.addEventListener("resize", resize);
    resize();
  },
});
