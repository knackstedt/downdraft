// ============================================================================
// Camera2D — 2D camera for grid-based / cellular automata games
// ============================================================================
//
// Tracks a position in world coordinates with zoom. Provides screen↔world
// coordinate conversion, smooth lerp follow, and a GPU-ready transform matrix.
// Used by mining-rpg (player follow + zoom) and falling-sand (GPU matrix).

export interface Camera2D {
  /** World coordinate at the center of the view */
  x: number;
  y: number;
  /** Pixels per world unit */
  zoom: number;
  /** Canvas dimensions in pixels */
  width: number;
  height: number;
}

export interface Camera2DOptions {
  /** Initial zoom (pixels per world unit). Default: 1 */
  zoom?: number;
  /** Initial center position. Default: (0, 0) */
  x?: number;
  y?: number;
  /** Smoothing factor for updateCamera (0–1, higher = snappier). Default: 0.08 */
  smooth?: number;
}

/** Create a 2D camera. Defaults to origin-centered with zoom=1. */
export function makeCamera2D(w: number, h: number, opts?: Camera2DOptions): Camera2D {
  const zoom = opts?.zoom ?? 1;
  const x = opts?.x ?? w / 2 / zoom;
  const y = opts?.y ?? h / 2 / zoom;
  return { x, y, zoom, width: w, height: h };
}

/** Smoothly move camera toward a target position via lerp. */
export function updateCamera(
  cam: Camera2D,
  targetX: number,
  targetY: number,
  smooth: number = 0.08,
): void {
  cam.x += (targetX - cam.x) * smooth;
  cam.y += (targetY - cam.y) * smooth;
}

/** Convert screen pixel coords to world coords. */
export function screenToWorld(cam: Camera2D, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - cam.width / 2) / cam.zoom + cam.x,
    y: (sy - cam.height / 2) / cam.zoom + cam.y,
  };
}

/** Convert world coords to screen pixel coords. */
export function worldToScreen(cam: Camera2D, wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx - cam.x) * cam.zoom + cam.width / 2,
    y: (wy - cam.y) * cam.zoom + cam.height / 2,
  };
}

// ============================================================================
// PanZoomCamera2D — class-based 2D camera with pan + focal-point zoom gestures
// ============================================================================
//
// Generalized from overburden's `Camera`. Use this when the camera supports
// mouse-drag panning and zoom-to-cursor; use the free-function Camera2D above
// for simple follow cams.

export interface PanZoomCamera2DOptions {
  /** Initial zoom (pixels per world unit). Default: 1 */
  zoom?: number;
  /** Initial center position. Default: (0, 0) */
  x?: number;
  y?: number;
  /** Zoom clamp bounds. Defaults: (0, Infinity) — effectively unclamped. */
  minZoom?: number;
  maxZoom?: number;
}

export class PanZoomCamera2D {
  // Camera position in world coordinates (center of view)
  x: number;
  y: number;
  /** Zoom: pixels per world unit */
  zoom: number;
  /** Canvas dimensions in pixels */
  canvasW: number;
  canvasH: number;
  minZoom: number;
  maxZoom: number;

  // Detached mode: camera doesn't follow the player. When detached, movement
  // input typically pans the camera instead of moving the player.
  detached = false;

  // Pan state (mouse drag)
  private panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartCamX = 0;
  private panStartCamY = 0;

  constructor(canvasW: number, canvasH: number, opts?: PanZoomCamera2DOptions) {
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.x = opts?.x ?? 0;
    this.y = opts?.y ?? 0;
    this.zoom = opts?.zoom ?? 1;
    this.minZoom = opts?.minZoom ?? 0;
    this.maxZoom = opts?.maxZoom ?? Infinity;
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

  /** Move the camera by a delta in world coordinates (e.g. WASD in detached mode). */
  move(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /** Re-center on a position and re-attach to the follow target. */
  reattach(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.detached = false;
    this.panning = false;
  }

  /** Zoom by `factor`, keeping the world point under the cursor fixed. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const oldZoom = this.zoom;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
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

  /** Convert screen pixel coords to world coords (same as screenToWorld). */
  screenToGrid(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.canvasW / 2) / this.zoom + this.x,
      y: (screenY - this.canvasH / 2) / this.zoom + this.y,
    };
  }

  /** Convert world coords to screen pixel coords. */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: (worldX - this.x) * this.zoom + this.canvasW / 2,
      y: (worldY - this.y) * this.zoom + this.canvasH / 2,
    };
  }
}

/**
 * Build a 4×4 column-major transform matrix for GPU shaders.
 * Maps world coords to NDC (-1..1) with the camera centered.
 */
export function cameraMatrix(cam: Camera2D): Float32Array {
  const sx = 2 / (cam.width * cam.zoom);
  const sy = -2 / (cam.height * cam.zoom);
  const tx = -cam.x * sx;
  const ty = cam.y * sy;
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, 1, 0,
    tx, ty, 0, 1,
  ]);
}
