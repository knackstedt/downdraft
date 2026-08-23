// ============================================================================
// Blockheads sim worker — runs the BlockWorld simulation in a Web Worker.
//
// Each tick: rebuilds the active grid if needed, steps the simulation (blockhead
// physics, mining, placing, fluid sim, light propagation), and writes the active
// grid + blockhead state + stats back to the SAB.
// ============================================================================

import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_LEAVES, BLOCK_WOOD,
    SURFACE_Y, TICK_RATE, WORLD_W
} from "../shared/constants";
import { Inventory } from "../shared/inventory";
import { getItemForBlock } from "../shared/items";
import { getRecipe, recipesForStation, type CraftStation } from "../shared/recipes";
import {
    SimBufferWriter,
} from "../shared/sim-buffer";
import type { BlockheadState } from "../shared/types";
import {
    animStateToCode,
    BH_STRIDE
} from "../shared/types";
import { BlockWorld } from "./block-world";
import {
    BH_H, BH_W,
    createBlockhead, createDefaultInput, getMineTarget, updateBlockhead,
    type BlockheadInput
} from "./blockhead";
import { initFluidSim, stepFluidSim } from "./fluid-sim";
import { stepLightSim } from "./light-sim";
import { createTask, executeTask, type Task, type TaskType } from "./task-queue";

const events = exposeEvents();

let world: BlockWorld | null = null;
let writer: SimBufferWriter | null = null;
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

const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;

// --- Deterministic pseudo-random for drop rolls (no Math.random in sim) ---
function pseudoRandom(x: number, y: number, tick: number, salt: string): number {
  let h = 2166136261 ^ x;
  h = Math.imul(h, 16777619) ^ y;
  h = Math.imul(h, 16777619) ^ tick;
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h, 16777619) ^ salt.charCodeAt(i);
  }
  // Normalize to [0, 1)
  return ((h >>> 0) % 100000) / 100000;
}

// --- Blockhead state ---
let blockheads: BlockheadState[] = [];
let inventories: Inventory[] = [];
let input: BlockheadInput = createDefaultInput();
let inputInt32: Int32Array | null = null;
let inputF32: Float32Array | null = null;

// --- Mining state ---
// Per-cell damage tracking. Key = y * ACTIVE_GRID_W + x, value = damage accumulated.
const mineDamage = new Map<number, number>();
let mineTarget: { x: number; y: number; blockId: number } | null = null;
let mineCooldown = 0;

// --- Task queue (per-blockhead) ---
const taskQueues: Task[][] = [];

