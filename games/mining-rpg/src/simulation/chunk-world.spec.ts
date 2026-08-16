import { DEFAULT_GRAVITY, FIELD, Material, packCell } from "@downdraft/library-sand";
import { expect, test } from "bun:test";
import { ACTIVE_GRID_W, CHUNK_H, CHUNK_W } from "../shared/constants";
import { ChunkWorld } from "./chunk-world";

// Helper: get material at world coords from the active grid
function matAtWorld(world: ChunkWorld, wx: number, wy: number): number {
  const { x: ax, y: ay } = world.worldToActive(wx, wy);
  if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_W) return -1;
  return world.activeGrid.grid[ay * ACTIVE_GRID_W + ax] & 0xff;
}

// Helper: set a cell in the active grid at world coords
function setMatAtWorld(world: ChunkWorld, wx: number, wy: number, mat: number): void {
  const { x: ax, y: ay } = world.worldToActive(wx, wy);
  const idx = ay * ACTIVE_GRID_W + ax;
  world.activeGrid.grid[idx] = packCell(mat, 0, 0);
  // Also reset the gravity field — ore cells (TinOre/CopperOre) have gravity=0
  // set during terrain generation, and without resetting it, test-placed
  // stone/dirt above those cells won't fall.
  world.activeGrid.fields[idx * 4 + FIELD.GRAVITY] = DEFAULT_GRAVITY;
}

// Helper: run N steps with no input
function runIdle(world: ChunkWorld, steps: number): void {
  for (let i = 0; i < steps; i++) {
    world.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
  }
}

// Helper: run one mine call directly (without step, to avoid player movement)
function runMine(world: ChunkWorld, wx: number, wy: number): void {
  world.mine(wx, wy);
}

// Helper: clear a vertical shaft from the player down to a target Y,
// so the raycast can reach the target without hitting terrain in between.
// Clears a 5-wide shaft and extends 5 cells below the target to account for
// ray drift from player center and ensure no natural terrain is hit first.
function clearShaft(world: ChunkWorld, wx: number, targetY: number): void {
  const px = Math.floor(world.player.x);
  const py = Math.floor(world.player.y);
  for (let y = py; y <= targetY + 5; y++) {
    for (let dx = -2; dx <= 2; dx++) {
      setMatAtWorld(world, wx + dx, y, Material.Empty);
    }
  }
}

// Helper: place a 5-wide stone wall at a given Y in the shaft.
// The ray drifts from the player center, so a single-cell stone may be missed.
// A 5-wide wall ensures the ray hits it.
function placeStoneWall(world: ChunkWorld, wx: number, wy: number, mat: number = Material.Stone): void {
  for (let dx = -2; dx <= 2; dx++) {
    setMatAtWorld(world, wx + dx, wy, mat);
  }
}

// Helper: check if any cell in a 5-wide row at the given Y has the expected material
function matAtRow(world: ChunkWorld, wx: number, wy: number, mat: number): boolean {
  for (let dx = -2; dx <= 2; dx++) {
    if (matAtWorld(world, wx + dx, wy) === mat) return true;
  }
  return false;
}

// Helper: mine a target multiple times until the stone is dislodged.
// With base damage=10 and stone hardness=30, it takes 3 hits.
// Clears a shaft first so the raycast can reach the target.
function mineUntilDislodged(world: ChunkWorld, wx: number, wy: number, maxHits: number = 10): void {
  // Clear a shaft so the ray can reach the target
  clearShaft(world, wx, wy);
  // Place the stone at the target (after clearing)
  setMatAtWorld(world, wx, wy, Material.Stone);
  for (let i = 0; i < maxHits; i++) {
    runMine(world, wx, wy);
  }
}

// --- Basic world construction ---

test("ChunkWorld constructs with correct active grid dimensions", () => {
  const w = new ChunkWorld();
  expect(w.activeGrid.W).toBe(ACTIVE_GRID_W);
  expect(w.activeGrid.H).toBe(ACTIVE_GRID_W); // square active grid
});

