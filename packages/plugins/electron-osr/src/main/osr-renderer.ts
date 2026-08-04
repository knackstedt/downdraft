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
        if (!el) { return null; }
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
        // Update software cursor position if enabled
        var sc = document.getElementById('__osr_sw_cursor');
        if (sc) { sc.style.left = ${px} + 'px'; sc.style.top = ${py} + 'px'; sc.style.display = 'block'; }
      })()`;
      wc.executeJavaScript(js).catch(() => {});
      // Separately query the cursor style at the current mouse position
      const cursorJs = `(function(){
        var el = document.elementFromPoint(${px}, ${py});
        if (!el) return null;
        var ct = el;
        while (ct && ct !== document) {
          var cur = getComputedStyle(ct).cursor;
          if (cur && cur !== 'auto' && cur !== 'default' && cur !== 'none') return cur;
          ct = ct.parentElement;
        }
        return null;
      })()`;
      wc.executeJavaScript(cursorJs).then((cursor: string | null) => {
        if (cursor && this.targetWebContents && !this.targetWebContents.isDestroyed()) {
          this.targetWebContents.send("osr-cursor-style", this.id, cursor);
        }
      }).catch((err: any) => {
        console.error(`[OSR] cursor style query failed:`, err?.message ?? err);
      });
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
      const js = `(function(){
        var el = document.activeElement || document.body;
        var ev = new KeyboardEvent('${domType}', {
          bubbles: true, cancelable: true, view: window,
          key: '${keyName}', code: '${keyName.length === 1 ? 'Key' + keyName.toUpperCase() : keyName}'
        });
        el.dispatchEvent(ev);
        if ('${domType}' === 'keydown' && el.tagName) {
          var tag = el.tagName.toLowerCase();
          var isInput = (tag === 'input' || tag === 'textarea');
          if (isInput && '${keyName}'.length === 1) {
            // Synthetic KeyboardEvents don't insert text — do it manually
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            el.value = el.value.substring(0, start) + '${keyName}' + el.value.substring(end);
            el.selectionStart = el.selectionEnd = start + 1;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '${keyName}' }));
          } else if (isInput && '${keyName}' === 'Backspace') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start > 0 && start === end) {
              el.value = el.value.substring(0, start - 1) + el.value.substring(end);
              el.selectionStart = el.selectionEnd = start - 1;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
            }
          } else if (isInput && '${keyName}' === 'Delete') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start < el.value.length && start === end) {
              el.value = el.value.substring(0, start) + el.value.substring(end + 1);
              el.selectionStart = el.selectionEnd = start;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
            }
          } else if (isInput && '${keyName}' === 'Enter') {
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (isInput && '${keyName}' === 'ArrowLeft') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start === end) { el.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1)); }
            else { el.setSelectionRange(start, start); }
          } else if (isInput && '${keyName}' === 'ArrowRight') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start === end) { el.setSelectionRange(Math.min(el.value.length, start + 1), Math.min(el.value.length, start + 1)); }
            else { el.setSelectionRange(end, end); }
          } else if (isInput && '${keyName}' === 'ArrowUp') {
            if (tag === 'textarea') {
              var pos = el.selectionStart || 0;
              var lineStart = el.value.lastIndexOf('\\n', pos - 1) + 1;
              el.setSelectionRange(lineStart, lineStart);
            } else { el.setSelectionRange(0, 0); }
          } else if (isInput && '${keyName}' === 'ArrowDown') {
            if (tag === 'textarea') {
              var pos = el.selectionEnd || 0;
              var nextNL = el.value.indexOf('\\n', pos);
              var lineEnd = nextNL === -1 ? el.value.length : nextNL;
              el.setSelectionRange(lineEnd, lineEnd);
            } else { el.setSelectionRange(el.value.length, el.value.length); }
          } else if (isInput && '${keyName}' === 'Home') {
            el.setSelectionRange(0, 0);
          } else if (isInput && '${keyName}' === 'End') {
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }
      })()`;
      wc.executeJavaScript(js).then(() => {
        if (!wc.isDestroyed()) {
          wc.executeJavaScript("if(window.__osrUpdateCaret) window.__osrUpdateCaret();").catch(() => {});
        }
      }).catch(() => {});
    }
  }

  private softwareCursorEnabled = false;

  protected injectFakeCaret(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const js = `(function(){
      if (window.__osrFakeCaretInit) { window.__osrUpdateCaret(); return; }
      window.__osrFakeCaretInit = true;
      var style = document.createElement('style');
      style.textContent = 'input, textarea { caret-color: transparent !important; } ' +
        '#__osr_fake_caret { position: fixed; width: 2px; height: 1.2em; background: #0078d4; ' +
        'pointer-events: none; z-index: 999998; display: none; animation: __osr_blink 1s step-end infinite; } ' +
        '@keyframes __osr_blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }';
      document.head.appendChild(style);
      var caret = document.createElement('div');
      caret.id = '__osr_fake_caret';
      document.body.appendChild(caret);
      var mirror = document.createElement('span');
      mirror.style.cssText = 'position:absolute; visibility:hidden; white-space:pre; top:0; left:0;';
      document.body.appendChild(mirror);

      function getCaretRect(el) {
        var cs = getComputedStyle(el);
        var pos = el.selectionStart || 0;
        var text = el.value.substring(0, pos);
        mirror.style.font = cs.font;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.textContent = text;
        var rect = el.getBoundingClientRect();
        var paddingLeft = parseFloat(cs.paddingLeft) || 0;
        var paddingTop = parseFloat(cs.paddingTop) || 0;
        var borderLeft = parseFloat(cs.borderLeftWidth) || 0;
        var borderTop = parseFloat(cs.borderTopWidth) || 0;
        var x = rect.left + paddingLeft + borderLeft + mirror.offsetWidth;
        var lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4);
        var y = rect.top + paddingTop + borderTop;
        return { x: x, y: y, h: lineHeight };
      }

      window.__osrUpdateCaret = function() {
        var el = document.activeElement;
        if (!el || !el.tagName) { caret.style.display = 'none'; return; }
        var tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') { caret.style.display = 'none'; return; }
        var r = getCaretRect(el);
        caret.style.left = r.x + 'px';
        caret.style.top = r.y + 'px';
        caret.style.height = r.h + 'px';
        caret.style.display = 'block';
      };

      document.addEventListener('input', window.__osrUpdateCaret, true);
      document.addEventListener('keydown', function() { setTimeout(window.__osrUpdateCaret, 0); }, true);
      document.addEventListener('click', window.__osrUpdateCaret, true);
      document.addEventListener('focusin', window.__osrUpdateCaret, true);
      document.addEventListener('focusout', function() { caret.style.display = 'none'; }, true);
      window.__osrUpdateCaret();
    })()`;
    this.window.webContents.executeJavaScript(js).catch(() => {});
  }

  setSoftwareCursorEnabled(enabled: boolean): void {
    this.softwareCursorEnabled = enabled;
    if (!this.window || this.window.isDestroyed()) return;
    if (enabled) {
      const js = `(function(){
        if (document.getElementById('__osr_sw_cursor')) return;
        var c = document.createElement('div');
        c.id = '__osr_sw_cursor';
        c.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;pointer-events:none;z-index:999999;display:none;';
        c.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M1 1 L1 12 L4 9 L6 14 L8 13 L6 8 L11 8 Z" fill="white" stroke="black" stroke-width="1"/></svg>';
        document.body.appendChild(c);
      })()`;
      this.window.webContents.executeJavaScript(js).catch(() => {});
    } else {
      const js = `(function(){
        var c = document.getElementById('__osr_sw_cursor');
        if (c) c.remove();
      })()`;
      this.window.webContents.executeJavaScript(js).catch(() => {});
    }
  }

  isSoftwareCursorEnabled(): boolean {
    return this.softwareCursorEnabled;
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
