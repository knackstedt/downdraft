import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import {
    INPUT,
    INPUT_BYTES,
    INPUT_OFFSET,
    NUM_LAYERS,
    STATS,
    SimBufferWriter
} from "../shared/sim-buffer";
import { SandWorld } from "./sand-world";

(globalThis as any).__ddThreadTag = "S0";

const events = exposeEvents();

let worlds: SandWorld[] = [];
let writer: SimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
let running = false;
let paused = false;
let lastTick = 0;
let tickCount = 0;
let frameCount = 0;
let fpsTimer = 0;
let fps = 0;

let prevMouseX = 0;
let prevMouseY = 0;
let wasMouseDown = false;

const TICK_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;

expose({
  async init(sab: SharedArrayBuffer, gridW: number, gridH: number): Promise<void> {
    sabRef = sab;
    writer = new SimBufferWriter(sab, gridW, gridH);
    writer.init();
    worlds = [];
    for (let i = 0; i < NUM_LAYERS; i++) {
      worlds.push(new SandWorld(gridW, gridH));
    }
    running = true;
    paused = false;
    lastTick = performance.now();
    prevMouseX = 0;
    prevMouseY = 0;
    wasMouseDown = false;
    events.emit("ready", {});
    loop();
  },

  resize(gridW: number, gridH: number): void {
    if (!writer || !sabRef) return;
    writer.setDims(gridW, gridH);
    worlds = [];
    for (let i = 0; i < NUM_LAYERS; i++) {
      worlds.push(new SandWorld(gridW, gridH));
    }
  },

  pause(): void { paused = true; },
  resume(): void { paused = false; lastTick = performance.now(); },
  shutdown(): void { running = false; },

  clear(): void {
    for (let i = 0; i < worlds.length; i++) {
      worlds[i] = new SandWorld(worlds[i].W, worlds[i].H);
    }
  },

  loadGrids(grids: Uint32Array[], fields: Uint8Array[], gridW: number, gridH: number): void {
    if (!writer) return;
    // Recreate worlds at the new dimensions
    if (worlds.length === 0 || worlds[0].W !== gridW || worlds[0].H !== gridH) {
      writer.setDims(gridW, gridH);
      worlds = [];
      for (let i = 0; i < NUM_LAYERS; i++) {
        worlds.push(new SandWorld(gridW, gridH));
      }
    }
    // Copy saved grid + field data into each world
    for (let i = 0; i < worlds.length && i < grids.length; i++) {
      worlds[i].grid.set(grids[i].subarray(0, gridW * gridH));
      if (fields[i]) {
        worlds[i].fields.set(fields[i].subarray(0, gridW * gridH * 4));
      }
    }
  },

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
  },
});

async function loop(): Promise<void> {
  if (!running || worlds.length === 0 || !writer || !sabRef) return;

  const now = performance.now();
  const elapsed = now - lastTick;

  if (elapsed >= TICK_MS) {
    lastTick = now - (elapsed % TICK_MS);
    tickAccumulator += elapsed / TICK_MS;

    if (!paused) {
      let steps = 0;
      while (tickAccumulator >= 1 && steps < MAX_STEPS_PER_FRAME) {
        readInput();
        for (let i = 0; i < worlds.length; i++) {
          worlds[i].step();
          writer.writeGrid(i, worlds[i].grid);
          writer.writeFieldGrid(i, worlds[i].fields);
        }
        writer.writeStat(STATS.FRAME, worlds[0].frame);
        writer.writeStat(STATS.TICK, tickCount);
        tickCount++;
        tickAccumulator--;
        steps++;
      }
      if (tickAccumulator > MAX_STEPS_PER_FRAME) {
        tickAccumulator = 0;
      }
    }
  }

  frameCount++;
  fpsTimer += elapsed;
  if (fpsTimer >= 1000) {
    fps = Math.round((frameCount * 1000) / fpsTimer);
    writer.writeStat(STATS.FPS, fps);
    frameCount = 0;
    fpsTimer = 0;
  }

  setTimeout(loop, 0);
}

function readInput(): void {
  if (worlds.length === 0 || !sabRef) return;

  const inputBuf = new Int32Array(sabRef, INPUT_OFFSET, INPUT_BYTES / 4);

  const mouseDown = inputBuf[INPUT.MOUSE_DOWN / 4] !== 0;
  const mouseRight = inputBuf[INPUT.MOUSE_RIGHT / 4] !== 0;
  const mouseX = inputBuf[INPUT.MOUSE_X / 4];
  const mouseY = inputBuf[INPUT.MOUSE_Y / 4];
  const selectedMat = inputBuf[INPUT.SELECTED_MAT / 4];
  const brushRadius = inputBuf[INPUT.BRUSH_RADIUS / 4];
  const brushMode = inputBuf[INPUT.BRUSH_MODE / 4];
  const fieldType = inputBuf[INPUT.FIELD_TYPE / 4];
  const fieldValue = inputBuf[INPUT.FIELD_VALUE / 4];
  const impulseChance = inputBuf[INPUT.IMPULSE_CHANCE / 4] / 1000;
  const impulseStrength = inputBuf[INPUT.IMPULSE_STRENGTH / 4] / 1000;
  const activeLayer = Math.min(inputBuf[INPUT.ACTIVE_LAYER / 4], worlds.length - 1);

  // Apply impulse settings to all worlds
  for (const w of worlds) {
    w.horizontalImpulseChance = impulseChance;
    w.horizontalImpulseStrength = impulseStrength;
  }

  if (mouseDown) {
    if (!wasMouseDown) {
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    }
    const world = worlds[activeLayer];
    if (brushMode === 1) {
      world.paintFieldLine(prevMouseX, prevMouseY, mouseX, mouseY, fieldType, fieldValue, brushRadius);
    } else {
      world.paintLine(prevMouseX, prevMouseY, mouseX, mouseY, selectedMat, brushRadius);
    }
  }
  if (mouseRight) {
    // Ignite on all layers
    for (const w of worlds) {
      w.igniteLine(prevMouseX, prevMouseY, mouseX, mouseY, 3);
    }
  }

  prevMouseX = mouseX;
  prevMouseY = mouseY;
  wasMouseDown = mouseDown;
}
