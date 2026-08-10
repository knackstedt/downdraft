export interface Camera2D {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export function makeCamera2D(w: number, h: number): Camera2D {
  return { x: w / 2, y: h / 2, zoom: 1, width: w, height: h };
}

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

export function screenToWorld(cam: Camera2D, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - cam.width / 2) / cam.zoom + cam.x,
    y: (sy - cam.height / 2) / cam.zoom + cam.y,
  };
}
