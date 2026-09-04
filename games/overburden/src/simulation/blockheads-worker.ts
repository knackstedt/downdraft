// ============================================================================
// Blockheads sim worker — runs the BlockWorld simulation in a Web Worker.
//
// Each tick: rebuilds the active grid if needed, steps the simulation (blockhead
// physics, mining, placing, fluid sim, light propagation), and writes the active
// grid + blockhead state + stats back to the SAB.
// ============================================================================

import { createSimWorker, type SimWorkerControl } from "@downdraft/core";
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
import { encodeMapRegion, getMapSabViews } from "../shared/map-buffer";
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
    BH_STRIDE,
    MAX_BLOCKHEADS,
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
import { PathfindingBroker } from "./pathfinding-broker";
import { getSeason } from "./season-system";
import { createTask, executeTask, invalidatePath, setPathBroker, type Task, type TaskType } from "./task-queue";
import { fellTree } from "./tree-fell";
import { forceFruitSpawnTick, packSaplingVfx, stepTreeDaily } from "./tree-sim";
import { stepVineGrowth } from "./vine-sim";

let simEvents: { emit: (kind: string, data?: any) => void } | null = null;
let simControl: SimWorkerControl | null = null;

let world: BlockWorld | null = null;
let writer: SimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
// Map SAB — shared with the pixi-ui worker for streaming per-block map data.
// The renderer posts this via a __mapSab message; getMapRegion writes into it.
let mapSab: SharedArrayBuffer | null = null;
// Dedicated pather worker broker — offloads A* pathfinding to a separate
// thread (not the sim thread, not the renderer thread). Constructed in onInit
// once the SAB is available; disposed in onShutdown.
let pathBroker: PathfindingBroker | null = null;
let tickCount = 0; // synced from ctx.tickCount in onTick (for helper functions)

// --- Pather port listener ---
// The renderer spawns the dedicated pather worker (Vite can only bundle
// workers spawned from the renderer, not nested workers). It creates a
// MessageChannel, sends one port to the pather worker and the other here.
// We use addEventListener (not onmessage) so this coexists with the
// expose() handler that createSimWorker() installs.
self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { __patherPort?: boolean; __mapSab?: boolean } | undefined;
  if (data?.__patherPort) {
    const port = e.ports[0];
    if (!port || !pathBroker) return;
    pathBroker.attachPort(port);
    return;
  }
  if (data?.__mapSab) {
    mapSab = e.data.sab as SharedArrayBuffer;
    return;
  }
});
let lastSaveTime = 0;
let autoSaveInFlight = false; // guards against overlapping auto-saves
const SAVE_INTERVAL_MS = 5000; // save dirty chunks every 5 seconds

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

// --- Blockhead state ---
let blockheads: BlockheadState[] = [];
let inventories: Inventory[] = [];
let input: BlockheadInput = createDefaultInput();
let inputInt32: Int32Array | null = null;
let inputF32: Float32Array | null = null;
// Index of the directly-controlled blockhead (WASD/mouse). Read from the SAB
// input region each tick; clamped to alive blockheads. Non-active blockheads
// are task-queue-only (their direct input is idle).
let activeBhIndex = 0;
// Per-blockhead gender (cosmetic, renderer-side; worker stores it for roster
// persistence). Keyed by blockhead id.
const bhGenders: Map<number, string> = new Map();
// Next unique blockhead id (incremented on spawn).
let nextBhId = 1;

