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
    BLOCK_AIR,
    BLOCK_DIRT,
    BLOCK_GRASS,
    BLOCK_SAPLING,
    SURFACE_Y, TICK_RATE, WORLD_W
} from "../shared/constants";
import { getWildCropByBlock, isCropBlock, isWildCropBlock } from "../shared/crops";
import { decodeDropItem, encodeDropItem } from "../shared/drop-registry";
import { Inventory } from "../shared/inventory";
import { getItemDef, getItemForBlock } from "../shared/items";
import { pseudoRandom } from "../shared/pseudo-random";
import { getRecipe, recipesForStation, type CraftStation } from "../shared/recipes";
import {
    MAX_DROPS as SAB_MAX_DROPS,
    SimBufferWriter,
} from "../shared/sim-buffer";
import { getStationByBlock, getStationByType } from "../shared/stations";
import { getSpeciesIndex, isLeafBlock, isTreeBlock, isWoodBlock, pickTreeSpecies } from "../shared/tree-species";
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
import { deleteSave, loadAllChunks, saveDirtyChunks } from "./chunk-storage";
import { clearCropTracking, recordCropPlant, recordWildHarvest, stepCropGrowth } from "./crop-growth";
import { initFluidSim, stepFluidSim } from "./fluid-sim";
import { recomputeLight } from "./light-sim";
import { getSeason } from "./season-system";
import { createTask, executeTask, invalidatePath, type Task, type TaskType } from "./task-queue";
import { fellTree } from "./tree-fell";
import { forceFruitSpawnTick, packSaplingVfx, stepTreeDaily } from "./tree-sim";
import { stepVineGrowth } from "./vine-sim";

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
let lastSaveTime = 0;
let autoSaveInFlight = false; // guards against overlapping auto-saves
const SAVE_INTERVAL_MS = 5000; // save dirty chunks every 5 seconds
let speedMultiplier = 1;
let stepOnce = false;

// --- Light recompute (event-driven, not per-tick) ---
// Set to true whenever the grid changes (block edit, emitter change, active
// grid rebuild) or the daylight level changes. The recompute runs once per
// frame at most, only when something actually changed.
// `lastLightDaylight` tracks the smooth (unrounded) daylight value used for
// the last recompute, so the light field transitions continuously instead of
// stepping through 16 integer levels.
let lightDirty = true;
let lastLightDaylight = -1;

// --- Tree life-cycle (daily) ---
// Tracks the last in-game day the tree sim ran, so stepTreeDaily runs once
// per day (18000 ticks). Reset to -1 on active grid rebuild so the sim runs
// on the first day tick after a rebuild.
let lastTreeDay = -1;

const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;

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

// --- Station state (fuel + craft queue, persisted in chunk vfx) ---
interface CraftJob {
  id: number;
  recipeId: string;
  bhIndex: number;
  elapsed: number;     // seconds
  status: "pending" | "working" | "done" | "aborted";
}

interface StationState {
  fuel: number;        // 0-10 (current fuel slots filled)
  fuelFraction: number; // 0-1 (partial fuel slot, for smooth depletion)
  queue: CraftJob[];
  activeJob: CraftJob | null;
}

const stationStates = new Map<string, StationState>(); // key = "ax,ay"
let nextJobId = 1;

// VFX packing for station state persistence:
// Bits 0-7:   fuel level (0-10)
// Bits 8-15:  activeJob recipeId index (0=none, 1+=index into recipe table)
// Bits 16-23: activeJob elapsed seconds (0-255, capped)
// Bits 24-31: queue length (0-8)
const VFX_FUEL_MASK = 0xFF;
const VFX_FUEL_SHIFT = 0;
const VFX_RECIPE_SHIFT = 8;
const VFX_ELAPSED_SHIFT = 16;
const VFX_QUEUE_LEN_SHIFT = 24;

function stationKey(ax: number, ay: number): string {
  return `${ax},${ay}`;
}

// --- Drop entities (world drops that spin + can be picked up) ---
// DropEntity is used for both regular world drops (mining products) and tree
// life-cycle entities (fruits + seeds). Tree fruits/seeds use kind=1/2 and
// are managed by stepTreeDaily (age-based, not lifetime-based). They render
// as spinning 2D quads via DropPass, just like regular drops.
interface DropEntity {
  x: number;       // active grid X (float, sub-block)
  y: number;       // active grid Y (float)
  vx: number;      // velocity X (blocks/tick)
  vy: number;      // velocity Y (blocks/tick)
  spin: number;    // current rotation angle (radians)
  spinSpeed: number; // radians per second
  itemCode: number;  // encoded item ID (from drop-registry)
  count: number;     // stack size
  lifetime: number;  // seconds remaining before despawn (regular drops only)
  onGround: boolean;
  // Tree life-cycle fields (kind > 0):
  kind: number;      // 0 = normal drop, 1 = fruit, 2 = seed
  speciesIdx: number; // species index (for seeds → sapling planting)
  age: number;       // age in days (incremented by stepTreeDaily)
  fallen: boolean;   // false = on tree, true = falling/on ground
}

const drops: DropEntity[] = [];
const MAX_DROPS = 512;
const DROP_LIFETIME = 120; // 2 minutes before despawn
const DROP_GRAVITY = 0.03;
const DROP_MAX_FALL = 1.5;
const DROP_FRICTION = 0.8;
const PICKUP_RADIUS = 1.2; // blocks from blockhead center
const PICKUP_DELAY = 0.5;  // seconds before a fresh drop can be picked up

// --- Pickup notification accumulator ---
// Pickups are recorded here each tick, then flushed once per frame as a
// single "pickups" event to the host (see the per-frame flush in the loop).
// Batching per-frame (not per-tick) collapses bursts (e.g. mining a vein)
// into one tiny event regardless of how many ticks ran.
const tickPickups = new Map<string, number>();
function recordPickup(itemId: string, count: number): void {
  if (count <= 0 || !itemId) return;
  tickPickups.set(itemId, (tickPickups.get(itemId) ?? 0) + count);
}

