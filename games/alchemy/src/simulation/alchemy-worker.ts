import { createSimWorker } from "@downdraft/core";
import { DEFAULT_GRAVITY, DEFAULT_TEMP, FIELD, Material, SandWorld } from "@downdraft/library-sand";
import { CAULDRON_WALL_THICKNESS } from "../shared/constants";
import {
    INPUT,
    INPUT_BYTES,
    INPUT_OFFSET,
    OFFSETS,
    STATS,
    SimBufferWriter,
} from "../shared/sim-buffer";
import { computeHistogram, initCauldron } from "./cauldron";

// --- Worker state ---
let world: SandWorld | null = null;
let writer: SimBufferWriter | null = null;
let inputBuf: Int32Array | null = null;
let histogram: Uint32Array | null = null;

let wasMouseDown = false;

// Station state
let stationActive: "heat" | "cool" | "settle" | null = null;
let stationTicksRemaining = 0;
let stationTotalTicks = 0;

createSimWorker({
  fixedDt: 1 / 30,
  maxStepsPerFrame: 5,

  onInit(sab: SharedArrayBuffer, _control, gridW: number, gridH: number): void {
    writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);
    histogram = new Uint32Array(256);

    world = new SandWorld(gridW, gridH);
    initCauldron(world.grid, world.fields, gridW, gridH);

    wasMouseDown = false;
  },

  onTick(_dt: number, _ctx): void {
    if (!world || !writer) return;

    readInput();
    applyStationTick();
    world.step();
    writer.writeGrid(world.grid);
    writer.writeFieldGrid(world.fields);
    if (histogram) {
      computeHistogram(world.grid, world.W, world.H, histogram);
      writer.writeMixtureHistogram(histogram);
    }
  },

  onAfterTicks(ctx): void {
    if (!writer) return;
    writer.writeStat(STATS.TICK, ctx.tickCount);
    writer.writeStat(STATS.FRAME, ctx.frameCount);
    writer.writeStat(STATS.FPS, ctx.fps);
  },

  onResize(gridW: number, gridH: number): void {
    if (!writer || !world) return;
    writer.setDims(gridW, gridH);
    world = new SandWorld(gridW, gridH);
    initCauldron(world.grid, world.fields, gridW, gridH);
  },

  extraApi: {
    clear(): void {
      if (!world) return;
      initCauldron(world.grid, world.fields, world.W, world.H);
    },

    loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): void {
      if (!writer || !world) return;
      if (world.W !== gridW || world.H !== gridH) {
        writer.setDims(gridW, gridH);
        world = new SandWorld(gridW, gridH);
      }
      world.grid.set(grid.subarray(0, gridW * gridH));
      world.fields.set(fields.subarray(0, gridW * gridH * 4));
    },

    // --- Station actions ---
    runStation(station: "heat" | "cool" | "settle", durationTicks: number): void {
      if (!world) return;
      stationActive = station;
      stationTicksRemaining = durationTicks;
      stationTotalTicks = durationTicks;
    },

    cancelStation(): void {
      stationActive = null;
      stationTicksRemaining = 0;
    },

    getStationState(): { station: string | null; progress: number } {
      if (!stationActive) return { station: null, progress: 0 };
      const elapsed = stationTotalTicks - stationTicksRemaining;
      return { station: stationActive, progress: elapsed / stationTotalTicks };
    },
  },
});