// --- Mining state (per-blockhead) ---
// Per-cell damage tracking. Key = y * ACTIVE_GRID_W + x, value = damage accumulated.
// Each blockhead has its own damage map + target + cooldown.
interface MineState {
  damage: Map<number, number>;
  target: { x: number; y: number; blockId: number } | null;
  cooldown: number;
}
let mineStates: MineState[] = [];
// Legacy single-target aliases for the SAB header (reports the active BH's mining).
function activeMineState(): MineState {
  return mineStates[activeBhIndex] ?? (mineStates[activeBhIndex] = { damage: new Map(), target: null, cooldown: 0 });
}

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
    // Drop limit reached — merge into the active blockhead's inventory as fallback.
    const inv = inventories[activeBhIndex] ?? inventories[0];
    if (inv) {
      const added = count - inv.add(itemId, count);
      if (added > 0) recordPickup(itemId, added);
    }
    return;
  }
  const code = encodeDropItem(itemId);
  if (code === 0) {
    // Unknown item — add to the active blockhead's inventory. Overflow is discarded.
    const inv = inventories[activeBhIndex] ?? inventories[0];
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

  // Find the nearest blockhead to a drop position (for pickup attribution).
  // Returns { bi, distSq } or null if no blockheads.
  const findNearestBh = (dx: number, dy: number): { bi: number; distSq: number } | null => {
    let best: { bi: number; distSq: number } | null = null;
    for (let bi = 0; bi < blockheads.length; bi++) {
      const bh = blockheads[bi];
      const cx = bh.x + BH_W * 0.5;
      const cy = bh.y + BH_H * 0.5;
      const ddx = dx - cx;
      const ddy = dy - cy;
      const distSq = ddx * ddx + ddy * ddy;
      if (!best || distSq < best.distSq) best = { bi, distSq };
    }
    return best;
  };

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
    if (d.kind > 0 && !d.fallen) {
      d.spin += d.spinSpeed * dt;
      // Pickup by nearest blockhead (no pickup delay for fruits/seeds).
      if (d.kind === 1 || d.kind === 2) {
        const nearest = findNearestBh(d.x, d.y);
        if (nearest && nearest.distSq < PICKUP_RADIUS * PICKUP_RADIUS) {
          const inv = inventories[nearest.bi];
          if (inv) {
            const itemId = decodeDropItem(d.itemCode);
            if (itemId) {
              const overflow = inv.add(itemId, d.count);
              const pickedUp = d.count - overflow;
              if (pickedUp > 0) recordPickup(itemId, pickedUp);
              if (overflow > 0) {
                d.count = overflow;
              } else {
                drops.splice(i, 1);
              }
            } else {
              drops.splice(i, 1);
            }
          }
        }
      }
      continue;
    }

    // Physics: gravity + collision with solid foreground blocks
    if (!d.onGround) {
      d.vy += DROP_GRAVITY;
      if (d.vy > DROP_MAX_FALL) d.vy = DROP_MAX_FALL;
    } else {
      d.vy = 0;
    }

    d.x += d.vx;
    d.vx *= DROP_FRICTION;
    if (Math.abs(d.vx) < 0.001) d.vx = 0;

    const newY = d.y + d.vy;
    const checkX = Math.floor(d.x);
    const checkY = Math.floor(newY + 0.3);
    if (checkX >= 0 && checkX < ACTIVE_GRID_W && checkY >= 0 && checkY < ACTIVE_GRID_H) {
      const blockId = world.activeForeground[checkY * ACTIVE_GRID_W + checkX] & 0xFF;
      const def = getBlockDef(blockId);
      if (def && def.category === "solid") {
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

    if (d.x < 0) { d.x = 0; d.vx = Math.abs(d.vx); }
    if (d.x >= ACTIVE_GRID_W) { d.x = ACTIVE_GRID_W - 0.01; d.vx = -Math.abs(d.vx); }
    if (d.y < 0) { d.y = 0; d.vy = 0; d.onGround = true; }
    if (d.y >= ACTIVE_GRID_H) { d.y = ACTIVE_GRID_H - 0.01; d.vy = 0; }

    d.spin += d.spinSpeed * dt;

    // Pickup by nearest blockhead.
    const canPickup = d.kind === 1 || d.kind === 2 || d.lifetime < DROP_LIFETIME - PICKUP_DELAY;
    if (canPickup) {
      const nearest = findNearestBh(d.x, d.y);
      if (nearest && nearest.distSq < PICKUP_RADIUS * PICKUP_RADIUS) {
        const inv = inventories[nearest.bi];
        if (inv) {
          const itemId = decodeDropItem(d.itemCode);
          if (itemId) {
            const overflow = inv.add(itemId, d.count);
            const pickedUp = d.count - overflow;
            if (pickedUp > 0) recordPickup(itemId, pickedUp);
            if (overflow > 0) {
              d.count = overflow;
            } else {
              drops.splice(i, 1);
            }
          } else {
            drops.splice(i, 1);
          }
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
  mineStates = [];
  activeBhIndex = 0;
  nextBhId = 1;
  bhGenders.clear();
  taskQueues.length = 0;
  stationStates.clear();
  drops.length = 0;
  nextJobId = 1;
  tickCount = 0;
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
  bhGenders.set(0, "male");

  // Starting inventory — a few torches + ladders so the player can light
  // underground and climb back out of shallow holes immediately.
  const inv = new Inventory();
  inv.add("torch", 8);
  inv.add("ladder", 8);
  inventories = [inv];
  taskQueues.length = 0;
  taskQueues.push([]);
  mineStates = [{ damage: new Map(), target: null, cooldown: 0 }];

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

simControl = createSimWorker({
  fixedDt: 1 / TICK_RATE,
  maxStepsPerFrame: 5,

  async onInit(sab: SharedArrayBuffer, control: SimWorkerControl): Promise<void> {
    sabRef = sab;
    writer = new SimBufferWriter(sab);
    inputInt32 = writer.inputInt32;
    inputF32 = writer.inputF32;

    simEvents = control.events;
    simControl = control;

    // Create the pathfinding broker in degraded (sync) mode. The renderer
    // will spawn the dedicated pather worker, create a MessageChannel, and
    // transfer one port to this worker. When the port arrives (via the
    // __patherPort listener below), the broker switches to async mode.
    pathBroker = new PathfindingBroker(sab);
    setPathBroker(pathBroker);

    await setupWorld(true);
  },

  // SAB polyfill: declare buffer sync regions (worker side).
  // The worker writes everything except the INPUT region; the main thread
  // writes the INPUT region. The BufferSyncWorker posts written regions to
  // the main thread after each tick batch. See buffer-sync.ts.
  onSyncConfig(sab: SharedArrayBuffer): BufferSyncConfig {
    // INPUT is the last region in the SAB (128 bytes).
    const inputOffset = sab.byteLength - 128;
    return {
      buffers: { sim: sab },
      regions: {
        sim: {
          // Worker writes: everything except the input region
          writeRegions: [
            { offset: 0, length: inputOffset, name: "sim-data" },
          ],
          // Main thread writes: input region only
          readRegions: [
            { offset: inputOffset, length: 128, name: "input" },
          ],
        },
      },
      seqFields: {
        sim: { offset: 0 }, // HDR_TICK (Uint32 at offset 0)
      },
    };
  },

  onTick(dt: number, ctx): void {
    if (!world) return;
    tickCount = ctx.tickCount;

    // Read input from SAB (direct control for the active blockhead).
    readInput();

    // --- Per-blockhead task execution + input assembly ---
    // The active blockhead uses the SAB direct input (read above), possibly
    // overridden by its task queue's synthetic input. Non-active blockheads
    // use their task queue's synthetic input, or idle input if no task.
    // We build a per-blockhead input array, then run physics + mining +
    // placing for each blockhead with its own input.
    const bhInputs: BlockheadInput[] = [];
    const originCx = world.getActiveOriginCx();
    const originCy = world.getActiveOriginCy();
    for (let bi = 0; bi < blockheads.length; bi++) {
      const queue = taskQueues[bi];
      let bhInput: BlockheadInput;
      if (bi === activeBhIndex) {
        // Active: start from direct SAB input (clone it so we don't mutate
        // the shared `input` object when merging task input).
        bhInput = { ...input };
      } else {
        // Non-active: start from idle input (no direct control).
        bhInput = createDefaultInput();
      }

      if (queue && queue.length > 0) {
        const task = queue[0];
        // Handle CRAFT_AT task completion: queue the craft at the station
        if (task.type === "CRAFT_AT" && task.status === "done" && task.recipeId) {
          if (task.stationAx !== undefined && task.stationAy !== undefined) {
            const recipe = getRecipe(task.recipeId);
            if (recipe) {
              const state = getOrCreateStationState(task.stationAx, task.stationAy);
              if (state) {
                const job: CraftJob = {
                  id: nextJobId++,
                  recipeId: task.recipeId,
                  bhIndex: bi,
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
            blockheads[bi], current, world.activeForeground, world.activeBackground,
            originCx, originCy,
            dt,
          );
          if (taskInput) {
            // Override input with task input
            bhInput.left = taskInput.left;
            bhInput.right = taskInput.right;
            bhInput.up = taskInput.up;
            bhInput.down = taskInput.down;
            bhInput.jump = taskInput.jump;
            bhInput.noclip = false; // never noclip during tasks
            bhInput.mineX = taskInput.mineX;
            bhInput.mineY = taskInput.mineY;
            bhInput.placeX = taskInput.placeX;
            bhInput.placeY = taskInput.placeY;
            bhInput.placeBlockId = taskInput.placeBlockId;
          }
          if (current.status === "done" || current.status === "failed") {
            queue.shift();
          }
        }
      }
      bhInputs.push(bhInput);
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
      // Invalidate all task path caches (grid shifted)
      for (const queue of taskQueues) {
        for (const task of queue) {
          invalidatePath(task);
        }
      }
      // Remap blockhead positions from old active grid coords to new ones.
      const dx = (world.getActiveOriginCx() - oldOriginCx) * 64;
      const dy = (world.getActiveOriginCy() - oldOriginCy) * 64;
      for (const bh of blockheads) {
        bh.x = bh.x - dx;
        bh.y = bh.y - dy;
        bh.x = Math.max(0, Math.min(ACTIVE_GRID_W - BH_W, bh.x));
        bh.y = Math.max(0, Math.min(ACTIVE_GRID_H - BH_H, bh.y));
      }
      // Remap drop positions to new active grid coords
      for (let di = drops.length - 1; di >= 0; di--) {
        const d = drops[di];
        d.x = d.x - dx;
        d.y = d.y - dy;
        if (d.x < 0 || d.x >= ACTIVE_GRID_W || d.y < 0 || d.y >= ACTIVE_GRID_H) {
          drops.splice(di, 1);
        }
      }
      lightDirty = true;
    }

    // Step blockhead physics (each with its own input)
    for (let bi = 0; bi < blockheads.length; bi++) {
      updateBlockhead(blockheads[bi], bhInputs[bi], world.activeForeground, world.activeBackground, dt);
    }

    // Process mining + placing per blockhead
    for (let bi = 0; bi < blockheads.length; bi++) {
      processMiningFor(bi, bhInputs[bi], dt);
      processPlacingFor(bi, bhInputs[bi]);
    }

    // Update world drops (physics + pickup by nearest blockhead)
    updateDrops(dt);

    // Step stations (fuel depletion, craft queue advancement)
    stepStations(dt);

    // Process task effects (EAT, SLEEP) — already iterates all blockheads
    processTaskEffects(dt);

    // Passive stat decay + death checks (multi-character feature)
    stepAttributes(dt);
    checkDeaths();

    // Update fog of war: mark cells near every blockhead as explored
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
  },

  onAfterTicks(ctx): void {
    tickCount = ctx.tickCount;

    // Flush pickup notifications once per frame (batched across all ticks
    // that ran this frame). Emits a single tiny event regardless of how
    // many pickups occurred — keeps the worker→host channel quiet even
    // during a 500-block mining burst.
    if (tickPickups.size > 0) {
      simEvents?.emit("pickups", Object.fromEntries(tickPickups));
      tickPickups.clear();
    }

    // Write to SAB once per frame
    if (world && writer) {
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

      // Compute mining VFX data for the header (reports the active BH's target)
      let mineX = -1, mineY = -1, mineDamageF = 0;
      const ams = mineStates[activeBhIndex];
      if (ams && ams.target) {
        mineX = ams.target.x;
        mineY = ams.target.y;
        const key = ams.target.y * ACTIVE_GRID_W + ams.target.x;
        const dmg = ams.damage.get(key) ?? 0;
        const def = getBlockDef(ams.target.blockId);
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

    // Periodically save dirty chunks to OPFS.
    // Guard against overlapping saves: if the previous save hasn't finished
    // yet (OPFS can be slow), skip this cycle rather than risk two writes
    // racing — the last writer would win and could drop chunks the other
    // write had already persisted.
    const now = performance.now();
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
  },

  async onShutdown(): Promise<void> {
    // Save dirty chunks before shutting down
    if (world) {
      world.syncActiveForSave();
      await saveDirtyChunks(world.allChunks());
    }
    // Tear down the dedicated pather worker.
    pathBroker?.dispose();
    pathBroker = null;
    setPathBroker(null);
  },

  extraApi: {
    /**
     * Reset the whole game: delete the OPFS save, re-create the world from
     * scratch (no saved chunks), reset the blockhead + inventory + task queues,
     * and write fresh state to the SAB. The render loop keeps running.
     */
    async resetGame(): Promise<{ ok: boolean; error?: string }> {
      // Pause the sim while we tear down + rebuild
      simControl?.pause();

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
      simControl?.resume();
      return { ok: true };
    },

    async saveNow(): Promise<number> {
      if (!world) return 0;
      world.syncActiveForSave();
      return saveDirtyChunks(world.allChunks());
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

  // --- Map region snapshot (for zoomed-out map mode) ---
  // Writes per-block map data directly into the map SAB (if available) and
  // returns an encoded ArrayBuffer with station data only. The pixi-ui worker
  // reads the block data from the SAB; the renderer reads stations from the
  // returned buffer.
  getMapRegion(centerCx: number): ArrayBuffer {
    if (!world) return encodeMapRegion({
      cx0: 0, cols: 0, rows: 0,
      blockIds: new Uint16Array(0), explored: new Uint8Array(0), stations: [],
    });
    // If the map SAB is available, write all 4 planes directly into it.
    if (mapSab) {
      const views = getMapSabViews(mapSab);
      const region = world.getMapRegion(centerCx, {
        foreground: views.foreground,
        background: views.background,
        mask: views.mask,
        vfx: views.vfx,
        explored: views.explored,
      });
      views.cx0[0] = region.cx0;
      // Increment seq so the MapCanvas reader detects new data.
      // The main thread reads the SAB directly (no postMessage barrier),
      // so we use Atomics.store for a store-store ordering.
      Atomics.store(views.seq, 0, (Atomics.load(views.seq, 0) + 1) | 0);
      return encodeMapRegion({
        cx0: region.cx0, cols: region.cols, rows: region.rows,
        blockIds: new Uint16Array(0), explored: new Uint8Array(0),
        stations: region.stations,
      });
    }
    // Fallback: no SAB, return full data via ArrayBuffer.
    const region = world.getMapRegion(centerCx);
    return encodeMapRegion(region);
  },

  // --- Multi-character: spawn, active selection, roster ---
  // Spawn a new blockhead (free — creative/MCP). If x/y omitted, spawns near
  // the active blockhead. Returns the new blockhead's index + id.
  spawnBlockhead(x?: number, y?: number, gender?: string): { ok: boolean; bhIndex?: number; id?: number; error?: string } {
    if (!world) return { ok: false, error: "World not initialized" };
    let wx: number, wy: number;
    if (x !== undefined && y !== undefined) {
      wx = x; wy = y;
    } else if (blockheads.length > 0) {
      const bh = blockheads[activeBhIndex] ?? blockheads[0];
      wx = bh.x + world.getActiveOriginCx() * 64;
      wy = bh.y + world.getActiveOriginCy() * 64;
    } else {
      return { ok: false, error: "No reference blockhead and no coords given" };
    }
    return spawnBlockheadInternal(wx, wy, gender ?? "male");
  },

  // Spawn a blockhead by consuming a spawn_egg from the given blockhead's inventory.
  spawnBlockheadFromEgg(bhIndex: number): { ok: boolean; bhIndex?: number; id?: number; error?: string } {
    const inv = inventories[bhIndex];
    if (!inv) return { ok: false, error: "Invalid blockhead index" };
    if (!inv.remove("spawn_egg", 1)) return { ok: false, error: "No spawn egg in inventory" };
    const bh = blockheads[bhIndex];
    const wx = bh.x + world!.getActiveOriginCx() * 64;
    const wy = bh.y + world!.getActiveOriginCy() * 64;
    const gender = bhGenders.get(bh.id) ?? "male";
    return spawnBlockheadInternal(wx, wy, gender);
  },

  // Use an item from a blockhead's inventory (e.g. spawn egg). Currently only
  // spawn_egg has a use action; other items are no-ops.
  useItem(itemId: string, bhIndex: number = 0): { ok: boolean; error?: string } {
    if (itemId === "spawn_egg") {
      // Inline the egg-spawn logic (can't use `this` in RPC context).
      const inv = inventories[bhIndex];
      if (!inv) return { ok: false, error: "Invalid blockhead index" };
      if (!inv.remove("spawn_egg", 1)) return { ok: false, error: "No spawn egg in inventory" };
      const bh = blockheads[bhIndex];
      if (!bh || !world) return { ok: false, error: "Blockhead or world not available" };
      const wx = bh.x + world.getActiveOriginCx() * 64;
      const wy = bh.y + world.getActiveOriginCy() * 64;
      const gender = bhGenders.get(bh.id) ?? "male";
      return spawnBlockheadInternal(wx, wy, gender);
    }
    return { ok: false, error: `Item ${itemId} has no use action` };
  },

  // Set the active blockhead index (which one receives direct WASD/mouse).
  setActiveBhIndex(i: number): { ok: boolean; activeBhIndex: number } {
    if (blockheads.length === 0) return { ok: false, activeBhIndex: 0 };
    activeBhIndex = Math.max(0, Math.min(i, blockheads.length - 1));
    return { ok: true, activeBhIndex };
  },

  // Get the active blockhead index.
  getActiveBhIndex(): number {
    return activeBhIndex;
  },

  // Get a roster snapshot of all blockheads (for UI/MCP).
  getBlockheads(): { id: number; bhIndex: number; x: number; y: number; health: number; hunger: number; energy: number; air: number; happiness: number; environment: number; gender: string }[] {
    return blockheads.map((bh, i) => ({
      id: bh.id,
      bhIndex: i,
      x: bh.x + (world?.getActiveOriginCx() ?? 0) * 64,
      y: bh.y + (world?.getActiveOriginCy() ?? 0) * 64,
      health: bh.health,
      hunger: bh.hunger,
      energy: bh.energy,
      air: bh.air,
      happiness: bh.happiness,
      environment: bh.environment,
      gender: bhGenders.get(bh.id) ?? "male",
    }));
  },

  // Set a blockhead's gender (cosmetic, for roster persistence).
  setBhGender(id: number, gender: string): { ok: boolean } {
    bhGenders.set(id, gender);
    return { ok: true };
  },

  // --- Roster persistence (save/load across reloads) ---
  // Returns a serializable roster snapshot of all blockheads.
  getBlockheadRoster(): {
    activeBhIndex: number;
    blockheads: {
      id: number; x: number; y: number; gender: string;
      health: number; hunger: number; energy: number; air: number;
      happiness: number; environment: number;
      inventory: ({ itemId: string; count: number } | null)[];
      tasks: { type: string; targetX?: number; targetY?: number; status: string }[];
    }[];
  } {
    const originCx = world?.getActiveOriginCx() ?? 0;
    const originCy = world?.getActiveOriginCy() ?? 0;
    return {
      activeBhIndex,
      blockheads: blockheads.map((bh, i) => ({
        id: bh.id,
        x: bh.x + originCx * 64,
        y: bh.y + originCy * 64,
        gender: bhGenders.get(bh.id) ?? "male",
        health: bh.health,
        hunger: bh.hunger,
        energy: bh.energy,
        air: bh.air,
        happiness: bh.happiness,
        environment: bh.environment,
        inventory: inventories[i]?.snapshot() ?? new Array(54).fill(null),
        tasks: (taskQueues[i] ?? []).map((t) => ({
          type: t.type,
          targetX: t.targetX,
          targetY: t.targetY,
          status: t.status,
        })),
      })),
    };
  },

  // Restore blockheads from a roster snapshot (called on init after chunks load).
  setBlockheadRoster(roster: {
    activeBhIndex?: number;
    blockheads: {
      id: number; x: number; y: number; gender: string;
      health: number; hunger: number; energy: number; air: number;
      happiness: number; environment: number;
      inventory: ({ itemId: string; count: number } | null)[];
      tasks: { type: string; targetX?: number; targetY?: number; status: string }[];
    }[];
  }): { ok: boolean } {
    if (!world) return { ok: false };
    const originCx = world.getActiveOriginCx();
    const originCy = world.getActiveOriginCy();
    blockheads = [];
    inventories = [];
    taskQueues.length = 0;
    mineStates = [];
    bhGenders.clear();
    let maxId = 0;
    for (const entry of roster.blockheads) {
      if (blockheads.length >= MAX_BLOCKHEADS) break;
      const ax = entry.x - originCx * 64;
      const ay = entry.y - originCy * 64;
      const bh = createBlockhead(
        Math.max(0, Math.min(ACTIVE_GRID_W - BH_W, ax)),
        Math.max(0, Math.min(ACTIVE_GRID_H - BH_H, ay)),
      );
      bh.id = entry.id;
      bh.health = entry.health;
      bh.hunger = entry.hunger;
      bh.energy = entry.energy;
      bh.air = entry.air;
      bh.happiness = entry.happiness;
      bh.environment = entry.environment;
      blockheads.push(bh);
      const inv = new Inventory();
      inv.loadSnapshot(entry.inventory);
      inventories.push(inv);
      taskQueues.push([]);
      mineStates.push({ damage: new Map(), target: null, cooldown: 0 });
      bhGenders.set(entry.id, entry.gender);
      if (entry.id > maxId) maxId = entry.id;
    }
    nextBhId = maxId + 1;
    activeBhIndex = Math.max(0, Math.min(roster.activeBhIndex ?? 0, blockheads.length - 1));
    return { ok: true };
  },
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
  // Read the active blockhead index from the SAB (slot 20 = byte offset 80).
  // Clamped to alive blockheads; defaults to 0 if out of range.
  const sabActive = inputInt32[20] | 0;
  if (blockheads.length > 0) {
    activeBhIndex = Math.max(0, Math.min(sabActive, blockheads.length - 1));
  } else {
    activeBhIndex = 0;
  }
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

// --- Process mining (per-blockhead) ---
function processMiningFor(bi: number, bhInput: BlockheadInput, dt: number): void {
  if (!world) return;
  const bh = blockheads[bi];
  if (!bh) return;
  const ms = mineStates[bi] ?? (mineStates[bi] = { damage: new Map(), target: null, cooldown: 0 });

  if (bhInput.mineX < 0 || bhInput.mineY < 0) {
    ms.target = null;
    ms.damage.clear();
    return;
  }

  // Convert world mouse coords to active grid coords
  const ax = bhInput.mineX - world.getActiveOriginCx() * 64;
  const ay = bhInput.mineY - world.getActiveOriginCy() * 64;

  // Auto-target: if there's a foreground block at the click position, mine it.
  // If the foreground is air but there's a background block, mine the background.
  const fgTarget = getMineTarget(bh, ax, ay, world.activeForeground);
  const bgTarget = getMineTarget(bh, ax, ay, world.activeBackground);
  const target = fgTarget ?? bgTarget;
  const miningBackground = !fgTarget && !!bgTarget;

  if (!target) {
    ms.target = null;
    return;
  }

  // If target changed, reset damage
  if (!ms.target || ms.target.x !== target.x || ms.target.y !== target.y) {
    ms.target = target;
    ms.damage.clear();
  }

  // Apply mining damage
  ms.cooldown -= dt;
  if (ms.cooldown <= 0) {
    const def = getBlockDef(target.blockId);
    if (!def) return;
    const hardness = Math.max(1, def.hardness);
    const key = target.y * ACTIVE_GRID_W + target.x;
    const dmg = (ms.damage.get(key) ?? 0) + 1;
    ms.damage.set(key, dmg);
    ms.cooldown = 0.1; // 10 hits per second

    // Set anim state to dig
    bh.animState = "dig";

    // When damage exceeds hardness, break the block
    if (dmg >= hardness) {
      // Tree felling: if the player mined a wood block in the background
      // (a tree trunk), cut down the entire tree.
      if (miningBackground && isWoodBlock(target.blockId)) {
        const felled = fellTree(
          world.activeBackground, ACTIVE_GRID_W, ACTIVE_GRID_H,
          target.x, target.y,
        );
        for (const cell of felled) {
          const cellDef = getBlockDef(cell.blockId);
          if (!cellDef) continue;
          world.setActiveBackground(cell.x, cell.y, BLOCK_AIR);
          if (isWoodBlock(cell.blockId)) {
            spawnDrop(cell.x, cell.y, "wood", 1);
          }
          if (isLeafBlock(cell.blockId)) {
            const stickRoll = pseudoRandom(cell.x, cell.y, tickCount, "stick-drop");
            if (stickRoll <= 0.3) {
              spawnDrop(cell.x, cell.y, "stick", 1);
            }
            for (const drop of cellDef.drops) {
              if (drop.itemId === "stick") continue;
              const roll = pseudoRandom(cell.x, cell.y, tickCount, drop.itemId);
              if (roll <= drop.chance) {
                spawnDrop(cell.x, cell.y, drop.itemId, drop.count);
              }
            }
          }
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
        for (const cell of felled) {
          for (let di = drops.length - 1; di >= 0; di--) {
            const d = drops[di];
            if (d.kind === 0) continue;
            const dx = d.x - (cell.x + 0.5);
            const dy = d.y - (cell.y + 0.5);
            if (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.0) {
              if (d.kind === 1 || d.kind === 2) {
                const itemId = decodeDropItem(d.itemCode);
                if (itemId) spawnDrop(cell.x, cell.y, itemId, 1);
              }
              drops.splice(di, 1);
            }
          }
        }
        lightDirty = true;
        ms.damage.delete(key);
        ms.target = null;
        bhInput.mineX = -1;
        bhInput.mineY = -1;
        return;
      }

      if (miningBackground) {
        world.setActiveBackground(target.x, target.y, BLOCK_AIR);
      } else {
        world.setActiveBlock(target.x, target.y, BLOCK_AIR);
      }
      lightDirty = true;

      // Wild crop harvested: record harvest info for regrow timer.
      if (isWildCropBlock(target.blockId)) {
        const wc = getWildCropByBlock(target.blockId);
        if (wc) {
          recordWildHarvest(target.x, target.y, world.currentTick, wc.blockId, wc.regrowTicks);
        }
      }
      // Leaf blocks mined individually: 30% chance to spawn a stick drop,
      // plus any fruit drops.
      if (isLeafBlock(target.blockId)) {
        const stickRoll = pseudoRandom(target.x, target.y, tickCount, "stick-drop");
        if (stickRoll <= 0.3) {
          spawnDrop(target.x, target.y, "stick", 1);
        }
        for (const drop of def.drops) {
          if (drop.itemId === "stick") continue;
          const roll = pseudoRandom(target.x, target.y, tickCount, drop.itemId);
          if (roll <= drop.chance) {
            spawnDrop(target.x, target.y, drop.itemId, drop.count);
          }
        }
      } else {
        // All other blocks: add drops to this blockhead's inventory
        const inv = inventories[bi];
        if (inv) {
          for (const drop of def.drops) {
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
      ms.damage.delete(key);
      ms.target = null;
      if (!miningBackground) {
        bhInput.mineX = -1;
        bhInput.mineY = -1;
      }
    }
  }
}

// --- Process placing (per-blockhead) ---
function processPlacingFor(bi: number, bhInput: BlockheadInput): void {
  if (!world) return;
  const bh = blockheads[bi];
  if (!bh) return;

  if (bhInput.placeX < 0 || bhInput.placeY < 0) return;
  if (bhInput.placeBlockId === BLOCK_AIR) return;

  // Convert world mouse coords to active grid coords
  const ax = Math.floor(bhInput.placeX - world.getActiveOriginCx() * 64);
  const ay = Math.floor(bhInput.placeY - world.getActiveOriginCy() * 64);

  if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_H) return;

  // Don't place on a cell occupied by ANY blockhead
  for (const other of blockheads) {
    const oX0 = Math.floor(other.x);
    const oX1 = Math.floor(other.x + BH_W - 0.001);
    const oY0 = Math.floor(other.y);
    const oY1 = Math.floor(other.y + BH_H - 0.001);
    if (ax >= oX0 && ax <= oX1 && ay >= oY0 && ay <= oY1) return;
  }

  // --- Tree seed → plant a sapling in the BACKGROUND plane ---
  if (bhInput.placeBlockId === BLOCK_SAPLING) {
    if (world.getActiveBackground(ax, ay) !== BLOCK_AIR) return;
    const below = ay + 1;
    if (below >= ACTIVE_GRID_H) return;
    const groundId = world.getActiveBlock(ax, below) & 0xFF;
    if (groundId !== BLOCK_GRASS && groundId !== BLOCK_DIRT) return;
    const inv = inventories[bi];
    if (!inv || !inv.remove("seed", 1)) return;
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
  const placeDef = getBlockDef(bhInput.placeBlockId);
  if (placeDef?.isStation) {
    if (!hasSupport(ax, ay)) return;
  }

  // Consume the corresponding item from this blockhead's inventory
  const itemId = getItemForBlock(bhInput.placeBlockId);
  const inv = inventories[bi];
  if (itemId && inv) {
    if (!inv.remove(itemId, 1)) return;
  }

  // Place the block
  world.setActiveBlock(ax, ay, bhInput.placeBlockId);
  lightDirty = true;

  // If a seed/spore was planted, record the plant tick for crop growth timing.
  if (isCropBlock(bhInput.placeBlockId)) {
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

// --- Passive stat decay + death causes (multi-character feature) ---
// Rates are per-second. Stats deplete over ~30 minutes of normal play, so
// short e2e tests (60s) are unaffected. Starvation/exposure drain health.
const HUNGER_RATE = 0.05;   // -1 every 20s → ~33 min from 100 to 0
const ENERGY_RATE = 0.04;   // -1 every 25s → ~42 min from 100 to 0 (idle)
const ENERGY_REGEN = 0.06;  // +1 every ~17s when resting
const HAPPINESS_RATE = 0.02; // slow baseline decay
const ENV_RATE = 0.02;      // baseline; faster in darkness
const STARVE_HP_RATE = 1.0;  // -1 hp/s when hunger is 0
const EXPOSURE_HP_RATE = 0.5; // -0.5 hp/s when environment is 0

function stepAttributes(dt: number): void {
  if (!world) return;
  for (const bh of blockheads) {
    // Activity multiplier: active actions drain hunger/energy faster.
    const active = bh.animState === "dig" || bh.animState === "chop" ||
                   bh.animState === "walk" || bh.animState === "climb";
    const hungerMul = active ? 1.5 : 1.0;
    bh.hunger = Math.max(0, bh.hunger - HUNGER_RATE * hungerMul * dt);

    // Energy: drains when active, regens when idle + on ground.
    if (active) {
      bh.energy = Math.max(0, bh.energy - ENERGY_RATE * dt);
    } else if (bh.animState === "idle" && bh.onGround) {
      bh.energy = Math.min(100, bh.energy + ENERGY_REGEN * dt);
    }

    // Happiness: slow decay; faster when hungry or exposed.
    const happMul = (bh.hunger < 20 || bh.environment < 20) ? 2.0 : 1.0;
    bh.happiness = Math.max(0, bh.happiness - HAPPINESS_RATE * happMul * dt);

    // Environment: decays in darkness, regens near light.
    // Sample the light level at the blockhead's cell.
    const cx = Math.floor(bh.x + BH_W * 0.5);
    const cy = Math.floor(bh.y + BH_H * 0.5);
    let lightLevel = 0;
    if (cx >= 0 && cx < ACTIVE_GRID_W && cy >= 0 && cy < ACTIVE_GRID_H) {
      // Light is RGBA8; use the R channel as brightness.
      lightLevel = world.activeLight[(cy * ACTIVE_GRID_W + cx) * 4];
    }
    if (lightLevel >= 8) {
      bh.environment = Math.min(100, bh.environment + 0.05 * dt);
    } else {
      bh.environment = Math.max(0, bh.environment - (ENV_RATE + (lightLevel === 0 ? 0.08 : 0)) * dt);
    }

    // Death causes: starvation + exposure drain health.
    if (bh.hunger <= 0) {
      bh.health = Math.max(0, bh.health - STARVE_HP_RATE * dt);
    }
    if (bh.environment <= 0) {
      bh.health = Math.max(0, bh.health - EXPOSURE_HP_RATE * dt);
    }
  }
}

// --- Death check: remove blockheads at 0 HP, drop inventory ---
function checkDeaths(): void {
  if (!world) return;
  let anyDied = false;
  for (let bi = blockheads.length - 1; bi >= 0; bi--) {
    const bh = blockheads[bi];
    if (bh.health > 0) continue;
    anyDied = true;
    // Drop entire inventory as world drops at the blockhead's position.
    const inv = inventories[bi];
    if (inv) {
      for (const slot of inv.allSlots()) {
        if (slot && slot.count > 0) {
          spawnDrop(bh.x, bh.y, slot.itemId, slot.count);
        }
      }
    }
    // Remove from all parallel arrays.
    const id = bh.id;
    blockheads.splice(bi, 1);
    inventories.splice(bi, 1);
    taskQueues.splice(bi, 1);
    if (bi < mineStates.length) mineStates.splice(bi, 1);
    bhGenders.delete(id);
    // Reassign active index if the dead one was active.
    if (bi === activeBhIndex) {
      activeBhIndex = Math.max(0, Math.min(activeBhIndex, blockheads.length - 1));
    } else if (bi < activeBhIndex) {
      activeBhIndex--;
    }
    console.log(`[Overburden] Blockhead ${id} died at (${bh.x}, ${bh.y}).`);
    // TODO: emit a blockhead_died event to the renderer for UI notification.
  }
  if (anyDied && blockheads.length === 0) {
    console.log("[Overburden] All blockheads have died — game over.");
  }
}

// --- Spawn a new blockhead ---
function spawnBlockheadInternal(
  worldX: number, worldY: number, gender: string = "male",
): { ok: boolean; bhIndex?: number; id?: number; error?: string } {
  if (!world) return { ok: false, error: "World not initialized" };
  if (blockheads.length >= MAX_BLOCKHEADS) {
    return { ok: false, error: `Max blockheads (${MAX_BLOCKHEADS}) reached` };
  }
  // Find a clear spawn cell near (worldX, worldY). Convert to active-grid coords.
  const ax0 = worldX - world.getActiveOriginCx() * 64;
  const ay0 = worldY - world.getActiveOriginCy() * 64;
  // Scan outward for a cell with solid ground below + air above.
  let spawnX = ax0;
  let spawnY = ay0;
  const fg = world.activeForeground;
  const isSolid = (x: number, y: number): boolean => {
    if (x < 0 || x >= ACTIVE_GRID_W || y < 0 || y >= ACTIVE_GRID_H) return false;
    const def = getBlockDef(fg[y * ACTIVE_GRID_W + x] & 0xFF);
    return !!def && def.category === "solid";
  };
  if (!isSolid(Math.floor(ax0), Math.floor(ay0) + 1) || isSolid(Math.floor(ax0), Math.floor(ay0))) {
    // Search in a spiral for a valid spawn.
    let found = false;
    for (let r = 1; r < 20 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const tx = Math.floor(ax0) + dx;
          const ty = Math.floor(ay0) + dy;
          if (tx < 0 || tx >= ACTIVE_GRID_W - 1 || ty < 0 || ty >= ACTIVE_GRID_H - 2) continue;
          if (!isSolid(tx, ty + 1) && !isSolid(tx, ty) && !isSolid(tx, ty - 1)) {
            spawnX = tx;
            spawnY = ty;
            found = true;
          }
        }
      }
    }
  }
  const id = nextBhId++;
  const bh = createBlockhead(spawnX, spawnY);
  bh.id = id;
  blockheads.push(bh);
  inventories.push(new Inventory());
  taskQueues.push([]);
  mineStates.push({ damage: new Map(), target: null, cooldown: 0 });
  bhGenders.set(id, gender);
  console.log(`[Overburden] Spawned blockhead ${id} at (${spawnX}, ${spawnY}) — index ${blockheads.length - 1}.`);
  return { ok: true, bhIndex: blockheads.length - 1, id };
}

// --- Update focus to follow the blockhead ---
// --- Update fog of war: mark cells near every blockhead as explored ---
function updateExplored(): void {
  if (!world) return;
  const RADIUS = 120; // explore 120-block radius around each blockhead
  const RADIUS_SQ = RADIUS * RADIUS;
  for (const bh of blockheads) {
    const cx = Math.floor(bh.x + BH_W * 0.5);
    const cy = Math.floor(bh.y + BH_H * 0.5);
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
}

function updateFocus(): void {
  if (!world || blockheads.length === 0) return;
  // Follow the active blockhead (clamped to alive blockheads).
  const idx = Math.min(activeBhIndex, blockheads.length - 1);
  const bh = blockheads[idx];
  // Convert active grid coords back to world coords
  const wx = bh.x + world.getActiveOriginCx() * 64;
  const wy = bh.y + world.getActiveOriginCy() * 64;
  world.setFocus(wx, wy);
}

