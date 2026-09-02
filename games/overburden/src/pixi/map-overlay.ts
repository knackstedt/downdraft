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
// blockIds + explored flags directly into the SAB; this overlay reads them
// and converts to colors using the block palette (sent once via setMapPalette).
// This gives the map full per-block resolution — no downsampling.
//
// Display objects (added to ctx.app.stage in this order):
//   1. Container (alpha = mapOpacity, drives the crossfade)
//      ├── Background Graphics (opaque full-screen rect, covers the 3D scene)
//      ├── Sprite (bitmap texture from the OffscreenCanvas)
//      └── Markers Graphics (player circle + station squares)
// ============================================================================

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { CHUNK_W } from "../shared/constants";
import {
    MAP_REGION_COLS, REGION_BLOCK_H, REGION_BLOCK_W, THUMB_W,
    getMapSabViews, type MapSabViews,
} from "../shared/map-buffer";
import type { OverburdenEvent } from "./bridge-protocol";

const BW = REGION_BLOCK_W; // 8192
const BH = REGION_BLOCK_H; // 1024
const REGION_WIDTH = MAP_REGION_COLS * CHUNK_W; // 8192
const BG_COLOR = 0x1a1a2e;
const SKY_COLOR = 0x1a1a2e; // explored air (matches the 3D clear color)
const FOG_COLOR = 0x000000; // unexplored (opaque black)

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

  // Map SAB views (per-block data streamed from the sim worker).
  private mapSabViews: MapSabViews | null = null;
  private lastSeq = -1; // last SAB seq counter we read

  // Block color palette (RGBA per block ID, 256*4 bytes). Sent once via
  // setMapPalette event. Used to convert blockIds → colors when redrawing.
  private palette: Uint8Array | null = null;

  constructor(private stage: Container, extraSharedBuffers?: Record<string, SharedArrayBuffer>) {
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

    // Get typed views into the map SAB if provided.
    if (extraSharedBuffers?.mapSab) {
      this.mapSabViews = getMapSabViews(extraSharedBuffers.mapSab);
    }
  }

  /**
   * Per-frame update. Called from the scene's update() with SAB stats +
   * drained events. Updates all display objects imperatively — no @pixi/react
   * diffing, no `draw` callbacks, no instruction churn.
   */
  update(stats: MapStats, events: OverburdenEvent[], width: number, height: number): void {
    // Process events: setMapPalette (one-time palette), setMapRegion (cx0 + stations).
    for (const e of events) {
      if (e.kind === "setMapPalette") {
        this.palette = e.palette;
      } else if (e.kind === "setMapRegion") {
        this.region = { cx0: e.cx0, stations: e.stations };
      }
    }

    // Check if the map SAB has new data (seq counter changed).
    if (this.mapSabViews && this.mapSabViews.seq[0] !== this.lastSeq) {
      this.lastSeq = this.mapSabViews.seq[0];
      this.redrawBitmap();
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
    if (!this.region || !this.mapSabViews) {
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

    // The map bitmap always renders at the 3D camera's scale (camZoom screen
    // px per world block) so the 3D→map crossfade is a pure opacity blend with
    // no scale discontinuity: the bitmap perfectly overlays the 3D scene at
    // every zoom level. With THUMB_W=1, each texture pixel is one world block,
    // so sprite scale = camZoom yields mapPxPerBlock = camZoom (matching the
    // 3D camera at the Z=0 plane, where pitchAngle = 0).
    const scale = THUMB_W * stats.camZoom;
    const mapPxPerBlock = stats.camZoom;

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

  /**
   * Redraw the OffscreenCanvas bitmap from the map SAB's per-block data.
   * Converts blockIds → colors using the palette. Called when the SAB's
   * seq counter changes (the sim worker wrote new data).
   */
  private redrawBitmap(): void {
    if (!this.mapSabViews || !this.palette) return;
    const { blockIds, explored } = this.mapSabViews;
    const pal = this.palette;
    const img = this.bitmapCtx.createImageData(BW, BH);
    const view = new Uint32Array(img.data.buffer);
    const n = BW * BH;
    // Pre-compute sky + fog as little-endian RGBA u32.
    // SKY_COLOR = 0x1a1a2e → RGBA: R=0x2e, G=0x1a, B=0x1a, A=0xff
    const skyRGBA = 0xff1a1a2e;
    // FOG_COLOR = 0x000000 → RGBA: R=0, G=0, B=0, A=0xff
    const fogRGBA = 0xff000000;
    for (let i = 0; i < n; i++) {
      if (explored[i] === 0) {
        view[i] = fogRGBA;
        continue;
      }
      const id = blockIds[i];
      if (id === 0) {
        view[i] = skyRGBA;
        continue;
      }
      // Palette: RGBA per block ID (256 * 4 bytes).
      const off = id * 4;
      // Little-endian u32: R | G<<8 | B<<16 | A<<24
      view[i] = pal[off] | (pal[off + 1] << 8) | (pal[off + 2] << 16) | (pal[off + 3] << 24);
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
