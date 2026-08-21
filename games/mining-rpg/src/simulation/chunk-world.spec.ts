import { DEFAULT_GRAVITY, FIELD, Material, packCell } from "@downdraft/library-sand";
import { expect, test } from "bun:test";
import { ACTIVE_GRID_W, CHUNK_H, CHUNK_W, DeathCause, INTEGRITY_CHECK_INTERVAL } from "../shared/constants";
import { ChunkWorld } from "./chunk-world";

// Helper: get material at world coords from the active grid
function matAtWorld(world: ChunkWorld, wx: number, wy: number): number {
  const { x: ax, y: ay } = world.worldToActive(wx, wy);
  if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_W) return -1;
  return world.activeGrid.grid[ay * ACTIVE_GRID_W + ax] & 0xff;
}

// Helper: get the full packed cell at world coords
function packedAtWorld(world: ChunkWorld, wx: number, wy: number): number {
  const { x: ax, y: ay } = world.worldToActive(wx, wy);
  if (ax < 0 || ax >= ACTIVE_GRID_W || ay < 0 || ay >= ACTIVE_GRID_W) return 0;
  return world.activeGrid.grid[ay * ACTIVE_GRID_W + ax];
}

// Helper: check if a cell is "loosened stone debris" — Stone with lifetime > 0
// (mined/loosened, can fall). Stone no longer converts to Gravel; it stays
// Stone and falls when its lifetime field is set as a settle timer.
function isLoosenedStone(packed: number): boolean {
  if (packed === 0) return false;
  const mat = packed & 0xff;
  const lifetime = (packed >> 8) & 0xff;
  return mat === Material.Stone && lifetime > 0;
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

// Helper: set a STATIC solid cell at world coords with gravity=0, mimicking
// generated terrain (stone/ores have gravity=0 until dislodged by mining).
// Used by structural-integrity tests so placed stone doesn't fall on the next
// sim step before the integrity check runs.
function setStaticCellAtWorld(world: ChunkWorld, wx: number, wy: number, mat: number): void {
  const { x: ax, y: ay } = world.worldToActive(wx, wy);
  const idx = ay * ACTIVE_GRID_W + ax;
  world.activeGrid.grid[idx] = packCell(mat, 0, 0);
  world.activeGrid.fields[idx * 4 + FIELD.GRAVITY] = 0; // static — no gravity
}

// Helper: clear a rectangular region to Empty at world coords (inclusive).
function clearRegion(world: ChunkWorld, wx0: number, wy0: number, wx1: number, wy1: number): void {
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      setMatAtWorld(world, x, y, Material.Empty);
    }
  }
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

// Helper: check if any cell in a 5-wide row at the given Y is loosened stone
// debris (Stone with lifetime > 0 — mined/loosened, can fall)
function isStoneDebrisAtRow(world: ChunkWorld, wx: number, wy: number): boolean {
  for (let dx = -2; dx <= 2; dx++) {
    if (isLoosenedStone(packedAtWorld(world, wx + dx, wy))) return true;
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
  expect(w.getMaxInventory()).toBe(250); // BASE_INVENTORY_SIZE
});

test("upgrade system increases stats with levels", () => {
  const w = new ChunkWorld();
  w.setUpgrades({ damage: 2, radius: 1, rate: 1, inventorySize: 1 });
  expect(w.getMiningDamage()).toBe(20); // 10 + 2*5
  expect(w.getMiningRadius()).toBe(2); // 1 + 1*1
  expect(w.getMiningRate()).toBe(2); // max(1, 3 - 1*1)
  expect(w.getMaxInventory()).toBe(375); // 250 + 1*125
});

test("upgrade rate has minimum of 1 tick", () => {
  const w = new ChunkWorld();
  w.setUpgrades({ damage: 0, radius: 0, rate: 10, inventorySize: 0 });
  expect(w.getMiningRate()).toBe(1);
});

// --- Mining (raycast) ---

