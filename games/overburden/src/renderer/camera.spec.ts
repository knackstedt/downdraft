// ============================================================================
// Overburden — Camera zoom + map-mode opacity tests
// ============================================================================

import { describe, expect, it } from "bun:test";
import { Camera } from "./camera";

describe("Camera zoom limits", () => {
  it("MIN_ZOOM allows zooming out to the full map region", () => {
    // 8192-block-wide region on a 2048px screen → 0.25 px/block.
    expect(Camera.MIN_ZOOM).toBeLessThanOrEqual(0.25);
  });

  it("zoomAt clamps to [MIN_ZOOM, MAX_ZOOM]", () => {
    const cam = new Camera(1280, 720);
    // Zoom out way past the minimum.
    cam.zoomAt(640, 360, 0.001);
    expect(cam.zoom).toBe(Camera.MIN_ZOOM);
    // Zoom in way past the maximum.
    cam.zoomAt(640, 360, 10_000);
    expect(cam.zoom).toBe(Camera.MAX_ZOOM);
  });

  it("ZOOM_LEVELS is sorted descending for monotonic +/- stepping", () => {
    const levels = Camera.ZOOM_LEVELS;
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeLessThan(levels[i - 1]);
    }
  });
});

describe("Camera.getMapOpacity", () => {
  it("returns 0 at or above MAP_FADE_START (pure block mode)", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_START;
    expect(cam.getMapOpacity()).toBe(0);
    cam.zoom = Camera.MAP_FADE_START + 10;
    expect(cam.getMapOpacity()).toBe(0);
  });

  it("returns 1 at or below MAP_FADE_END (pure map mode)", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_END;
    expect(cam.getMapOpacity()).toBe(1);
    cam.zoom = Camera.MAP_FADE_END - 1;
    expect(cam.getMapOpacity()).toBe(1);
  });

  it("interpolates linearly across the fade band", () => {
    const cam = new Camera(1280, 720);
    const mid = (Camera.MAP_FADE_START + Camera.MAP_FADE_END) / 2;
    cam.zoom = mid;
    const opacity = cam.getMapOpacity();
    // Should be ~0.5 (linear interpolation midpoint).
    expect(opacity).toBeGreaterThan(0.4);
    expect(opacity).toBeLessThan(0.6);
  });

  it("is monotonic: opacity increases as zoom decreases", () => {
    const cam = new Camera(1280, 720);
    let prev = 0;
    for (let z = Camera.MAP_FADE_START; z >= Camera.MAP_FADE_END; z -= 0.1) {
      cam.zoom = z;
      const op = cam.getMapOpacity();
      expect(op).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = op;
    }
  });
});

describe("Camera.isMapMode", () => {
  it("is true at or below MAP_FADE_END", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_END;
    expect(cam.isMapMode()).toBe(true);
    cam.zoom = Camera.MIN_ZOOM;
    expect(cam.isMapMode()).toBe(true);
  });

  it("is false above MAP_FADE_END", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_END + 0.01;
    expect(cam.isMapMode()).toBe(false);
    cam.zoom = 96;
    expect(cam.isMapMode()).toBe(false);
  });
});

describe("Camera.zoomAt focal point", () => {
  it("keeps the point under the cursor fixed when zooming", () => {
    const cam = new Camera(1280, 720);
    cam.setCenter(100, 200);
    const sx = 900;
    const sy = 400;
    const before = cam.screenToGrid(sx, sy);
    cam.zoomAt(sx, sy, 1.5);
    const after = cam.screenToGrid(sx, sy);
    // The world point under the cursor should not move (within float tolerance).
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
  });
});