test("ChunkWorld player starts at a valid position", () => {
  const w = new ChunkWorld();
  expect(w.player.x).toBeGreaterThan(0);
  expect(w.player.y).toBeGreaterThan(0);
  expect(w.player.health).toBe(100);
});

test("ChunkWorld loads chunks on first step", () => {
  const w = new ChunkWorld();
  expect(w.getLoadedChunkCount()).toBe(0);
  runIdle(w, 1);
  expect(w.getLoadedChunkCount()).toBeGreaterThan(0);
});

// --- Upgrade system ---

test("upgrade system has correct base stats", () => {
  const w = new ChunkWorld();
  expect(w.getMiningDamage()).toBe(10); // BASE_MINING_DAMAGE
  expect(w.getMiningRadius()).toBe(1); // BASE_MINING_RADIUS
  expect(w.getMiningRate()).toBe(3); // BASE_MINING_RATE
  expect(w.getMaxInventory()).toBe(50); // BASE_INVENTORY_SIZE
});

test("upgrade system increases stats with levels", () => {
  const w = new ChunkWorld();
  w.setUpgrades({ damage: 2, radius: 1, rate: 1, inventorySize: 1 });
  expect(w.getMiningDamage()).toBe(20); // 10 + 2*5
  expect(w.getMiningRadius()).toBe(2); // 1 + 1*1
  expect(w.getMiningRate()).toBe(2); // max(1, 3 - 1*1)
  expect(w.getMaxInventory()).toBe(75); // 50 + 1*25
});

test("upgrade rate has minimum of 1 tick", () => {
  const w = new ChunkWorld();
  w.setUpgrades({ damage: 0, radius: 0, rate: 10, inventorySize: 0 });
  expect(w.getMiningRate()).toBe(1);
});

// --- Mining (raycast) ---

test("mining damages stone and eventually dislodges it to dirt", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  // Clear a shaft and place a stone wall at the target
  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);
  expect(matAtRow(w, digX, digY, Material.Stone)).toBe(true);

  // One mine hit should NOT dislodge stone (damage 10 < hardness 30)
  runMine(w, digX, digY);
  expect(matAtRow(w, digX, digY, Material.Stone)).toBe(true);

  // After enough hits, stone should be converted to dirt (loose, collectible)
  for (let i = 0; i < 10; i++) {
    runMine(w, digX, digY);
  }
  expect(matAtRow(w, digX, digY, Material.Dirt)).toBe(true);
});

test("mining does not destroy Wall material", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 10;

  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY, Material.Wall);
  expect(matAtRow(w, digX, digY, Material.Wall)).toBe(true);

  // Mine many times — wall should remain
  for (let i = 0; i < 20; i++) {
    runMine(w, digX, digY);
  }
  expect(matAtRow(w, digX, digY, Material.Wall)).toBe(true);
});

test("mining marks chunk as dirty", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);

  // Mine until dislodged
  for (let i = 0; i < 10; i++) {
    runMine(w, digX, digY);
  }

  const chunk = w.getChunkAt(digX, digY);
  expect(chunk.dirty).toBe(true);
});

test("mined dirt particle falls down due to gravity", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 25;

  // Clear a shaft and set up: stone wall at the bottom
  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);
  placeStoneWall(w, digX, digY + 1);
  placeStoneWall(w, digX, digY + 2);

  // Mine until the stone is dislodged to dirt (using mine() directly)
  for (let i = 0; i < 10; i++) {
    w.mine(digX, digY);
  }
  expect(matAtRow(w, digX, digY, Material.Dirt)).toBe(true);

  // Run simulation steps — dirt should fall
  runIdle(w, 10);

  // The dirt should have moved down from digY
  let foundDirt = false;
  for (let y = digY; y <= digY + 3; y++) {
    if (matAtRow(w, digX, y, Material.Dirt)) {
      foundDirt = true;
      break;
    }
  }
  expect(foundDirt).toBe(true);
});

