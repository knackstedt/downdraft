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

describe("Camera.getMapOpacity (animated)", () => {
  it("starts at 0 (pure 3D)", () => {
    const cam = new Camera(1280, 720);
    expect(cam.getMapOpacity()).toBe(0);
  });

  it("animates to 1 when zoom drops below MAP_FADE_THRESHOLD", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_THRESHOLD - 1;
    // Before any update, opacity is still 0.
    expect(cam.getMapOpacity()).toBe(0);
    // After enough update frames to complete the transition, opacity is 1.
    const steps = Math.ceil(Camera.MAP_FADE_DURATION / 0.016);
    for (let i = 0; i < steps; i++) cam.update(0.016);
    expect(cam.getMapOpacity()).toBe(1);
  });

  it("animates back to 0 when zoom rises above MAP_FADE_THRESHOLD", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_THRESHOLD - 1;
    const steps = Math.ceil(Camera.MAP_FADE_DURATION / 0.016);
    for (let i = 0; i < steps; i++) cam.update(0.016);
    expect(cam.getMapOpacity()).toBe(1);
    // Zoom back in past the threshold.
    cam.zoom = Camera.MAP_FADE_THRESHOLD + 10;
    for (let i = 0; i < steps; i++) cam.update(0.016);
    expect(cam.getMapOpacity()).toBe(0);
  });

  it("does not blend at rest — opacity is always exactly 0 or 1 when settled", () => {
    const cam = new Camera(1280, 720);
    // Zoom to a level below the threshold but not at MIN_ZOOM.
    cam.zoom = 4; // between MAP_FADE_THRESHOLD (6) and MIN_ZOOM (0.25)
    const steps = Math.ceil(Camera.MAP_FADE_DURATION / 0.016);
    for (let i = 0; i < steps; i++) cam.update(0.016);
    // At rest, opacity should be exactly 1 (pure map), not a blend.
    expect(cam.getMapOpacity()).toBe(1);
    // Further updates should be no-ops.
    cam.update(0.016);
    expect(cam.getMapOpacity()).toBe(1);
  });

  it("is monotonic during the transition", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MAP_FADE_THRESHOLD - 1;
    let prev = 0;
    const steps = Math.ceil(Camera.MAP_FADE_DURATION / 0.016);
    for (let i = 0; i < steps; i++) {
      cam.update(0.016);
      expect(cam.getMapOpacity()).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cam.getMapOpacity();
    }
  });
});

describe("Camera.isMapMode", () => {
  it("is true only when the animated opacity has reached 1", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = Camera.MIN_ZOOM;
    expect(cam.isMapMode()).toBe(false); // not yet animated
    const steps = Math.ceil(Camera.MAP_FADE_DURATION / 0.016);
    for (let i = 0; i < steps; i++) cam.update(0.016);
    expect(cam.isMapMode()).toBe(true);
  });

  it("is false when zoom is above the threshold", () => {
    const cam = new Camera(1280, 720);
    cam.zoom = 96;
    const steps = Math.ceil(Camera.MAP_FADE_DURATION / 0.016);
    for (let i = 0; i < steps; i++) cam.update(0.016);
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
