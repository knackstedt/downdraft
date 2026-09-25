// ============================================================================
// host.ts — NativePixiUiHost: in-process PixiJS v8 WebGPU UI renderer.
//
// Runs PixiJS on the main thread in native mode, on the *same* wgpu-native
// GPUDevice as the game (passed via Application.init({ gpu: { adapter,
// device } })). PixiJS renders the UI into a GPUTexture owned by a
// VirtualCanvas (not the swapchain); the game samples that texture each
// frame via UiBlitPass and composites it over the 3D frame.
//
// Rendering is driven manually (autoStart: false): the game calls
// `host.render()` each frame before encoding its blit pass, so PixiJS's
// command submission is ordered before the game's read on the shared queue.
// ============================================================================

import { VirtualCanvas } from "@downdraft/platform-native";
import { AccessibilitySystem, Application, extensions } from "pixi.js";
import "pixi.js/events";
import { UiBlitPass } from "./ui-blit-pass";

export interface NativePixiUiHostOptions {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** Swapchain texture format (the blit pass writes here). */
  targetFormat: GPUTextureFormat;
  width: number;
  height: number;
  resolution?: number;
  /** PixiJS background color (default: transparent overlay). */
  backgroundColor?: number;
  /** PixiJS background alpha — defaults to 0 (overlay compositing). */
  backgroundAlpha?: number;
}

export class NativePixiUiHost {
  readonly app: Application;
  readonly canvas: VirtualCanvas;
  readonly blitPass: UiBlitPass;
  /** Resolves when PixiJS Application.init() completes. */
  readonly ready: Promise<void>;
  private disposed = false;
  private width: number;
  private height: number;

  constructor(opts: NativePixiUiHostOptions) {
    this.width = opts.width;
    this.height = opts.height;

    // Disable the AccessibilitySystem — it requires a real DOM.
    try { extensions.remove(AccessibilitySystem); } catch { /* already removed */ }

    this.canvas = new VirtualCanvas(opts.width, opts.height);

    this.app = new Application();
    // Configure PixiJS to render into the virtual canvas on the shared device.
    // `gpu: { adapter, device }` makes GpuDeviceSystem reuse the game's device
    // instead of creating a second one (see pixi.js GpuDeviceSystem.init).
    // `autoStart: false` stops PixiJS's ticker from auto-rendering; the game
    // drives `render()` each frame for ordered queue submission.
    this.ready = this.app.init({
      canvas: this.canvas as unknown as HTMLCanvasElement,
      width: opts.width,
      height: opts.height,
      backgroundColor: opts.backgroundColor,
      backgroundAlpha: opts.backgroundAlpha ?? 0,
      preference: "webgpu",
      antialias: false,
      resolution: opts.resolution ?? 1,
      // autoDensity resizes the canvas backing to logical*resolution; our
      // VirtualCanvas width setter recreates the GPU texture accordingly.
      autoDensity: true,
      autoStart: false,
      gpu: { adapter: opts.adapter, device: opts.device } as any,
    }).then(() => {
      // Stop the ticker — the game drives rendering manually.
      try { this.app.ticker.stop(); } catch { /* ignore */ }
    }).catch((err) => {
      console.error("[NativePixiUiHost] PIXI.Application init failed:", err);
      throw err;
    });

    this.blitPass = new UiBlitPass(opts.device, opts.targetFormat);
  }

  get stage() {
    return this.app.stage;
  }

  get renderer() {
    return this.app.renderer;
  }

  /** PixiJS EventSystem (available after init + `pixi.js/events` import). */
  get events() {
    return (this.app.renderer as any).events;
  }

  /**
   * Render the PixiJS scene into the UI texture. Submits PixiJS's command
   * encoder to the shared queue. The game must call this *before* encoding
   * its blit pass so the write is ordered before the read.
   */
  render(): void {
    if (this.disposed) return;
    try {
      // VirtualCanvas isn't an HTMLCanvasElement, so Pixi never detects the
      // root target as "screen" and skips its background.colorRgba default —
      // the clear falls back to transparent. Pass the clear explicitly.
      this.app.renderer.render({
        container: this.app.stage,
        clear: this.app.renderer.background.clearBeforeRender,
        clearColor: this.app.renderer.background.colorRgba,
      });
    } catch (err) {
      console.error("[NativePixiUiHost] render error:", err);
    }
  }

  /**
   * Change the rasterization resolution while keeping the logical stage
   * size fixed — like a DPR change. The canvas backing becomes
   * (width*res) x (height*res); screen stays logical, so layout and input
   * coordinates are unaffected. Use to match the UI texture to the
   * (possibly resized) swapchain surface for 1:1, sharp compositing.
   */
  setResolution(resolution: number): void {
    if (this.disposed || !(resolution > 0)) return;
    const r = this.app.renderer as any;
    if (Math.abs((r.resolution ?? 1) - resolution) < 1e-4) return;
    try {
      r.resize(this.width, this.height, resolution);
    } catch (err) {
      console.error("[NativePixiUiHost] setResolution failed:", err);
    }
  }

  /** The UI texture view the game samples in its compositing blit pass. */
  getUiTextureView(): GPUTextureView | null {
    return this.canvas.getWebgpuContext().getUiTextureView() as unknown as GPUTextureView | null;
  }

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.resize(width, height);
    try {
      this.app.renderer.resize(width, height);
    } catch (err) {
      console.error("[NativePixiUiHost] resize error:", err);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.app.destroy({ removeView: false }, { children: true, texture: true, textureSource: true, context: true });
    } catch { /* ignore */ }
    try { this.canvas.destroy(); } catch { /* ignore */ }
    try { this.blitPass.dispose(); } catch { /* ignore */ }
  }
}
