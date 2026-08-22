import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import { SandStepPool, SandWorld } from "@downdraft/library-sand";
import {
    INPUT,
    INPUT_BYTES,
    INPUT_OFFSET,
    OFFSETS,
    PLAYER,
    STATS,
    SimBufferWriter
} from "../shared/sim-buffer";
import { createPlayer, updatePlayer, type PlayerState } from "./player";

const events = exposeEvents();

// --- Per-layer worker state ---
// Each worker instance is responsible for exactly one layer. The host spawns
// NUM_LAYERS workers, all sharing the same SharedArrayBuffer. Each worker
// writes only to its own layer's grid + field region (non-overlapping), reads
// the shared input region, and — for layer 0 only — writes the player + stats
// regions.
//
// Multi-threaded sand physics: instead of a single SandWorld stepping on this
// worker's thread, we use a SandStepPool that splits the grid into N vertical
// strips processed by N nested sand-step workers sharing a SAB-backed grid.
// This mirrors mining-rpg's ChunkWorld integration (commit af3e63c). The
// boundaryWorld (pool.getBoundaryWorld()) is the coordinator's SAB-backed
// SandWorld with full-grid write bounds — used for painting, player physics,
// boundary cleanup, and copying the grid to the sim-buffer SAB for rendering.
let pool: SandStepPool | null = null;
let world: SandWorld | null = null;  // = pool.getBoundaryWorld()
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
let player: PlayerState | null = null;

// Cached view of the SAB input region — avoids allocating a new Int32Array
// on every tick (readInput + player update were each doing this 30×/sec).
let inputBuf: Int32Array | null = null;

const TICK_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;
let speedMultiplier = 1;
// When true, the loop runs exactly one tick then re-pauses (for the Step button).
let stepOnce = false;
// Guards the loop during resize: when false, the loop exits without scheduling
// the next iteration. resize() sets this to false, waits for any in-flight
// pool.step() to finish, then recreates the pool and restarts the loop.
let loopActive = true;
// True while awaiting pool.step() — used by resize() to wait for the step to
// finish before shutting down the pool (which would orphan the await).
let stepInProgress = false;

// Number of strip-workers for multi-threaded sand physics.
// Leave one core for this coordinator worker + the renderer/main thread.
// Falls back to single-threaded (1 strip-worker) on low-core machines.
const NUM_SAND_WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

expose({
  async init(sab: SharedArrayBuffer, gridW: number, gridH: number, layer: number): Promise<void> {
    sabRef = sab;
    layerIndex = layer;
    (globalThis as any).__ddThreadTag = `S${layer}`;
    writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    // Cache the input view once — avoids a per-tick Int32Array allocation.
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);
    // NOTE: do NOT call writer.init() here — the host already initialized the
    // SAB (including all layer field regions and the input region) before
    // spawning any workers. Calling writer.init() from every worker would
    // re-clear the shared input region and overwrite other layers' field data
    // in the SAB, racing with workers that are already ticking.

    // --- Backend: multi-threaded SandStepPool ---
    // The pool allocates its own SAB for the grid + fields + skip mask +
    // histogram, shared with N nested sand-step workers. The boundaryWorld
    // is the coordinator's SAB-backed SandWorld (full-grid write bounds).
    pool = new SandStepPool({
      W: gridW,
      H: gridH,
      numWorkers: NUM_SAND_WORKERS,
    });
    await pool.init();
    world = pool.getBoundaryWorld();
    // Seed the boundary world's PRNG (used for painting, ignite, player).
    // Strip-workers seed themselves in their init.
    world.reseed(0x9e3779b9 ^ (layerIndex * 0x85ebca6b));
    if (layerIndex === 0) {
      player = createPlayer(gridW, gridH);
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

  async resize(gridW: number, gridH: number): Promise<void> {
    await doResize(gridW, gridH);
  },

  pause(): void { paused = true; },
  resume(): void { paused = false; lastTick = performance.now(); },
  shutdown(): void {
    running = false;
    loopActive = false;
    if (pool) {
      pool.shutdown();
      pool = null;
    }
    world = null;
  },

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
    // Clear the SAB-backed grid + reset fields to defaults. The grid is shared
    // with strip-workers, so clearing here is visible to all workers on the
    // next step.
    world.grid.fill(0);
    const cells = world.W * world.H;
    for (let i = 0; i < cells * 4; i += 4) {
      world.fields[i] = 128;     // DEFAULT_GRAVITY
      world.fields[i + 1] = 128; // DEFAULT_TEMP
    }
  },

  async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (!writer || !world || !pool) return;
    // Recreate pool at the new dimensions if needed. doResize handles the
    // loopActive guard + pool shutdown/recreation safely.
    if (world.W !== gridW || world.H !== gridH) {
      await doResize(gridW, gridH);
    }
    // Copy saved grid + field data into the SAB-backed world (shared with
    // strip-workers). The data is visible to all workers on the next step.
    world.grid.set(grid.subarray(0, gridW * gridH));
    world.fields.set(fields.subarray(0, gridW * gridH * 4));
  },

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
  },
});