test("mining damages stone and eventually dislodges it to gravel/loose stone", () => {
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

  // After enough hits, stone should be loosened (Stone with lifetime > 0)
  // (mined stone stays Stone but gets a settle timer and can fall)
  for (let i = 0; i < 10; i++) {
    runMine(w, digX, digY);
  }
  expect(isStoneDebrisAtRow(w, digX, digY)).toBe(true);
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

test("mined stone debris falls down due to gravity", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 25;

  // Clear a shaft and set up: stone wall at the bottom
  clearShaft(w, digX, digY);
  placeStoneWall(w, digX, digY);
  placeStoneWall(w, digX, digY + 1);
  placeStoneWall(w, digX, digY + 2);

  // Mine until the stone is dislodged to gravel/loose stone
  for (let i = 0; i < 10; i++) {
    w.mine(digX, digY);
  }
  expect(isStoneDebrisAtRow(w, digX, digY)).toBe(true);

  // Run simulation steps — debris should fall
  runIdle(w, 10);

  // The debris should have moved down from digY
  let foundDebris = false;
  for (let y = digY; y <= digY + 3; y++) {
    if (isStoneDebrisAtRow(w, digX, y)) {
      foundDebris = true;
      break;
    }
  }
  expect(foundDebris).toBe(true);
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
  expect(isStoneDebrisAtRow(w, digX, digY)).toBe(true);
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

// Regression: the mining ray must originate from the player's horizontal
// CENTER, not from player.x + PLAYER_W/2. player.x is already the center of
// the AABB (see mining-player.ts: x0 = floor(px - PLAYER_W/2)). Adding
// PLAYER_W/2 again shifts the ray origin 1.5 cells right, so a ray aimed
// "straight down" actually starts right-of-center and hits terrain on the
// right side of the player at shallow depths.
//
// This test places a stone at (centerX+1, mid-body-height) — a cell that a
// correctly-centered straight-down ray would miss, but a 1.5-right-shifted
// ray would hit at step 0. It also places a stone in the center column below
// the feet to confirm mining still works.
test("mining straight down originates from player center, not offset right", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const centerX = Math.floor(w.player.x);
  const playerTopY = Math.floor(w.player.y);

  // Clear a wide area around the player so no natural terrain interferes.
  for (let y = playerTopY - 2; y <= playerTopY + 14; y++) {
    for (let dx = -6; dx <= 6; dx++) {
      setMatAtWorld(w, centerX + dx, y, Material.Empty);
    }
  }

  // Stone A: center column, below the feet — the ray SHOULD hit this.
  const targetY = playerTopY + 8;
  setMatAtWorld(w, centerX, targetY, Material.Stone);
  // Stone B: 1 cell right of center, at mid-body height — a centered ray
  // going straight down should MISS this, but a +1.5-right-biased ray would
  // hit it at step 0 (before reaching Stone A).
  setMatAtWorld(w, centerX + 1, playerTopY + 3, Material.Stone);

  expect(matAtWorld(w, centerX, targetY)).toBe(Material.Stone);
  expect(matAtWorld(w, centerX + 1, playerTopY + 3)).toBe(Material.Stone);

  // Mine straight down (mouse directly below the player center).
  // With base rate=3, need ~9 calls for 3 actual hits (damage 10, hardness 30).
  for (let i = 0; i < 15; i++) {
    runMine(w, centerX, targetY);
  }

  // Stone A (center, below feet) must be dislodged — mining works.
  // Stone stays Stone but gets a lifetime (loosened, can fall).
  const aPacked = packedAtWorld(w, centerX, targetY);
  expect(isLoosenedStone(aPacked)).toBe(true);

  // Stone B (right of center, body height) must NOT be dislodged — the ray
  // originated from the player center and went straight down, missing it.
  // With the bug (origin at center+1.5), the ray would hit Stone B at step 0
  // and never reach Stone A.
  const bResult = matAtWorld(w, centerX + 1, playerTopY + 3);
  expect(bResult).toBe(Material.Stone);
});

// --- Collection ---

test("collect picks up loose ore near player", async () => {
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
    const collected = await w.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
    tinCollected = collected.find((c) => c.mat === Material.TinOre);
    if (tinCollected) break;
  }

  expect(tinCollected).toBeDefined();
  expect(tinCollected!.count).toBeGreaterThan(0);
});

test("collect does not pick up frozen ore (embedded in stone)", async () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  setMatAtWorld(w, px + 2, py, Material.TinOre);

  // Run a step without mining — the ore is frozen (never mined)
  const collected = await w.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
  });

  const tinCollected = collected.find((c) => c.mat === Material.TinOre);
  expect(tinCollected).toBeUndefined();
});

