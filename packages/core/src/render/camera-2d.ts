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