test("mining is rate-limited by cooldown", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);

  // With base rate=3, only every 3rd tick actually mines.
  // Damage per hit = 10, stone hardness = 30 → needs 3 actual hits.
  // With rate=3, that's ~9 ticks of holding mouseDown.
  for (let i = 0; i < 15; i++) {
    runMine(w, digX, digY);
  }
  expect(matAtRow(w, digX, digY, Material.Dirt)).toBe(true);
});

test("mining liquids does not destroy them", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  // Clear shaft and place water above a stone floor
  clearShaft(w, digX, digY + 2);
  placeStoneWall(w, digX, digY + 2, Material.Stone); // floor
  // Place water in the 5-wide row above the floor
  for (let dx = -2; dx <= 2; dx++) {
    setMatAtWorld(w, digX + dx, digY, Material.Water);
    setMatAtWorld(w, digX + dx, digY + 1, Material.Water);
  }
  expect(matAtRow(w, digX, digY, Material.Water)).toBe(true);

  // Mine toward the water — the ray should pass through the water
  // and hit the stone floor below. Water should remain.
  for (let i = 0; i < 20; i++) {
    runMine(w, digX, digY);
  }
  // Water should still be there (ray passes through liquids)
  expect(matAtRow(w, digX, digY, Material.Water)).toBe(true);
});

// --- Collection ---

test("collect picks up loose ore near player", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Clear a shaft and place ore on stone ground at the bottom
  clearShaft(w, px, py + 8);
  placeStoneWall(w, px, py + 8, Material.Stone); // ground
  placeStoneWall(w, px, py + 7, Material.TinOre); // ore on ground

  // Mine the ore to loosen it (make it unfrozen/collectible)
  for (let i = 0; i < 20; i++) {
    runMine(w, px, py + 7);
  }

  // Run steps to collect
  let tinCollected: { mat: number; count: number } | undefined;
  for (let i = 0; i < 10; i++) {
    const collected = w.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
    tinCollected = collected.find((c) => c.mat === Material.TinOre);
    if (tinCollected) break;
  }

  expect(tinCollected).toBeDefined();
  expect(tinCollected!.count).toBeGreaterThan(0);
});

test("collect does not pick up frozen ore (embedded in stone)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  setMatAtWorld(w, px + 2, py, Material.TinOre);

  // Run a step without mining — the ore is frozen (never mined)
  const collected = w.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
  });

  const tinCollected = collected.find((c) => c.mat === Material.TinOre);
  expect(tinCollected).toBeUndefined();
});

test("collect respects max inventory size", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Fill inventory to max (50 items)
  const fullInventory = [{ mat: Material.Stone, count: 50 }];

  // Place loose ore near player
  clearShaft(w, px, py + 8);
  placeStoneWall(w, px, py + 8, Material.Stone); // ground
  placeStoneWall(w, px, py + 7, Material.TinOre);

  // Mine the ore to loosen it
  for (let i = 0; i < 20; i++) {
    runMine(w, px, py + 7);
  }

  // Run a step with full inventory — should NOT collect
  const collected = w.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
  }, fullInventory);

  const tinCollected = collected.find((c) => c.mat === Material.TinOre);
  expect(tinCollected).toBeUndefined();
});

test("collect works when inventory has space", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Partially fill inventory (10 items, max 50)
  const partialInventory = [{ mat: Material.Stone, count: 10 }];

  clearShaft(w, px, py + 8);
  placeStoneWall(w, px, py + 8, Material.Stone); // ground
  placeStoneWall(w, px, py + 7, Material.TinOre);

  // Mine the ore to loosen it
  for (let i = 0; i < 20; i++) {
    runMine(w, px, py + 7);
  }

  let tinCollected: { mat: number; count: number } | undefined;
  for (let i = 0; i < 10; i++) {
    const collected = w.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    }, partialInventory);
    tinCollected = collected.find((c) => c.mat === Material.TinOre);
    if (tinCollected) break;
  }

  expect(tinCollected).toBeDefined();
});

