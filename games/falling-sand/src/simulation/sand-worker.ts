import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import { SandWorld } from "@downdraft/library-sand";
import {
    INPUT,
    INPUT_BYTES,
    INPUT_OFFSET,
    PLAYER,
    STATS,
    SimBufferWriter
} from "../shared/sim-buffer";
import { createPlayer, updatePlayer, type PlayerState } from "./player";

// --- Backend selection ---
// Set USE_WASM=true to use the Rust WASM+SIMD+threads backend instead of the
// TypeScript SandWorld. The WASM backend is ~2-9× faster depending on core
// count and material complexity. Both backends expose the same interface so
// the rest of the worker code is unchanged.
const USE_WASM = true;

// Union type for the world backend. Both SandWorld (JS) and SandWasmWorld
// expose the same surface (grid, fields, W, H, frame, step, paint*, ignite*).
type WorldBackend = SandWorld | import("./sand-wasm").SandWasmWorld;
type PlayerBackend = PlayerState | import("./sand-wasm").WasmPlayerHandle;

const events = exposeEvents();

// --- Per-layer worker state ---
// Each worker instance is responsible for exactly one layer. The host spawns
// NUM_LAYERS workers, all sharing the same SharedArrayBuffer. Each worker
// writes only to its own layer's grid + field region (non-overlapping), reads
// the shared input region, and — for layer 0 only — writes the player + stats
// regions.
let world: WorldBackend | null = null;
let layerIndex = 0;
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
let player: PlayerBackend | null = null;

// Cached view of the SAB input region — avoids allocating a new Int32Array
// on every tick (readInput + player update were each doing this 30×/sec).
let inputBuf: Int32Array | null = null;

// --- WASM init guard ---
// initWasm() is idempotent, but we only want to call it once per worker.
let wasmInitialized = false;

const TICK_MS = 1000 / 30;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;
let speedMultiplier = 1;
// When true, the loop runs exactly one tick then re-pauses (for the Step button).
let stepOnce = false;

expose({
  async init(sab: SharedArrayBuffer, gridW: number, gridH: number, layer: number): Promise<void> {
    sabRef = sab;
    layerIndex = layer;
    (globalThis as any).__ddThreadTag = `S${layer}`;
    writer = new SimBufferWriter(sab, gridW, gridH);
    // Cache the input view once — avoids a per-tick Int32Array allocation.
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);
    // NOTE: do NOT call writer.init() here — the host already initialized the
    // SAB (including all layer field regions and the input region) before
    // spawning any workers. Calling writer.init() from every worker would
    // re-clear the shared input region and overwrite other layers' field data
    // in the SAB, racing with workers that are already ticking.

    // --- Backend selection ---
    if (USE_WASM) {
      if (!wasmInitialized) {
        const { initWasm } = await import("./sand-wasm");
        await initWasm();
        wasmInitialized = true;
      }
      const { SandWasmWorld, createWasmPlayer } = await import("./sand-wasm");
      world = new SandWasmWorld(gridW, gridH);
      if (layerIndex === 0) {
        player = createWasmPlayer(gridW, gridH);
      }
    } else {
      world = new SandWorld(gridW, gridH);
      if (layerIndex === 0) {
        player = createPlayer(gridW, gridH);
      }
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
    if (USE_WASM && world) {
      // Free old WASM world + player, create new ones
      (world as import("./sand-wasm").SandWasmWorld).free?.();
      // Note: dynamic import already cached — re-import is fast
      import("./sand-wasm").then(({ SandWasmWorld, createWasmPlayer }) => {
        world = new SandWasmWorld(gridW, gridH);
        if (layerIndex === 0) {
          if (player) (player as import("./sand-wasm").WasmPlayerHandle).free?.();
          player = createWasmPlayer(gridW, gridH);
        }
      });
    } else {
      world = new SandWorld(gridW, gridH);
      if (layerIndex === 0) {
        player = createPlayer(gridW, gridH);
      }
    }
  },

  pause(): void { paused = true; },
  resume(): void { paused = false; lastTick = performance.now(); },
  shutdown(): void { running = false; },

  setSpeed(speed: number): void {
    speedMultiplier = Math.max(0, speed);
  },

  step(): void {
    // Advance exactly one tick, then re-pause. The loop checks stepOnce.
    stepOnce = true;
    paused = false;
    lastTick = performance.now();
  },

  clear(): void {
    if (!world) return;
    if (USE_WASM) {
      (world as import("./sand-wasm").SandWasmWorld).free?.();
      import("./sand-wasm").then(({ SandWasmWorld }) => {
        world = new SandWasmWorld(world!.W, world!.H);
      });
    } else {
      world = new SandWorld(world.W, world.H);
    }
  },

  loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): void {
    if (!writer || !world) return;
    // Recreate world at the new dimensions if needed
    if (world.W !== gridW || world.H !== gridH) {
      writer.setDims(gridW, gridH);
      if (USE_WASM) {
        (world as import("./sand-wasm").SandWasmWorld).free?.();
        // Synchronous re-creation isn't possible with dynamic import here,
        // but loadGrid is called after init, so the module is already loaded.
        // Use a direct constructor call via the cached module.
        // Fallback: create a JS world temporarily (rare path).
        world = new SandWorld(gridW, gridH);
      } else {
        world = new SandWorld(gridW, gridH);
      }
    }
    // Copy saved grid + field data into this layer's world
    world.grid.set(grid.subarray(0, gridW * gridH));
    world.fields.set(fields.subarray(0, gridW * gridH * 4));
  },

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
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
          world.step();
          writer.writeGrid(layerIndex, world.grid);
          writer.writeFieldGrid(layerIndex, world.fields);

          // Player physics on layer 0 only — reads input from the shared SAB
          // input region, writes player state to the shared SAB player region.
          if (player && layerIndex === 0) {
            const ib = inputBuf!;
            const input = {
              left: ib[INPUT.LEFT / 4] !== 0,
              right: ib[INPUT.RIGHT / 4] !== 0,
              up: ib[INPUT.UP / 4] !== 0,
              down: ib[INPUT.DOWN / 4] !== 0,
              jump: ib[INPUT.JUMP / 4] !== 0,
            };
            if (USE_WASM) {
              // WASM player: call update() method on the handle
              (player as import("./sand-wasm").WasmPlayerHandle).update(input, world.grid, world.W, world.H);
            } else {
              updatePlayer(player as PlayerState, input, world.grid, world.W, world.H);
            }
            writer.writePlayerF32(PLAYER.PX, player.x);
            writer.writePlayerF32(PLAYER.PY, player.y);
            writer.writePlayerF32(PLAYER.VX, player.vx);
            writer.writePlayerF32(PLAYER.VY, player.vy);
            writer.writePlayerI32(PLAYER.ON_GROUND, player.onGround ? 1 : 0);
            writer.writePlayerI32(PLAYER.FACING, player.facing);
            writer.writePlayerI32(PLAYER.ANIM_FRAME, player.animFrame);
            writer.writePlayerI32(PLAYER.HEALTH, player.health);
          }

          // Stats written by layer 0 only (the "primary" worker).
          if (layerIndex === 0) {
            writer.writeStat(STATS.FRAME, world.frame);
            writer.writeStat(STATS.TICK, tickCount);
          }
          tickCount++;
          tickAccumulator--;
          steps++;
        }
        if (tickAccumulator > MAX_STEPS_PER_FRAME) {
          tickAccumulator = 0;
        }
        // After a single-step, re-pause and clear the flag.
        if (stepOnce) {
          stepOnce = false;
          paused = true;
          tickAccumulator = 0;
        }
      }
    }

    frameCount++;
    fpsTimer += elapsed;
    if (fpsTimer >= 1000) {
      fps = Math.round((frameCount * 1000) / fpsTimer);
      if (layerIndex === 0) {
        writer?.writeStat(STATS.FPS, fps);
      }
      frameCount = 0;
      fpsTimer = 0;
    }
  } catch (err) {
    // If the loop throws, the setTimeout(loop, 0) at the end would never be
    // reached, silently killing the worker's tick loop. Log the error so we
    // can diagnose it, then schedule the next iteration to keep the loop alive.
    console.error(`[SandWorker L${layerIndex}] loop error:`, err);
  }

  setTimeout(loop, 0);
}

