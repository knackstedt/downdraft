// ============================================================================
// OSR Dedicated Renderer — One panel per BrowserWindow (high-res, crash isolation)
// ============================================================================

import type { AtlasPanelRect, OSRDataUpdate, OSRSharedTexturePixelFormat } from "../types";
import { buildSetContentCall, buildUpdateDataCall, generateDedicatedHTML } from "./atlas-html";
import { OSRRenderer } from "./osr-renderer";

export class OSRDedicatedRenderer extends OSRRenderer {
  private content: string | null = null;

  constructor(
    id: string,
    width: number,
    height: number,
    frameRate: number,
    displayRefreshRate: number,
    pixelFormat: OSRSharedTexturePixelFormat,
    maxCrashRetries: number,
  ) {
    super(id, "dedicated", width, height, frameRate, displayRefreshRate, pixelFormat, maxCrashRetries);
  }

  loadContent(): void {
    if (!this.window) {
      this.window = this.createWindow();
    }
    const html = generateDedicatedHTML(this.width, this.height);
    this.window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  }

  setContent(html: string): void {
    this.content = html;
    this.markDirty();

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.executeJavaScript(buildSetContentCall(html)).then(() => {
        this.injectFakeCaret();
      }).catch(() => {});
    }
  }

  loadURL(url: string): void {
    this.content = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.once("did-finish-load", () => {
        this.injectFakeCaret();
      });
      this.window.loadURL(url);
    }
  }

  applyDataUpdate(update: OSRDataUpdate): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.executeJavaScript(buildUpdateDataCall(update.panelId, update.values));
    }
  }

  getPanelRect(_panelId: string): AtlasPanelRect | null {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  addPanel(): AtlasPanelRect | null {
    return null;
  }

  removePanel(_id: string): void {
    // No-op for dedicated mode
  }

  updatePanelContent(_id: string, html: string): void {
    this.setContent(html);
  }

  protected recreate(): void {
    super.recreate();
    if (this.content) {
      this.setContent(this.content);
    }
  }
}