/** Spawn a drop entity at the given active-grid position with a small random pop velocity. */
function spawnDrop(gx: number, gy: number, itemId: string, count: number = 1): void {
  if (drops.length >= MAX_DROPS) {
    // Drop limit reached — merge into inventory directly as fallback.
    // Overflow is discarded (no ground drop possible).
    const inv = inventories[0];
    if (inv) {
      const added = count - inv.add(itemId, count);
      if (added > 0) recordPickup(itemId, added);
    }
    return;
  }
  const code = encodeDropItem(itemId);
  if (code === 0) {
    // Unknown item — add to inventory directly. Overflow is discarded.
    const inv = inventories[0];
    if (inv) {
      const added = count - inv.add(itemId, count);
      if (added > 0) recordPickup(itemId, added);
    }
    return;
  }
  // Pop velocity: slight upward + horizontal spread (deterministic from position)
  const angle = pseudoRandom(gx | 0, gy | 0, tickCount, "drop-angle") * Math.PI * 2;
  const speed = 0.05 + pseudoRandom(gx | 0, gy | 0, tickCount, "drop-speed") * 0.08;
  drops.push({
    x: gx + 0.5,
    y: gy + 0.5,
    vx: Math.cos(angle) * speed,
    vy: -Math.abs(Math.sin(angle) * speed) - 0.08, // always pops upward
    spin: pseudoRandom(gx | 0, gy | 0, tickCount, "drop-spin") * Math.PI * 2,
    spinSpeed: 2 + pseudoRandom(gx | 0, gy | 0, tickCount, "drop-spinspeed") * 3,
    itemCode: code,
    count,
    lifetime: DROP_LIFETIME,
    onGround: false,
    kind: 0, speciesIdx: 0, age: 0, fallen: false,
  });
}

/** Update drop physics + check pickup by the blockhead. Called each tick. */
function updateDrops(dt: number): void {
  if (!world) return;
  const bh = blockheads[0];
  const bhCx = bh ? bh.x + BH_W * 0.5 : -999;
  const bhCy = bh ? bh.y + BH_H * 0.5 : -999;
  const inv = inventories[0];

  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];

    // Tree fruits/seeds: skip lifetime-based despawn (managed by stepTreeDaily)
    if (d.kind === 0) {
      d.lifetime -= dt;
      if (d.lifetime <= 0) {
        drops.splice(i, 1);
        continue;
      }
    }

    // Tree fruits/seeds that haven't fallen yet are stationary on the tree.
    // They hang motionless (no physics) until stepTreeDaily sets fallen=true.
    // Without this, the ground-collision check below would find no solid
    // foreground block (trees are in the background), set onGround=false, and
    // the fruit would immediately fall through the world.
    if (d.kind > 0 && !d.fallen) {
      d.spin += d.spinSpeed * dt;
      // Pickup: fruits (kind=1) and seeds (kind=2) are pick-uppable by
      // proximity while on the tree (no pickup delay).
      if (bh && inv && (d.kind === 1 || d.kind === 2)) {
        const dx = d.x - bhCx;
        const dy = d.y - bhCy;
        if (dx * dx + dy * dy < PICKUP_RADIUS * PICKUP_RADIUS) {
          const itemId = decodeDropItem(d.itemCode);
          if (itemId) {
            const overflow = inv.add(itemId, d.count);
            const pickedUp = d.count - overflow;
            if (pickedUp > 0) recordPickup(itemId, pickedUp);
            if (overflow > 0) {
              // Inventory full — keep the remainder in the drop on the ground.
              d.count = overflow;
            } else {
              drops.splice(i, 1);
            }
          }
          else drops.splice(i, 1);
        }
      }
      continue; // skip physics entirely
    }

    // Physics: gravity + collision with solid foreground blocks
    if (!d.onGround) {
      d.vy += DROP_GRAVITY;
      if (d.vy > DROP_MAX_FALL) d.vy = DROP_MAX_FALL;
    } else {
      d.vy = 0;
    }

    // Horizontal movement with friction
    d.x += d.vx;
    d.vx *= DROP_FRICTION;
    if (Math.abs(d.vx) < 0.001) d.vx = 0;

    // Vertical movement + ground collision
    const newY = d.y + d.vy;
    // Check if the cell below the drop's new position is solid
    const checkX = Math.floor(d.x);
    const checkY = Math.floor(newY + 0.3); // check slightly below center
    if (checkX >= 0 && checkX < ACTIVE_GRID_W && checkY >= 0 && checkY < ACTIVE_GRID_H) {
      const blockId = world.activeForeground[checkY * ACTIVE_GRID_W + checkX] & 0xFF;
      const def = getBlockDef(blockId);
      if (def && def.category === "solid") {
        // Land on top of the block
        d.y = checkY - 0.5;
        d.vy = 0;
        d.onGround = true;
      } else {
        d.y = newY;
        d.onGround = false;
      }
    } else {
      d.y = newY;
      d.onGround = false;
    }

    // Keep drop in bounds
    if (d.x < 0) { d.x = 0; d.vx = Math.abs(d.vx); }
    if (d.x >= ACTIVE_GRID_W) { d.x = ACTIVE_GRID_W - 0.01; d.vx = -Math.abs(d.vx); }
    if (d.y < 0) { d.y = 0; d.vy = 0; d.onGround = true; }
    if (d.y >= ACTIVE_GRID_H) { d.y = ACTIVE_GRID_H - 0.01; d.vy = 0; }

    // Spin
    d.spin += d.spinSpeed * dt;

    // Pickup: fruits (kind=1) and seeds (kind=2) are pick-uppable by
    // proximity (no pickup delay). Regular drops (kind=0) use the pickup delay.
    if (bh && inv) {
      const canPickup = d.kind === 1 || d.kind === 2 || d.lifetime < DROP_LIFETIME - PICKUP_DELAY;
      if (canPickup) {
        const dx = d.x - bhCx;
        const dy = d.y - bhCy;
        if (dx * dx + dy * dy < PICKUP_RADIUS * PICKUP_RADIUS) {
          // Decode item and add to inventory
          const itemId = decodeDropItem(d.itemCode);
          if (itemId) {
            const overflow = inv.add(itemId, d.count);
            const pickedUp = d.count - overflow;
            if (pickedUp > 0) recordPickup(itemId, pickedUp);
            if (overflow > 0) {
              // Inventory full — keep the remainder in the drop on the ground.
              d.count = overflow;
            } else {
              drops.splice(i, 1);
            }
          }
          else drops.splice(i, 1);
        }
      }
    }
  }
}

/** Write drop entities to the SAB for the renderer. */
function writeDropsToSab(): void {
  if (!writer) return;
  // The SAB has a fixed-size drop region (SAB_MAX_DROPS = 512). The worker
  // can hold up to 512 drops, all of which fit in the SAB.
  const count = Math.min(drops.length, SAB_MAX_DROPS);
  const data = new Float32Array(SAB_MAX_DROPS * 8);
  for (let i = 0; i < count; i++) {
    const d = drops[i];
    const off = i * 8;
    data[off + 0] = d.x;
    data[off + 1] = d.y;
    data[off + 2] = d.vx;
    data[off + 3] = d.vy;
    data[off + 4] = d.spin;
    data[off + 5] = d.spinSpeed;
    data[off + 6] = d.itemCode;
    data[off + 7] = d.lifetime;
  }
  writer.writeDrops(data, count);
}

