// ============================================================================
// OSR Renderer — Abstract base class for offscreen rendering BrowserWindows
// ============================================================================

import { BrowserWindow, clipboard, type WebContents } from "electron";
import type {
  AtlasPanelRect,
  OSRDataUpdate,
  OSRInputEvent,
  OSRPanelConfig,
  OSRRendererMode,
  OSRRendererStatus,
  OSRSharedTexturePixelFormat,
} from "../types";
const { sharedTexture, ipcMain } = require("electron") as any;
const { deflateSync } = require("zlib") as typeof import("zlib");

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
  protected useSharedTexture: boolean;
  protected sharedTextureFailed = false;
  protected paintWatchdogTimer: NodeJS.Timeout | null = null;
  protected syncTokenHandler: ((_e: any, rId: string, syncToken: any) => void) | null = null;
  protected static readonly PAINT_WATCHDOG_MS = 5000;

  constructor(
    id: string,
    mode: OSRRendererMode,
    width: number,
    height: number,
    frameRate: number,
    displayRefreshRate: number,
    pixelFormat: OSRSharedTexturePixelFormat,
    maxCrashRetries: number,
    useSharedTexture?: boolean,
  ) {
    this.id = id;
    this.mode = mode;
    this.width = width;
    this.height = height;
    this.frameRate = Math.min(frameRate, displayRefreshRate);
    this.displayRefreshRate = displayRefreshRate;
    this.pixelFormat = pixelFormat;
    this.maxCrashRetries = maxCrashRetries;

    // Determine useSharedTexture: explicit param > env override > platform default
    // Linux/NVIDIA shared textures produce empty VideoFrames (Chromium platform bug),
    // so default to CPU on Linux. Other platforms default to shared texture.
    const envDisable = process.env.DOWNDRAFT_OSR_DISABLE_SHARED_TEXTURE;
    if (envDisable === "1" || envDisable === "true") {
      this.useSharedTexture = false;
    } else {
      this.useSharedTexture = useSharedTexture ?? (process.platform !== "linux");
    }
    console.log(`[OSR] Renderer '${this.id}': ${width}x${height} @${this.frameRate}fps, useSharedTexture=${this.useSharedTexture}`);
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
    const useShared = this.useSharedTexture && !this.sharedTextureFailed;
    console.log(`[OSR] createWindow for '${this.id}': useSharedTexture=${useShared} (requested=${this.useSharedTexture}, failed=${this.sharedTextureFailed})`);

    const win = new BrowserWindow({
      width: this.width,
      height: this.height,
      show: false,
      frame: false,
      webPreferences: {
        offscreen: {
          useSharedTexture: useShared,
        } as any,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      } as any,
    });

    win.webContents.setFrameRate(this.frameRate);

    // Paint event → import shared texture → send to game renderer
    // CPU mode: (event, dirtyRect, image: NativeImage)
    // Shared texture mode: (event, dirtyRect, image) with event.texture set
    let paintCount = 0;
    let sharedTexturePaintCount = 0;
    let cpuPaintCount = 0;
    // Queue of imported textures pending release — kept alive until the preload
    // sends back a sync token confirming the renderer has acquired the texture.
    const pendingReleases: { imported: any; texture: any }[] = [];

    // Sync token handler — confirms the target process has acquired the shared
    // texture on the GPU before we release the source.
    const syncTokenHandler = (_e: any, rId: string, syncToken: any) => {
      if (rId !== this.id) return;
      if (pendingReleases.length > 0) {
        const pending = pendingReleases.shift()!;
        try {
          pending.imported.setReleaseSyncToken(syncToken);
          pending.imported.release(() => {
            try { pending.texture.release(); } catch {}
          });
        } catch {
          try { pending.texture.release(); } catch {}
        }
      }
    };
    ipcMain.on("__osr_sync_token", syncTokenHandler);
    this.syncTokenHandler = syncTokenHandler;

    this.startPaintWatchdog();

    win.webContents.on("paint", (event: any, ...args: any[]) => {
      // Only reset watchdog before first paint — once we've received a paint,
      // the GPU process is working. Static pages won't generate continuous paints.
      if (paintCount === 0) {
        this.resetPaintWatchdog();
      } else if (this.paintWatchdogTimer) {
        this.clearPaintWatchdog();
      }

      const texture = event.texture;
      const isSharedTextureMode = !!texture;

      if (paintCount === 0) {
        console.log(`[OSR] First paint for '${this.id}': sharedTexture=${isSharedTextureMode}`);
      }

      if (isSharedTextureMode) {
        sharedTexturePaintCount++;

        if (!texture || !this.targetWebContents || this.targetWebContents.isDestroyed()) {
          if (texture) texture.release();
          return;
        }
        const subtle = sharedTexture?.subtle;
        if (!subtle?.importSharedTexture) {
          if (sharedTexturePaintCount === 1) {
            console.error(`[OSR] sharedTexture.subtle not available for '${this.id}' — falling back to CPU`);
          }
          this.fallbackToCpu();
          texture.release();
          return;
        }
        try {
          // Try high-level sendSharedTexture API first — handles GPU sync automatically
          if (sharedTexture?.sendSharedTexture && sharedTexture?.importSharedTexture) {
            const imported = sharedTexture.importSharedTexture({ textureInfo: texture.textureInfo });
            if (sharedTexturePaintCount === 1) {
              console.log(`[OSR] Using sendSharedTexture API for '${this.id}'`);
            }
            sharedTexture.sendSharedTexture({ frame: this.targetWebContents.mainFrame, importedSharedTexture: imported }, this.id);
            pendingReleases.push({ imported, texture });
            while (pendingReleases.length > 5) {
              const old = pendingReleases.shift()!;
              try { old.imported.release(() => { try { old.texture.release(); } catch {} }); } catch {}
            }
          } else {
            // Fallback: subtle API with manual transfer
            const imported = subtle.importSharedTexture(texture.textureInfo);
            if (sharedTexturePaintCount === 1) {
              console.log(`[OSR] Using subtle API transfer for '${this.id}'`);
            }
            const transfer = imported.startTransferSharedTexture();
            this.targetWebContents.send("__osr_shared_texture_transfer", this.id, transfer);
            pendingReleases.push({ imported, texture });
            while (pendingReleases.length > 5) {
              const old = pendingReleases.shift()!;
              try { old.imported.release(() => { try { old.texture.release(); } catch {} }); } catch {}
            }
          }
        } catch (err) {
          console.error(`[OSR] Shared texture transfer failed for '${this.id}':`, err);
          texture.release();
          if (sharedTexturePaintCount <= 2) {
            this.fallbackToCpu();
          }
        }
      } else {
        cpuPaintCount++;

        if (useShared && paintCount === 0) {
          console.warn(`[OSR] useSharedTexture=true but no texture in paint event — Electron fell back to CPU for '${this.id}'`);
        }

        // CPU bitmap mode — (event, dirtyRect, image: NativeImage)
        // Extract dirty rect and crop — only send the changed region
        const dirtyRect = args[0];
        const image = args[1];
        if (!image || !this.targetWebContents || this.targetWebContents.isDestroyed()) {
          return;
        }
        try {
          const fullSize = image.getSize();
          if (fullSize.width === 0 || fullSize.height === 0) return;

          // Clamp dirty rect to frame bounds — Chromium can report rects that overflow
          let rx = Math.max(0, Math.min(dirtyRect?.x ?? 0, fullSize.width - 1));
          let ry = Math.max(0, Math.min(dirtyRect?.y ?? 0, fullSize.height - 1));
          let rw = Math.max(1, Math.min(dirtyRect?.width ?? fullSize.width, fullSize.width - rx));
          let rh = Math.max(1, Math.min(dirtyRect?.height ?? fullSize.height, fullSize.height - ry));

          // Crop to dirty rect — only send the changed region
          let didCrop = false;
          if (rw > 0 && rh > 0 && (rw < fullSize.width || rh < fullSize.height)) {
            try {
              image.crop({ x: rx, y: ry, width: rw, height: rh });
              const croppedSize = image.getSize();
              // Verify crop actually worked — if size unchanged, crop() is a no-op
              if (croppedSize.width === rw && croppedSize.height === rh) {
                didCrop = true;
              }
            } catch {}
          }

          const croppedSize = image.getSize();
          const rawBitmap = image.toBitmap();

          // If crop didn't work, send full frame with origin (0,0)
          let sendX = rx;
          let sendY = ry;
          let sendW = croppedSize.width;
          let sendH = croppedSize.height;
          if (!didCrop && (sendW > rw || sendH > rh)) {
            sendX = 0;
            sendY = 0;
            sendW = fullSize.width;
            sendH = fullSize.height;
          }

          // Compress small regions with zlib (level 3 = fast)
          // Skip compression for large regions (>1MB) — overhead exceeds benefit
          let data: Uint8Array = rawBitmap;
          let compressed = false;
          if (rawBitmap.length < 1048576) {
            try {
              const deflated = deflateSync(rawBitmap, { level: 3 });
              if (deflated.length < rawBitmap.length) {
                data = deflated;
                compressed = true;
              }
            } catch {}
          }

          if (cpuPaintCount <= 3) {
            const ratio = compressed ? `${(data.length / rawBitmap.length * 100).toFixed(0)}%` : "raw";
            console.log(`[OSR] CPU paint #${cpuPaintCount} for '${this.id}': region ${sendW}x${sendH} at (${sendX},${sendY}), ${rawBitmap.length}B → ${data.length}B (${ratio})${didCrop ? "" : " (crop failed, full frame)"}`);
          }

          // Convert to clean ArrayBuffer for zero-copy transfer via postMessage
          const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          this.targetWebContents.send("__osr_paint_region", this.id, {
            x: sendX, y: sendY,
            width: sendW,
            height: sendH,
            fullWidth: fullSize.width,
            fullHeight: fullSize.height,
            data: arrayBuffer,
            compressed,
          });
        } catch {
          return;
        }
      }
      paintCount++;
    });

    // Crash handling
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[OSR] render-process-gone for '${this.id}': reason=${details.reason}, exitCode=${details.exitCode}`);
      if (this.useSharedTexture && !this.sharedTextureFailed) {
        this.sharedTextureFailed = true;
      }
      this.handleCrash(details.reason);
    });

    return win;
  }

  protected startPaintWatchdog(): void {
    this.clearPaintWatchdog();
    this.paintWatchdogTimer = setTimeout(() => {
      if (this.useSharedTexture && !this.sharedTextureFailed) {
        console.warn(`[OSR] Paint watchdog: no paint within ${OSRRenderer.PAINT_WATCHDOG_MS}ms for '${this.id}' — falling back to CPU`);
        this.fallbackToCpu();
      }
    }, OSRRenderer.PAINT_WATCHDOG_MS);
  }

  protected resetPaintWatchdog(): void {
    if (this.paintWatchdogTimer) {
      clearTimeout(this.paintWatchdogTimer);
    }
    this.paintWatchdogTimer = setTimeout(() => {
      if (this.useSharedTexture && !this.sharedTextureFailed) {
        console.warn(`[OSR] Paint watchdog: no paint within ${OSRRenderer.PAINT_WATCHDOG_MS}ms for '${this.id}' — GPU process may be broken, falling back to CPU`);
        this.fallbackToCpu();
      }
    }, OSRRenderer.PAINT_WATCHDOG_MS);
  }

  protected clearPaintWatchdog(): void {
    if (this.paintWatchdogTimer) {
      clearTimeout(this.paintWatchdogTimer);
      this.paintWatchdogTimer = null;
    }
  }

  protected fallbackToCpu(): void {
    if (this.sharedTextureFailed) return;
    this.sharedTextureFailed = true;
    console.warn(`[OSR] Falling back to CPU path for '${this.id}'`);

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.stopPainting();
      this.window.destroy();
    }
    this.window = this.createWindow();
    this.dirty = true;
    this.painting = true;
    this.loadContent();
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
    this.clearPaintWatchdog();
    if (this.syncTokenHandler) {
      ipcMain.removeListener("__osr_sync_token", this.syncTokenHandler);
      this.syncTokenHandler = null;
    }
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
          // Find if we clicked on an input/textarea
          var inputEl = null;
          var target = el;
          while (target && target !== document.body) {
            if (target.tagName && (target.tagName.toLowerCase() === 'input' || target.tagName.toLowerCase() === 'textarea')) {
              inputEl = target;
              break;
            }
            target = target.parentElement;
          }
          if (inputEl) {
            inputEl.focus();
            // Set caret position based on click X offset within the input
            var cs = getComputedStyle(inputEl);
            var rect = inputEl.getBoundingClientRect();
            var clickX = ${px} - rect.left - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.borderLeftWidth) || 0);
            var mirror = document.createElement('span');
            mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
            mirror.style.font = cs.font;
            mirror.style.fontSize = cs.fontSize;
            mirror.style.fontFamily = cs.fontFamily;
            mirror.style.fontWeight = cs.fontWeight;
            mirror.style.letterSpacing = cs.letterSpacing;
            document.body.appendChild(mirror);
            var pos = 0;
            for (var i = 0; i <= inputEl.value.length; i++) {
              mirror.textContent = inputEl.value.substring(0, i);
              if (mirror.offsetWidth >= clickX) { pos = i; break; }
              pos = i;
            }
            mirror.remove();
            inputEl.setSelectionRange(pos, pos);
            window.__osrDragStart = pos;
          } else {
            // Click outside any input — blur the active input
            var active = document.activeElement;
            if (active && active.tagName && (active.tagName.toLowerCase() === 'input' || active.tagName.toLowerCase() === 'textarea')) {
              active.blur();
            }
            window.__osrDragStart = null;
          }
        }
        if ('${domType}' === 'mousemove') {
          // Handle drag selection if mouse button is down and we started on an input
          if (window.__osrDragStart != null) {
            var active = document.activeElement;
            if (active && active.tagName && (active.tagName.toLowerCase() === 'input' || active.tagName.toLowerCase() === 'textarea')) {
              var cs = getComputedStyle(active);
              var rect = active.getBoundingClientRect();
              var dragX = ${px} - rect.left - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.borderLeftWidth) || 0);
              var mirror = document.createElement('span');
              mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
              mirror.style.font = cs.font;
              mirror.style.fontSize = cs.fontSize;
              mirror.style.fontFamily = cs.fontFamily;
              mirror.style.fontWeight = cs.fontWeight;
              mirror.style.letterSpacing = cs.letterSpacing;
              document.body.appendChild(mirror);
              var pos = 0;
              for (var i = 0; i <= active.value.length; i++) {
                mirror.textContent = active.value.substring(0, i);
                if (mirror.offsetWidth >= dragX) { pos = i; break; }
                pos = i;
              }
              mirror.remove();
              var start = window.__osrDragStart;
              if (pos < start) { active.setSelectionRange(pos, start); }
              else { active.setSelectionRange(start, pos); }
            }
          }
        }
        if ('${domType}' === 'mouseup') {
          window.__osrDragStart = null;
        }
        // Update software cursor position if enabled
        var sc = document.getElementById('__osr_sw_cursor');
        if (sc) { sc.style.left = ${px} + 'px'; sc.style.top = ${py} + 'px'; sc.style.display = 'block'; }
        if (window.__osrUpdateCaret) window.__osrUpdateCaret();
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
      const mods = event.modifiers ?? [];
      const js = `(function(){
        var el = document.activeElement || document.body;
        var ctrl = ${mods.includes('Control')};
        var shift = ${mods.includes('Shift')};
        var ev = new KeyboardEvent('${domType}', {
          bubbles: true, cancelable: true, view: window,
          key: '${keyName}', code: '${keyName.length === 1 ? 'Key' + keyName.toUpperCase() : keyName}',
          ctrlKey: ctrl, shiftKey: shift, altKey: ${mods.includes('Alt')}, metaKey: ${mods.includes('Meta')}
        });
        el.dispatchEvent(ev);
        if ('${domType}' === 'keydown' && el.tagName) {
          var tag = el.tagName.toLowerCase();
          var isInput = (tag === 'input' || tag === 'textarea');
          if (isInput && ctrl && '${keyName}' === 'a') {
            el.setSelectionRange(0, el.value.length);
          } else if (isInput && ctrl && '${keyName}' === 'c') {
            var s = el.selectionStart || 0, e = el.selectionEnd || 0;
            if (s !== e) { window.__osrClipboardText = el.value.substring(s, e); }
          } else if (isInput && ctrl && '${keyName}' === 'x') {
            var s = el.selectionStart || 0, e = el.selectionEnd || 0;
            if (s !== e) {
              window.__osrClipboardText = el.value.substring(s, e);
              el.value = el.value.substring(0, s) + el.value.substring(e);
              el.setSelectionRange(s, s);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
            }
          } else if (isInput && ctrl && '${keyName}' === 'v') {
            var txt = window.__osrClipboardPaste || '';
            if (txt) {
              var s = el.selectionStart || 0, e = el.selectionEnd || 0;
              el.value = el.value.substring(0, s) + txt + el.value.substring(e);
              el.setSelectionRange(s + txt.length, s + txt.length);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: txt }));
            }
          } else if (isInput && ctrl && '${keyName}' === 'ArrowLeft') {
            var s = el.selectionStart || 0;
            var newPos = s;
            if (shift) { newPos = s; }
            // Skip non-word chars then skip word chars
            var v = el.value;
            newPos = s;
            while (newPos > 0 && /\\W/.test(v[newPos - 1])) newPos--;
            while (newPos > 0 && /\\w/.test(v[newPos - 1])) newPos--;
            if (shift) { el.setSelectionRange(newPos, s); }
            else { el.setSelectionRange(newPos, newPos); }
          } else if (isInput && ctrl && '${keyName}' === 'ArrowRight') {
            var s = el.selectionEnd || 0;
            var v = el.value;
            var newPos = s;
            while (newPos < v.length && /\\W/.test(v[newPos])) newPos++;
            while (newPos < v.length && /\\w/.test(v[newPos])) newPos++;
            if (shift) { el.setSelectionRange(el.selectionStart, newPos); }
            else { el.setSelectionRange(newPos, newPos); }
          } else if (isInput && shift && '${keyName}' === 'ArrowLeft') {
            var s = el.selectionStart || 0;
            if (s > 0) el.setSelectionRange(s - 1, el.selectionEnd);
          } else if (isInput && shift && '${keyName}' === 'ArrowRight') {
            var e = el.selectionEnd || 0;
            if (e < el.value.length) el.setSelectionRange(el.selectionStart, e + 1);
          } else if (isInput && shift && '${keyName}' === 'Home') {
            el.setSelectionRange(0, el.selectionEnd);
          } else if (isInput && shift && '${keyName}' === 'End') {
            el.setSelectionRange(el.selectionStart, el.value.length);
          } else if (isInput && '${keyName}'.length === 1 && !ctrl) {
            // Synthetic KeyboardEvents don't insert text — do it manually
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            el.value = el.value.substring(0, start) + '${keyName}' + el.value.substring(end);
            el.selectionStart = el.selectionEnd = start + 1;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '${keyName}' }));
          } else if (isInput && '${keyName}' === 'Backspace') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start !== end) {
              el.value = el.value.substring(0, start) + el.value.substring(end);
              el.setSelectionRange(start, start);
            } else if (start > 0) {
              el.value = el.value.substring(0, start - 1) + el.value.substring(end);
              el.selectionStart = el.selectionEnd = start - 1;
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          } else if (isInput && '${keyName}' === 'Delete') {
            var start = el.selectionStart || 0;
            var end = el.selectionEnd || 0;
            if (start !== end) {
              el.value = el.value.substring(0, start) + el.value.substring(end);
              el.setSelectionRange(start, start);
            } else if (start < el.value.length) {
              el.value = el.value.substring(0, start) + el.value.substring(end + 1);
              el.setSelectionRange(start, start);
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
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
      // For paste: inject clipboard text before running keydown JS
      const isPaste = mods.includes("Control") && keyName === "v";
      const isCopyOrCut = mods.includes("Control") && (keyName === "c" || keyName === "x");
      const runJs = () => {
        wc.executeJavaScript(js).then(() => {
          if (!wc.isDestroyed()) {
            if (isCopyOrCut) {
              wc.executeJavaScript("window.__osrClipboardText || ''").then((text: string) => {
                if (text) clipboard.writeText(text);
              }).catch(() => {});
            }
            wc.executeJavaScript("if(window.__osrUpdateCaret) window.__osrUpdateCaret();").catch(() => {});
          }
        }).catch(() => {});
      };
      if (isPaste) {
        const pasteText = clipboard.readText().replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
        wc.executeJavaScript(`window.__osrClipboardPaste = '${pasteText}';`).then(() => runJs()).catch(() => runJs());
      } else {
        runJs();
      }
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
        '#__osr_sel_highlight { position: fixed; background: rgba(0,120,212,0.25); ' +
        'pointer-events: none; z-index: 999997; display: none; } ' +
        '@keyframes __osr_blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }';
      document.head.appendChild(style);
      var caret = document.createElement('div');
      caret.id = '__osr_fake_caret';
      document.body.appendChild(caret);
      var selHighlight = document.createElement('div');
      selHighlight.id = '__osr_sel_highlight';
      document.body.appendChild(selHighlight);
      var mirror = document.createElement('span');
      mirror.style.cssText = 'position:absolute; visibility:hidden; white-space:pre; top:0; left:0;';
      document.body.appendChild(mirror);

      function measureText(el, text) {
        var cs = getComputedStyle(el);
        mirror.style.font = cs.font;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.textContent = text;
        return mirror.offsetWidth;
      }

      function getCaretRect(el) {
        var cs = getComputedStyle(el);
        var pos = el.selectionStart || 0;
        var text = el.value.substring(0, pos);
        var rect = el.getBoundingClientRect();
        var paddingLeft = parseFloat(cs.paddingLeft) || 0;
        var paddingTop = parseFloat(cs.paddingTop) || 0;
        var borderLeft = parseFloat(cs.borderLeftWidth) || 0;
        var borderTop = parseFloat(cs.borderTopWidth) || 0;
        var x = rect.left + paddingLeft + borderLeft + measureText(el, text);
        var lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4);
        var y = rect.top + paddingTop + borderTop;
        return { x: x, y: y, h: lineHeight, rect: rect, cs: cs };
      }

      window.__osrUpdateCaret = function() {
        var el = document.activeElement;
        if (!el || !el.tagName) { caret.style.display = 'none'; selHighlight.style.display = 'none'; return; }
        var tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') { caret.style.display = 'none'; selHighlight.style.display = 'none'; return; }
        var s = el.selectionStart || 0;
        var e = el.selectionEnd || 0;
        if (s !== e) {
          // Show selection highlight
          var r = getCaretRect(el);
          var selStartX = r.rect.left + (parseFloat(r.cs.paddingLeft) || 0) + (parseFloat(r.cs.borderLeftWidth) || 0) + measureText(el, el.value.substring(0, s));
          var selEndX = r.rect.left + (parseFloat(r.cs.paddingLeft) || 0) + (parseFloat(r.cs.borderLeftWidth) || 0) + measureText(el, el.value.substring(0, e));
          selHighlight.style.left = Math.min(selStartX, selEndX) + 'px';
          selHighlight.style.top = r.y + 'px';
          selHighlight.style.width = Math.abs(selEndX - selStartX) + 'px';
          selHighlight.style.height = r.h + 'px';
          selHighlight.style.display = 'block';
          // Position caret at end of selection
          var endPos = e;
          var endX = r.rect.left + (parseFloat(r.cs.paddingLeft) || 0) + (parseFloat(r.cs.borderLeftWidth) || 0) + measureText(el, el.value.substring(0, endPos));
          caret.style.left = endX + 'px';
          caret.style.top = r.y + 'px';
          caret.style.height = r.h + 'px';
          caret.style.display = 'block';
        } else {
          selHighlight.style.display = 'none';
          var r2 = getCaretRect(el);
          caret.style.left = r2.x + 'px';
          caret.style.top = r2.y + 'px';
          caret.style.height = r2.h + 'px';
          caret.style.display = 'block';
        }
      };

      document.addEventListener('input', window.__osrUpdateCaret, true);
      document.addEventListener('keydown', function() { setTimeout(window.__osrUpdateCaret, 0); }, true);
      document.addEventListener('click', window.__osrUpdateCaret, true);
      document.addEventListener('focusin', window.__osrUpdateCaret, true);
      document.addEventListener('focusout', function() { caret.style.display = 'none'; selHighlight.style.display = 'none'; }, true);
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
    this.clearPaintWatchdog();
    if (this.syncTokenHandler) {
      ipcMain.removeListener("__osr_sync_token", this.syncTokenHandler);
      this.syncTokenHandler = null;
    }
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