expose({
  async init(sab: SharedArrayBuffer): Promise<void> {
    sabRef = sab;
    writer = new SimBufferWriter(sab);
    inputInt32 = writer.inputInt32;
    inputF32 = writer.inputF32;

    // Create the world with a fixed seed for now (will be configurable later)
    const seed = 99999;
    world = new BlockWorld(seed);

    // Initial focus at world center, surface level
    world.setFocus(WORLD_W / 2, SURFACE_Y);
    world.checkRebuild();
    world.rebuildActiveGrid();

    // Initialize fluid simulation
    initFluidSim(world.activeForeground);

    // Create the first blockhead at the surface.
    // Scan X positions near the center to find a spawn point that:
    // 1. Has solid ground (not wood/leaves/water)
    // 2. Has clear space above the ground for the blockhead body (3 wide × 7 tall)
    let bhX = -1;
    let surfaceGridY = Math.floor(ACTIVE_GRID_H / 2) - 10; // fallback
    const centerX = Math.floor(ACTIVE_GRID_W / 2);
    // Search outward from center, trying each X position
    for (let offset = 0; offset < 80 && bhX < 0; offset++) {
      for (const x of [centerX + offset, centerX - offset]) {
        if (x < 2 || x > ACTIVE_GRID_W - 3) continue;
        // Find ground surface at this X (first solid non-tree block from top)
        let groundY = -1;
        for (let y = 0; y < ACTIVE_GRID_H; y++) {
          const blockId = world.activeForeground[y * ACTIVE_GRID_W + x] & 0xFF;
          if (blockId === BLOCK_AIR || blockId === 0) continue;
          const def = getBlockDef(blockId);
          if (!def || def.category !== "solid") continue;
          if (blockId === BLOCK_WOOD || blockId === BLOCK_LEAVES) continue;
          groundY = y;
          break;
        }
        if (groundY < 0) continue;
        // Check that the spawn area (x..x+BH_W-1, groundY-BH_H..groundY-1) is clear
        const spawnTop = groundY - BH_H;
        let clear = true;
        for (let cy = spawnTop; cy < groundY && clear; cy++) {
          if (cy < 0) { clear = false; break; }
          for (let cx = x; cx < x + BH_W && clear; cx++) {
            const blockId = world.activeForeground[cy * ACTIVE_GRID_W + cx] & 0xFF;
            const def = getBlockDef(blockId);
            if (def && def.category === "solid") {
              clear = false; // blocked by a solid block (tree, etc.)
            }
          }
        }
        if (clear) {
          bhX = x;
          surfaceGridY = spawnTop;
          break;
        }
      }
    }
    if (bhX < 0) {
      // Fallback: use center and hope for the best
      bhX = centerX;
      // Force-clear the spawn area by removing any solid blocks
      for (let cy = surfaceGridY; cy < surfaceGridY + BH_H; cy++) {
        if (cy < 0 || cy >= ACTIVE_GRID_H) continue;
        for (let cx = bhX; cx < bhX + BH_W; cx++) {
          if (cx < 0 || cx >= ACTIVE_GRID_W) continue;
          world.activeForeground[cy * ACTIVE_GRID_W + cx] = BLOCK_AIR;
        }
      }
    }
    const bh = createBlockhead(bhX, surfaceGridY);
    bh.id = 0;
    blockheads = [bh];

    // Starting inventory — a few torches + ladders so the player can light
    // underground and climb back out of shallow holes immediately.
    const inv = new Inventory();
    inv.add("torch", 8);
    inv.add("ladder", 8);
    inventories = [inv];
    taskQueues.length = 0;
    taskQueues.push([]);

    // Write initial SAB state so the renderer has valid data on the first frame
    if (world && writer) {
      writer.writeGrid(world);
      writeBlockheads();
      writer.writeHeader(
        0,
        world.getActiveOriginCx(),
        world.getActiveOriginCy(),
        blockheads.length,
        15, // full daylight at start
      );
    }

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
    tickAccumulator = 0;
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
    tickAccumulator = 0;
  },

  getStats(): { fps: number; tick: number; frame: number } {
    return { fps, tick: tickCount, frame: frameCount };
  },

  setFocus(x: number, y: number): void {
    if (!world) return;
    world.setFocus(x, y);
    world.checkRebuild();
  },

  setBlock(x: number, y: number, blockId: number): void {
    if (!world) return;
    world.setBlockAt(x, y, blockId);
  },

  getBlock(x: number, y: number): number {
    if (!world) return 0;
    return world.getBlockAt(x, y);
  },

  getWorldStats(): { loadedChunks: number; activeChunks: number; tick: number } {
    if (!world) return { loadedChunks: 0, activeChunks: 0, tick: 0 };
    const stats = world.getStats();
    return {
      loadedChunks: stats.loadedChunks,
      activeChunks: stats.activeChunks,
      tick: stats.tick,
    };
  },

  // --- Inventory + crafting ---
  getInventory(bhIndex: number = 0): { itemId: string; count: number }[] {
    const inv = inventories[bhIndex];
    return inv ? inv.snapshot() : [];
  },

  craft(recipeId: string, bhIndex: number = 0): { ok: boolean; error?: string } {
    const recipe = getRecipe(recipeId);
    if (!recipe) return { ok: false, error: `Unknown recipe: ${recipeId}` };
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false, error: "No inventory for that blockhead" };
    // Station check: for now, "hand" recipes always work; workbench/furnace
    // require the blockhead to be adjacent to the station block. We don't have
    // station blocks in the registry yet, so allow hand recipes only.
    if (recipe.station !== "hand") {
      return { ok: false, error: `Recipe requires a ${recipe.station} (not yet implemented)` };
    }
    if (!inv.hasIngredients(recipe.inputs)) {
      return { ok: false, error: "Insufficient ingredients" };
    }
    inv.applyRecipe(recipe);
    return { ok: true };
  },

  getRecipes(station?: CraftStation): { id: string; name: string; station: CraftStation }[] {
    const list = station ? recipesForStation(station) : recipesForStation("hand");
    return list.map((r) => ({ id: r.id, name: r.name, station: r.station }));
  },

  // Give an item (creative mode / testing). Bypasses inventory limits.
  giveItem(itemId: string, count: number = 1, bhIndex: number = 0): { ok: boolean } {
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false };
    inv.add(itemId, count);
    return { ok: true };
  },

  // --- Task queue ---
  queueTask(type: TaskType, targetX: number, targetY: number, blockId: number = 0, bhIndex: number = 0): { ok: boolean; taskId: number } {
    const queue = taskQueues[bhIndex];
    if (!queue) return { ok: false, taskId: -1 };
    const task = createTask(type, targetX, targetY, blockId);
    queue.push(task);
    return { ok: true, taskId: task.id };
  },

  getTasks(bhIndex: number = 0): { id: number; type: TaskType; targetX: number; targetY: number; blockId: number; status: string }[] {
    const queue = taskQueues[bhIndex];
    if (!queue) return [];
    return queue.map((t) => ({
      id: t.id, type: t.type, targetX: t.targetX, targetY: t.targetY,
      blockId: t.blockId ?? 0, status: t.status,
    }));
  },

  clearTasks(bhIndex: number = 0): { ok: boolean } {
    const queue = taskQueues[bhIndex];
    if (!queue) return { ok: false };
    queue.length = 0;
    return { ok: true };
  },
});