function getOrCreateStationState(ax: number, ay: number): StationState | null {
  if (!world) return null;
  const blockId = world.getActiveBlock(ax, ay) & 0xFF;
  const def = getBlockDef(blockId);
  if (!def || !def.isStation) return null;
  const key = stationKey(ax, ay);
  let state = stationStates.get(key);
  if (!state) {
    // Try to restore from vfx
    const packed = world.getActiveVfx(ax, ay);
    state = {
      fuel: packed & VFX_FUEL_MASK,
      fuelFraction: 0,
      queue: [],
      activeJob: null,
    };
    stationStates.set(key, state);
  }
  return state;
}

function packStationState(state: StationState, ax: number, ay: number): void {
  if (!world) return;
  const fuel = Math.min(255, Math.round(state.fuel));
  const recipeIdx = state.activeJob ? 1 : 0; // simplified: just flag active
  const elapsed = state.activeJob ? Math.min(255, Math.round(state.activeJob.elapsed)) : 0;
  const queueLen = Math.min(255, state.queue.length);
  const packed =
    (fuel << VFX_FUEL_SHIFT) |
    (recipeIdx << VFX_RECIPE_SHIFT) |
    (elapsed << VFX_ELAPSED_SHIFT) |
    (queueLen << VFX_QUEUE_LEN_SHIFT);
  world.setActiveVfx(ax, ay, packed);
}

/** Find a station of the given type adjacent to the blockhead. */
function findAdjacentStation(bh: BlockheadState, station: CraftStation): { x: number; y: number } | null {
  if (!world) return null;
  const stationDef = getStationByType(station);
  if (!stationDef) return null;
  const bhCx = Math.floor(bh.x + BH_W / 2);
  const bhCy = Math.floor(bh.y + BH_H / 2);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ax = bhCx + dx;
      const ay = bhCy + dy;
      if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) continue;
      if ((world.getActiveBlock(ax, ay) & 0xFF) === stationDef.blockId) {
        return { x: ax, y: ay };
      }
    }
  }
  return null;
}

/** Check if a cell has support (adjacent solid or background backwall). */
function hasSupport(ax: number, ay: number): boolean {
  if (!world) return false;
  // Check adjacent cells for solid blocks
  const neighbors = [
    [ax - 1, ay], [ax + 1, ay], [ax, ay - 1], [ax, ay + 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || nx >= ACTIVE_GRID_W || ny < 0 || ny >= ACTIVE_GRID_H) continue;
    const blockId = world.getActiveBlock(nx, ny) & 0xFF;
    const def = getBlockDef(blockId);
    if (def && def.category === "solid") return true;
  }
  // Check for backwall behind
  const bg = world.getActiveBackground(ax, ay) & 0xFF;
  if (bg !== BLOCK_AIR) {
    const def = getBlockDef(bg);
    if (def && (def.category === "backwall" || def.category === "solid")) return true;
  }
  return false;
}

/** Step all stations: deplete fuel, advance active craft, start queued crafts. */
function stepStations(dt: number): void {
  if (!world) return;
  for (const [key, state] of stationStates) {
    const [axStr, ayStr] = key.split(",");
    const ax = parseInt(axStr, 10);
    const ay = parseInt(ayStr, 10);
    // Verify station still exists
    const blockId = world.getActiveBlock(ax, ay) & 0xFF;
    const def = getBlockDef(blockId);
    if (!def || !def.isStation) {
      stationStates.delete(key);
      continue;
    }
    const stationDef = getStationByBlock(blockId);
    if (!stationDef) continue;

    // Advance active job
    if (state.activeJob) {
      const recipe = getRecipe(state.activeJob.recipeId);
      if (!recipe) {
        state.activeJob.status = "aborted";
        state.activeJob = null;
        continue;
      }
      // Check fuel for fueled stations
      if (stationDef.fueled && state.fuel <= 0 && state.fuelFraction <= 0) {
        // No fuel — pause (no progress)
        state.activeJob.status = "pending"; // waiting for fuel
        continue;
      }
      state.activeJob.status = "working";
      state.activeJob.elapsed += dt;

      // Deplete fuel for fueled stations
      if (stationDef.fueled) {
        state.fuelFraction -= dt / stationDef.fuelBurnTime;
        while (state.fuelFraction <= 0 && state.fuel > 0) {
          state.fuel--;
          state.fuelFraction += 1;
        }
        if (state.fuel < 0) state.fuel = 0;
      }

      // Check completion
      if (state.activeJob.elapsed >= recipe.craftTime) {
        // Add outputs to the blockhead's inventory; overflow drops at the station.
        const inv = inventories[state.activeJob.bhIndex];
        if (inv) {
          for (const out of recipe.outputs) {
            const overflow = inv.add(out.itemId, out.count);
            if (overflow > 0) spawnDrop(ax, ay, out.itemId, overflow);
          }
        }
        state.activeJob.status = "done";
        state.activeJob = null;
      }
    }

    // Start next queued job if no active job
    if (!state.activeJob && state.queue.length > 0) {
      const job = state.queue.shift()!;
      const recipe = getRecipe(job.recipeId);
      if (!recipe) {
        job.status = "aborted";
        continue;
      }
      const inv = inventories[job.bhIndex];
      if (!inv) {
        job.status = "aborted";
        continue;
      }
      // Validate ingredients (consume on job start)
      if (!inv.hasIngredients(recipe.inputs)) {
        job.status = "aborted";
        continue;
      }
      inv.applyRecipe(recipe);
      job.status = "working";
      job.elapsed = 0;
      state.activeJob = job;
    }

    // Persist state to vfx
    packStationState(state, ax, ay);
  }
}

/**
 * Set up a fresh world + blockhead + inventory.
 *
 * Called from `init` (first boot, optionally loading saved chunks from OPFS)
 * and from `resetGame` (wipe everything, no saved chunks).
 *
 * Assumes `writer` / `inputInt32` / `inputF32` are already initialised.
 * Resets all per-game state (blockheads, inventories, task queues, station
 * states, mining damage, tick/frame counters, light dirty flag).
 */
async function setupWorld(loadSavedChunks: boolean): Promise<void> {
  // Create the world with a fixed seed for now (will be configurable later)
  const seed = 99999;
  world = new BlockWorld(seed);

  if (loadSavedChunks) {
    // Load saved chunks from OPFS (restores mining/placing changes)
    const savedChunks = await loadAllChunks();
    if (savedChunks.size > 0) {
      world.savedChunks = savedChunks;
      console.log(`[blockheads-worker] Loaded ${savedChunks.size} saved chunks from OPFS`);
    }
  }

  // Initial focus at world center, surface level
  world.setFocus(WORLD_W / 2, SURFACE_Y);
  world.checkRebuild();
  world.rebuildActiveGrid();
  // Mark light dirty so the first frame computes the initial light field.
  lightDirty = true;

  // Initialize fluid simulation
  initFluidSim(world.activeForeground);

  // Reset all per-game state
  blockheads = [];
  inventories = [];
  input = createDefaultInput();
  mineDamage.clear();
  mineTarget = null;
  mineCooldown = 0;
  taskQueues.length = 0;
  stationStates.clear();
  drops.length = 0;
  nextJobId = 1;
  tickCount = 0;
  frameCount = 0;
  speedMultiplier = 1;
  lastLightDaylight = -1;
  lastTreeDay = -1;

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
        if (isTreeBlock(blockId)) continue;
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
}