function readInput(): void {
  if (!world || !inputBuf) return;
  const ib = inputBuf;
  const mouseDown = ib[INPUT.MOUSE_DOWN / 4] !== 0;
  const mouseRight = ib[INPUT.MOUSE_RIGHT / 4] !== 0;
  const mouseX = ib[INPUT.MOUSE_X / 4];
  const mouseY = ib[INPUT.MOUSE_Y / 4];
  const selectedMat = ib[INPUT.SELECTED_MAT / 4];
  const brushRadius = ib[INPUT.BRUSH_RADIUS / 4];
  const lastMouseX = ib[INPUT.LAST_MOUSE_X / 4];
  const lastMouseY = ib[INPUT.LAST_MOUSE_Y / 4];

  // Left-click: paint selected ingredient
  if (mouseDown && selectedMat > 0) {
    // Don't paint on walls
    paintInCauldron(mouseX, mouseY, selectedMat, brushRadius);
    // Interpolate from last position for smooth strokes
    if (wasMouseDown && (lastMouseX !== mouseX || lastMouseY !== mouseY)) {
      paintLineInCauldron(lastMouseX, lastMouseY, mouseX, mouseY, selectedMat, brushRadius);
    }
  }
  // Right-click: erase (set to empty) — useful for cleaning up
  if (mouseRight) {
    eraseInCauldron(mouseX, mouseY, brushRadius);
  }

  wasMouseDown = mouseDown;
}

/** Paint material but skip wall cells (don't overwrite the cauldron perimeter). */
function paintInCauldron(cx: number, cy: number, mat: number, radius: number): void {
  if (!world) return;
  const W = world.W, H = world.H;
  const grid = world.grid;
  const r2 = radius * radius;
  const t = CAULDRON_WALL_THICKNESS;
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < t || y >= H - t) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < t || x >= W - t) continue;
      const ddx = x - cx, ddy = y - cy;
      if (ddx * ddx + ddy * ddy > r2) continue;
      const curMat = grid[y * W + x] & 0xff;
      if (curMat === Material.Wall) continue;
      grid[y * W + x] = (mat & 0xff) | (Math.floor(Math.random() * 4) << 16);
    }
  }
}

function paintLineInCauldron(x0: number, y0: number, x1: number, y1: number, mat: number, radius: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (true) {
    paintInCauldron(x, y, mat, radius);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function eraseInCauldron(cx: number, cy: number, radius: number): void {
  if (!world) return;
  const W = world.W, H = world.H;
  const grid = world.grid;
  const r2 = radius * radius;
  const t = CAULDRON_WALL_THICKNESS;
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < t || y >= H - t) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < t || x >= W - t) continue;
      const ddx = x - cx, ddy = y - cy;
      if (ddx * ddx + ddy * ddy > r2) continue;
      grid[y * W + x] = 0;
    }
  }
}

/** Apply the active station's per-tick effect on the cauldron fields. */
function applyStationTick(): void {
  if (!world || !stationActive) return;
  const W = world.W, H = world.H;
  const fields = world.fields;
  const t = CAULDRON_WALL_THICKNESS;

  if (stationActive === "heat") {
    // Paint high temperature across the cauldron interior
    for (let y = t; y < H - t; y++) {
      for (let x = t; x < W - t; x++) {
        const fi = (y * W + x) * 4;
        fields[fi + FIELD.TEMP] = 255;
      }
    }
  } else if (stationActive === "cool") {
    // Paint low temperature across the cauldron interior
    for (let y = t; y < H - t; y++) {
      for (let x = t; x < W - t; x++) {
        const fi = (y * W + x) * 4;
        fields[fi + FIELD.TEMP] = 0;
      }
    }
  } else if (stationActive === "settle") {
    // Crank gravity to max so dense particles sink fast
    for (let y = t; y < H - t; y++) {
      for (let x = t; x < W - t; x++) {
        const fi = (y * W + x) * 4;
        fields[fi + FIELD.GRAVITY] = 255;
      }
    }
  }

  stationTicksRemaining--;
  if (stationTicksRemaining <= 0) {
    // Reset fields to defaults when the station finishes
    for (let y = t; y < H - t; y++) {
      for (let x = t; x < W - t; x++) {
        const fi = (y * W + x) * 4;
        fields[fi + FIELD.GRAVITY] = DEFAULT_GRAVITY;
        fields[fi + FIELD.TEMP] = DEFAULT_TEMP;
      }
    }
    stationActive = null;
    stationTicksRemaining = 0;
  }
}