test("collect respects max inventory size", async () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Fill inventory to max (250 items)
  const fullInventory = [{ mat: Material.Stone, count: 250 }];

  // Place loose ore near player
  clearShaft(w, px, py + 8);
  placeStoneWall(w, px, py + 8, Material.Stone); // ground
  placeStoneWall(w, px, py + 7, Material.TinOre);

  // Mine the ore to loosen it
  for (let i = 0; i < 20; i++) {
    runMine(w, px, py + 7);
  }

  // Run a step with full inventory — should NOT collect
  const collected = await w.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
  }, fullInventory);

  const tinCollected = collected.find((c) => c.mat === Material.TinOre);
  expect(tinCollected).toBeUndefined();
});

test("collect works when inventory has space", async () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Partially fill inventory (10 items, max 250)
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
    const collected = await w.step({
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

test("player tracks last damage material (death cause)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Surround the player completely with lava (wide + tall) so they can't
  // move out of it during the simulation steps
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -2; dy <= 10; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Lava);
    }
  }

  runIdle(w, 10);

  // lastDamageMaterial should be set to a damaging material (lava or fire —
  // lava can convert to fire during simulation)
  const DAMAGING = [Material.Lava, Material.Fire, Material.Plasma, Material.FuseFire, Material.BurningOil, Material.MethaneGas, Material.SulfurGas];
  expect(DAMAGING).toContain(w.player.lastDamageMaterial);
});

test("respawn clears last damage material", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Damage the player with lava
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -2; dy <= 10; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Lava);
    }
  }
  runIdle(w, 10);
  // Player should have taken some damage
  expect(w.player.lastDamageMaterial).not.toBe(0);

  // Respawn
  w.respawn();

  // lastDamageMaterial should be cleared
  expect(w.player.lastDamageMaterial).toBe(0);
});

// --- Bury / crush mechanics ---

test("fully buried player takes crush damage", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialHealth = w.player.health;

  // Completely surround the player with stone (all body cells)
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 8; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Stone);
    }
  }

  // Run a few ticks — player should take damage
  runIdle(w, 5);

  expect(w.player.health).toBeLessThan(initialHealth);
  expect(w.player.lastDamageMaterial).toBe(DeathCause.Suffocation);
});

test("partially buried player can wiggle out", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Place stone only on the right side of the player (partial coverage)
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = 1; dx <= 2; dx++) {
    for (let dy = 0; dy < 7; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Stone);
    }
  }

  const initialX = w.player.x;

  // Press left to wiggle away from the stone
  for (let i = 0; i < 60; i++) {
    w.step({
      left: true, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
  }

  // Player should have moved left (wiggled out)
  expect(w.player.x).toBeLessThan(initialX);
});

test("partially buried player does not take crush damage", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialHealth = w.player.health;

  // Place stone only on one side (partial)
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = 1; dx <= 2; dx++) {
    for (let dy = 0; dy < 7; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Stone);
    }
  }

  runIdle(w, 10);

  // Should not take crush damage (only fully buried triggers crush)
  expect(w.player.health).toBe(initialHealth);
});

// --- Bomb explosion ---

test("explosion dislodges stone to gravel/loose stone in radius", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Place a block of stone at a known location
  const targetX = Math.floor(w.player.x) + 20;
  const targetY = Math.floor(w.player.y) + 10;
  for (let dx = -8; dx <= 8; dx++) {
    for (let dy = -8; dy <= 8; dy++) {
      setMatAtWorld(w, targetX + dx, targetY + dy, Material.Stone);
    }
  }

  // Explode at the center
  w.explode(targetX, targetY, 5);

  // Center stone should be dislodged (loosened Stone with lifetime > 0,
  // not destroyed, not cleared to empty)
  expect(isStoneDebrisAtRow(w, targetX, targetY)).toBe(true);

  // Cells within radius should be dislodged too (loosened Stone)
  expect(isLoosenedStone(packedAtWorld(w, targetX + 3, targetY))).toBe(true);
  expect(isLoosenedStone(packedAtWorld(w, targetX, targetY + 3))).toBe(true);

  // Cells outside radius should remain as stone
  expect(matAtRow(w, targetX + 8, targetY, Material.Stone)).toBe(true);
});

test("explosion does not destroy walls", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const targetX = Math.floor(w.player.x) + 20;
  const targetY = Math.floor(w.player.y) + 10;
  placeStoneWall(w, targetX, targetY, Material.Wall);

  w.explode(targetX, targetY, 5);

  // Wall should still be there
  expect(matAtRow(w, targetX, targetY, Material.Wall)).toBe(true);
});

