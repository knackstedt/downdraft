// ============================================================================
// 2D camera for the mining RPG — follows the player, scrolls horizontally
// and vertically, clamped to world bounds.
// ============================================================================

import { CHUNK_W, MAX_CHUNKS_X } from "../shared/constants";

export interface Camera2D {
  x: number; // world cell coords (center of view)
  y: number;
  zoom: number;
  width: number; // canvas width in pixels
  height: number; // canvas height in pixels
}

export function makeCamera2D(w: number, h: number): Camera2D {
  return { x: 0, y: 0, zoom: 2, width: w, height: h };
}

/** Update camera to follow a target, clamped to world bounds. */
export function updateCamera(
  cam: Camera2D,
  targetX: number,
  targetY: number,
): void {
  cam.x = targetX;
  cam.y = targetY;

  // Clamp to world horizontal bounds
  const halfViewCells = (cam.width / cam.zoom) / 2;
  const worldMaxX = MAX_CHUNKS_X * CHUNK_W;
  if (cam.x - halfViewCells < 0) cam.x = halfViewCells;
  if (cam.x + halfViewCells > worldMaxX) cam.x = worldMaxX - halfViewCells;

  // No Y clamping — the world extends infinitely upward (sky) and downward.
}

/** Convert screen pixel coords to world cell coords. */
export function screenToWorld(cam: Camera2D, sx: number, sy: number): { x: number; y: number } {
  // sx, sy are in CSS pixels with origin at top-left
  // Flip Y (screen Y goes down, world Y goes down too in this game)
  return {
    x: (sx - cam.width / 2) / cam.zoom + cam.x,
    y: (sy - cam.height / 2) / cam.zoom + cam.y,
  };
}
