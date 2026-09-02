// ============================================================================
// MapOverlay — imperative PixiJS display objects for the zoomed-out 2D map.
//
// Managed entirely outside @pixi/react to avoid the per-frame `draw` callback
// churn that overflows PixiJS's GC instruction list. The scene's update()
// method calls MapOverlay.update() each frame with the latest SAB stats +
// events; the overlay updates its display objects imperatively.
//
// Per-block map data is streamed via the map SAB (SharedArrayBuffer shared
// between the sim worker and this pixi-ui worker). The sim worker writes
// all 4 chunk planes (foreground, background, mask, vfx) + explored flags
// directly into the SAB; this overlay reads them, composites all 4 planes
// into a single RGBA bitmap, and uploads it to one texture.
//
// Compositing order (back-to-front, into one bitmap):
//   1. background plane (backwalls) — dimmed block colors
//   2. mask plane (solid/liquid flags) — tinted overlay
//   3. vfx plane (particle effects) — effect colors
//   4. foreground plane (blocks) — full block colors
// Air (blockId=0) is transparent in each layer so lower layers show through.
// Unexplored cells are opaque black (fog).
//
// Display objects (added to ctx.app.stage in this order):
//   1. Container (alpha = mapOpacity, drives the crossfade)
//      ├── Background Graphics (opaque full-screen rect, covers the 3D scene)
//      ├── Sprite (composited bitmap texture)
//      └── Markers Graphics (player circle + station squares)
// ============================================================================

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { CHUNK_W, MASK_LIQUID, MASK_SOLID } from "../shared/constants";
import {
    MAP_REGION_COLS, REGION_BLOCK_H, REGION_BLOCK_W, THUMB_W,
    getMapSabViews, type MapSabViews,
} from "../shared/map-buffer";
import type { OverburdenEvent } from "./bridge-protocol";

const BW = REGION_BLOCK_W; // 8192
const BH = REGION_BLOCK_H; // 1024
const REGION_WIDTH = MAP_REGION_COLS * CHUNK_W; // 8192
const BG_COLOR = 0x1a1a2e;

interface MapStats {
  camWorldX: number;
  camWorldY: number;
  camZoom: number;
  mapOpacity: number;
  playerWorldX: number;
  playerWorldY: number;
  playerFacing: number;
}

interface MapRegionState {
  cx0: number;
  stations: { x: number; y: number; color: number }[];
}

export class MapOverlay {
  private container: Container;
  private bg: Graphics;
  private sprite: Sprite;
  private markers: Graphics;
  private bitmapCanvas: OffscreenCanvas;
  private bitmapCtx: OffscreenCanvasRenderingContext2D;
  private texture: Texture;
  private region: MapRegionState | null = null;
  private lastW = 0;
  private lastH = 0;

  private mapSabViews: MapSabViews | null = null;
  private palette: Uint8Array | null = null;

  constructor(private stage: Container, extraSharedBuffers?: Record<string, SharedArrayBuffer>) {
    this.container = new Container();
    this.container.visible = false;
    this.container.isRenderGroup = true;

    this.bg = new Graphics();
    this.container.addChild(this.bg);

    this.bitmapCanvas = new OffscreenCanvas(BW, BH);
    this.bitmapCtx = this.bitmapCanvas.getContext("2d")!;
    this.texture = Texture.from(this.bitmapCanvas);
    this.texture.source.scaleMode = "nearest";
    this.texture.source.premultipliedAlpha = false;
    this.sprite = new Sprite(this.texture);
    this.sprite.visible = false;
    this.container.addChild(this.sprite);

    this.markers = new Graphics();
    this.container.addChild(this.markers);

    this.stage.addChild(this.container);

    if (extraSharedBuffers?.mapSab) {
      this.mapSabViews = getMapSabViews(extraSharedBuffers.mapSab);
    }
  }

