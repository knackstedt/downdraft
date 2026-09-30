// ============================================================================
// PixiUI Demo — shared GameModule
//
// Runs on the native runtime via `native-entry.ts` → runNativeGameModule.
// The PixiUI overlay runs in-process via the NativePixiUiHost adapter
// (native-pixi-host.ts) on the shared wgpu-native device.
// ============================================================================

import { getNativeHost, type RenderSurface } from "@downdraft/engine";
import {
    createMcpHarness,
    getSurface,
    type GameContext,
    type GameModule,
    type GameSimWorker,
} from "@downdraft/engine/app/renderer";
import {
    createPixiUiMcpTools,
    PixiUiHost,
} from "@downdraft/engine/libraries/pixi-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import type { NativeDemoUiHandle } from "./native-pixi-host";
const log = createLogger();


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
  private surface: RenderSurface;
  private ctx: CanvasRenderingContext2D | null;
  private frame = 0;

  constructor(surface: RenderSurface) {
    this.surface = surface;
    // "2d" is a canvas-compat context — not part of the RenderSurface
    // contract; on native it's served by the VirtualCanvas adapter.
    this.ctx = surface.getContext("2d") as CanvasRenderingContext2D | null;
  }

  async init(): Promise<boolean> {
    return true;
  }

  render(): void {
    if (!this.ctx) return;
    this.frame++;
    const w = this.surface.width;
    const h = this.surface.height;
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
    this.surface.width = w;
    this.surface.height = h;
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
  renderer: (surface) => {
    renderer = new TrivialRenderer(surface);
    return renderer as any;
  },
  sim: () => new NoopSim(),
  simConfig: {},

  onInit: async (ctx) => {
    const ok = await (ctx.renderer as any).init();
    return ok;
  },

  onReady: async (ctx: GameContext<any>) => {
    const nativeHost = getNativeHost();

    if (nativeHost?.device) {
      // ── Native path: in-process PixiUI on the shared wgpu-native device ──
      const { createNativeDemoUi } = await import("./native-pixi-host");
      const surface = getSurface(0) as any;
      nativeUi = await createNativeDemoUi({
        device: nativeHost.device,
        adapter: nativeHost.adapter as GPUAdapter,
        surface,
      });
      pixiHost = nativeUi.host;
      log.info("demo", 'Native PixiUI host started (in-process, wgpu-native)');
    } else {
      // ── PixiJS path: scene host on the shared device ──
      const workerHost = new PixiUiHost({
        backend: "webgl2",
        sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
        canvasLayer: 1,
        canvasId: "pixi-ui-canvas",
      });
      pixiHost = workerHost;
      try {
        await workerHost.start();
        log.info("demo", 'PixiUI host started');
      } catch (e) {
        const err = e as Error & { name?: string };
        log.error("demo", `PixiUI host failed to start: ${err.name} ${err.message} ${err.stack}`);
        return;
      }
    }

    // Handle UI→game actions (pause/resume from the button).
    pixiHost.onAction = (action) => {
      if (action.kind === "pause") {
        log.info("demo", 'Game paused via PixiUI button');
      } else if (action.kind === "resume") {
        log.info("demo", 'Game resumed via PixiUI button');
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
      const canvas = getSurface(0);
      if (canvas && renderer) {
        renderer.resize(window.innerWidth, window.innerHeight);
        nativeUi?.resize(window.innerWidth, window.innerHeight);
      }
    }
    window.addEventListener("resize", resize);
    resize();
  },
};