test("explosion damages player if in range", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialHealth = w.player.health;

  // Explode right at the player's position
  w.explode(w.player.x, w.player.y, 5);

  expect(w.player.health).toBeLessThan(initialHealth);
  // Bombs attribute damage to FuseFire so the death quip reflects the
  // explosion (e.g. "should've cut the red wire"), not generic fire.
  expect(w.player.lastDamageMaterial).toBe(Material.FuseFire);
});

test("explosion does not damage player if out of range", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialHealth = w.player.health;

  // Explode far from the player
  const farX = Math.floor(w.player.x) + 100;
  const farY = Math.floor(w.player.y) + 100;
  w.explode(farX, farY, 5);

  expect(w.player.health).toBe(initialHealth);
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
  // Use Wall (not Stone) as the marker: Wall is solid and never falls, but —
  // unlike Stone — it is immune to the structural-integrity check. A Stone
  // marker placed in the sky (player.y - 5) is an isolated floating block and
  // is correctly demolished by the integrity check, which would conflate with
  // the rebuild-sync behavior this test actually verifies.
  setMatAtWorld(w, markerX, markerY, Material.Wall);

  runIdle(w, 1);

  const chunkBefore = w.getChunkAt(markerX, markerY);
  const { cx, cy } = w.worldToChunk(markerX, markerY);
  const localMx = markerX - cx * CHUNK_W;
  const localMy = markerY - cy * CHUNK_H;
  const markerIdx = localMy * CHUNK_W + localMx;
  expect(chunkBefore.grid[markerIdx] & 0xff).toBe(Material.Wall);

  w.player.x += CHUNK_W;
  runIdle(w, 1);

  w.player.x -= CHUNK_W;
  runIdle(w, 1);

  const chunkAfter = w.getChunkAt(markerX, markerY);
  expect(chunkAfter.grid[markerIdx] & 0xff).toBe(Material.Wall);
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

// --- Respawn ---

test("respawn resets player to spawn point with full health", () => {
  const w = new ChunkWorld();
  // Record initial spawn position BEFORE running any steps (the player
  // falls during simulation, so we capture the constructor's spawn point)
  const spawnX = w.player.x;
  const spawnY = w.player.y;

  runIdle(w, 1);

  // Move player away and damage them
  w.player.x += 100;
  w.player.y += 100;
  w.player.health = 0;

  // Respawn
  w.respawn();

  // Player should be back at spawn with full health
  expect(w.player.x).toBe(spawnX);
  expect(w.player.y).toBe(spawnY);
  expect(w.player.vx).toBe(0);
  expect(w.player.vy).toBe(0);
  expect(w.player.health).toBe(100);
});

test("respawn preserves upgrades", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Set upgrades
  w.setUpgrades({ damage: 3, radius: 2, rate: 1, inventorySize: 1 });
  expect(w.getMiningDamage()).toBe(25);

  // Respawn
  w.respawn();

  // Upgrades should be preserved
  expect(w.getMiningDamage()).toBe(25);
  expect(w.getMiningRadius()).toBe(3);
  expect(w.getMiningRate()).toBe(2);
  expect(w.getMaxInventory()).toBe(375);
});

test("respawn clears mining cooldown", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Mine once to set cooldown
  clearShaft(w, Math.floor(w.player.x), Math.floor(w.player.y) + 20);
  placeStoneWall(w, Math.floor(w.player.x), Math.floor(w.player.y) + 20);
  w.mine(Math.floor(w.player.x), Math.floor(w.player.y) + 20);
  expect(w.mineCooldown).toBeGreaterThan(0);

  // Respawn
  w.respawn();

  // Cooldown should be reset
  expect(w.mineCooldown).toBe(0);
});

// --- WakeTick transfer bug (cells that fall remain collectible) ---

