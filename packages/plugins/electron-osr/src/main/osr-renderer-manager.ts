// ============================================================================
// OSR Renderer Manager — Manages all OSR renderer instances
// ============================================================================

import { screen, type WebContents } from "electron";
import { OSRRenderer, type RendererEventCallback } from "./osr-renderer.ts";
import { OSRAtlasRenderer } from "./osr-atlas-renderer.ts";
import { OSRDedicatedRenderer } from "./osr-dedicated-renderer.ts";
import type { OSRRendererConfig, OSRRendererEvent, AtlasLayout } from "../types.ts";

export class OSRRendererManager {
  private renderers = new Map<string, OSRRenderer>();
  private targetWebContents: WebContents | null = null;
  private onEvent: RendererEventCallback | null = null;
  private displayMetricsListener: ((...args: any[]) => void) | null = null;

  setTargetWebContents(wc: WebContents): void {
    this.targetWebContents = wc;
    for (const renderer of this.renderers.values()) {
      renderer.setTargetWebContents(wc);
    }
  }

  setEventCallback(cb: (event: OSRRendererEvent) => void): void {
    this.onEvent = (rendererId, status, crashCount) => {
      cb({ rendererId, status, crashCount });
    };
  }

  getDisplayRefreshRate(): number {
    const display = screen.getPrimaryDisplay();
    return display.displayFrequency || 60;
  }

  createRenderer(config: OSRRendererConfig): OSRRenderer {
    if (this.renderers.has(config.id)) {
      throw new Error(`OSR renderer '${config.id}' already exists`);
    }

    const displayRefreshRate = this.getDisplayRefreshRate();
    const pixelFormat = config.sharedTexturePixelFormat ?? "rgba";
    const maxCrashRetries = config.maxCrashRetries ?? 3;

    let renderer: OSRRenderer;
    if (config.mode === "atlas") {
      renderer = new OSRAtlasRenderer(
        config.id,
        config.width,
        config.height,
        config.frameRate,
        displayRefreshRate,
        pixelFormat,
        maxCrashRetries,
      );
    } else {
      renderer = new OSRDedicatedRenderer(
        config.id,
        config.width,
        config.height,
        config.frameRate,
        displayRefreshRate,
        pixelFormat,
        maxCrashRetries,
      );
    }

    if (this.targetWebContents) {
      renderer.setTargetWebContents(this.targetWebContents);
    }
    if (this.onEvent) {
      renderer.setEventCallback(this.onEvent);
    }

    renderer.loadContent();
    this.renderers.set(config.id, renderer);
    return renderer;
  }

  destroyRenderer(id: string): void {
    const renderer = this.renderers.get(id);
    if (renderer) {
      renderer.destroy();
      this.renderers.delete(id);
    }
  }

  getRenderer(id: string): OSRRenderer | null {
    return this.renderers.get(id) ?? null;
  }

  getAtlasLayout(id: string): AtlasLayout | null {
    const renderer = this.renderers.get(id);
    if (renderer instanceof OSRAtlasRenderer) {
      return renderer.getLayout();
    }
    return null;
  }

  /** Re-clamp all renderer framerates when display refresh rate changes. */
  onDisplayMetricsChanged(): void {
    const refreshRate = this.getDisplayRefreshRate();
    for (const renderer of this.renderers.values()) {
      renderer.setDisplayRefreshRate(refreshRate);
    }
  }

  /** Register a listener for display-metrics-changed events. */
  registerDisplayMetricsListener(): void {
    this.displayMetricsListener = () => {
      this.onDisplayMetricsChanged();
    };
    screen.on("display-metrics-changed", this.displayMetricsListener as any);
  }

  destroy(): void {
    if (this.displayMetricsListener) {
      screen.off("display-metrics-changed", this.displayMetricsListener as any);
      this.displayMetricsListener = null;
    }
    for (const renderer of this.renderers.values()) {
      renderer.destroy();
    }
    this.renderers.clear();
  }
}
