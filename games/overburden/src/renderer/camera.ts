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

  // Zoom limits (pixels per block)
  static readonly MIN_ZOOM = 32;
  static readonly MAX_ZOOM = 256;

  // Zoom levels — tuned for 3D perspective: 10-15 blocks visible at default
  static readonly ZOOM_LEVELS = [32, 48, 64, 96, 128, 192, 256];

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
}
