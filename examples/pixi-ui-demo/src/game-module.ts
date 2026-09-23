// ============================================================================
// PixiUI Demo — shared GameModule
//
// The SAME module runs on Electron/browser (`main.tsx` → startGame) and on
// the native host (`native-entry.ts` → runNativeGameModule). On native there
// is no OffscreenCanvas/WebGL2 worker — onReady branches to the in-process
// NativePixiUiHost adapter (native-pixi-host.ts) instead.
// ============================================================================

import {
    createMcpHarness,
    getCanvas,
    type GameContext,
    type GameModule,
    type GameSimWorker,
} from "@downdraft/engine/app/renderer";
import {
    createPixiUiMcpTools,
    PixiUiHost,
} from "@downdraft/engine/libraries/pixi-ui";
import type { NativeDemoUiHandle } from "./native-pixi-host";

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

let pixiHost: {
  onAction: ((action: any) => void) | null;
  start(): Promise<void>;
  writeStats(stats: Record<string, number>): void;
} | null = null;
let nativeUi: NativeDemoUiHandle | null = null;
let renderer: TrivialRenderer | null = null;
let gameFrame = 0;
let lastFpsUpdate = 0;
let fpsFrameCount = 0;
let currentFps = 60;
let health = 100;
const maxHealth = 100;
let healthDir = -1;

export const pixiUiDemoModule: GameModule<NoopSim> = {
  renderer: (canvas) => {
    renderer = new TrivialRenderer(canvas);
    return renderer as any;
  },
  sim: () => new NoopSim(),
  simConfig: {},

  // No DOM UI overlay — the PixiJS overlay IS the UI.
  mountUI: () => {},

  onInit: async (ctx) => {
    const ok = await (ctx.renderer as any).init();
    return ok;
  },

  onReady: async (ctx: GameContext<any>) => {
    const nativeHost = (globalThis as any).__nativeHost;

    if (nativeHost?.device) {
      // ── Native path: in-process PixiUI on the shared wgpu-native device ──
      const { createNativeDemoUi } = await import("./native-pixi-host");
      const surface = getCanvas(0) as any;
      nativeUi = await createNativeDemoUi({
        device: nativeHost.device as GPUDevice,
        adapter: nativeHost.adapter as GPUAdapter,
        surface,
      });
      pixiHost = nativeUi.host;
      console.log("[demo] Native PixiUI host started (in-process, wgpu-native)");
    } else {
      // ── Browser/Electron path: PixiJS in a worker on OffscreenCanvas ──
      const workerHost = new PixiUiHost({
        backend: "webgl2",
        sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
        canvasLayer: 1,
        canvasId: "pixi-ui-canvas",
      });
      pixiHost = workerHost;
      try {
        await workerHost.start();
        console.log("[demo] PixiUI host started");
      } catch (e) {
        const err = e as Error & { name?: string };
        console.error("[demo] PixiUI host failed to start:", err.name, err.message, err.stack);
        return;
      }
    }

    // Handle UI→game actions (pause/resume from the button).
    pixiHost.onAction = (action) => {
      if (action.kind === "pause") {
        console.log("[demo] Game paused via PixiUI button");
      } else if (action.kind === "resume") {
        console.log("[demo] Game resumed via PixiUI button");
      }
    };

    // Register MCP automation tools for e2e testing — the adapter satisfies
    // the PixiUiMcpHost surface on both paths.
    const tools = createPixiUiMcpTools(pixiHost as any);
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

      // Native: tick the in-process scene, render the (decorative) 2d canvas,
      // then composite the UI texture onto the swapchain. The host
      // auto-presents after the rAF callback returns.
      nativeUi?.tick(dt);
      renderer?.render();
      nativeUi?.composite();

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // Handle canvas resize.
    function resize(): void {
      const canvas = getCanvas(0);
      if (canvas && renderer) {
        renderer.resize(window.innerWidth, window.innerHeight);
        nativeUi?.resize(window.innerWidth, window.innerHeight);
      }
    }
    window.addEventListener("resize", resize);
    resize();
  },
};
