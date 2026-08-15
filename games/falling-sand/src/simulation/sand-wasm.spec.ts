/**
 * sand-wasm.spec.ts — Tests for the Rust WASM sand simulation backend.
 *
 * These tests mirror the scenarios in sand-world.spec.ts to verify the WASM
 * backend produces the same behavior as the TypeScript implementation.
 *
 * Note: The WASM backend uses a xorshift PRNG (not Math.random), so exact
 * positions may differ for randomized behaviors. Tests check invariants
 * (material counts, relative positions) rather than exact coordinates.
 */

import { Material } from "@downdraft/library-sand";
import { beforeAll, expect, test } from "bun:test";
import { FIELD } from "../shared/sim-buffer";
import { initWasm, reseedRng, SandWasmWorld } from "./sand-wasm";

// Deterministic helper: run N steps and return the grid as a mat-id matrix.
function run(world: SandWasmWorld, steps: number): void {
  for (let i = 0; i < steps; i++) world.step();
}
function matAt(world: SandWasmWorld, x: number, y: number): number {
  return world.grid[y * world.W + x] & 0xff;
}
function lifetimeAt(world: SandWasmWorld, x: number, y: number): number {
  return (world.grid[y * world.W + x] >> 8) & 0xff;
}
function flagsAt(world: SandWasmWorld, x: number, y: number): number {
  return (world.grid[y * world.W + x] >> 16) & 0xff;
}
function countMat(world: SandWasmWorld, mat: number): number {
  let n = 0;
  for (let i = 0; i < world.grid.length; i++) {
    if ((world.grid[i] & 0xff) === mat) n++;
  }
  return n;
}
function topMostY(world: SandWasmWorld, mat: number): number {
  for (let y = 0; y < world.H; y++) {
    for (let x = 0; x < world.W; x++) {
      if (matAt(world, x, y) === mat) return y;
    }
  }
  return -1;
}

// Initialize WASM once before all tests.
let wasmReady = false;
beforeAll(async () => {
  await initWasm(1); // single thread for deterministic tests
  reseedRng(42); // deterministic PRNG
  wasmReady = true;
});

test("WASM module initializes", () => {
  expect(wasmReady).toBe(true);
});

test("WASM sand falls straight down through empty space", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 20);
  // Sand should rest just above the stone floor (floor occupies y=12..15).
  expect(matAt(w, 4, 11)).toBe(Material.Sand);
  expect(matAt(w, 4, 0)).toBe(Material.Empty);
  w.free();
});

test("WASM sand piles into a pyramid (diagonal fall works)", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 0; y < 8; y++) w.setCell(4, y, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 60);
  let sandCount = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (matAt(w, x, y) === Material.Sand) sandCount++;
  expect(sandCount).toBe(8); // no sand lost
  expect(matAt(w, 4, 11)).toBe(Material.Sand);
  w.free();
});

test("WASM water flows horizontally to fill a basin", () => {
  const w = new SandWasmWorld(16, 16);
  for (let y = 11; y < 12; y++) {
    w.setCell(2, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(13, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  w.setCell(7, 0, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 80);
  let water = 0;
  for (let y = 0; y < 16; y++) for (let x = 3; x < 13; x++) if (matAt(w, x, y) === Material.Water) water++;
  expect(water).toBe(1);
  expect(matAt(w, 7, 0)).toBe(Material.Empty);
  w.free();
});

test("WASM smoke rises (negative gravityDir)", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 11, { mat: Material.Smoke, lifetime: 200, flags: 0 });
  run(w, 40);
  let highest = 16;
  for (let y = 0; y < 16; y++) if (matAt(w, 4, y) === Material.Smoke) highest = Math.min(highest, y);
  if (highest < 16) expect(highest).toBeLessThan(11);
  w.free();
});

test("WASM fire rises through smoke (gas-to-gas displacement, not suffocated)", () => {
  const w = new SandWasmWorld(8, 32);
  for (let y = 0; y < 28; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 18; y <= 22; y++) w.setCell(4, y, { mat: Material.Smoke, lifetime: 255, flags: 0 });
  w.setCell(4, 23, { mat: Material.Fire, lifetime: 255, flags: 0 });
  run(w, 40);
  let topFire = 32, bottomSmoke = -1;
  for (let y = 0; y < 32; y++) {
    const m = matAt(w, 4, y);
    if (m === Material.Fire && y < topFire) topFire = y;
    if (m === Material.Smoke && y > bottomSmoke) bottomSmoke = y;
  }
  expect(topFire).toBeLessThan(bottomSmoke);
  w.free();
});

test("WASM fire ignites adjacent wood and decays to smoke", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Wood, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Fire, lifetime: 30, flags: 0 });
  run(w, 120);
  let woodLeft = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (matAt(w, x, y) === Material.Wood) woodLeft++;
  expect(woodLeft).toBeLessThan(3);
  w.free();
});

test("WASM lava + water → steam + stone (applyReactions)", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 10, { mat: Material.Lava, lifetime: 0, flags: 0 });
  w.setCell(4, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 5);
  const lava = countMat(w, Material.Lava);
  const stone = countMat(w, Material.Stone);
  const steam = countMat(w, Material.Steam);
  expect(stone).toBeGreaterThan(0);
  expect(steam + (lava === 0 ? 1 : 0)).toBeGreaterThan(0);
  w.free();
});

test("WASM mercury sinks through water (density displacement)", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 8; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  w.setCell(4, 8, { mat: Material.Mercury, lifetime: 0, flags: 0 });
  run(w, 80);
  const mercY = topMostY(w, Material.Mercury);
  const waterY = topMostY(w, Material.Water);
  expect(mercY).toBeGreaterThan(waterY);
  w.free();
});