  update(stats: MapStats, events: OverburdenEvent[], width: number, height: number): void {
    let needRedraw = false;
    for (const e of events) {
      if (e.kind === "setMapPalette") {
        this.palette = e.palette;
        needRedraw = true;
      } else if (e.kind === "setMapRegion") {
        this.region = { cx0: e.cx0, stations: e.stations };
        // The setMapRegion event arrives via postMessage from the main thread,
        // which received the RPC reply from the sim worker. This postMessage
        // chain creates a full memory barrier — all SAB writes made by the
        // sim worker before returning are visible to us now. No seqlock needed.
        needRedraw = true;
      }
    }

    if (needRedraw && this.mapSabViews) {
      this.redrawBitmap();
    }

    const opacity = stats.mapOpacity;
    if (opacity <= 0) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;
    this.container.alpha = opacity;

    if (width !== this.lastW || height !== this.lastH) {
      this.bg.clear();
      this.bg.rect(0, 0, width, height).fill({ color: BG_COLOR, alpha: 1 });
      this.lastW = width;
      this.lastH = height;
    }

    if (!this.region || !this.mapSabViews) {
      this.sprite.visible = false;
      this.markers.clear();
      return;
    }

    const cx0 = this.region.cx0;
    const regionWorldX0 = cx0 * CHUNK_W;
    const wrap = (wx: number): number =>
      (((wx - regionWorldX0) % REGION_WIDTH) + REGION_WIDTH) % REGION_WIDTH;
    const camStripX = wrap(stats.camWorldX);

    const scale = THUMB_W * stats.camZoom;
    const mapPxPerBlock = stats.camZoom;

    this.sprite.visible = true;
    // DEBUG: fixed position + scale to test texture pipeline.
    this.sprite.x = 0;
    this.sprite.y = 0;
    this.sprite.scale.set(0.1, 0.1); // 8192x1024 → 819x102 px

    this.markers.clear();

    const px = width / 2 + (wrap(stats.playerWorldX) - camStripX) * mapPxPerBlock;
    const py = height / 2 + (stats.playerWorldY - stats.camWorldY) * mapPxPerBlock;
    const dir = stats.playerFacing >= 0 ? 1 : -1;
    this.markers
      .circle(px, py, 5)
      .fill({ color: 0xffffff })
      .stroke({ color: 0x000000, width: 1 });
    this.markers
      .moveTo(px, py)
      .lineTo(px + 8 * dir, py)
      .stroke({ color: 0x000000, width: 2 });

    for (const s of this.region.stations) {
      const ssx = width / 2 + (wrap(s.x) - camStripX) * mapPxPerBlock;
      const ssy = height / 2 + (s.y - stats.camWorldY) * mapPxPerBlock;
      if (ssx < -8 || ssx > width + 8 || ssy < -8 || ssy > height + 8) continue;
      this.markers
        .rect(ssx - 3, ssy - 3, 6, 6)
        .fill({ color: s.color })
        .stroke({ color: 0x000000, width: 1 });
    }
  }

  /**
   * Composite all 4 SAB planes into a single RGBA bitmap.
   * Back-to-front: background (dimmed) → mask (tinted) → vfx → foreground.
   * Fog (unexplored) = opaque black. Air = transparent.
   */
  private redrawBitmap(): void {
    if (!this.mapSabViews || !this.palette) return;
    const { foreground, background, mask, vfx, explored } = this.mapSabViews;
    const pal = this.palette;
    const n = BW * BH;
    const fogRGBA = 0xff000000; // opaque black

    const img = this.bitmapCtx.createImageData(BW, BH);
    const view = new Uint32Array(img.data.buffer);

    // DEBUG: Fill first 512 columns with solid red to verify texture pipeline.
    for (let y = 0; y < BH; y++) {
      for (let x = 0; x < 512; x++) {
        view[y * BW + x] = 0xff0000ff; // RGBA little-endian: R=255, A=255
      }
    }

    for (let i = 0; i < n; i++) {
      if (explored[i] === 0) { view[i] = fogRGBA; continue; }

      // Start with background (dimmed), then overlay foreground.
      let r = 0, g = 0, b = 0, a = 0;

      // 1. Background (backwalls) — dimmed 50%.
      const bgId = background[i];
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
      const fgId = foreground[i];
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
    this.texture.source.update();
  }

  dispose(): void {
    this.stage.removeChild(this.container);
    this.container.destroy({ children: true });
    this.texture.destroy(true);
  }
}
