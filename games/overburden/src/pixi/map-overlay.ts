// ============================================================================
// MapOverlay — imperative PixiJS display objects for the zoomed-out 2D map.
//
// Managed entirely outside @pixi/react to avoid the per-frame `draw` callback
// churn that overflows PixiJS's GC instruction list. The scene's update()
// method calls MapOverlay.update() each frame with the latest SAB stats +
// events; the overlay updates its display objects imperatively.
//
// Display objects (added to ctx.app.stage in this order):
//   1. Container (alpha = mapOpacity, drives the crossfade)
//      ├── Background Graphics (opaque full-screen rect, covers the 3D scene)
//      ├── Sprite (bitmap texture from the OffscreenCanvas)
//      └── Markers Graphics (player circle + station squares)
// ============================================================================

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { CHUNK_W } from "../shared/constants";
import { MAP_REGION_COLS, REGION_BLOCK_H, REGION_BLOCK_W, THUMB_W } from "../shared/map-buffer";
import type { OverburdenEvent } from "./bridge-protocol";

const BW = REGION_BLOCK_W; // 1024
const BH = REGION_BLOCK_H; // 128
const REGION_WIDTH = MAP_REGION_COLS * CHUNK_W; // 8192
const MAP_FADE_THRESHOLD = 6;
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
  cells: Uint32Array;
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

  constructor(private stage: Container) {
    this.container = new Container();
    this.container.visible = false;
    // Isolate the MapOverlay as its own render group root. This prevents
    // it from being merged into the @pixi/react stage's render group tree,
    // which can cause GC system stack overflows when @pixi/react re-renders
    // and restructures the stage's children. As a separate render group,
    // the MapOverlay's display objects are managed independently.
    this.container.isRenderGroup = true;

    this.bg = new Graphics();
    this.container.addChild(this.bg);

    this.bitmapCanvas = new OffscreenCanvas(BW, BH);
    const ctx = this.bitmapCanvas.getContext("2d")!;
    this.bitmapCtx = ctx;
    this.texture = Texture.from(this.bitmapCanvas);
    this.texture.source.scaleMode = "nearest";
    this.sprite = new Sprite(this.texture);
    this.sprite.visible = false;
    this.container.addChild(this.sprite);

    this.markers = new Graphics();
    this.container.addChild(this.markers);

    // Add at the end so the MapOverlay renders on top of the @pixi/react
    // HUD tree (it covers everything when zoomed out). The isRenderGroup
    // isolation ensures @pixi/react's child management doesn't interfere.
    this.stage.addChild(this.container);
  }

  /**
   * Per-frame update. Called from the scene's update() with SAB stats +
   * drained events. Updates all display objects imperatively — no @pixi/react
   * diffing, no `draw` callbacks, no instruction churn.
   */
  update(stats: MapStats, events: OverburdenEvent[], width: number, height: number): void {
    // Process setMapRegion events (bitmap data arrives here).
    for (const e of events) {
      if (e.kind === "setMapRegion") {
        if (e.cells && e.cells.length > 0) {
          this.region = { cells: e.cells, cx0: e.cx0, stations: e.stations };
          this.redrawBitmap();
        } else {
          this.region = null;
          this.sprite.visible = false;
        }
      }
    }

    const opacity = stats.mapOpacity;
    if (opacity <= 0) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;
    this.container.alpha = opacity;

    // Redraw background only when canvas size changes.
    if (width !== this.lastW || height !== this.lastH) {
      this.bg.clear();
      this.bg.rect(0, 0, width, height).fill({ color: BG_COLOR, alpha: 1 });
      this.lastW = width;
      this.lastH = height;
    }

    // No bitmap data yet — just show the background (crossfade still works).
    if (!this.region) {
      this.sprite.visible = false;
      this.markers.clear();
      return;
    }

    // --- Position + scale the bitmap sprite ---
    const cx0 = this.region.cx0;
    const regionWorldX0 = cx0 * CHUNK_W;
    const wrap = (wx: number): number =>
      (((wx - regionWorldX0) % REGION_WIDTH) + REGION_WIDTH) % REGION_WIDTH;
    const camStripX = wrap(stats.camWorldX);

    // Scale interpolation: lerp from 3D scene scale (at opacity 0) to map
    // mode scale (at opacity 1) so the crossfade is seamless.
    const scale3D = THUMB_W * stats.camZoom;
    const scaleMap = stats.camZoom / MAP_FADE_THRESHOLD;
    const scale = scale3D + (scaleMap - scale3D) * opacity;
    const mapPxPerBlock = scale / THUMB_W;

    this.sprite.visible = true;
    this.sprite.x = width / 2 + (0 - camStripX) * mapPxPerBlock;
    this.sprite.y = height / 2 + (0 - stats.camWorldY) * mapPxPerBlock;
    this.sprite.scale.set(scale, scale);

    // --- Draw player + station markers ---
    this.markers.clear();

    // Player marker: white circle + facing tick.
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

    // Station markers.
    for (const s of this.region.stations) {
      const sx = width / 2 + (wrap(s.x) - camStripX) * mapPxPerBlock;
      const sy = height / 2 + (s.y - stats.camWorldY) * mapPxPerBlock;
      if (sx < -8 || sx > width + 8 || sy < -8 || sy > height + 8) continue;
      this.markers
        .rect(sx - 3, sy - 3, 6, 6)
        .fill({ color: s.color })
        .stroke({ color: 0x000000, width: 1 });
    }
  }

  /** Redraw the OffscreenCanvas bitmap from the region's cell data. */
  private redrawBitmap(): void {
    if (!this.region) return;
    const cells = this.region.cells;
    const img = this.bitmapCtx.createImageData(BW, BH);
    const view = new Uint32Array(img.data.buffer);
    const n = Math.min(cells.length, BW * BH);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c === 0) { view[i] = 0xff000000; continue; } // fog = opaque black
      // Packed 0xRRGGBB → RGBA (little-endian: R | G<<8 | B<<16 | A<<24)
      view[i] = ((c >> 16) & 0xff) | ((c >> 8) & 0xff) << 8 | (c & 0xff) << 16 | 0xff000000;
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
