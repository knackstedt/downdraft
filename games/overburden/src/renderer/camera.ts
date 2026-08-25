// ============================================================================
// Overburden — camera (pan + zoom)
//
// Coordinate system: Y increases downward (screen + world both go down).
// The camera center is in active-grid coordinates.
// ============================================================================

export class Camera {
  // Camera position in active grid coordinates (center of view)
  x: number;
  y: number;
  // Zoom: pixels per block
  zoom: number;
  // Canvas dimensions
  canvasW: number;
  canvasH: number;

  // Detached mode: camera doesn't follow the player. Toggled by the user
  // (e.g. pressing a key or middle-clicking). When detached, WASD moves
  // the camera instead of the player.
  detached = false;

  // Pan state (middle/right mouse drag)
  private panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartCamX = 0;
  private panStartCamY = 0;

  // Zoom limits (pixels per block).
  // MIN_ZOOM is small enough that the full map region (8192 blocks wide)
  // fits on a ≥2048px screen. The 3D scene cross-fades into the 2D map
  // overview between MAP_FADE_START and MAP_FADE_END (see getMapOpacity).
  static readonly MIN_ZOOM = 0.25;
  static readonly MAX_ZOOM = 256;

  // Map-mode fade band (px/block). Above MAP_FADE_START the view is pure 3D
  // scene; below MAP_FADE_END it is pure 2D map. In between, both layers are
  // blended by getMapOpacity() so the zoom-out gesture feels continuous.
  static readonly MAP_FADE_START = 6;
  static readonly MAP_FADE_END = 3;

  // Zoom levels — sorted descending so +/- stepping is monotonic in both
  // directions across the block-mode → map-mode boundary (256 → 6).
  static readonly ZOOM_LEVELS = [256, 192, 128, 96, 64, 48, 32, 6, 4, 2, 1, 0.5, 0.25];

  constructor(canvasW: number, canvasH: number) {
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.x = 0;
    this.y = 0;
    this.zoom = 96; // ~13 blocks visible width at 1280px
  }

  resize(w: number, h: number): void {
    this.canvasW = w;
    this.canvasH = h;
  }

  setCenter(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  startPan(screenX: number, screenY: number): void {
    this.panning = true;
    this.panStartX = screenX;
    this.panStartY = screenY;
    this.panStartCamX = this.x;
    this.panStartCamY = this.y;
  }

  updatePan(screenX: number, screenY: number): void {
    if (!this.panning) return;
    const dx = (screenX - this.panStartX) / this.zoom;
    const dy = (screenY - this.panStartY) / this.zoom;
    this.x = this.panStartCamX - dx;
    this.y = this.panStartCamY - dy;
  }

  endPan(): void {
    this.panning = false;
  }

  isPanning(): boolean {
    return this.panning;
  }

  /** Move the camera by a delta in grid coordinates (for WASD in detached mode). */
  move(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /** Re-center on a position and re-attach to the player. */
  reattach(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.detached = false;
    this.panning = false;
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const oldZoom = this.zoom;
    const newZoom = Math.max(Camera.MIN_ZOOM, Math.min(Camera.MAX_ZOOM, this.zoom * factor));
    if (newZoom === oldZoom) return;

    // Adjust camera so the point under the mouse stays fixed
    const dx = (screenX - this.canvasW / 2) / oldZoom;
    const dy = (screenY - this.canvasH / 2) / oldZoom;
    const worldX = this.x + dx;
    const worldY = this.y + dy;

    this.zoom = newZoom;

    const newDx = (screenX - this.canvasW / 2) / newZoom;
    const newDy = (screenY - this.canvasH / 2) / newZoom;
    this.x = worldX - newDx;
    this.y = worldY - newDy;
  }

  // Convert screen coordinates to active-grid coordinates
  screenToGrid(screenX: number, screenY: number): { x: number; y: number } {
    const gx = (screenX - this.canvasW / 2) / this.zoom + this.x;
    const gy = (screenY - this.canvasH / 2) / this.zoom + this.y;
    return { x: gx, y: gy };
  }

  /**
   * Map-mode opacity in [0,1]. 0 in pure block mode (zoom >= MAP_FADE_START),
   * 1 in pure map mode (zoom <= MAP_FADE_END), linearly interpolated between.
   * Used to cross-fade the 3D canvas and drive the map overlay's rAF.
   */
  getMapOpacity(): number {
    if (this.zoom >= Camera.MAP_FADE_START) return 0;
    if (this.zoom <= Camera.MAP_FADE_END) return 1;
    return (Camera.MAP_FADE_START - this.zoom) / (Camera.MAP_FADE_START - Camera.MAP_FADE_END);
  }

  /** True when the view is fully replaced by the 2D map overview. */
  isMapMode(): boolean {
    return this.zoom <= Camera.MAP_FADE_END;
  }
}