/**
 * Safely recreate the SandStepPool at new dimensions. Stops the loop, waits
 * for any in-flight pool.step() to finish, shuts down the old pool, creates
 * a new one, and restarts the loop. Used by both resize() and loadGrid().
 */
async function doResize(gridW: number, gridH: number): Promise<void> {
  if (!writer || !sabRef) return;
  // Stop the loop to prevent a race between pool.step() and pool.shutdown().
  // If the loop is in await pool.step() and we terminate the workers, the
  // promise never resolves and the loop hangs.
  loopActive = false;
  // Wait for any in-flight step to complete (max ~50ms). If it doesn't
  // finish in time, we proceed — the old pool's workers get terminated and
  // the old loop's await hangs harmlessly (we start a fresh loop below).
  for (let i = 0; i < 50 && stepInProgress; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  stepInProgress = false;

  writer.setDims(gridW, gridH);
  // Shut down the old pool and create a new one at the new dimensions.
  if (pool) {
    pool.shutdown();
  }
  pool = new SandStepPool({
    W: gridW,
    H: gridH,
    numWorkers: NUM_SAND_WORKERS,
  });
  await pool.init();
  world = pool.getBoundaryWorld();
  world.reseed(0x9e3779b9 ^ (layerIndex * 0x85ebca6b));
  if (layerIndex === 0) {
    player = createPlayer(gridW, gridH);
  }

  // Restart the loop.
  loopActive = true;
  lastTick = performance.now();
  loop();
}

async function loop(): Promise<void> {
  if (!loopActive || !running || !world || !writer || !sabRef || !pool) return;

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
          // Multi-threaded step: dispatch to strip-workers + boundary cleanup.
          // The pool shares the SAB-backed grid with workers. The async step
          // resolves when all workers finish + boundary cleanup is done.
          // Capture the pool reference so we can detect if resize() replaced
          // it while we were awaiting (resize shuts down the old pool).
          const stepPool: SandStepPool | null = pool;
          if (!stepPool) break;
          stepInProgress = true;
          await stepPool.step(world.frame);
          stepInProgress = false;
          // If resize() replaced the pool during the await, exit — the new
          // pool's loop was already started by resize().
          if (pool !== stepPool || !loopActive) return;
          // Increment the frame counter (normally done by SandWorld.step()).
          world.frame++;
          writer.writeGrid(world.grid, layerIndex);
          writer.writeFieldGrid(world.fields, layerIndex);

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
            updatePlayer(player, input, world.grid, world.W, world.H);
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

  if (loopActive) setTimeout(loop, 0);
}

function readInput(): void {
  if (!world || !sabRef || !inputBuf || !pool) return;

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

  // Sync impulse settings to the pool (forwards to all strip-workers + the
  // boundary world on the next step). This replaces setting fields directly
  // on the world — strip-workers need the config via the step message.
  pool.updateConfig({
    horizontalImpulseChance: impulseChance,
    horizontalImpulseStrength: impulseStrength,
  });

  // Paint on the boundary world (SAB-backed grid shared with strip-workers).
  // With a single layer, layerIndex is always 0 and the active-layer check
  // is always true — paint unconditionally when mouse is down.
  if (mouseDown) {
    if (!wasMouseDown) {
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    }
    if (brushMode === 1) {
      world.paintFieldLine(prevMouseX, prevMouseY, mouseX, mouseY, fieldType, fieldValue, brushRadius);
    } else {
      world.paintLine(prevMouseX, prevMouseY, mouseX, mouseY, selectedMat, brushRadius);
    }
  }
  // Right-click ignite.
  if (mouseRight) {
    world.igniteLine(prevMouseX, prevMouseY, mouseX, mouseY, 3);
  }

  prevMouseX = mouseX;
  prevMouseY = mouseY;
  wasMouseDown = mouseDown;
}
