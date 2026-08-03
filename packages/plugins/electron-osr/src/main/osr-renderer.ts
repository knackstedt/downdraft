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
    const px = Math.round(event.x);
    const py = Math.round(event.y);

    if (event.type === "mouseDown" || event.type === "mouseUp" || event.type === "mouseMove") {
      const domType = event.type === "mouseDown" ? "mousedown" : event.type === "mouseUp" ? "mouseup" : "mousemove";
      const button = event.button === "right" ? 2 : event.button === "middle" ? 1 : 0;
      const js = `(function(){
        var el = document.elementFromPoint(${px}, ${py}) || document;
        if (!el) { return; }
        var ev = new MouseEvent('${domType}', {
          bubbles: true, cancelable: true, view: window,
          clientX: ${px}, clientY: ${py},
          screenX: ${px}, screenY: ${py},
          button: ${button}, buttons: ${domType === 'mouseup' ? 0 : (button === 0 ? 1 : button === 2 ? 2 : 4)},
          relatedTarget: null
        });
        el.dispatchEvent(ev);
        if ('${domType}' === 'mousedown') {
          if (el.focus) el.focus();
          var target = el;
          while (target && target !== document.body) {
            if (target.tagName && (target.tagName.toLowerCase() === 'input' || target.tagName.toLowerCase() === 'textarea')) {
              target.focus();
              break;
            }
            target = target.parentElement;
          }
        }
      })()`;
      wc.executeJavaScript(js).catch(() => {});
      // After mouseup, also dispatch a click event (synthetic events don't auto-generate clicks)
      if (event.type === "mouseUp") {
        const clickJs = `(function(){
          var el = document.elementFromPoint(${px}, ${py}) || document;
          var ev = new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: ${px}, clientY: ${py},
            button: ${button}, buttons: 0
          });
          el.dispatchEvent(ev);
        })()`;
        wc.executeJavaScript(clickJs).catch(() => {});
      }
    } else if (event.type === "mouseWheel") {
      const js = `(function(){
        var el = document.elementFromPoint(${px}, ${py}) || document;
        var ev = new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: ${px}, clientY: ${py},
          deltaX: ${event.deltaX ?? 0}, deltaY: ${event.deltaY ?? 0}
        });
        el.dispatchEvent(ev);
      })()`;
      wc.executeJavaScript(js).catch(() => {});
    } else if (event.type === "keyDown" || event.type === "keyUp") {
      const keyName = keyCodeToElectronKey(event.keyCode ?? "");
      const domType = event.type === "keyDown" ? "keydown" : "keyup";
      // For keydown, dispatch the event AND insert text if focused on an input
      const js = `(function(){
        var el = document.activeElement || document.body;
        var ev = new KeyboardEvent('${domType}', {
          bubbles: true, cancelable: true, view: window,
          key: '${keyName}', code: '${keyName.length === 1 ? 'Key' + keyName.toUpperCase() : keyName}'
        });
        el.dispatchEvent(ev);
        if ('${domType}' === 'keydown' && el.tagName) {
          var tag = el.tagName.toLowerCase();
          if ((tag === 'input' || tag === 'textarea') && '${keyName}'.length === 1) {
            // Synthetic KeyboardEvents don't insert text — do it manually
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            el.value = el.value.substring(0, start) + '${keyName}' + el.value.substring(end);
            el.selectionStart = el.selectionEnd = start + 1;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '${keyName}' }));
          } else if ((tag === 'input' || tag === 'textarea') && '${keyName}' === 'Backspace') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start > 0 && start === end) {
              el.value = el.value.substring(0, start - 1) + el.value.substring(end);
              el.selectionStart = el.selectionEnd = start - 1;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
            }
          } else if ((tag === 'input' || tag === 'textarea') && '${keyName}' === 'Enter') {
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      })()`;
      wc.executeJavaScript(js).catch(() => {});
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

const KEY_CODE_MAP: Record<number, string> = {
  8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Control",
  18: "Alt", 19: "Pause", 27: "Escape", 32: " ", 33: "PageUp", 34: "PageDown",
  35: "End", 36: "Home", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight",
  40: "ArrowDown", 45: "Insert", 46: "Delete",
  112: "F1", 113: "F2", 114: "F3", 115: "F4", 116: "F5", 117: "F6",
  118: "F7", 119: "F8", 120: "F9", 121: "F10", 122: "F11", 123: "F12",
  186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`",
  219: "[", 220: "\\", 221: "]", 222: "'",
};

function keyCodeToElectronKey(code: string): string {
  const num = parseInt(code, 10);
  if (isNaN(num)) return code;
  if (num >= 48 && num <= 57) return String.fromCharCode(num); // 0-9
  if (num >= 65 && num <= 90) return String.fromCharCode(num + 32); // a-z (lowercase)
  return KEY_CODE_MAP[num] ?? code;
}
