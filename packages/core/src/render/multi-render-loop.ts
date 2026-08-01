import { Camera } from "../scene/camera.ts";
import { ViewportLayout, type ViewportRect, type ViewportMode, viewportRectToPixels } from "./viewport.ts";

export interface MultiCameraRenderConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  maxPlayers: number;
  mode: ViewportMode;
}

export type CameraRenderCallback = (
  camera: Camera,
  viewportPx: { x: number; y: number; w: number; h: number },
  playerIdx: number,
) => void;

export class MultiCameraRenderLoop {
  private cameras: Camera[] = [];
  private viewportRects: ViewportRect[] = [];
  private mode: ViewportMode;
  private maxPlayers: number;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private width: number = 0;
  private height: number = 0;
  private activePlayerCount: number = 1;

  constructor(config: MultiCameraRenderConfig) {
    this.canvas = config.canvas;
    this.maxPlayers = config.maxPlayers;
    this.mode = config.mode;
    this.width = config.canvas.width;
    this.height = config.canvas.height;

    for (let i = 0; i < config.maxPlayers; i++) {
      this.cameras.push(new Camera());
    }
    this.updateLayout();
  }

  getCamera(playerIdx: number): Camera {
    if (playerIdx < 0 || playerIdx >= this.cameras.length) {
      return this.cameras[0];
    }
    return this.cameras[playerIdx];
  }

  getCameras(): Camera[] {
    return this.cameras;
  }

  getActiveCameras(): Camera[] {
    return this.cameras.slice(0, this.activePlayerCount);
  }

  getViewportRect(playerIdx: number): ViewportRect | null {
    if (playerIdx < 0 || playerIdx >= this.viewportRects.length) return null;
    return this.viewportRects[playerIdx];
  }

  getViewportRects(): ViewportRect[] {
    return this.viewportRects;
  }

  setMode(mode: ViewportMode): void {
    this.mode = mode;
    this.updateLayout();
  }

  getMode(): ViewportMode {
    return this.mode;
  }

  setActivePlayerCount(n: number): void {
    this.activePlayerCount = Math.max(1, Math.min(n, this.maxPlayers));
    this.updateLayout();
  }

  getActivePlayerCount(): number {
    return this.activePlayerCount;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.updateLayout();
  }

  private updateLayout(): void {
    this.viewportRects = ViewportLayout.compute(
      this.activePlayerCount,
      this.width,
      this.height,
      this.mode,
    );

    for (let i = 0; i < this.activePlayerCount; i++) {
      const rect = this.viewportRects[i];
      if (rect) {
        const px = viewportRectToPixels(rect, this.width, this.height);
        this.cameras[i].setAspect(px.w, px.h);
      }
    }
  }

  renderFrame(callback: CameraRenderCallback): void {
    for (let i = 0; i < this.activePlayerCount; i++) {
      const camera = this.cameras[i];
      const rect = this.viewportRects[i];
      if (!camera || !rect) continue;

      const px = viewportRectToPixels(rect, this.width, this.height);
      callback(camera, px, i);
    }
  }

  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
  }

  getCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.canvas;
  }
}