// --- Read input from SAB ---
function readInput(): void {
  if (!inputInt32 || !inputF32) return;
  input.left = inputInt32[0] !== 0;
  input.right = inputInt32[1] !== 0;
  input.up = inputInt32[2] !== 0;
  input.down = inputInt32[3] !== 0;
  input.jump = inputInt32[4] !== 0;
  input.noclip = inputInt32[5] !== 0;
  const mineActive = inputInt32[6] !== 0;
  const placeActive = inputInt32[7] !== 0;
  input.mineX = mineActive ? inputF32[8] : -1;
  input.mineY = mineActive ? inputF32[9] : -1;
  input.placeX = placeActive ? inputF32[10] : -1;
  input.placeY = placeActive ? inputF32[11] : -1;
  input.placeBlockId = inputInt32[12];
}

// --- Write blockhead state to SAB ---
function writeBlockheads(): void {
  if (!writer) return;
  const count = Math.min(blockheads.length, 32);
  for (let i = 0; i < count; i++) {
    const bh = blockheads[i];
    const off = i * BH_STRIDE;
    writer.blockheads[off + 0] = bh.x;
    writer.blockheads[off + 1] = bh.y;
    writer.blockheads[off + 2] = bh.vx;
    writer.blockheads[off + 3] = bh.vy;
    writer.blockheads[off + 4] = bh.facing;
    writer.blockheads[off + 5] = bh.onGround ? 1 : 0;
    writer.blockheads[off + 6] = bh.animTime * 8; // animFrame
    writer.blockheads[off + 7] = bh.health;
    writer.blockheads[off + 8] = bh.hunger;
    writer.blockheads[off + 9] = bh.energy;
    writer.blockheads[off + 10] = bh.air;
    writer.blockheads[off + 11] = bh.happiness;
    writer.blockheads[off + 12] = bh.environment;
    writer.blockheads[off + 13] = animStateToCode(bh.animState);
    writer.blockheads[off + 14] = bh.id;
    writer.blockheads[off + 15] = 0; // pad
  }
}

// --- Process mining ---
function processMining(dt: number): void {
  if (!world) return;
  const bh = blockheads[0];
  if (!bh) return;

  if (input.mineX < 0 || input.mineY < 0) {
    mineTarget = null;
    mineDamage.clear();
    return;
  }

  // Convert world mouse coords to active grid coords
  const ax = input.mineX - world.getActiveOriginCx() * 64;
  const ay = input.mineY - world.getActiveOriginCy() * 64;

  // Auto-target: if there's a foreground block at the click position, mine it.
  // If the foreground is air but there's a background block, mine the background.
  // This lets the player click on what they see — no manual layer toggle needed.
  const fgTarget = getMineTarget(bh, ax, ay, world.activeForeground);
  const bgTarget = getMineTarget(bh, ax, ay, world.activeBackground);
  const target = fgTarget ?? bgTarget;
  const miningBackground = !fgTarget && !!bgTarget;

  if (!target) {
    mineTarget = null;
    return;
  }

  // If target changed, reset damage
  if (!mineTarget || mineTarget.x !== target.x || mineTarget.y !== target.y) {
    mineTarget = target;
    mineDamage.clear();
  }

  // Apply mining damage
  mineCooldown -= dt;
  if (mineCooldown <= 0) {
    const def = getBlockDef(target.blockId);
    if (!def) return;
    const hardness = Math.max(1, def.hardness);
    const key = target.y * ACTIVE_GRID_W + target.x;
    const dmg = (mineDamage.get(key) ?? 0) + 1;
    mineDamage.set(key, dmg);
    mineCooldown = 0.1; // 10 hits per second

    // Set anim state to dig
    bh.animState = "dig";

    // When damage exceeds hardness, break the block
    if (dmg >= hardness) {
      if (miningBackground) {
        world.setActiveBackground(target.x, target.y, BLOCK_AIR);
      } else {
        world.setActiveBlock(target.x, target.y, BLOCK_AIR);
      }
      // Add drops to the blockhead's inventory
      const inv = inventories[0];
      if (inv) {
        for (const drop of def.drops) {
          // Deterministic drop roll based on block coords + tick so e2e tests
          // are reproducible (no Math.random).
          const roll = pseudoRandom(target.x, target.y, tickCount, drop.itemId);
          if (roll <= drop.chance) {
            inv.add(drop.itemId, drop.count);
          }
        }
      }
      mineDamage.delete(key);
      mineTarget = null;
    }
  }
}

