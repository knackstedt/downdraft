// ============================================================================
// Mining worker — runs the ChunkWorld simulation in a Web Worker.
//
// Each tick: reads input from the shared SAB, runs ChunkWorld.step, writes the
// active grid + player state + stats back to the SAB.
// ============================================================================

import { createSimWorker, exposeEvents } from "@downdraft/core";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, INPUT, INPUT_OFFSET, OXYGEN_MAX_TICKS, PLAYER, STATS, TICK_RATE, type BuildMaterialType } from "../shared/constants";
import { MiningSimBufferWriter, OFFSETS } from "../shared/sim-buffer";
import type { BuildMaterials, InventoryEntry, MiningPlayerState, PlayerUpgrades } from "../shared/types";
import { ChunkWorld, type SavedChunk } from "./chunk-world";
import { applyMaterialOverrides } from "./material-overrides";

const events = exposeEvents();

let world: ChunkWorld | null = null;
let writer: MiningSimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
let inputBuf: Int32Array | null = null;
let inputF32: Float32Array | null = null;
let currentInventory: InventoryEntry[] = [];
// Last buildMaterials snapshot emitted to the renderer — emit only on change.
let lastEmittedBuild: BuildMaterials = { scaffolding: 0, ladder: 0, rope: 0, torch: 0 };
// Collected items batched across all ticks in a frame.
let anyCollected: InventoryEntry[] = [];

