// ============================================================================
// OSR Renderer — Abstract base class for offscreen rendering BrowserWindows
// ============================================================================

import { BrowserWindow, type WebContents } from "electron";
import type {
    AtlasPanelRect,
    OSRDataUpdate,
    OSRInputEvent,
    OSRPanelConfig,
    OSRRendererMode,
    OSRRendererStatus,
    OSRSharedTexturePixelFormat,
} from "../types.ts";

export type RendererEventCallback = (rendererId: string, status: OSRRendererStatus, crashCount: number) => void;

export abstract class OSRRenderer {
  readonly id: string;
  readonly mode: OSRRendererMode;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: OSRSharedTexturePixelFormat;
  readonly maxCrashRetries: number;

  protected window: BrowserWindow | null = null;
  protected frameRate: number;
  protected displayRefreshRate: number;
  protected dirty = true;
  protected painting = true;
  protected status: OSRRendererStatus = "running";
  protected crashCount = 0;
  protected retryTimer: NodeJS.Timeout | null = null;
  protected onEvent: RendererEventCallback | null = null;
  protected targetWebContents: WebContents | null = null;

  constructor(
    id: string,
    mode: OSRRendererMode,
    width: number,
    height: number,
    frameRate: number,
    displayRefreshRate: number,
    pixelFormat: OSRSharedTexturePixelFormat,
    maxCrashRetries: number,
  ) {
    this.id = id;
    this.mode = mode;
    this.width = width;
    this.height = height;
    this.frameRate = Math.min(frameRate, displayRefreshRate);
    this.displayRefreshRate = displayRefreshRate;
    this.pixelFormat = pixelFormat;
    this.maxCrashRetries = maxCrashRetries;
  }

  setEventCallback(cb: RendererEventCallback): void {
    this.onEvent = cb;
  }

  setTargetWebContents(wc: WebContents): void {
    this.targetWebContents = wc;
  }

  setDisplayRefreshRate(refreshRate: number): void {
    this.displayRefreshRate = refreshRate;
    this.frameRate = Math.min(this.frameRate, refreshRate);
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.setFrameRate(this.frameRate);
    }
  }

  protected createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: this.width,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        offscreen: {
          useSharedTexture: false,
        } as any,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      } as any,
    });

    win.webContents.setFrameRate(this.frameRate);

    // Paint event → import shared texture → send to game renderer
    // CPU mode signature: (event, dirtyRect, image: NativeImage)
    // Shared texture mode signature: (event, { texture, dirtyRect })
    win.webContents.on("paint", async (event: any, ...args: any[]) => {
      // Detect mode: shared texture passes an object with .texture, CPU passes a NativeImage as 2nd arg
      const params = args[0];
      const isSharedTextureMode = params && typeof params === "object" && "texture" in params;
      
      if (isSharedTextureMode) {
        const texture = params.texture;
        if (!texture || !this.targetWebContents || this.targetWebContents.isDestroyed()) {
          if (texture) texture.release();
          return;
        }
        try {
          const imported = this.targetWebContents.sharedTexture.importSharedTexture({
            textureInfo: texture.textureInfo,
          });
          try {
            await this.targetWebContents.sharedTexture.sendSharedTexture({
              frame: this.targetWebContents.mainFrame,
              importedSharedTexture: imported,
            });
          } finally {
            imported.release();
          }
        } catch (err) {
          // Shared texture send failed
        } finally {
          texture.release();
        }
      } else {
        // CPU bitmap mode — args[1] is the NativeImage
        const image = args[1];
        if (!image || !this.targetWebContents || this.targetWebContents.isDestroyed()) {
          return;
        }
        // Forward the NativeImage to the renderer via IPC
        this.targetWebContents.send("__osr_paint_image", this.id, image);
      }

      // Note: We don't stop painting here — the offscreen page may still be
      // loading content (e.g. an iframe). Continuous painting ensures we capture
      // the page as it renders. Painting is explicitly stopped on destroy.
    });

    // Crash handling
    win.webContents.on("render-process-gone", (_event, details) => {
      this.handleCrash(details.reason);
    });

    return win;
  }

  protected handleCrash(_reason: string): void {
    this.crashCount++;
    this.status = "crashed";
    this.emitEvent();

    if (this.crashCount <= this.maxCrashRetries) {
      this.status = "recovering";
      this.emitEvent();

      const backoffMs = Math.pow(2, this.crashCount - 1) * 1000;
      this.retryTimer = setTimeout(() => {
        this.recreate();
      }, backoffMs);
    } else {
      this.status = "failed";
      this.emitEvent();
    }
  }

  protected recreate(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = this.createWindow();
    this.dirty = true;
    this.painting = true;
    this.loadContent();
  }

  protected emitEvent(): void {
    this.onEvent?.(this.id, this.status, this.crashCount);
  }

  protected markDirty(): void {
    this.dirty = true;
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.startPainting();
      this.painting = true;
    }
  }

  abstract loadContent(): void;
  abstract getPanelRect(panelId: string): AtlasPanelRect | null;
  abstract addPanel(config: OSRPanelConfig): AtlasPanelRect | null;
  abstract removePanel(id: string): void;
  abstract updatePanelContent(id: string, html: string): void;
  abstract applyDataUpdate(update: OSRDataUpdate): void;

  sendInputEvent(event: Omit<OSRInputEvent, "rendererId">): void {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.status === "crashed" || this.status === "failed") return;

    const wc = this.window.webContents;
    if (event.type === "mouseDown" || event.type === "mouseUp" || event.type === "mouseMove") {
      wc.sendInputEvent({
        type: event.type === "mouseDown" ? "mouseDown" : event.type === "mouseUp" ? "mouseUp" : "mouseMove",
        x: Math.round(event.x),
        y: Math.round(event.y),
        button: event.button ?? "left",
        globalX: Math.round(event.x),
        globalY: Math.round(event.y),
      } as any);
    } else if (event.type === "mouseWheel") {
      wc.sendInputEvent({
        type: "mouseWheel",
        x: Math.round(event.x),
        y: Math.round(event.y),
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
        wheelTicksX: (event.deltaX ?? 0) / 120,
        wheelTicksY: (event.deltaY ?? 0) / 120,
        accelerationRatioX: 1,
        accelerationRatioY: 1,
        hasPreciseScrollingDeltas: false,
      } as any);
    } else if (event.type === "keyDown" || event.type === "keyUp") {
      wc.sendInputEvent({
        type: event.type,
        keyCode: event.keyCode ?? "",
      } as any);
    }
  }

  getStatus(): OSRRendererStatus {
    return this.status;
  }

  destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.stopPainting();
      this.window.destroy();
    }
    this.window = null;
  }
}