// --- Process placing ---
function processPlacing(): void {
  if (!world) return;
  const bh = blockheads[0];
  if (!bh) return;

  if (input.placeX < 0 || input.placeY < 0) return;
  if (input.placeBlockId === BLOCK_AIR) return;

  // Convert world mouse coords to active grid coords
  const ax = Math.floor(input.placeX - world.getActiveOriginCx() * 64);
  const ay = Math.floor(input.placeY - world.getActiveOriginCy() * 64);

  if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return;

  // Don't place on a cell occupied by the blockhead
  const bhX0 = Math.floor(bh.x);
  const bhX1 = Math.floor(bh.x + BH_W - 0.001);
  const bhY0 = Math.floor(bh.y);
  const bhY1 = Math.floor(bh.y + BH_H - 0.001);
  if (ax >= bhX0 && ax <= bhX1 && ay >= bhY0 && ay <= bhY1) return;

  // Only place on empty cells
  if (world.getActiveBlock(ax, ay) !== BLOCK_AIR) return;

  // Consume the corresponding item from inventory (if a placeable block)
  const itemId = getItemForBlock(input.placeBlockId);
  const inv = inventories[0];
  if (itemId && inv) {
    if (!inv.remove(itemId, 1)) return; // no item → can't place
  }

  // Place the block
  world.setActiveBlock(ax, ay, input.placeBlockId);
}

// --- Update focus to follow the blockhead ---
// --- Update fog of war: mark cells near blockhead as explored ---
function updateExplored(): void {
  if (!world) return;
  const bh = blockheads[0];
  if (!bh) return;
  const cx = Math.floor(bh.x + BH_W * 0.5);
  const cy = Math.floor(bh.y + BH_H * 0.5);
  const RADIUS = 120; // explore 120-block radius around blockhead (wide visibility)
  const RADIUS_SQ = RADIUS * RADIUS;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (dx * dx + dy * dy > RADIUS_SQ) continue;
      const ax = cx + dx;
      const ay = cy + dy;
      if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) continue;
      world.activeExplored[ay * ACTIVE_GRID_W + ax] = 1;
    }
  }
}

function updateFocus(): void {
  if (!world || blockheads.length === 0) return;
  const bh = blockheads[0];
  // Convert active grid coords back to world coords
  const wx = bh.x + world.getActiveOriginCx() * 64;
  const wy = bh.y + world.getActiveOriginCy() * 64;
  world.setFocus(wx, wy);
}

