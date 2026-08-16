// ============================================================================
// 2D camera for the mining RPG — follows the player, scrolls horizontally
// and vertically. Camera coords are in WORLD cell coords (the same space as
// the player position from the worker SAB).
//
// Tracking in world coords (not active-grid-local) is important: when the
// player crosses a chunk boundary, the active grid origin shifts by CHUNK_W,
// which would make the local-space target jump by a full chunk. By tracking
// in world space, the target is continuous, and the local-space conversion
// (cam.x - originX) shifts both the camera and player equally — no visible
// jump at chunk seams.
//
// Uses smooth lerp follow for a polished feel — the camera eases toward the
// target position rather than snapping.
// ============================================================================

export interface Camera2D {
  x: number; // WORLD cell coords (center of view)
  y: number;
  zoom: number;
  width: number; // canvas width in pixels
  height: number; // canvas height in pixels
}

export function makeCamera2D(w: number, h: number): Camera2D {
  return { x: 0, y: 0, zoom: 4, width: w, height: h };
}

// Smoothing factor — higher = snappier, lower = smoother
const CAMERA_SMOOTH = 0.08;

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

/** Convert screen pixel coords to world cell coords. */
export function screenToWorld(cam: Camera2D, sx: number, sy: number): { x: number; y: number } {
  // sx, sy are in device pixels with origin at top-left
  return {
    x: (sx - cam.width / 2) / cam.zoom + cam.x,
    y: (sy - cam.height / 2) / cam.zoom + cam.y,
  };
}

/** Convert world cell coords to screen pixel coords (device pixels). */
export function worldToScreen(cam: Camera2D, wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx - cam.x) * cam.zoom + cam.width / 2,
    y: (wy - cam.y) * cam.zoom + cam.height / 2,
  };
}