expose({
  async init(sab: SharedArrayBuffer): Promise<void> {
    sabRef = sab;
    writer = new SimBufferWriter(sab);
    inputInt32 = writer.inputInt32;
    inputF32 = writer.inputF32;

    await setupWorld(true);

    running = true;
    paused = false;
    lastTick = performance.now();
    events.emit("ready", {});
    loop();
  },

  /**
   * Reset the whole game: delete the OPFS save, re-create the world from
   * scratch (no saved chunks), reset the blockhead + inventory + task queues,
   * and write fresh state to the SAB. The render loop keeps running.
   */
  async resetGame(): Promise<{ ok: boolean; error?: string }> {
    // Pause the sim while we tear down + rebuild
    const wasRunning = running;
    paused = true;

    // Delete the OPFS save so the next boot starts fresh too
    try {
      await deleteSave();
    } catch (e) {
      console.warn("[blockheads-worker] resetGame: deleteSave failed:", e);
      // Continue anyway — we can still reset the in-memory state
    }

    // Rebuild the world from scratch (no saved chunks)
    try {
      await setupWorld(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[blockheads-worker] resetGame: setupWorld failed:", e);
      return { ok: false, error: msg };
    }

    // Resume
    running = wasRunning;
    paused = false;
    lastTick = performance.now();
    tickAccumulator = 0;
    return { ok: true };
  },

  pause(): void {
    paused = true;
  },
  resume(): void {
    paused = false;
    lastTick = performance.now();
    tickAccumulator = 0;
  },
  async shutdown(): Promise<void> {
    // Save dirty chunks before shutting down
    if (world) {
      world.syncActiveForSave();
      await saveDirtyChunks(world.allChunks());
    }
    running = false;
  },
  async saveNow(): Promise<number> {
    if (!world) return 0;
    world.syncActiveForSave();
    return saveDirtyChunks(world.allChunks());
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

  // Debug: force a fruit spawn tick (F7 keybind). Rolls the fruit-spawn dice
  // for all fruit-capable leaf blocks immediately, without waiting for the
  // daily tick. Returns the number of fruit drops spawned.
  forceFruitSpawn(): number {
    if (!world) return 0;
    const spawned = forceFruitSpawnTick(
      world.activeBackground, tickCount,
      ACTIVE_GRID_W, ACTIVE_GRID_H, drops,
    );
    // Write drops to SAB immediately so they appear even if the sim loop
    // hasn't ticked yet (e.g. paused or between frames).
    writeDropsToSab();
    return spawned;
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
  getInventory(bhIndex: number = 0): ({ itemId: string; count: number } | null)[] {
    const inv = inventories[bhIndex];
    return inv ? inv.snapshot() : new Array(54).fill(null);
  },

  craft(recipeId: string, stationAx: number = -1, stationAy: number = -1, bhIndex: number = 0): { ok: boolean; error?: string; jobId?: number } {
    const recipe = getRecipe(recipeId);
    if (!recipe) return { ok: false, error: `Unknown recipe: ${recipeId}` };
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false, error: "No inventory for that blockhead" };

    // Hand recipes: instant craft (backward compatibility)
    if (recipe.station === "hand") {
      if (!inv.hasIngredients(recipe.inputs)) {
        return { ok: false, error: "Insufficient ingredients" };
      }
      // Drop overflow at the blockhead's position.
      const bh = blockheads[bhIndex];
      const bx = bh ? Math.floor(bh.x + BH_W * 0.5) : 0;
      const by = bh ? Math.floor(bh.y + BH_H * 0.5) : 0;
      inv.applyRecipe(recipe, (itemId, count) => spawnDrop(bx, by, itemId, count));
      return { ok: true };
    }

    // Station recipes: find the station and queue the craft
    if (!world) return { ok: false, error: "World not initialized" };

    // If station coords provided, use them; otherwise search for adjacent station
    let ax = stationAx;
    let ay = stationAy;
    if (ax < 0 || ay < 0) {
      const bh = blockheads[bhIndex];
      if (!bh) return { ok: false, error: "No blockhead" };
      const found = findAdjacentStation(bh, recipe.station);
      if (!found) return { ok: false, error: `No ${recipe.station} nearby` };
      ax = found.x;
      ay = found.y;
    }

    // Verify station block at coords
    const blockId = world.getActiveBlock(ax, ay) & 0xFF;
    const def = getBlockDef(blockId);
    if (!def || !def.isStation) {
      return { ok: false, error: "No station at that location" };
    }
    const stationDef = getStationByBlock(blockId);
    if (!stationDef || stationDef.station !== recipe.station) {
      return { ok: false, error: `Wrong station type for recipe` };
    }

    // Verify blockhead adjacency to the station
    const bh = blockheads[bhIndex];
    if (bh) {
      const bhCx = Math.floor(bh.x + BH_W / 2);
      const bhCy = Math.floor(bh.y + BH_H / 2);
      const distX = Math.abs(ax - bhCx);
      const distY = Math.abs(ay - bhCy);
      if (distX > 2 || distY > 2) {
        return { ok: false, error: "Blockhead not adjacent to station" };
      }
    }

    // Check fuel for fueled stations
    const state = getOrCreateStationState(ax, ay);
    if (!state) return { ok: false, error: "Failed to get station state" };
    if (stationDef.fueled && state.fuel <= 0 && state.fuelFraction <= 0) {
      return { ok: false, error: "Station needs fuel" };
    }

    // Check ingredients (don't consume yet — consumed on job start)
    if (!inv.hasIngredients(recipe.inputs)) {
      return { ok: false, error: "Insufficient ingredients" };
    }

    // Queue the job
    const job: CraftJob = {
      id: nextJobId++,
      recipeId,
      bhIndex,
      elapsed: 0,
      status: "pending",
    };
    state.queue.push(job);
    packStationState(state, ax, ay);
    return { ok: true, jobId: job.id };
  },

  getRecipes(station?: CraftStation): { id: string; name: string; station: CraftStation }[] {
    const list = station ? recipesForStation(station) : recipesForStation("hand");
    return list.map((r) => ({ id: r.id, name: r.name, station: r.station }));
  },

  // Get the craft queue + fuel state for a station
  getCraftQueue(stationAx: number, stationAy: number): {
    fuel: number;
    activeJob: { id: number; recipeId: string; recipeName: string; progress: number; elapsed: number; craftTime: number; bhIndex: number; status: string } | null;
    queue: { id: number; recipeId: string; recipeName: string; bhIndex: number; status: string }[];
  } {
    if (!world) return { fuel: 0, activeJob: null, queue: [] };
    const state = getOrCreateStationState(stationAx, stationAy);
    if (!state) return { fuel: 0, activeJob: null, queue: [] };
    const activeJob = state.activeJob ? (() => {
      const r = getRecipe(state.activeJob!.recipeId);
      return {
        id: state.activeJob!.id,
        recipeId: state.activeJob!.recipeId,
        recipeName: r?.name ?? state.activeJob!.recipeId,
        progress: r ? Math.min(1, state.activeJob!.elapsed / r.craftTime) : 0,
        elapsed: state.activeJob!.elapsed,
        craftTime: r?.craftTime ?? 0,
        bhIndex: state.activeJob!.bhIndex,
        status: state.activeJob!.status,
      };
    })() : null;
    const queue = state.queue.map((j) => {
      const r = getRecipe(j.recipeId);
      return {
        id: j.id,
        recipeId: j.recipeId,
        recipeName: r?.name ?? j.recipeId,
        bhIndex: j.bhIndex,
        status: j.status,
      };
    });
    return { fuel: state.fuel, activeJob, queue };
  },

  // Add fuel to a station
  addFuel(stationAx: number, stationAy: number, itemId: string, count: number = 1, bhIndex: number = 0): { ok: boolean; error?: string } {
    if (!world) return { ok: false, error: "World not initialized" };
    const blockId = world.getActiveBlock(stationAx, stationAy) & 0xFF;
    const def = getBlockDef(blockId);
    if (!def || !def.isStation) return { ok: false, error: "No station at that location" };
    const stationDef = getStationByBlock(blockId);
    if (!stationDef || !stationDef.fueled) return { ok: false, error: "That station doesn't use fuel" };

    const itemDef = getItemDef(itemId);
    if (!itemDef) return { ok: false, error: "Unknown item" };
    // Check fuel value — look up the block def for the item's placeBlock
    let fuelValue = 0;
    if (itemDef.placeBlock > 0) {
      const blockDef = getBlockDef(itemDef.placeBlock);
      fuelValue = blockDef?.fuelValue ?? 0;
    } else {
      // For material items like coal/charcoal, check if they have a known fuel value
      // via a lookup. For now, hardcode common fuel items.
      if (itemId === "coal") fuelValue = 5;
      else if (itemId === "charcoal") fuelValue = 3;
      else if (itemId === "stick") fuelValue = 1;
    }
    if (fuelValue <= 0) return { ok: false, error: "That item is not fuel" };
    if (!stationDef.acceptsFuel.includes(fuelValue)) {
      return { ok: false, error: "That fuel is not accepted by this station" };
    }

    const inv = inventories[bhIndex];
    if (!inv) return { ok: false, error: "No inventory" };
    if (!inv.remove(itemId, count)) return { ok: false, error: "Not enough items" };

    const state = getOrCreateStationState(stationAx, stationAy);
    if (!state) return { ok: false, error: "Failed to get station state" };
    state.fuel = Math.min(stationDef.fuelSlots, state.fuel + fuelValue * count);
    packStationState(state, stationAx, stationAy);
    return { ok: true };
  },

  // Rush a craft job with crystals
  rushCraft(stationAx: number, stationAy: number, jobId: number, bhIndex: number = 0): { ok: boolean; error?: string } {
    if (!world) return { ok: false, error: "World not initialized" };
    const state = getOrCreateStationState(stationAx, stationAy);
    if (!state) return { ok: false, error: "No station at that location" };
    const job = state.activeJob;
    if (!job || job.id !== jobId) {
      // Check queue
      const qIdx = state.queue.findIndex((j) => j.id === jobId);
      if (qIdx < 0) return { ok: false, error: "Job not found" };
      // Rush from queue: instantly complete (no time has elapsed)
      const recipe = getRecipe(state.queue[qIdx].recipeId);
      if (!recipe) return { ok: false, error: "Recipe not found" };
      const inv = inventories[state.queue[qIdx].bhIndex];
      if (!inv) return { ok: false, error: "No inventory" };
      if (!inv.hasIngredients(recipe.inputs)) {
        state.queue[qIdx].status = "aborted";
        state.queue.splice(qIdx, 1);
        return { ok: false, error: "Insufficient ingredients" };
      }
      inv.applyRecipe(recipe, (itemId, count) => spawnDrop(stationAx, stationAy, itemId, count));
      state.queue.splice(qIdx, 1);
      return { ok: true };
    }
    const recipe = getRecipe(job.recipeId);
    if (!recipe) return { ok: false, error: "Recipe not found" };
    const remaining = recipe.craftTime - job.elapsed;
    const cost = Math.max(1, Math.ceil(remaining / 20));
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false, error: "No inventory" };
    if (!inv.remove("crystal", cost)) return { ok: false, error: `Need ${cost} crystals to rush` };
    // Complete the job; overflow drops at the station.
    for (const out of recipe.outputs) {
      const overflow = inv.add(out.itemId, out.count);
      if (overflow > 0) spawnDrop(stationAx, stationAy, out.itemId, overflow);
    }
    job.status = "done";
    state.activeJob = null;
    packStationState(state, stationAx, stationAy);
    return { ok: true };
  },

  // Abort a craft job
  abortCraft(stationAx: number, stationAy: number, jobId: number): { ok: boolean } {
    if (!world) return { ok: false };
    const state = getOrCreateStationState(stationAx, stationAy);
    if (!state) return { ok: false };
    // Check active job
    if (state.activeJob && state.activeJob.id === jobId) {
      // Return unused ingredients (fuel already burned is lost)
      const recipe = getRecipe(state.activeJob.recipeId);
      if (recipe) {
        const inv = inventories[state.activeJob.bhIndex];
        if (inv) {
          for (const inp of recipe.inputs) {
            const overflow = inv.add(inp.itemId, inp.count);
            if (overflow > 0) spawnDrop(stationAx, stationAy, inp.itemId, overflow);
          }
        }
      }
      state.activeJob.status = "aborted";
      state.activeJob = null;
      packStationState(state, stationAx, stationAy);
      return { ok: true };
    }
    // Check queue
    const qIdx = state.queue.findIndex((j) => j.id === jobId);
    if (qIdx >= 0) {
      const job = state.queue[qIdx];
      // Ingredients haven't been consumed yet (consumed on job start)
      job.status = "aborted";
      state.queue.splice(qIdx, 1);
      packStationState(state, stationAx, stationAy);
      return { ok: true };
    }
    return { ok: false };
  },

  // Give an item (creative mode / testing). Overflow is discarded by design
  // (creative grants cap at maxStack). Returns the count actually added.
  giveItem(itemId: string, count: number = 1, bhIndex: number = 0): { ok: boolean; added: number } {
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false, added: 0 };
    const overflow = inv.add(itemId, count);
    return { ok: true, added: count - overflow };
  },

  // Move a stack from one slot to another (drag-and-drop in the UI).
  moveSlot(from: number, to: number, bhIndex: number = 0): { ok: boolean } {
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false };
    if (from < 0 || from >= inv.size || to < 0 || to >= inv.size) return { ok: false };
    inv.move(from, to);
    return { ok: true };
  },

  // Set inventory from a snapshot (used for save/load persistence).
  // Replaces the entire inventory for the given blockhead. Accepts both the
  // legacy {itemId,count}[] shape and the new (InventorySlot|null)[] shape.
  setInventory(slots: unknown, bhIndex: number = 0): { ok: boolean } {
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false };
    inv.loadSnapshot(slots);
    return { ok: true };
  },

  // --- Task queue ---
  queueTask(type: TaskType, opts: {
    targetX?: number; targetY?: number;
    blockId?: number;
    recipeId?: string;
    stationAx?: number; stationAy?: number;
    itemId?: string;
  }, bhIndex: number = 0): { ok: boolean; taskId: number; duplicate: boolean } {
    const queue = taskQueues[bhIndex];
    if (!queue) return { ok: false, taskId: -1, duplicate: false };
    // Limit queue size — reject new tasks if too many pending (don't pop old ones)
    const MAX_TASKS = 100;
    if (queue.length >= MAX_TASKS) {
      return { ok: false, taskId: -1, duplicate: false };
    }
    // Prevent duplicate tasks: same type + same target coords
    const tx = opts.targetX ?? 0;
    const ty = opts.targetY ?? 0;
    const isDuplicate = queue.some(
      (t) => t.type === type && t.targetX === tx && t.targetY === ty,
    );
    if (isDuplicate) {
      return { ok: false, taskId: -1, duplicate: true };
    }
    const task = createTask(type, opts);
    queue.push(task);
    return { ok: true, taskId: task.id, duplicate: false };
  },

  getTasks(bhIndex: number = 0): { id: number; type: TaskType; targetX: number; targetY: number; blockId: number; status: string; failReason?: string }[] {
    const queue = taskQueues[bhIndex];
    if (!queue) return [];
    return queue.map((t) => ({
      id: t.id, type: t.type, targetX: t.targetX, targetY: t.targetY,
      blockId: t.blockId ?? 0, status: t.status, failReason: t.failReason,
    }));
  },

  clearTasks(bhIndex: number = 0): { ok: boolean } {
    const queue = taskQueues[bhIndex];
    if (!queue) return { ok: false };
    queue.length = 0;
    return { ok: true };
  },

  cancelTask(type: TaskType, targetX: number, targetY: number, bhIndex: number = 0): { ok: boolean } {
    const queue = taskQueues[bhIndex];
    if (!queue) return { ok: false };
    const idx = queue.findIndex(
      (t) => t.type === type && t.targetX === targetX && t.targetY === targetY,
    );
    if (idx < 0) return { ok: false };
    queue.splice(idx, 1);
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
    writer.blockheads[off + 15] = bh.wallClimbing ? 1 : 0;
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
      // Tree felling: if the player mined a wood block in the background
      // (a tree trunk), cut down the entire tree — all connected wood +
      // leaf blocks in the background, plus any vines climbing the tree.
      // Wood blocks spawn spinning wood drops; leaf blocks have a 30%
      // chance to spawn a stick drop.
      if (miningBackground && isWoodBlock(target.blockId)) {
        const felled = fellTree(
          world.activeBackground, ACTIVE_GRID_W, ACTIVE_GRID_H,
          target.x, target.y,
        );
        for (const cell of felled) {
          const cellDef = getBlockDef(cell.blockId);
          if (!cellDef) continue;
          world.setActiveBackground(cell.x, cell.y, BLOCK_AIR);
          // Wood blocks → spawn wood drops (spinning world items)
          if (isWoodBlock(cell.blockId)) {
            spawnDrop(cell.x, cell.y, "wood", 1);
          }
          // Leaf blocks → 30% chance to spawn a stick drop
          if (isLeafBlock(cell.blockId)) {
            const stickRoll = pseudoRandom(cell.x, cell.y, tickCount, "stick-drop");
            if (stickRoll <= 0.3) {
              spawnDrop(cell.x, cell.y, "stick", 1);
            }
            // Fruit drops (species-specific) → also spawn as world drops
            for (const drop of cellDef.drops) {
              if (drop.itemId === "stick") continue; // already handled above
              const roll = pseudoRandom(cell.x, cell.y, tickCount, drop.itemId);
              if (roll <= drop.chance) {
                spawnDrop(cell.x, cell.y, drop.itemId, drop.count);
              }
            }
          }
          // Vine blocks → drop vine item
          if (!isWoodBlock(cell.blockId) && !isLeafBlock(cell.blockId)) {
            for (const drop of cellDef.drops) {
              const roll = pseudoRandom(cell.x, cell.y, tickCount, drop.itemId);
              if (roll <= drop.chance) {
                spawnDrop(cell.x, cell.y, drop.itemId, drop.count);
              }
            }
          }
        }

        // Remove fruit/seed drop entities at each felled tree cell.
        // Fruit and seeds on the tree → spawn as regular world drops so the
        // player can pick them up.
        for (const cell of felled) {
          for (let di = drops.length - 1; di >= 0; di--) {
            const d = drops[di];
            if (d.kind === 0) continue; // skip regular drops
            const dx = d.x - (cell.x + 0.5);
            const dy = d.y - (cell.y + 0.5);
            if (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.0) {
              if (d.kind === 1 || d.kind === 2) {
                // Fruit/seed → spawn as a regular drop so the player can pick it up
                const itemId = decodeDropItem(d.itemCode);
                if (itemId) spawnDrop(cell.x, cell.y, itemId, 1);
              }
              drops.splice(di, 1);
            }
          }
        }
        lightDirty = true;
        mineDamage.delete(key);
        mineTarget = null;
        // Stop mining — the whole tree is gone, no block to continue on.
        input.mineX = -1;
        input.mineY = -1;
        return;
      }

      if (miningBackground) {
        world.setActiveBackground(target.x, target.y, BLOCK_AIR);
      } else {
        world.setActiveBlock(target.x, target.y, BLOCK_AIR);
      }
      // Block removed → light field must be recomputed.
      lightDirty = true;

      // Wild crop harvested: record harvest info for regrow timer.
      if (isWildCropBlock(target.blockId)) {
        const wc = getWildCropByBlock(target.blockId);
        if (wc) {
          recordWildHarvest(target.x, target.y, world.currentTick, wc.blockId, wc.regrowTicks);
        }
      }
      // Leaf blocks mined individually: 30% chance to spawn a stick drop
      // (as a spinning world item), plus any fruit drops.
      if (isLeafBlock(target.blockId)) {
        const stickRoll = pseudoRandom(target.x, target.y, tickCount, "stick-drop");
        if (stickRoll <= 0.3) {
          spawnDrop(target.x, target.y, "stick", 1);
        }
        for (const drop of def.drops) {
          if (drop.itemId === "stick") continue; // handled above with 30% chance
          const roll = pseudoRandom(target.x, target.y, tickCount, drop.itemId);
          if (roll <= drop.chance) {
            spawnDrop(target.x, target.y, drop.itemId, drop.count);
          }
        }
      } else {
        // All other blocks: add drops directly to inventory (existing behavior)
        const inv = inventories[0];
        if (inv) {
          for (const drop of def.drops) {
            // Deterministic drop roll based on block coords + tick so e2e tests
            // are reproducible (no Math.random).
            const roll = pseudoRandom(target.x, target.y, tickCount, drop.itemId);
            if (roll <= drop.chance) {
              const overflow = inv.add(drop.itemId, drop.count);
              const pickedUp = drop.count - overflow;
              if (pickedUp > 0) recordPickup(drop.itemId, pickedUp);
              if (overflow > 0) spawnDrop(target.x, target.y, drop.itemId, overflow);
            }
          }
        }
      }
      mineDamage.delete(key);
      mineTarget = null;
      // Stop mining after breaking a foreground block — don't fall through
      // to the background on the next tick. The player must click again to
      // mine the background layer.
      if (!miningBackground) {
        input.mineX = -1;
        input.mineY = -1;
      }
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

  // --- Tree seed → plant a sapling in the BACKGROUND plane ---
  // Saplings are background blocks (like adult trees) with species + target
  // height encoded in the vfx plane. They require grass/dirt directly below
  // (in the foreground) and an empty background cell. A random species is
  // chosen (the source tree's species isn't preserved through the inventory).
  if (input.placeBlockId === BLOCK_SAPLING) {
    if (world.getActiveBackground(ax, ay) !== BLOCK_AIR) return;
    const below = ay + 1;
    if (below >= ACTIVE_GRID_H) return;
    const groundId = world.getActiveBlock(ax, below) & 0xFF;
    if (groundId !== BLOCK_GRASS && groundId !== BLOCK_DIRT) return;
    // Validate first, then consume the seed from inventory.
    const inv = inventories[0];
    if (!inv || !inv.remove("seed", 1)) return; // no seed → can't plant
    const species = pickTreeSpecies(pseudoRandom(ax, ay, tickCount, "plant-species"));
    const speciesIdx = getSpeciesIndex(species);
    const heightRoll = pseudoRandom(ax, ay, tickCount, "plant-saplingHeight");
    const targetH = species.trunkMin +
      Math.floor(heightRoll * (species.trunkMax - species.trunkMin + 1));
    world.setActiveBackground(ax, ay, BLOCK_SAPLING);
    world.setActiveVfx(ax, ay, packSaplingVfx(speciesIdx, targetH, 0, 0));
    lightDirty = true;
    return;
  }

  // Only place on empty cells
  if (world.getActiveBlock(ax, ay) !== BLOCK_AIR) return;

  // Station placement: require support (adjacent solid or backwall)
  const placeDef = getBlockDef(input.placeBlockId);
  if (placeDef?.isStation) {
    if (!hasSupport(ax, ay)) return;
  }

  // Consume the corresponding item from inventory (if a placeable block)
  const itemId = getItemForBlock(input.placeBlockId);
  const inv = inventories[0];
  if (itemId && inv) {
    if (!inv.remove(itemId, 1)) return; // no item → can't place
  }

  // Place the block
  world.setActiveBlock(ax, ay, input.placeBlockId);
  // Block added → light field must be recomputed.
  lightDirty = true;

  // If a seed/spore was planted, record the plant tick for crop growth timing.
  if (isCropBlock(input.placeBlockId)) {
    recordCropPlant(ax, ay, world.currentTick);
  }
}

