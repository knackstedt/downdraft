// ============================================================================
// MapCanvas — 2D canvas overlay for the zoomed-out map mode.
//
// Replaces the pixi-based MapOverlay. Uses a plain <canvas> element in the
// main thread that reads the map SAB directly and draws via putImageData.
// No pixi worker, no OffscreenCanvas transfer, no texture pipeline.
//
// The canvas is a separate DOM element layered above the 3D game canvas.
// It reads per-block data from the map SAB (SharedArrayBuffer shared with
// the sim worker), composites all 4 planes into a single RGBA bitmap, and
// draws it with putImageData. Player + station markers are drawn on top
// with 2D canvas primitives.
// ============================================================================

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
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bitmapCanvas: HTMLCanvasElement;
  private bitmapCtx: CanvasRenderingContext2D;
  private views: MapSabViews;
  private palette: Uint8Array;
  private region: { cx0: number; stations: MapStation[] } | null = null;
  private dirty = true; // redraw bitmap when SAB data changes
  private lastSeq = -1;

  constructor(mapSab: SharedArrayBuffer, palette: Uint8Array) {
    this.views = getMapSabViews(mapSab);
    this.palette = palette;

    // The visible canvas (sized to the window, positioned via CSS).
    this.canvas = document.createElement("canvas");
    this.canvas.id = "map-overlay-canvas";
    this.canvas.style.position = "fixed";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.zIndex = "55"; // above pixi-ui (z=50), below DOM overlay (z=100)
    this.canvas.style.display = "none"; // hidden until mapOpacity > 0
    this.canvas.style.imageRendering = "pixelated";
    this.ctx = this.canvas.getContext("2d")!;

    // The offscreen bitmap canvas (fixed size = region dimensions).
    this.bitmapCanvas = document.createElement("canvas");
    this.bitmapCanvas.width = BW;
    this.bitmapCanvas.height = BH;
    this.bitmapCtx = this.bitmapCanvas.getContext("2d")!;
  }

  /** Attach the canvas to the DOM (call once during init). */
  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.canvas);
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
    const opacity = stats.mapOpacity;
    if (opacity <= 0) {
      this.canvas.style.display = "none";
      return;
    }
    this.canvas.style.display = "block";
    this.canvas.style.opacity = String(opacity);

    // Resize the visible canvas to match the window if needed.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // Redraw the bitmap if the SAB has new data.
    const seq = this.views.seq[0];
    if (seq !== this.lastSeq) {
      this.lastSeq = seq;
      this.redrawBitmap();
    }

    if (!this.region) return;

    // Draw background (sky color from the renderer's daylight level).
    const [sr, sg, sb] = stats.skyColor;
    this.ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
    this.ctx.fillRect(0, 0, w, h);

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
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.bitmapCanvas, screenX0, screenY0, drawW, drawH);
    if (screenX0 > 0) {
      this.ctx.drawImage(this.bitmapCanvas, screenX0 - drawW, screenY0, drawW, drawH);
    } else if (screenX0 + drawW < w) {
      this.ctx.drawImage(this.bitmapCanvas, screenX0 + drawW, screenY0, drawW, drawH);
    }

    // Draw player marker.
    const px = w / 2 + (wrap(stats.playerWorldX) - camStripX) * mapPxPerBlock;
    const py = h / 2 + (stats.playerWorldY - stats.camWorldY) * mapPxPerBlock;
    const dir = stats.playerFacing >= 0 ? 1 : -1;
    this.ctx.fillStyle = "#ffffff";
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(px, py, 5, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(px, py);
    this.ctx.lineTo(px + 8 * dir, py);
    this.ctx.stroke();

    // Draw station markers.
    this.ctx.fillStyle = STATION_COLOR;
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 1;
    for (const s of this.region.stations) {
      const ssx = w / 2 + (wrap(s.wx) - camStripX) * mapPxPerBlock;
      const ssy = h / 2 + (s.wy - stats.camWorldY) * mapPxPerBlock;
      if (ssx < -8 || ssx > w + 8 || ssy < -8 || ssy > h + 8) continue;
      this.ctx.fillRect(ssx - 3, ssy - 3, 6, 6);
      this.ctx.strokeRect(ssx - 3, ssy - 3, 6, 6);
    }
  }

  /**
   * Composite all 4 SAB planes into the bitmap canvas.
   * Back-to-front: background (dimmed) → mask (tinted) → vfx → foreground.
   * Fog (unexplored) = opaque black. Air = transparent.
   */
  private redrawBitmap(): void {
    const { foreground, background, mask, vfx, explored } = this.views;
    const pal = this.palette;
    const n = BW * BH;

    const img = this.bitmapCtx.createImageData(BW, BH);
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

    this.bitmapCtx.putImageData(img, 0, 0);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