test("loose ore that falls to a new position is still collectible", async () => {
  // Regression test: when a detached (loose) particle falls via physics,
  // its wakeTick was set at its ORIGINAL position, not its new one.
  // The collect() function checks isCellUnfrozen at the current position,
  // which had wakeTick=0, so the particle was never collected.
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Set up: stone floor far below, ore above it with empty space to fall through
  const floorY = py + 12;
  clearShaft(w, px, floorY);
  placeStoneWall(w, px, floorY, Material.Stone); // stone floor
  // Place ore 5 cells above the floor with empty space below it
  const oreY = floorY - 5;
  for (let dx = -2; dx <= 2; dx++) {
    setMatAtWorld(w, px + dx, oreY, Material.TinOre);
  }

  // Mine the ore to loosen it (sets FLAG_DETACHED + markCellUnfrozen)
  for (let i = 0; i < 20; i++) {
    runMine(w, px, oreY);
  }

  // Verify ore is loosened (FLAG_DETACHED set, gravity enabled)
  // Run several steps to let the ore fall to the floor
  let tinCollected: { mat: number; count: number } | undefined;
  for (let i = 0; i < 30; i++) {
    const collected = await w.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
    tinCollected = collected.find((c) => c.mat === Material.TinOre);
    if (tinCollected) break;
  }

  // The ore should have been collected after falling near the player
  expect(tinCollected).toBeDefined();
  expect(tinCollected!.count).toBeGreaterThan(0);
});

test("loose stone debris that falls multiple cells is still collectible", async () => {
  // Regression: stone debris (loosened Stone from mined stone) falls and
  // should remain collectible at its landing position.
  const w = new ChunkWorld();
  runIdle(w, 1);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Set up: stone floor below player, stone wall above to mine
  const floorY = py + 10;
  clearShaft(w, px, floorY);
  placeStoneWall(w, px, floorY, Material.Stone); // floor
  const wallY = py + 3;
  placeStoneWall(w, px, wallY, Material.Stone); // stone to mine

  // Mine the stone until it becomes loosened (Stone with lifetime > 0, falls)
  for (let i = 0; i < 15; i++) {
    runMine(w, px, wallY);
  }

  // The debris should fall and be collected as Stone
  let debrisCollected: { mat: number; count: number } | undefined;
  for (let i = 0; i < 30; i++) {
    const collected = await w.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
    debrisCollected = collected.find(
      (c) => c.mat === Material.Stone,
    );
    if (debrisCollected) break;
  }

  expect(debrisCollected).toBeDefined();
  expect(debrisCollected!.count).toBeGreaterThan(0);
});

// ============================================================================
// Structural integrity — auto-demolish cells disconnected from the main world.
//
// Static Stone has gravity=0, so a block fully surrounded by empty space (a
// "floating island") hangs forever. The integrity check is a 4-connected
// flood-fill from the active-grid border; unreached solid cells are demolished
// (converted to loose falling debris, same as explode()). Walls are immune.
// ============================================================================

// Helper: find the first solid Stone cell below the player (in generated
// terrain) so tests have a known connected stone cell to assert against.
function firstStoneBelowPlayer(world: ChunkWorld): { x: number; y: number } {
  const px = Math.floor(world.player.x);
  const py = Math.floor(world.player.y);
  for (let y = py + 2; y < py + 200; y++) {
    if (matAtWorld(world, px, y) === Material.Stone) return { x: px, y };
  }
  throw new Error("no stone found below player");
}

test("structural integrity: a floating island of stone is demolished", () => {
  const w = new ChunkWorld();
  runIdle(w, 5); // settle player + fire initial integrity check

  // Pick a spot near the player and clear a cavity, then place an isolated
  // static stone block in the center.
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  const bx = px + 15;
  const by = py + 15;
  // Clear a 7×7 cavity (the surrounding terrain stays — connected to border).
  clearRegion(w, bx - 3, by - 3, bx + 3, by + 3);
  // Place a static stone block isolated in the middle of the cavity.
  setStaticCellAtWorld(w, bx, by, Material.Stone);
  expect(matAtWorld(w, bx, by)).toBe(Material.Stone);

  // Force the integrity check. The block is surrounded by empty space →
  // unreachable from the border → demolished to loosened Stone (lifetime > 0).
  w.forceIntegrityCheckForTest();

  const p = packedAtWorld(w, bx, by);
  expect(isLoosenedStone(p)).toBe(true);
});

test("structural integrity: stone connected to the main world is not demolished", () => {
  const w = new ChunkWorld();
  runIdle(w, 5);

  // A stone cell in the generated terrain (connected to the bottom border via
  // the surrounding stone mass) must survive the integrity check.
  const stone = firstStoneBelowPlayer(w);
  expect(matAtWorld(w, stone.x, stone.y)).toBe(Material.Stone);

  w.forceIntegrityCheckForTest();

  expect(matAtWorld(w, stone.x, stone.y)).toBe(Material.Stone);
});

