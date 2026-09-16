// ============================================================================
// MapCanvas — 2D canvas overlay for the zoomed-out map mode.
//
// Built on the shared SabCanvasOverlay (core/render): the overlay owns the
// DOM plumbing (visible canvas, opacity/display, window resize, seq-gated
// bitmap repaint); this file supplies the map-specific compositing (4 SAB
// planes → palette RGBA) and drawing (camera-aligned bitmap + markers).
// ============================================================================

import { SabCanvasOverlay } from "@downdraft/core";
import { CHUNK_W, MASK_LIQUID, MASK_SOLID } from "./shared/constants";
import type { MapStation } from "./shared/map-buffer";
import {
    MAP_REGION_COLS, REGION_BLOCK_H, REGION_BLOCK_W,
    getMapSabViews, type MapSabViews,
} from "./shared/map-buffer";

const BW = REGION_BLOCK_W; // 8192
const BH = REGION_BLOCK_H; // 1024
const REGION_WIDTH = MAP_REGION_COLS * CHUNK_W; // 8192
const STATION_COLOR = "#ffd700"; // gold

export interface MapCameraStats {
  camWorldX: number;
  camWorldY: number;
  camZoom: number;
  mapOpacity: number;
  playerWorldX: number;
  playerWorldY: number;
  playerFacing: number;
  skyColor: [number, number, number];
}

export class MapCanvas {
  private overlay: SabCanvasOverlay;
  private views: MapSabViews;
  private palette: Uint8Array;
  private region: { cx0: number; stations: MapStation[] } | null = null;
  private stats: MapCameraStats | null = null;

  constructor(mapSab: SharedArrayBuffer, palette: Uint8Array) {
    this.views = getMapSabViews(mapSab);
    this.palette = palette;

    this.overlay = new SabCanvasOverlay({
      id: "map-overlay-canvas",
      bitmapWidth: BW,
      bitmapHeight: BH,
      getSeq: () => this.views.seq[0],
      redrawBitmap: (ctx) => this.redrawBitmap(ctx),
      draw: (ctx, bitmap, w, h) => this.draw(ctx, bitmap!, w, h),
    });
  }

  /** Attach the canvas to the DOM (call once during init). */
  mount(parent: HTMLElement = document.body): void {
    this.overlay.mount(parent);
  }

  /** Update the region metadata (cx0 + stations) from the sim worker. */
  setRegion(cx0: number, stations: MapStation[]): void {
    this.region = { cx0, stations };
  }

  /**
   * Per-frame update. Called from the main render loop.
   * Reads the SAB directly (no postMessage), composites the bitmap if the
   * seq counter changed, then draws the bitmap + markers to the visible canvas.
   */
  update(stats: MapCameraStats): void {
    this.stats = stats;
    this.overlay.update(stats.mapOpacity);
  }

  private draw(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, w: number, h: number): void {
    const stats = this.stats!;
    if (!this.region) return;

    // Draw background (sky color from the renderer's daylight level).
    const [sr, sg, sb] = stats.skyColor;
    ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
    ctx.fillRect(0, 0, w, h);

    // Draw the bitmap, positioned to align with the camera.
    const cx0 = this.region.cx0;
    const regionWorldX0 = cx0 * CHUNK_W;
    const wrap = (wx: number): number =>
      (((wx - regionWorldX0) % REGION_WIDTH) + REGION_WIDTH) % REGION_WIDTH;
    const camStripX = wrap(stats.camWorldX);
    const mapPxPerBlock = stats.camZoom;

    // The bitmap's pixel (0,0) corresponds to world (regionWorldX0, 0).
    // We want world (camWorldX, camWorldY) at screen center.
    // bitmapX = (worldX - regionWorldX0) wrapped to [0, REGION_WIDTH)
    // screenX = w/2 + (bitmapX - camStripX) * mapPxPerBlock
    const screenX0 = w / 2 + (0 - camStripX) * mapPxPerBlock;
    const screenY0 = h / 2 + (0 - stats.camWorldY) * mapPxPerBlock;
    const drawW = BW * mapPxPerBlock;
    const drawH = BH * mapPxPerBlock;

    // The bitmap wraps horizontally (cylindrical world). Draw it twice to
    // handle the wrap-around seam.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, screenX0, screenY0, drawW, drawH);
    if (screenX0 > 0) {
      ctx.drawImage(bitmap, screenX0 - drawW, screenY0, drawW, drawH);
    } else if (screenX0 + drawW < w) {
      ctx.drawImage(bitmap, screenX0 + drawW, screenY0, drawW, drawH);
    }

    // Draw player marker.
    const px = w / 2 + (wrap(stats.playerWorldX) - camStripX) * mapPxPerBlock;
    const py = h / 2 + (stats.playerWorldY - stats.camWorldY) * mapPxPerBlock;
    const dir = stats.playerFacing >= 0 ? 1 : -1;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + 8 * dir, py);
    ctx.stroke();