// --- Process task effects (EAT, SLEEP) ---
// These task types don't generate movement input but have side effects.
function processTaskEffects(dt: number): void {
  for (let bi = 0; bi < taskQueues.length; bi++) {
    const queue = taskQueues[bi];
    if (!queue || queue.length === 0) continue;
    const task = queue[0];
    const bh = blockheads[bi];
    if (!bh) continue;

    if (task.type === "EAT" && task.status === "done") {
      // Consume food and restore hunger
      const itemDef = task.itemId ? getItemDef(task.itemId) : undefined;
      if (itemDef && itemDef.category === "food" && itemDef.hungerRestore) {
        const inv = inventories[bi];
        if (inv && inv.remove(task.itemId!, 1)) {
          bh.hunger = Math.min(100, bh.hunger + itemDef.hungerRestore);
        }
      }
      queue.shift();
    }

    if (task.type === "SLEEP" && task.status === "executing") {
      // Restore energy while sleeping
      bh.animState = "sleep";
      bh.energy = Math.min(100, bh.energy + 5 * dt);
      if (bh.energy >= 100) {
        task.status = "done";
        bh.animState = "idle";
        queue.shift();
      }
    }
  }
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
            // Handle CRAFT_AT task completion: queue the craft at the station
            if (task.type === "CRAFT_AT" && task.status === "done" && task.recipeId) {
              if (task.stationAx !== undefined && task.stationAy !== undefined) {
                // Queue the craft at the station (ingredients consumed on job start)
                const recipe = getRecipe(task.recipeId);
                if (recipe) {
                  const state = getOrCreateStationState(task.stationAx, task.stationAy);
                  if (state) {
                    const job: CraftJob = {
                      id: nextJobId++,
                      recipeId: task.recipeId,
                      bhIndex: 0,
                      elapsed: 0,
                      status: "pending",
                    };
                    state.queue.push(job);
                    packStationState(state, task.stationAx, task.stationAy);
                  }
                }
              }
              queue.shift();
            }
            // Remove completed/failed tasks from the front
            if (task.status === "done" || task.status === "failed") {
              queue.shift();
            }
            if (queue.length > 0) {
              const current = queue[0];
              const taskInput = executeTask(
                blockheads[0], current, world.activeForeground, world.activeBackground,
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
            // Clear station state cache (will be re-read from vfx on next access)
            stationStates.clear();
            // Clear crop tracking (ages are in active-grid coords, which shifted)
            clearCropTracking();
            // NOTE: do NOT reset lastTreeDay here. The tree daily sim is gated
            // by the actual in-game day number (currentDay !== lastTreeDay), so
            // it already runs exactly once per day. Resetting lastTreeDay to -1
            // on every chunk crossing would trigger a bonus daily tick that:
            //   1. Ages all existing fruit/seed drops by +1 (causing them to
            //      fall/despawn prematurely — "drop the ones already on trees")
            //   2. Spawns new fruit/seeds on newly-loaded leaves (which have no
            //      drops since drops aren't saved to chunks)
            // Sapling vfx (species + heights + days) IS saved to chunks, so
            // saplings grow naturally on the next real day boundary.
            // Invalidate all task path caches (grid shifted)
            for (const queue of taskQueues) {
              for (const task of queue) {
                invalidatePath(task);
              }
            }
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
            // Remap drop positions (fruits/seeds/drops) to new active grid coords
            for (let di = drops.length - 1; di >= 0; di--) {
              const d = drops[di];
              d.x = d.x - dx;
              d.y = d.y - dy;
              // Remove drops that are now out of bounds
              if (d.x < 0 || d.x >= ACTIVE_GRID_W || d.y < 0 || d.y >= ACTIVE_GRID_H) {
                drops.splice(di, 1);
              }
            }
            // Active grid rebuilt → light field must be recomputed.
            lightDirty = true;
          }

          // Step blockhead physics
          const dt = 1 / TICK_RATE;
          for (const bh of blockheads) {
            updateBlockhead(bh, input, world.activeForeground, world.activeBackground, dt);
          }

          // Process mining + placing
          processMining(dt);
          processPlacing();

          // Update world drops (physics + pickup by blockhead)
          updateDrops(dt);

          // Step stations (fuel depletion, craft queue advancement)
          stepStations(dt);

          // Process task effects (EAT, SLEEP)
          processTaskEffects(dt);

          // Update fog of war: mark cells near blockhead as explored
          updateExplored();

          // Step fluid simulation (CA water/lava flow)
          stepFluidSim(world.activeForeground, world.currentTick);

          // Step vine growth (vines climb trees/walls/trellis over time).
          // Runs every VINE_GROWTH_INTERVAL ticks; marks light dirty if any
          // vine extended into a new cell.
          if (stepVineGrowth(
            world.activeForeground, world.activeBackground,
            world.currentTick, ACTIVE_GRID_W, ACTIVE_GRID_H,
          )) {
            lightDirty = true;
          }

          // Step crop growth (crops advance through stages, mushrooms spread,
          // wild crops regrow, winter kills cold-sensitive crops).
          if (stepCropGrowth(
            world.activeForeground, world.activeBackground,
            world.activeLight, world.currentTick,
            getSeason(world.currentTick),
            ACTIVE_GRID_W, ACTIVE_GRID_H,
          )) {
            lightDirty = true;
          }

          // Day/night cycle: 10-minute day (18000 ticks at 30tps).
          // Daylight follows a sine wave: starts at noon (full daylight),
          // transitions to night, then back to day.
          // Light propagation is event-driven (not per-tick): mark the field
          // dirty when the smooth daylight changes so the light field
          // recomputes with continuous brightness (no integer stepping).
          const dayPhase = (tickCount % 18000) / 18000; // 0..1
          const daylightF = Math.sin(dayPhase * Math.PI * 2 + Math.PI / 2) * 0.5 + 0.5; // 0..1, starts at 1
          const daylightSmooth = daylightF * 15;
          const daylight = Math.round(daylightSmooth);
          if (Math.abs(daylightSmooth - lastLightDaylight) > 0.01) {
            lightDirty = true;
          }

          // Tree life-cycle: runs once per in-game day (18000 ticks).
          // Spawns fruit + seeds on leaves (as spinning 2D drop entities),
          // ages/falls/scatters them, and grows saplings (paused in winter).
          // Gated by lastTreeDay so it only runs once per day.
          const currentDay = Math.floor(tickCount / 18000);
          if (currentDay !== lastTreeDay) {
            lastTreeDay = currentDay;
            if (stepTreeDaily(
              world.activeForeground, world.activeBackground,
              world.activeVfx, tickCount, getSeason(world.currentTick),
              ACTIVE_GRID_W, ACTIVE_GRID_H,
              drops, world,
            )) {
              lightDirty = true;
            }
          }

          // Step the simulation tick
          world.currentTick++;

          tickCount++;
          steps++;
          tickAccumulator -= 1;
        }
        stepOnce = false;

        // Flush pickup notifications once per frame (batched across all ticks
        // that ran this frame). Emits a single tiny event regardless of how
        // many pickups occurred — keeps the worker→host channel quiet even
        // during a 500-block mining burst.
        if (tickPickups.size > 0) {
          events.emit("pickups", Object.fromEntries(tickPickups));
          tickPickups.clear();
        }

        // Write to SAB once per frame
        if (steps > 0 && world && writer) {
          // Compute current daylight for the header.
          // `daylight` is the integer 0-15 level used by the per-cell light
          // simulation (Minecraft-style light levels must be integers).
          // `daylightSmooth` is the unrounded 0-15 value written to the SAB
          // header so the sky pass can interpolate colors continuously
          // instead of snapping between 16 discrete states.
          const dayPhase = (tickCount % 18000) / 18000;
          const daylightF = Math.sin(dayPhase * Math.PI * 2 + Math.PI / 2) * 0.5 + 0.5;
          const daylightSmooth = daylightF * 15;
          const daylight = Math.round(daylightSmooth);

          // Recompute the light field if anything changed since last frame
          // (block edit, emitter change, active-grid rebuild, or daylight
          // change). Runs at most once per frame, only when dirty.
          // Uses the smooth (unrounded) daylight so sky-light brightness
          // transitions continuously instead of stepping through 16 levels.
          if (lightDirty) {
            recomputeLight(world.activeForeground, world.activeLight, daylightSmooth);
            lightDirty = false;
            lastLightDaylight = daylightSmooth;
          }

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
          writeDropsToSab();
          writer.writeHeader(
            tickCount,
            world.getActiveOriginCx(),
            world.getActiveOriginCy(),
            blockheads.length,
            daylightSmooth,
            mineX,
            mineY,
            mineDamageF,
            0, // selectedSlot (renderer-managed)
            Math.min(drops.length, SAB_MAX_DROPS),
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

    // Periodically save dirty chunks to OPFS.
    // Guard against overlapping saves: if the previous save hasn't finished
    // yet (OPFS can be slow), skip this cycle rather than risk two writes
    // racing — the last writer would win and could drop chunks the other
    // write had already persisted.
    if (world && !autoSaveInFlight && now - lastSaveTime >= SAVE_INTERVAL_MS) {
      lastSaveTime = now;
      autoSaveInFlight = true;
      // Sync the active grid back to chunks before saving — mining/placing/
      // fluid/light/explored all modify the active grid directly, and the
      // chunk arrays stay stale until a rebuild. Without this sync, saves
      // write pre-edit chunk data and changes are lost on reload.
      world.syncActiveForSave();
      saveDirtyChunks(world.allChunks())
        .catch((e) => {
          console.warn("[blockheads-worker] Auto-save failed:", e);
        })
        .finally(() => {
          autoSaveInFlight = false;
        });
    }

    setTimeout(loop, 0);
  } catch (e) {
    console.error("[blockheads-worker] Loop error:", e);
    setTimeout(loop, 0);
  }
}
