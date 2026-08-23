// ============================================================================
// Overburden — volumetric colored light propagation unit tests
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    ACTIVE_GRID_CELLS, ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_STONE, BLOCK_TORCH,
} from "../shared/constants";
import { recomputeLight } from "./light-sim";

// Helper: create a foreground grid filled with air
function makeAirGrid(): Uint16Array {
  return new Uint16Array(ACTIVE_GRID_W * ACTIVE_GRID_H).fill(BLOCK_AIR);
}

// Helper: create an RGBA8 light buffer (4 bytes/cell)
function makeLight(): Uint8Array {
  return new Uint8Array(4 * ACTIVE_GRID_CELLS);
}

// Helper: read RGB at (x, y) from an RGBA8 light buffer
function rgbAt(light: Uint8Array, x: number, y: number): [number, number, number] {
  const off = (y * ACTIVE_GRID_W + x) * 4;
  return [light[off], light[off + 1], light[off + 2]];
}

// Helper: set a solid block at (x, y)
function setSolid(fg: Uint16Array, x: number, y: number): void {
  fg[y * ACTIVE_GRID_W + x] = BLOCK_STONE;
}

// Helper: set a torch at (x, y)
function setTorch(fg: Uint16Array, x: number, y: number): void {
  fg[y * ACTIVE_GRID_W + x] = BLOCK_TORCH;
}

describe("recomputeLight", () => {
  it("sky light fills open air columns and lights the surface block", () => {
    const fg = makeAirGrid();
    // Build a single column: air y=0..9, solid surface at y=10, air below.
    const x = 100;
    for (let y = 0; y <= 9; y++) fg[y * ACTIVE_GRID_W + x] = BLOCK_AIR;
    setSolid(fg, x, 10);
    // Other columns stay air (also sky-lit, but we only assert on this column).

    const light = makeLight();
    recomputeLight(fg, light, 15);

    // Sky color at daylight 15 = [200, 220, 255].
    // Air cells y=0..9 should have full sky light.
    const top = rgbAt(light, x, 0);
    expect(top[0]).toBe(200);
    expect(top[1]).toBe(220);
    expect(top[2]).toBe(255);

    const air9 = rgbAt(light, x, 9);
    expect(air9[0]).toBe(200);
    expect(air9[1]).toBe(220);
    expect(air9[2]).toBe(255);

    // Surface block at y=10 is lit by the sky (first opaque block in column).
    const surface = rgbAt(light, x, 10);
    expect(surface[0]).toBe(200);
    expect(surface[1]).toBe(220);
    expect(surface[2]).toBe(255);
  });

  it("cells deep under a thick solid roof stay dark", () => {
    const fg = makeAirGrid();
    const x = 120;
    // 10-thick solid roof spanning the FULL grid width (y=5..14), air below.
    // Full width prevents side leakage from neighboring open-air columns.
    for (let y = 5; y <= 14; y++) {
      for (let xi = 0; xi < ACTIVE_GRID_W; xi++) setSolid(fg, xi, y);
    }

    const light = makeLight();
    recomputeLight(fg, light, 15);

    // Air above the roof (y=0..4) is sky-lit.
    const above = rgbAt(light, x, 0);
    expect(above[0]).toBe(200);

    // The roof surface (y=5) is sky-lit.
    const roof = rgbAt(light, x, 5);
    expect(roof[0]).toBe(200);

    // Light attenuates through solid at 34/level. After 10 solid blocks
    // (255 - 10*34 < 0), the air at y=15 should be fully dark (0,0,0).
    const under = rgbAt(light, x, 15);
    expect(under[0]).toBe(0);
    expect(under[1]).toBe(0);
    expect(under[2]).toBe(0);
  });

  it("a torch emits warm colored light that attenuates with distance", () => {
    const fg = makeAirGrid();
    const light = makeLight();
    // No sky light (daylight=0) — torch is the only source.
    const x = 200, y = 200;
    setTorch(fg, x, y);
    recomputeLight(fg, light, 0);

    // Torch: lightEmit=14, color [255,180,80]. scale=14/15.
    // emit = [round(255*14/15), round(180*14/15), round(80*14/15)] = [238,168,75].
    const src = rgbAt(light, x, y);
    expect(src[0]).toBe(238);
    expect(src[1]).toBe(168);
    expect(src[2]).toBe(75);

    // Immediate air neighbor (atten 17): [238-17, 168-17, 75-17] = [221,151,58].
    const neighbor = rgbAt(light, x + 1, y);
    expect(neighbor[0]).toBe(221);
    expect(neighbor[1]).toBe(151);
    expect(neighbor[2]).toBe(58);

    // Two cells away: [221-17, 151-17, 58-17] = [204,134,41].
    const two = rgbAt(light, x + 2, y);
    expect(two[0]).toBe(204);
    expect(two[1]).toBe(134);
    // 58-17=41, but 75 attenuates to 0 after a few hops; check it's dimmer.
    expect(two[2]).toBeLessThanOrEqual(41);
    expect(two[2]).toBeGreaterThanOrEqual(38);
  });

  it("colored light blends per-channel (torch + sky = max per channel)", () => {
    const fg = makeAirGrid();
    const light = makeLight();
    // Open air column (sky-lit) + a torch in that same column.
    const x = 300, y = 100;
    setTorch(fg, x, y);
    recomputeLight(fg, light, 15);

    // At the torch cell: sky = [200,220,255], torch = [238,168,75].
    // Per-channel max → [238, 220, 255].
    const cell = rgbAt(light, x, y);
    expect(cell[0]).toBe(238); // torch R wins (238 > 200)
    expect(cell[1]).toBe(220); // sky G wins (220 > 168)
    expect(cell[2]).toBe(255); // sky B wins (255 > 75)
  });

  it("daylight=0 produces no sky light; daylight=15 produces full sky color", () => {
    const fg = makeAirGrid();
    const x = 50;

    // daylight=0 → sky cells should be dark (no sky light).
    const light0 = makeLight();
    recomputeLight(fg, light0, 0);
    const at0 = rgbAt(light0, x, 0);
    expect(at0[0]).toBe(0);
    expect(at0[1]).toBe(0);
    expect(at0[2]).toBe(0);

    // daylight=15 → full sky color [200,220,255].
    const light15 = makeLight();
    recomputeLight(fg, light15, 15);
    const at15 = rgbAt(light15, x, 0);
    expect(at15[0]).toBe(200);
    expect(at15[1]).toBe(220);
    expect(at15[2]).toBe(255);
  });

  it("recompute is idempotent (same result when called twice)", () => {
    const fg = makeAirGrid();
    const x = 250, y = 150;
    setTorch(fg, x, y);
    setSolid(fg, x, y - 5); // a surface block above to mix things up

    const light1 = makeLight();
    recomputeLight(fg, light1, 15);
    const light2 = makeLight();
    recomputeLight(fg, light2, 15);

    // Compare the entire buffers.
    expect(light2.length).toBe(light1.length);
    let diff = 0;
    for (let i = 0; i < light1.length; i++) {
      if (light1[i] !== light2[i]) diff++;
    }
    expect(diff).toBe(0);
  });
});