    // Draw station markers.
    ctx.fillStyle = STATION_COLOR;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    for (const s of this.region.stations) {
      const ssx = w / 2 + (wrap(s.wx) - camStripX) * mapPxPerBlock;
      const ssy = h / 2 + (s.wy - stats.camWorldY) * mapPxPerBlock;
      if (ssx < -8 || ssx > w + 8 || ssy < -8 || ssy > h + 8) continue;
      ctx.fillRect(ssx - 3, ssy - 3, 6, 6);
      ctx.strokeRect(ssx - 3, ssy - 3, 6, 6);
    }
  }

  /**
   * Composite all 4 SAB planes into the bitmap canvas.
   * Back-to-front: background (dimmed) → mask (tinted) → vfx → foreground.
   * Fog (unexplored) = opaque black. Air = transparent.
   */
  private redrawBitmap(bitmapCtx: CanvasRenderingContext2D): void {
    const { foreground, background, mask, vfx, explored } = this.views;
    const pal = this.palette;
    const n = BW * BH;

    const img = bitmapCtx.createImageData(BW, BH);
    const view = new Uint32Array(img.data.buffer);
    const fogRGBA = 0xff000000; // opaque black (little-endian: R=0, G=0, B=0, A=255)

    for (let i = 0; i < n; i++) {
      if (explored[i] === 0) { view[i] = fogRGBA; continue; }

      let r = 0, g = 0, b = 0, a = 0;

      // 1. Background (backwalls + trees) — dimmed 50%.
      // Tree blocks are packed as (blockId & 0xFF) | (treeTag << 8), so
      // mask off the tag bits for the palette lookup.
      const bgId = background[i] & 0xFF;
      if (bgId !== 0) {
        const off = bgId * 4;
        r = (pal[off] * 0.5) | 0;
        g = (pal[off + 1] * 0.5) | 0;
        b = (pal[off + 2] * 0.5) | 0;
        a = pal[off + 3];
      }

      // 2. Mask — tint by flags (solid=gray, liquid=blue).
      const m = mask[i];
      if (m !== 0) {
        const isLiquid = (m & MASK_LIQUID) !== 0;
        const isSolid = (m & MASK_SOLID) !== 0;
        if (isLiquid && isSolid) { r = (r + 0xa0) >> 1; g = (g + 0x20) >> 1; b = (b + 0x40) >> 1; a = 255; }
        else if (isLiquid) { r = (r + 0x20) >> 1; g = (g + 0x60) >> 1; b = (b + 0xa0) >> 1; a = 255; }
        else if (isSolid) { r = (r + 0x40) >> 1; g = (g + 0x40) >> 1; b = (b + 0x40) >> 1; a = 255; }
      }

      // 3. VFX — packed RGBA u32 (blended 50%).
      const v = vfx[i];
      if (v !== 0) {
        const vr = v & 0xff;
        const vg = (v >> 8) & 0xff;
        const vb = (v >> 16) & 0xff;
        const va = (v >> 24) & 0xff;
        if (va > 0) {
          r = (r + vr) >> 1;
          g = (g + vg) >> 1;
          b = (b + vb) >> 1;
          a = Math.max(a, va);
        }
      }

      // 4. Foreground — full block colors (replaces everything below).
      // Mask off any upper bits (flow data for liquids, etc.).
      const fgId = foreground[i] & 0xFF;
      if (fgId !== 0) {
        const off = fgId * 4;
        r = pal[off];
        g = pal[off + 1];
        b = pal[off + 2];
        a = pal[off + 3];
      }

      // Little-endian u32: R | G<<8 | B<<16 | A<<24
      view[i] = r | (g << 8) | (b << 16) | (a << 24);
    }

    bitmapCtx.putImageData(img, 0, 0);
  }

  dispose(): void {
    this.overlay.dispose();
  }
}