test("structural integrity: Walls are immune (never demolished)", () => {
  const w = new ChunkWorld();
  runIdle(w, 5);

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  const bx = px + 15;
  const by = py + 15;
  // Clear a cavity and place an isolated Wall block.
  clearRegion(w, bx - 3, by - 3, bx + 3, by + 3);
  setStaticCellAtWorld(w, bx, by, Material.Wall);
  expect(matAtWorld(w, bx, by)).toBe(Material.Wall);

  w.forceIntegrityCheckForTest();

  // Wall is solid (participates in the connectivity graph) but the demolish
  // loop skips it — it stays even though it's disconnected.
  expect(matAtWorld(w, bx, by)).toBe(Material.Wall);
});

test("structural integrity: check is gated by cadence between edits", () => {
  const w = new ChunkWorld();
  runIdle(w, 30); // settle player; initial check fires (needsIntegrityCheck)

  // Reset the cadence timer so the next check is gated by INTEGRITY_CHECK_INTERVAL
  // from NOW (not from tick 1, when the initial check ran). Without this, the
  // cadence would elapse mid-way through the idle-step loop below.
  w.forceIntegrityCheckForTest();

  // Place an isolated static stone block DEEP in the stone body. Near the
  // surface the dirt/grass layer has gravity (gravityDir=1) and would fall
  // into a cleared cavity during idle steps, reconnecting the block. Deep
  // stone (gravityDir=0) never falls, so the cavity persists.
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  const bx = px + 15;
  const by = py + 200; // deep stone body — below the dirt layer
  clearRegion(w, bx - 3, by - 3, bx + 3, by + 3);
  setStaticCellAtWorld(w, bx, by, Material.Stone);
  expect(matAtWorld(w, bx, by)).toBe(Material.Stone);

  // Set the dirty flag by exploding far from the block. explode() always
  // sets terrainDirtyForIntegrity=true, so the cadence gate is the only thing
  // holding the check back. The blast is far enough that its debris won't
  // reach the isolated block's cavity.
  w.explode(px - 60, py + 60, 3);

  // Step for fewer than INTEGRITY_CHECK_INTERVAL ticks. The check must NOT
  // run (cadence not elapsed, no rebuild) → the isolated block survives.
  for (let i = 0; i < INTEGRITY_CHECK_INTERVAL - 1; i++) {
    runIdle(w, 1);
    if (matAtWorld(w, bx, by) !== Material.Stone) break;
  }
  expect(matAtWorld(w, bx, by)).toBe(Material.Stone);

  // Step past the cadence. Now the check runs and demolishes the block.
  // Demolished stone stays Stone but gets lifetime > 0 (loosened, can fall).
  for (let i = 0; i < 5; i++) {
    runIdle(w, 1);
    if (isLoosenedStone(packedAtWorld(w, bx, by))) break;
  }
  const p = packedAtWorld(w, bx, by);
  expect(isLoosenedStone(p)).toBe(true);
});

test("structural integrity: demolish cap limits cells demolished per check", () => {
  const w = new ChunkWorld();
  runIdle(w, 5);

  // Lower the cap so we can exceed it with a small grid of isolated blocks.
  w.integrityMaxDemolish = 3;

  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  // Place 10 isolated static stone blocks, each in its own 3×3 cavity spaced
  // 5 cells apart so none touch each other or the surrounding terrain.
  const blocks: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const bx = px + 10 + i * 6;
    const by = py + 10;
    clearRegion(w, bx - 1, by - 1, bx + 1, by + 1);
    setStaticCellAtWorld(w, bx, by, Material.Stone);
    blocks.push([bx, by]);
  }

  w.forceIntegrityCheckForTest();

  // Exactly `integrityMaxDemolish` blocks should be demolished (loosened —
  // Stone with lifetime > 0); the rest stay static Stone (lifetime === 0,
  // deferred to the next check).
  let demolished = 0;
  let remaining = 0;
  for (const [bx, by] of blocks) {
    const p = packedAtWorld(w, bx, by);
    if (isLoosenedStone(p)) demolished++;
    else if ((p & 0xff) === Material.Stone) remaining++;
  }
  expect(demolished).toBe(3);
  expect(remaining).toBe(7);
});
