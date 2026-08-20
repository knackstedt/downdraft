import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
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
let sabRef: SharedArrayBuffer | null = null;
let running = false;
let paused = false;
let lastTick = 0;
let tickCount = 0;
let frameCount = 0;
let fpsTimer = 0;
let fps = 0;

let wasMouseDown = false;

// Cached input view
let inputBuf: Int32Array | null = null;

// Mixture histogram (reused buffer)
let histogram: Uint32Array | null = null;

// Station state
let stationActive: "heat" | "cool" | "settle" | null = null;
let stationTicksRemaining = 0;
let stationTotalTicks = 0;

const events = exposeEvents();

const TICK_MS = 1000 / 30;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;
let speedMultiplier = 1;
let stepOnce = false;

expose({
  async init(sab: SharedArrayBuffer, gridW: number, gridH: number): Promise<void> {
    sabRef = sab;
    writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);
    histogram = new Uint32Array(256);

    world = new SandWorld(gridW, gridH);
    // Override the stone floor with a cauldron (walled interior)
    initCauldron(world.grid, world.fields, gridW, gridH);

    running = true;
    paused = false;
    lastTick = performance.now();
    wasMouseDown = false;
    events.emit("ready", {});
    loop();
  },

  resize(gridW: number, gridH: number): void {
    if (!writer || !sabRef) return;
    writer.setDims(gridW, gridH);
    world = new SandWorld(gridW, gridH);
    initCauldron(world.grid, world.fields, gridW, gridH);
  },

  pause(): void { paused = true; },
  resume(): void { paused = false; lastTick = performance.now(); },
  shutdown(): void { running = false; },

  setSpeed(speed: number): void {
    speedMultiplier = Math.max(0, speed);
  },

  step(): void {
    stepOnce = true;
    paused = false;
    lastTick = performance.now();
  },

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

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
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
});

async function loop(): Promise<void> {
  if (!running || !world || !writer || !sabRef) return;

  try {
    const now = performance.now();
    const elapsed = now - lastTick;

    if (elapsed >= TICK_MS) {
      lastTick = now - (elapsed % TICK_MS);
      tickAccumulator += (elapsed / TICK_MS) * speedMultiplier;

      if (!paused || stepOnce) {
        let steps = 0;
        const maxSteps = stepOnce ? 1 : MAX_STEPS_PER_FRAME;
        while (tickAccumulator >= 1 && steps < maxSteps) {
          readInput();
          applyStationTick();
          world.step();
          writer.writeGrid(world.grid);
          writer.writeFieldGrid(world.fields);
          if (histogram) {
            computeHistogram(world.grid, world.W, world.H, histogram);
            writer.writeMixtureHistogram(histogram);
          }
          writer.writeStat(STATS.TICK, tickCount);
          writer.writeStat(STATS.FRAME, frameCount);
          tickCount++;
          tickAccumulator -= 1;
          steps++;
        }
        if (stepOnce) {
          stepOnce = false;
          paused = true;
        }
        frameCount++;
      }
    }

    // FPS tracking
    fpsTimer += elapsed;
    if (fpsTimer >= 1000) {
      fps = Math.round((frameCount * 1000) / fpsTimer);
      writer.writeStat(STATS.FPS, fps);
      frameCount = 0;
      fpsTimer = 0;
    }

    setTimeout(loop, 0);
  } catch (e) {
    console.error("[alchemy-worker] loop error:", e);
    setTimeout(loop, 100);
  }
}

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