async function loop(): Promise<void> {
  if (!running) return;

  try {
    const now = performance.now();
    const elapsed = now - lastTick;

    if (elapsed >= TICK_MS) {
      lastTick = now - (elapsed % TICK_MS);

      if (!paused || stepOnce) {
        tickAccumulator += (elapsed / TICK_MS) * speedMultiplier;
        let steps = 0;
        const maxSteps = stepOnce ? 1 : MAX_STEPS_PER_FRAME;

        while (tickAccumulator >= 1 && steps < maxSteps) {
          if (!world) break;

          // Read input from SAB (direct control)
          readInput();

          // If the task queue has an active task, override input with the
          // task's synthetic input (autonomous blockhead execution).
          const queue = taskQueues[0];
          if (queue && queue.length > 0) {
            const task = queue[0];
            // Remove completed/failed tasks from the front
            if (task.status === "done" || task.status === "failed") {
              queue.shift();
            }
            if (queue.length > 0) {
              const current = queue[0];
              const taskInput = executeTask(
                blockheads[0], current, world.activeForeground,
                world.getActiveOriginCx(), world.getActiveOriginCy(),
                1 / TICK_RATE,
              );
              if (taskInput) {
                // Override direct input with task input
                input.left = taskInput.left;
                input.right = taskInput.right;
                input.up = taskInput.up;
                input.down = taskInput.down;
                input.jump = taskInput.jump;
                input.noclip = false; // never noclip during tasks
                input.mineX = taskInput.mineX;
                input.mineY = taskInput.mineY;
                input.placeX = taskInput.placeX;
                input.placeY = taskInput.placeY;
                input.placeBlockId = taskInput.placeBlockId;
              }
              // If executeTask returned null but task isn't done/failed,
              // it means "use direct input" (e.g. MOVE_TO arrived). The task
              // status was set to done, so it'll be shifted next tick.
              if (current.status === "done" || current.status === "failed") {
                queue.shift();
              }
            }
          }

          // Rebuild active grid if the focus has crossed a chunk boundary
          updateFocus();
          world.checkRebuild();
          if (world.needsRebuild) {
            // Save old origin before rebuild changes it
            const oldOriginCx = world.getActiveOriginCx();
            const oldOriginCy = world.getActiveOriginCy();
            world.rebuildActiveGrid();
            // Re-initialize fluid sim for the new active grid
            initFluidSim(world.activeForeground);
            // Remap blockhead position from old active grid coords to new ones.
            // The world shifted by (newOrigin - oldOrigin) * CHUNK_W blocks.
            const dx = (world.getActiveOriginCx() - oldOriginCx) * 64;
            const dy = (world.getActiveOriginCy() - oldOriginCy) * 64;
            for (const bh of blockheads) {
              bh.x = bh.x - dx;
              bh.y = bh.y - dy;
              // Clamp to valid range
              bh.x = Math.max(0, Math.min(ACTIVE_GRID_W - BH_W, bh.x));
              bh.y = Math.max(0, Math.min(ACTIVE_GRID_H - BH_H, bh.y));
            }
          }

          // Step blockhead physics
          const dt = 1 / TICK_RATE;
          for (const bh of blockheads) {
            updateBlockhead(bh, input, world.activeForeground, dt);
          }

          // Process mining + placing
          processMining(dt);
          processPlacing();

          // Update fog of war: mark cells near blockhead as explored
          updateExplored();

          // Step fluid simulation (CA water/lava flow)
          stepFluidSim(world.activeForeground, world.currentTick);

          // Step light propagation (daylight + emitters)
          // Day/night cycle: 10-minute day (18000 ticks at 30tps).
          // Daylight follows a sine wave: starts at noon (full daylight),
          // transitions to night, then back to day.
          const dayPhase = (tickCount % 18000) / 18000; // 0..1
          const daylightF = Math.sin(dayPhase * Math.PI * 2 + Math.PI / 2) * 0.5 + 0.5; // 0..1, starts at 1
          const daylight = Math.round(daylightF * 15);
          stepLightSim(world.activeForeground, world.activeLight, daylight);

          // Step the simulation tick
          world.currentTick++;

          tickCount++;
          steps++;
          tickAccumulator -= 1;
        }
        stepOnce = false;

        // Write to SAB once per frame
        if (steps > 0 && world && writer) {
          // Compute current daylight for the header
          const dayPhase = (tickCount % 18000) / 18000;
          const daylightF = Math.sin(dayPhase * Math.PI * 2 + Math.PI / 2) * 0.5 + 0.5;
          const daylight = Math.round(daylightF * 15);

          // Compute mining VFX data for the header
          let mineX = -1, mineY = -1, mineDamageF = 0;
          if (mineTarget) {
            mineX = mineTarget.x;
            mineY = mineTarget.y;
            const key = mineTarget.y * ACTIVE_GRID_W + mineTarget.x;
            const dmg = mineDamage.get(key) ?? 0;
            const def = getBlockDef(mineTarget.blockId);
            const hardness = def ? Math.max(1, def.hardness) : 1;
            mineDamageF = Math.min(1, dmg / hardness);
          }

          writer.writeGrid(world);
          writeBlockheads();
          writer.writeHeader(
            tickCount,
            world.getActiveOriginCx(),
            world.getActiveOriginCy(),
            blockheads.length,
            daylight,
            mineX,
            mineY,
            mineDamageF,
          );
        }
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
    console.error("[blockheads-worker] Loop error:", e);
    setTimeout(loop, 0);
  }
}
