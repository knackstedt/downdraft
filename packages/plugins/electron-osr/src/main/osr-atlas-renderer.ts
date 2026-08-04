// ============================================================================
// OSR Atlas Renderer — Multiple panels in one shared texture (fixed-size slots)
// ============================================================================

import { OSRRenderer } from "./osr-renderer";
import { generateAtlasHTML, buildAddPanelCall, buildRemovePanelCall, buildUpdatePanelCall, buildUpdateDataCall } from "./atlas-html";
import type { OSRPanelConfig, OSRDataUpdate, AtlasPanelRect, AtlasLayout, OSRSharedTexturePixelFormat } from "../types";

interface PackedPanel {
  id: string;
  rect: AtlasPanelRect;
  config: OSRPanelConfig;
}

export class OSRAtlasRenderer extends OSRRenderer {
  private panels = new Map<string, PackedPanel>();
  private nextY = 0;
  private readonly maxWidth: number;

  constructor(
    id: string,
    width: number,
    height: number,
    frameRate: number,
    displayRefreshRate: number,
    pixelFormat: OSRSharedTexturePixelFormat,
    maxCrashRetries: number,
  ) {
    super(id, "atlas", width, height, frameRate, displayRefreshRate, pixelFormat, maxCrashRetries);
    this.maxWidth = width;
  }

  loadContent(): void {
    if (!this.window) {
      this.window = this.createWindow();
    }
    const html = generateAtlasHTML(this.width, this.height);
    this.window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  }

  addPanel(config: OSRPanelConfig): AtlasPanelRect | null {
    if (this.panels.has(config.id)) return null;

    // Simple shelf packing: place panels left-to-right, wrap to next row
    const rect = this.packPanel(config.width, config.height);
    if (!rect) return null;

    this.panels.set(config.id, { id: config.id, rect, config });
    this.markDirty();

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.executeJavaScript(buildAddPanelCall(config.id, rect, config.html));
    }

    return rect;
  }

  removePanel(id: string): void {
    this.panels.delete(id);
    this.markDirty();

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.executeJavaScript(buildRemovePanelCall(id));
    }
  }

  updatePanelContent(id: string, html: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;

    panel.config.html = html;
    this.markDirty();

    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.executeJavaScript(buildUpdatePanelCall(id, html));
    }
  }

  applyDataUpdate(update: OSRDataUpdate): void {
    // Data-only update does NOT set dirty — the panel script applies values to
    // existing DOM nodes without triggering a full repaint. Chromium will paint
    // the changed regions on its next composite cycle.
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.executeJavaScript(buildUpdateDataCall(update.panelId, update.values));
    }
  }

  getPanelRect(panelId: string): AtlasPanelRect | null {
    return this.panels.get(panelId)?.rect ?? null;
  }

  getLayout(): AtlasLayout {
    const panelMap = new Map<string, AtlasPanelRect>();
    for (const [id, panel] of this.panels) {
      panelMap.set(id, panel.rect);
    }
    return { width: this.width, height: this.height, panels: panelMap };
  }

  private packPanel(w: number, h: number): AtlasPanelRect | null {
    // Shelf packing: try to fit on current row, otherwise start new row
    const lastPanel = Array.from(this.panels.values()).pop();
    let x = 0;
    let y = 0;

    if (lastPanel) {
      const lastRect = lastPanel.rect;
      if (lastRect.x + lastRect.w + w <= this.maxWidth) {
        x = lastRect.x + lastRect.w;
        y = lastRect.y;
      } else {
        // Find the max y of the current row
        let maxBottom = 0;
        for (const panel of this.panels.values()) {
          if (panel.rect.y === this.nextY) {
            maxBottom = Math.max(maxBottom, panel.rect.y + panel.rect.h);
          }
        }
        x = 0;
        y = maxBottom;
        this.nextY = maxBottom;
      }
    }

    if (y + h > this.height) return null;
    if (x + w > this.maxWidth) return null;

    return { x, y, w, h };
  }
}