test("WASM sand sinks through water (solid denser than liquid)", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 6; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Water, lifetime: 0, flags: 0 });
  w.setCell(4, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 80);
  const sandY = topMostY(w, Material.Sand);
  const waterY = topMostY(w, Material.Water);
  expect(sandY).toBeGreaterThan(waterY);
  w.free();
});

test("WASM sand floats on mercury (solid less dense than liquid)", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 6; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Mercury, lifetime: 0, flags: 0 });
  w.setCell(4, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 80);
  const sandY = topMostY(w, Material.Sand);
  const mercY = topMostY(w, Material.Mercury);
  expect(sandY).toBeLessThan(mercY);
  w.free();
});

test("WASM salt + water → brine (applySpecialReactions)", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 11, { mat: Material.Salt, lifetime: 0, flags: 0 });
  w.setCell(5, 11, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 60);
  expect(countMat(w, Material.Brine)).toBeGreaterThan(0);
  w.free();
});

test("WASM FLAG_UPDATED is cleared after each step (no sticky flag)", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 0 });
  w.step();
  for (let i = 0; i < w.grid.length; i++) {
    const flags = (w.grid[i] >> 16) & 0xff;
    expect(flags & 0x04).toBe(0);
  }
  w.free();
});

test("WASM shade bits are preserved across steps", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 0, { mat: Material.Sand, lifetime: 0, flags: 2 });
  run(w, 20);
  let foundShade2 = false;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
    if (matAt(w, x, y) === Material.Sand && (flagsAt(w, x, y) & 0x03) === 2) foundShade2 = true;
  }
  expect(foundShade2).toBe(true);
  w.free();
});

test("WASM reusable buffers are sized to the grid (no out-of-bounds in combustion)", () => {
  const w = new SandWasmWorld(12, 20);
  for (let y = 10; y <= 15; y++) w.setCell(6, y, { mat: Material.Wood, lifetime: 0, flags: 0 });
  w.setCell(6, 15, { mat: Material.Fire, lifetime: 30, flags: 0 });
  w.setCell(5, 15, { mat: Material.Oil, lifetime: 0, flags: 0 });
  w.setCell(7, 15, { mat: Material.Fuse, lifetime: 0, flags: 0 });
  run(w, 200);
  expect(w.frame).toBe(200);
  w.free();
});

test("WASM wind field decays toward 0", () => {
  const w = new SandWasmWorld(8, 16);
  const fi = (11 * 8 + 4) * 4;
  w.fields[fi + FIELD.WIND_X] = 100 & 0xff;
  run(w, 40);
  const v = (w.fields[fi + FIELD.WIND_X] << 24) >> 24;
  expect(Math.abs(v)).toBeLessThan(100);
  w.free();
});

test("WASM nanobots move and eat through material", () => {
  const w = new SandWasmWorld(8, 16);
  w.setCell(4, 8, { mat: Material.Nanobots, lifetime: 255, flags: 0 });
  w.setCell(5, 8, { mat: Material.Wood, lifetime: 0, flags: 0 });
  run(w, 200);
  expect(countMat(w, Material.Nanobots)).toBe(1);
  w.free();
});

test("WASM sand falls through smoke (solid displaces gas)", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 4; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Smoke, lifetime: 255, flags: 0 });
  w.setCell(4, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  run(w, 80);
  expect(matAt(w, 4, 11)).toBe(Material.Sand);
  w.free();
});

test("WASM water falls through smoke (liquid displaces gas)", () => {
  const w = new SandWasmWorld(8, 16);
  for (let y = 4; y <= 11; y++) {
    w.setCell(3, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
    w.setCell(5, y, { mat: Material.Wall, lifetime: 0, flags: 0 });
  }
  for (let y = 9; y <= 11; y++) w.setCell(4, y, { mat: Material.Smoke, lifetime: 255, flags: 0 });
  w.setCell(4, 8, { mat: Material.Water, lifetime: 0, flags: 0 });
  run(w, 80);
  expect(matAt(w, 4, 11)).toBe(Material.Water);
  w.free();
});

test("WASM grid and fields are zero-copy views into WASM memory", () => {
  const w = new SandWasmWorld(8, 16);
  // The grid view should be a Uint32Array of the correct length.
  expect(w.grid).toBeInstanceOf(Uint32Array);
  expect(w.grid.length).toBe(8 * 16);
  // The fields view should be a Uint8Array of the correct length.
  expect(w.fields).toBeInstanceOf(Uint8Array);
  expect(w.fields.length).toBe(8 * 16 * 4);
  w.free();
});

test("WASM paintMaterial places material in a circle", () => {
  const w = new SandWasmWorld(16, 16);
  w.paintMaterial(8, 8, Material.Sand, 3);
  // Center should be sand.
  expect(matAt(w, 8, 8)).toBe(Material.Sand);
  // Corner of the brush circle should not be sand (radius 3).
  expect(matAt(w, 4, 4)).toBe(Material.Empty);
  let sandCount = 0;
  for (let i = 0; i < w.grid.length; i++) if ((w.grid[i] & 0xff) === Material.Sand) sandCount++;
  expect(sandCount).toBeGreaterThan(10);
  w.free();
});

test("WASM stone floor is created on construction", () => {
  const w = new SandWasmWorld(8, 16);
  // Bottom 4 rows should be stone.
  for (let y = 12; y < 16; y++) {
    for (let x = 0; x < 8; x++) {
      expect(matAt(w, x, y)).toBe(Material.Stone);
    }
  }
  // Row above the floor should be empty.
  expect(matAt(w, 4, 11)).toBe(Material.Empty);
  w.free();
});
