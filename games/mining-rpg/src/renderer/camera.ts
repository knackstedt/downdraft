// ============================================================================
// 2D camera for the mining RPG — follows the player, scrolls horizontally
// and vertically. Camera coords are in active-grid-local space (the same
// space the grid texture and stickman shader use).
//
// Uses smooth lerp follow for a polished feel — the camera eases toward the
// target position rather than snapping.
// ============================================================================

export interface Camera2D {
  x: number; // active-grid-local cell coords (center of view)
  y: number;
  zoom: number;
  width: number; // canvas width in pixels
  height: number; // canvas height in pixels
}

export function makeCamera2D(w: number, h: number): Camera2D {
  return { x: 0, y: 0, zoom: 2, width: w, height: h };
}

// Smoothing factor — higher = snappier, lower = smoother
const CAMERA_SMOOTH = 0.12;

/** Update camera to follow a target with smooth lerp. No clamping — the
 *  active grid bounds the visible area, and anything outside it renders
 *  as empty space. */
export function updateCamera(
  cam: Camera2D,
  targetX: number,
  targetY: number,
): void {
  cam.x += (targetX - cam.x) * CAMERA_SMOOTH;
  cam.y += (targetY - cam.y) * CAMERA_SMOOTH;
}

/** Convert screen pixel coords to active-grid-local cell coords. */
export function screenToWorld(cam: Camera2D, sx: number, sy: number): { x: number; y: number } {
  // sx, sy are in device pixels with origin at top-left
  return {
    x: (sx - cam.width / 2) / cam.zoom + cam.x,
    y: (sy - cam.height / 2) / cam.zoom + cam.y,
  };
}
