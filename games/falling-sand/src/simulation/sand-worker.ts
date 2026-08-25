import { createSimWorker, exposeEvents, type SimWorkerControl } from "@downdraft/core";
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
let pool: SandStepPool | null = null;
let world: SandWorld | null = null;  // = pool.getBoundaryWorld()
let layerIndex = 0;
let writer: SimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
// createSimWorker control — captured in onInit so extraApi methods (loadGrid)
// can use withLoopStopped to safely tear down + recreate the pool without
// racing the tick loop. Without this, loadGrid's inline pool recreation
// overlaps with onTick's SandStepPool.step(), causing a double-init that
// spawns 2x workers and crashes on `strip.startX` (undefined strip).
let simControl: SimWorkerControl | null = null;

let prevMouseX = 0;
let prevMouseY = 0;
let wasMouseDown = false;
let player: PlayerState | null = null;

// Cached view of the SAB input region — avoids allocating a new Int32Array
// on every tick (readInput + player update were each doing this 30×/sec).
let inputBuf: Int32Array | null = null;

// Number of strip-workers for multi-threaded sand physics.
// Leave one core for this coordinator worker + the renderer/main thread.
// Falls back to single-threaded (1 strip-worker) on low-core machines.
const NUM_SAND_WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

createSimWorker({
  fixedDt: 1 / 60,
  maxStepsPerFrame: 5,

  async onInit(sab: SharedArrayBuffer, control: SimWorkerControl, gridW: number, gridH: number, layer: number): Promise<void> {
    sabRef = sab;
    layerIndex = layer;
    simControl = control;
    (globalThis as any).__ddThreadTag = `S${layer}`;
    writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    // Cache the input view once — avoids a per-tick Int32Array allocation.
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);

    // --- Backend: multi-threaded SandStepPool ---
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

    prevMouseX = 0;
    prevMouseY = 0;
    wasMouseDown = false;
  },

  async onTick(_dt: number, ctx): Promise<void> {
    if (!world || !writer || !sabRef || !pool || !inputBuf) return;

    readInput();
    // Multi-threaded step: dispatch to strip-workers + boundary cleanup.
    const stepPool: SandStepPool | null = pool;
    if (!stepPool) return;
    await stepPool.step(world.frame);
    // If resize replaced the pool during the await, exit — the new pool's
    // loop was already started by resize (via withLoopStopped).
    if (pool !== stepPool) return;
    // Increment the frame counter (normally done by SandWorld.step()).
    world.frame++;
    writer.writeGrid(world.grid, layerIndex);
    writer.writeFieldGrid(world.fields, layerIndex);

    // Player physics on layer 0 only
    if (player && layerIndex === 0) {
      const ib = inputBuf;
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
      writer.writeStat(STATS.TICK, ctx.tickCount);
    }
  },

  onAfterTicks(ctx): void {
    if (!writer || layerIndex !== 0) return;
    writer.writeStat(STATS.FPS, ctx.fps);
  },

  async onResize(gridW: number, gridH: number): Promise<void> {
    // The resize RPC already wraps onResize in withLoopStopped, so we can
    // safely tear down + recreate the pool here directly.
    await doResize(gridW, gridH);
  },

  onShutdown(): void {
    if (pool) {
      pool.shutdown();
      pool = null;
    }
    world = null;
  },

  extraApi: {
    clear(): void {
      if (!world) return;
      world.grid.fill(0);
      const cells = world.W * world.H;
      for (let i = 0; i < cells * 4; i += 4) {
        world.fields[i] = 128;     // DEFAULT_GRAVITY
        world.fields[i + 1] = 128; // DEFAULT_TEMP
      }
    },

    async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
      if (!writer || !world || !pool) return;
      // Recreate pool at the new dimensions if needed. Route through
      // withLoopStopped so the tick loop is paused + drained before we tear
      // down the old pool and build a new one. Without this, loadGrid's pool
      // recreation races onTick's SandStepPool.step(): the concurrent init()
      // calls each spawn a full set of workers, leaving workers.length >
      // strips.length and crashing step() on `strip.startX` (undefined strip).
      if (world.W !== gridW || world.H !== gridH) {
        await simControl?.withLoopStopped(() => doResize(gridW, gridH));
        // doResize may have failed to rebuild the pool (e.g. writer/sabRef
        // became null); bail out before touching world.
        if (!world || !pool) return;
      }
      // Copy saved grid + field data into the SAB-backed world.
      world.grid.set(grid.subarray(0, gridW * gridH));
      world.fields.set(fields.subarray(0, gridW * gridH * 4));
    },
  },
});

/**
 * Tear down the current SandStepPool and build a new one at the given
 * dimensions. Shared by onResize (wrapped in withLoopStopped by the resize
 * RPC) and loadGrid (wrapped in withLoopStopped via simControl).
 */
async function doResize(gridW: number, gridH: number): Promise<void> {
  if (!writer || !sabRef) return;
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
  // boundary world on the next step).
  pool.updateConfig({
    horizontalImpulseChance: impulseChance,
    horizontalImpulseStrength: impulseStrength,
  });

  // Paint on the boundary world (SAB-backed grid shared with strip-workers).
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
