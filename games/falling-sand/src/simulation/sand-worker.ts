import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import {
    INPUT,
    INPUT_BYTES,
    INPUT_OFFSET,
    STATS,
    SimBufferWriter,
} from "../shared/sim-buffer";
import { SandWorld } from "./sand-world";

(globalThis as any).__ddThreadTag = "S0";

const events = exposeEvents();

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

// Worker-side previous mouse tracking — more reliable than renderer-side
// because the worker reads the SAB every tick and always knows the
// previous position at tick granularity.
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
    world = new SandWorld(gridW, gridH);
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
    world = new SandWorld(gridW, gridH);
    prevMouseX = 0;
    prevMouseY = 0;
    wasMouseDown = false;
  },

  pause(): void { paused = true; },
  resume(): void { paused = false; lastTick = performance.now(); },
  shutdown(): void { running = false; },

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
  },
});

async function loop(): Promise<void> {
  if (!running || !world || !writer || !sabRef) return;

  const now = performance.now();
  const elapsed = now - lastTick;

  if (elapsed >= TICK_MS) {
    lastTick = now - (elapsed % TICK_MS);
    tickAccumulator += elapsed / TICK_MS;

    if (!paused) {
      let steps = 0;
      while (tickAccumulator >= 1 && steps < MAX_STEPS_PER_FRAME) {
        readInput();
        world.step();
        writer.writeGrid(world.grid);
        writer.writeStat(STATS.FRAME, world.frame);
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
  if (!world || !sabRef) return;

  const inputBuf = new Int32Array(sabRef, INPUT_OFFSET, INPUT_BYTES / 4);

  const mouseDown = inputBuf[INPUT.MOUSE_DOWN / 4] !== 0;
  const mouseRight = inputBuf[INPUT.MOUSE_RIGHT / 4] !== 0;
  const mouseX = inputBuf[INPUT.MOUSE_X / 4];
  const mouseY = inputBuf[INPUT.MOUSE_Y / 4];
  const selectedMat = inputBuf[INPUT.SELECTED_MAT / 4];
  const brushRadius = inputBuf[INPUT.BRUSH_RADIUS / 4];
  const magnetActive = inputBuf[INPUT.MAGNET / 4] !== 0;
  const impulseChance = inputBuf[INPUT.IMPULSE_CHANCE / 4] / 1000;
  const impulseStrength = inputBuf[INPUT.IMPULSE_STRENGTH / 4] / 1000;

  // Apply settings to the world
  world.horizontalImpulseChance = impulseChance;
  world.horizontalImpulseStrength = impulseStrength;

  if (mouseDown) {
    // On mousedown transition, snap prev to current so we don't draw
    // a line from a stale position
    if (!wasMouseDown) {
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    }
    world.paintLine(prevMouseX, prevMouseY, mouseX, mouseY, selectedMat, brushRadius);
  }
  if (mouseRight) {
    world.igniteLine(prevMouseX, prevMouseY, mouseX, mouseY, 3);
  }

  // Always update prev so the next tick's line starts from here
  prevMouseX = mouseX;
  prevMouseY = mouseY;
  wasMouseDown = mouseDown;

  if (magnetActive) {
    world.setMagnet(mouseX, mouseY, true);
  } else {
    world.setMagnet(0, 0, false);
  }
}