function readInput(): void {
  if (!world || !sabRef || !inputBuf) return;

  const ib = inputBuf;

  const mouseDown = ib[INPUT.MOUSE_DOWN / 4] !== 0;
  const mouseRight = ib[INPUT.MOUSE_RIGHT / 4] !== 0;
  const mouseX = ib[INPUT.MOUSE_X / 4];
  const mouseY = ib[INPUT.MOUSE_Y / 4];
  const selectedMat = ib[INPUT.SELECTED_MAT / 4];
  const brushRadius = ib[INPUT.BRUSH_RADIUS / 4];
  const brushMode = ib[INPUT.BRUSH_MODE / 4];
  const fieldType = ib[INPUT.FIELD_TYPE / 4];
  const fieldValue = ib[INPUT.FIELD_VALUE / 4];
  const impulseChance = ib[INPUT.IMPULSE_CHANCE / 4] / 1000;
  const impulseStrength = ib[INPUT.IMPULSE_STRENGTH / 4] / 1000;
  const activeLayer = ib[INPUT.ACTIVE_LAYER / 4];

  // Apply impulse settings to this worker's world
  world.horizontalImpulseChance = impulseChance;
  world.horizontalImpulseStrength = impulseStrength;

  // Paint only on the active layer — each worker checks if it's the chosen one.
  if (mouseDown && activeLayer === layerIndex) {
    if (!wasMouseDown) {
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    }
    if (brushMode === 1) {
      world.paintFieldLine(prevMouseX, prevMouseY, mouseX, mouseY, fieldType, fieldValue, brushRadius);
    } else {
      world.paintLine(prevMouseX, prevMouseY, mouseX, mouseY, selectedMat, brushRadius);
    }
    // console.log(`[SandWorker L${layerIndex}] PAINT mat=${selectedMat} at (${mouseX},${mouseY}) r=${brushRadius} mode=${brushMode}`);
  }
  // Right-click ignite: every worker ignites its own layer.
  if (mouseRight) {
    world.igniteLine(prevMouseX, prevMouseY, mouseX, mouseY, 3);
  }

  prevMouseX = mouseX;
  prevMouseY = mouseY;
  wasMouseDown = mouseDown;
}