createSimWorker({
  fixedDt: 1 / TICK_RATE,
  maxStepsPerFrame: 5,
  startPaused: true, // Start PAUSED — renderer resumes after loading save data.

  async onInit(sab: SharedArrayBuffer, _control): Promise<void> {
    sabRef = sab;
    writer = new MiningSimBufferWriter(sab, OFFSETS, ACTIVE_GRID_W, ACTIVE_GRID_H);
    inputBuf = new Int32Array(sab, INPUT_OFFSET, 128 / 4);
    inputF32 = new Float32Array(sab, INPUT_OFFSET, 128 / 4);

    // Apply mining-game material overrides before creating the world.
    applyMaterialOverrides();

    // Multi-threaded sand step: spawn N sand-step workers (nested workers).
    const sandWorkers = Math.min(4, Math.max(0, (navigator.hardwareConcurrency || 4) - 2));
    world = new ChunkWorld(sandWorkers);
    await world.initSandStepPool();
  },

  async onTick(_dt: number, _ctx): Promise<void> {
    if (!world || !writer || !inputBuf || !inputF32) return;

    // Read input from SAB
    const ib = inputBuf;
    const if32 = inputF32;
    const input = {
      left: ib[INPUT.LEFT / 4] !== 0,
      right: ib[INPUT.RIGHT / 4] !== 0,
      up: ib[INPUT.UP / 4] !== 0,
      down: ib[INPUT.DOWN / 4] !== 0,
      jump: ib[INPUT.JUMP / 4] !== 0,
      noclip: ib[INPUT.NOCLIP / 4] !== 0,
      mouseDown: ib[INPUT.MOUSE_DOWN / 4] !== 0,
      mouseX: if32[INPUT.MOUSE_X / 4],
      mouseY: if32[INPUT.MOUSE_Y / 4],
      digRadius: ib[INPUT.DIG_RADIUS / 4],
      buildMode: ib[INPUT.BUILD_MODE / 4] !== 0,
      buildMat: ib[INPUT.BUILD_MAT / 4],
    };

    const collected = await world.step(input, currentInventory);
    if (collected.length > 0) {
      for (const c of collected) anyCollected.push(c);
    }

    // Emit buildMaterials to the renderer when counts change.
    const bm = world.buildMaterials;
    if (bm.scaffolding !== lastEmittedBuild.scaffolding ||
        bm.ladder !== lastEmittedBuild.ladder ||
        bm.rope !== lastEmittedBuild.rope ||
        bm.torch !== lastEmittedBuild.torch) {
      lastEmittedBuild = { ...bm };
      events.emit("buildMaterials", { ...bm });
    }
  },

  onAfterTicks(ctx): void {
    if (!world || !writer) return;

    // --- SAB writes: once per frame (after all steps), not per step ---
    writer.writeGrid(world.activeGrid.grid);
    writer.writeFields(world.activeGrid.fields);
    writer.writeBackgroundGrid(world.backgroundGrid);
    writer.writeExploredGrid(world.getExploredGrid());
    writer.writeLightRegion(world.getLightCount(), world.getLightList());

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
    writer.writePlayerI32(PLAYER.OXYGEN, world.player.oxygen ?? OXYGEN_MAX_TICKS);

    // Write stats
    writer.writeStat(STATS.FRAME, ctx.frameCount);
    writer.writeStat(STATS.TICK, ctx.tickCount);
    writer.writeStat(STATS.FPS, ctx.fps);
    writer.writeStat(STATS.LOADED_CHUNKS, world.getLoadedChunkCount());
    writer.writeStat(STATS.ORIGIN_X, world.getActiveOriginX());
    writer.writeStat(STATS.ORIGIN_Y, world.getActiveOriginY());

    // Emit collected items (batched across all steps this frame)
    if (anyCollected.length > 0) {
      events.emit("collected", anyCollected);
      anyCollected = [];
    }
  },

  onShutdown(): void {
    world = null;
    writer = null;
    sabRef = null;
    inputBuf = null;
    inputF32 = null;
  },

  extraApi: {
    // --- Save / Load ---

    getSaveData(): {
      player: MiningPlayerState;
      upgrades: PlayerUpgrades;
      buildMaterials: BuildMaterials;
      dirtyChunks: SavedChunk[];
      tick: number;
    } {
      if (!world) return { player: { x: 0, y: 0, vx: 0, vy: 0, onGround: false, facing: 1, animFrame: 0, health: 100, lastDamageMaterial: 0, oxygen: OXYGEN_MAX_TICKS }, upgrades: { damage: 0, radius: 0, rate: 0, inventorySize: 0 }, buildMaterials: { scaffolding: 0, ladder: 0, rope: 0, torch: 0 }, dirtyChunks: [], tick: 0 };
      return {
        player: { ...world.player },
        upgrades: { ...world.upgrades },
        buildMaterials: { ...world.buildMaterials },
        dirtyChunks: world.getDirtyChunks(),
        tick: world.currentTick,
      };
    },

    loadSaveData(data: { player: MiningPlayerState; upgrades?: PlayerUpgrades; buildMaterials?: BuildMaterials; chunks: SavedChunk[]; tick: number }): void {
      if (!world) return;
      // Restore chunks first (before player state, since setPlayerState forces rebuild)
      for (const chunk of data.chunks) {
        world.restoreChunk(chunk);
      }
      // Restore player state
      world.setPlayerState(data.player);
      // Restore upgrades
      if (data.upgrades) world.setUpgrades(data.upgrades);
      // Restore build materials
      if (data.buildMaterials) {
        world.buildMaterials = { ...data.buildMaterials };
        lastEmittedBuild = { ...data.buildMaterials };
      }
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

    addBuildMaterial(type: BuildMaterialType, qty: number): void {
      if (!world) return;
      world.addBuildMaterial(type, qty);
    },

    respawn(): void {
      if (!world) return;
      world.respawn();
    },
    explode(x: number, y: number, radius: number): void {
      if (!world) return;
      world.explode(x, y, radius);
    },
    /** Apply damage to the player from external sources (e.g. enemies). */
    damagePlayer(amount: number, cause: number): void {
      if (!world) return;
      world.player.health = Math.max(0, world.player.health - amount);
      world.player.lastDamageMaterial = cause;
    },
    /** Place a torch via raycast from the player toward the target world coords. */
    placeTorch(targetX: number, targetY: number): boolean {
      if (!world) return false;
      return world.placeTorchRaycast(targetX, targetY);
    },
  },
});
