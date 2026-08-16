// ============================================================================
// Mining worker — runs the ChunkWorld simulation in a Web Worker.
//
// Each tick: reads input from the shared SAB, runs ChunkWorld.step, writes the
// active grid + player state + stats back to the SAB.
// ============================================================================

import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, INPUT, INPUT_OFFSET, PLAYER, STATS, TICK_RATE } from "../shared/constants";
import { MiningSimBufferWriter } from "../shared/sim-buffer";
import type { InventoryEntry, MiningPlayerState, PlayerUpgrades } from "../shared/types";
import { ChunkWorld, type SavedChunk } from "./chunk-world";

const events = exposeEvents();

let world: ChunkWorld | null = null;
let writer: MiningSimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
let running = false;
let paused = false;
let lastTick = 0;
let tickCount = 0;
let frameCount = 0;
let fpsTimer = 0;
let fps = 0;
let speedMultiplier = 1;
let stepOnce = false;
let inputBuf: Int32Array | null = null;
let inputF32: Float32Array | null = null;
let currentInventory: InventoryEntry[] = [];

const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;

expose({
  async init(sab: SharedArrayBuffer): Promise<void> {
    sabRef = sab;
    writer = new MiningSimBufferWriter(sab, ACTIVE_GRID_W, ACTIVE_GRID_H);
    inputBuf = new Int32Array(sab, INPUT_OFFSET, 128 / 4);
    inputF32 = new Float32Array(sab, INPUT_OFFSET, 128 / 4);

    world = new ChunkWorld();
    running = true;
    paused = false;
    lastTick = performance.now();
    events.emit("ready", {});
    loop();
  },

  pause(): void {
    paused = true;
  },
  resume(): void {
    paused = false;
    lastTick = performance.now();
  },
  shutdown(): void {
    running = false;
  },
  setSpeed(speed: number): void {
    speedMultiplier = Math.max(0, speed);
  },
  step(): void {
    stepOnce = true;
    paused = false;
    lastTick = performance.now();
  },

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
  },

  // --- Save / Load ---

  getSaveData(): {
    player: MiningPlayerState;
    upgrades: PlayerUpgrades;
    dirtyChunks: SavedChunk[];
    tick: number;
  } {
    if (!world) return { player: { x: 0, y: 0, vx: 0, vy: 0, onGround: false, facing: 1, animFrame: 0, health: 100, lastDamageMaterial: 0 }, upgrades: { damage: 0, radius: 0, rate: 0, inventorySize: 0 }, dirtyChunks: [], tick: 0 };
    return {
      player: { ...world.player },
      upgrades: { ...world.upgrades },
      dirtyChunks: world.getDirtyChunks(),
      tick: world.currentTick,
    };
  },

  loadSaveData(data: { player: MiningPlayerState; upgrades?: PlayerUpgrades; chunks: SavedChunk[]; tick: number }): void {
    if (!world) return;
    // Restore chunks first (before player state, since setPlayerState forces rebuild)
    for (const chunk of data.chunks) {
      world.restoreChunk(chunk);
    }
    // Restore player state
    world.setPlayerState(data.player);
    // Restore upgrades
    if (data.upgrades) world.setUpgrades(data.upgrades);
    // Restore tick counter
    if (data.tick) world.currentTick = data.tick;
  },

  setUpgrades(upgrades: PlayerUpgrades): void {
    if (!world) return;
    world.setUpgrades(upgrades);
  },

  setInventory(inventory: InventoryEntry[]): void {
    currentInventory = inventory;
  },

  respawn(): void {
    if (!world) return;
    world.respawn();
  },
  explode(x: number, y: number, radius: number): void {
    if (!world) return;
    world.explode(x, y, radius);
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
          // Read input from SAB
          const ib = inputBuf!;
          const if32 = inputF32!;
          const input = {
            left: ib[INPUT.LEFT / 4] !== 0,
            right: ib[INPUT.RIGHT / 4] !== 0,
            up: ib[INPUT.UP / 4] !== 0,
            down: ib[INPUT.DOWN / 4] !== 0,
            jump: ib[INPUT.JUMP / 4] !== 0,
            mouseDown: ib[INPUT.MOUSE_DOWN / 4] !== 0,
            mouseX: if32[INPUT.MOUSE_X / 4],
            mouseY: if32[INPUT.MOUSE_Y / 4],
            digRadius: ib[INPUT.DIG_RADIUS / 4],
          };

          const collected = world.step(input, currentInventory);
          tickCount++;

          // Write active grid + fields to SAB
          writer.writeGrid(world.activeGrid.grid);
          writer.writeFields(world.activeGrid.fields);

          // Write player state
          writer.writePlayerF32(PLAYER.PX, world.player.x);
          writer.writePlayerF32(PLAYER.PY, world.player.y);
          writer.writePlayerF32(PLAYER.VX, world.player.vx);
          writer.writePlayerF32(PLAYER.VY, world.player.vy);
          writer.writePlayerI32(PLAYER.ON_GROUND, world.player.onGround ? 1 : 0);
          writer.writePlayerI32(PLAYER.FACING, world.player.facing);
          writer.writePlayerI32(PLAYER.ANIM_FRAME, world.player.animFrame);
          writer.writePlayerI32(PLAYER.HEALTH, world.player.health);
          writer.writePlayerI32(PLAYER.DEATH_CAUSE, world.player.lastDamageMaterial ?? 0);

          // Write stats
          writer.writeStat(STATS.FRAME, frameCount);
          writer.writeStat(STATS.TICK, tickCount);
          writer.writeStat(STATS.FPS, fps);
          writer.writeStat(STATS.LOADED_CHUNKS, world.getLoadedChunkCount());
          writer.writeStat(STATS.ORIGIN_X, world.getActiveOriginX());
          writer.writeStat(STATS.ORIGIN_Y, world.getActiveOriginY());

          // Store collected items for the renderer to read (via a separate channel)
          // For now, we'll emit an event with the collected items
          if (collected.length > 0) {
            events.emit("collected", collected);
          }

          steps++;
          tickAccumulator -= 1;
        }
        stepOnce = false;
      }
    }

    frameCount++;
    fpsTimer += elapsed;
    if (fpsTimer >= 1000) {
      fps = Math.round((frameCount * 1000) / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
    }

    setTimeout(loop, 0);
  } catch (e) {
    console.error("[mining-worker] Loop error:", e);
    setTimeout(loop, 0);
  }
}