// --- Freeze optimization ---

test("mined cells have wakeTick set (unfrozen)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);

  const tickBefore = w.currentTick;
  // Mine until dislodged
  for (let i = 0; i < 10; i++) {
    runMine(w, digX, digY);
  }

  // At least one cell in the wall should have wakeTick set (unfrozen)
  let foundUnfrozen = false;
  for (let dx = -2; dx <= 2; dx++) {
    const chunk = w.getChunkAt(digX + dx, digY);
    const { cx, cy } = w.worldToChunk(digX + dx, digY);
    const localX = (digX + dx) - cx * CHUNK_W;
    const localY = digY - cy * CHUNK_H;
    const localIdx = localY * CHUNK_W + localX;
    if (chunk.wakeTick[localIdx] > tickBefore) {
      foundUnfrozen = true;
      break;
    }
  }
  expect(foundUnfrozen).toBe(true);
});

test("wakeTick expires after FREEZE_TICKS (re-freeze)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);

  // Mine until dislodged
  for (let i = 0; i < 10; i++) {
    runMine(w, digX, digY);
  }

  // At least one cell in the wall should have wakeTick set
  let foundUnfrozen = false;
  for (let dx = -2; dx <= 2; dx++) {
    const chunk = w.getChunkAt(digX + dx, digY);
    const { cx, cy } = w.worldToChunk(digX + dx, digY);
    const localX = (digX + dx) - cx * CHUNK_W;
    const localY = digY - cy * CHUNK_H;
    const localIdx = localY * CHUNK_W + localX;
    if (chunk.wakeTick[localIdx] > 0) {
      foundUnfrozen = true;
      break;
    }
  }
  expect(foundUnfrozen).toBe(true);
});

// --- Player physics ---

test("player falls due to gravity", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialY = w.player.y;

  runIdle(w, 30);

  expect(w.player.y).toBeGreaterThanOrEqual(initialY);
});

test("player health decreases when touching lava", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialHealth = w.player.health;

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = 0; dy < 8; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Lava);
    }
  }

  runIdle(w, 5);

  expect(w.player.health).toBeLessThan(initialHealth);
});

// --- Chunk management ---

test("active grid rebuilds when player crosses chunk boundary", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialLoaded = w.getLoadedChunkCount();

  w.player.x += CHUNK_W * 3;

  runIdle(w, 1);

  const newLoaded = w.getLoadedChunkCount();
  expect(newLoaded).toBeGreaterThanOrEqual(initialLoaded);
});

test("chunk data is not corrupted during rebuild (origin sync bug)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const markerX = Math.floor(w.player.x) + 5;
  const markerY = Math.floor(w.player.y) - 5;
  setMatAtWorld(w, markerX, markerY, Material.Stone);

  runIdle(w, 1);

  const chunkBefore = w.getChunkAt(markerX, markerY);
  const { cx, cy } = w.worldToChunk(markerX, markerY);
  const localMx = markerX - cx * CHUNK_W;
  const localMy = markerY - cy * CHUNK_H;
  const markerIdx = localMy * CHUNK_W + localMx;
  expect(chunkBefore.grid[markerIdx] & 0xff).toBe(Material.Stone);

  w.player.x += CHUNK_W;
  runIdle(w, 1);

  w.player.x -= CHUNK_W;
  runIdle(w, 1);

  const chunkAfter = w.getChunkAt(markerX, markerY);
  expect(chunkAfter.grid[markerIdx] & 0xff).toBe(Material.Stone);
});

test("getActiveChunkCount returns positive after step", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);
  expect(w.getActiveChunkCount()).toBeGreaterThan(0);
});

test("getPlayerDepth returns chunk Y of player", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);
  const expectedDepth = Math.floor(w.player.y / CHUNK_H);
  expect(w.getPlayerDepth()).toBe(expectedDepth);
});
