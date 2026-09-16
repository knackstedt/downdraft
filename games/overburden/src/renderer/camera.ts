// ============================================================================
// Overburden — camera (pan + zoom)
//
// Coordinate system: Y increases downward (screen + world both go down).
// The camera center is in active-grid coordinates.
//
// Extends the shared PanZoomCamera2D with the 3D→2D-map crossfade state.
// ============================================================================

import { PanZoomCamera2D } from "@downdraft/core";

export class Camera extends PanZoomCamera2D {
  // Zoom limits (pixels per block).
  // MIN_ZOOM is small enough that the full map region (8192 blocks wide)
  // fits on a ≥2048px screen. The 3D scene cross-fades into the 2D map
  // overview when zoom crosses MAP_FADE_THRESHOLD (see getMapOpacity +
  // update).
  static readonly MIN_ZOOM = 0.25;
  static readonly MAX_ZOOM = 256;

  // Map-mode transition threshold (px/block). When zoom drops below this,
  // the view animates from 3D scene → 2D map. When zoom rises above it,
  // it animates back. The transition is time-based (see MAP_FADE_DURATION),
  // not tied to the exact zoom level — so there's no blended "half 3D / half
  // map" state at rest, only during the animated transition.
  static readonly MAP_FADE_THRESHOLD = 6;
  // Crossfade duration in seconds.
  static readonly MAP_FADE_DURATION = 0.3;

  // Zoom levels — sorted descending so +/- stepping is monotonic in both
  // directions across the block-mode → map-mode boundary (256 → 6).
  static readonly ZOOM_LEVELS = [256, 192, 128, 96, 64, 48, 32, 6, 4, 2, 1, 0.5, 0.25];

  // Animated map opacity [0,1]. Tweens toward 0 (pure 3D) or 1 (pure map)
  // at a constant rate determined by MAP_FADE_DURATION. Updated each frame
  // by update(dt), called from the renderer's drawFrame.
  private mapOpacity = 0;

  constructor(canvasW: number, canvasH: number) {
    super(canvasW, canvasH, {
      zoom: 96, // ~13 blocks visible width at 1280px
      minZoom: Camera.MIN_ZOOM,
      maxZoom: Camera.MAX_ZOOM,
    });
  }

  /**
   * Advance the animated map opacity toward its target. Called each frame
   * from the renderer's drawFrame with the frame dt (seconds). The target is
   * 0 (pure 3D) when zoom >= MAP_FADE_THRESHOLD, 1 (pure map) when below.
   * The transition is a constant-speed tween over MAP_FADE_DURATION seconds
   * so the crossfade plays as a smooth animation when zoom crosses the
   * threshold, not as a static blend tied to the exact zoom level.
   */
  update(dt: number): void {
    const target = this.zoom < Camera.MAP_FADE_THRESHOLD ? 1 : 0;
    if (this.mapOpacity === target) return;
    const step = dt / Camera.MAP_FADE_DURATION;
    if (target > this.mapOpacity) {
      this.mapOpacity = Math.min(target, this.mapOpacity + step);
    } else {
      this.mapOpacity = Math.max(target, this.mapOpacity - step);
    }
  }

  /**
   * Current animated map-mode opacity in [0,1]. 0 = pure 3D scene,
   * 1 = pure 2D map. During the crossfade transition the value is between
   * 0 and 1; at rest it is always exactly 0 or 1. Used to cross-fade the
   * 3D canvas opacity and drive the map overlay's alpha.
   */
  getMapOpacity(): number {
    return this.mapOpacity;
  }

  /** True when the view is fully replaced by the 2D map overview. */
  isMapMode(): boolean {
    return this.mapOpacity >= 1;
  }
}
