import { DEFAULT_GRAVITY, FIELD, Material, packCell } from "@downdraft/library-sand";
import { expect, test } from "bun:test";
import { ACTIVE_GRID_W, CHUNK_H, CHUNK_W, FREEZE_TICKS } from "../shared/constants";
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

// Helper: run one step with a dig at the given world coords
function runDig(world: ChunkWorld, wx: number, wy: number, radius: number = 3): void {
  world.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: true, mouseX: wx, mouseY: wy, digRadius: radius,
  });
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

// --- Digging ---

test("dig clears stone cell and converts stone above to dirt", () => {
  const w = new ChunkWorld();
  runIdle(w, 1); // initialize active grid

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;

  // Place stone at digY and above it
  setMatAtWorld(w, digX, digY, Material.Stone);
  setMatAtWorld(w, digX, digY - 1, Material.Stone);

  expect(matAtWorld(w, digX, digY)).toBe(Material.Stone);
  expect(matAtWorld(w, digX, digY - 1)).toBe(Material.Stone);

  // Call dig() directly to check immediate effect (before simulation)
  const collected = w.dig(digX, digY, 0);

  // Dug cell should be cleared (empty)
  expect(matAtWorld(w, digX, digY)).toBe(Material.Empty);
  // Stone above should be converted to dirt (loose falling particle)
  expect(matAtWorld(w, digX, digY - 1)).toBe(Material.Dirt);
  // dig() no longer collects directly — collection is proximity-based only
  expect(collected).toHaveLength(0);
});

test("dig does not destroy Wall material", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 10;

  // Place a wall
  setMatAtWorld(w, digX, digY, Material.Wall);
  expect(matAtWorld(w, digX, digY)).toBe(Material.Wall);

  runDig(w, digX, digY, 0);

  // Wall should still be there
  expect(matAtWorld(w, digX, digY)).toBe(Material.Wall);
});

test("dig marks chunk as dirty", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;
  setMatAtWorld(w, digX, digY, Material.Stone);

  // Call dig() directly to check chunk dirty flag without simulation
  w.dig(digX, digY, 0);

  // The chunk containing the dug cell should be dirty
  const { cx, cy } = w.worldToChunk(digX, digY);
  const chunk = w.getChunkAt(digX, digY);
  expect(chunk.cx).toBe(cx);
  expect(chunk.cy).toBe(cy);
  expect(chunk.dirty).toBe(true);
});

test("dug dirt particle falls down due to gravity", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  // Dig deep enough to be in the Stone layer (below the variable-thickness
  // dirt layer). The dirt layer can be up to ~surface + 10 cells thick, and
  // the player spawns ~9 cells above the surface, so +25 ensures we're in Stone.
  const digY = Math.floor(w.player.y) + 25;

  // Set up: stone column
  for (let y = digY - 2; y <= digY + 2; y++) {
    setMatAtWorld(w, digX, y, Material.Stone);
  }

  // Call dig() directly to clear cell and convert above to dirt
  w.dig(digX, digY, 0);
  expect(matAtWorld(w, digX, digY)).toBe(Material.Empty);
  expect(matAtWorld(w, digX, digY - 1)).toBe(Material.Dirt);

  // Run simulation steps — dirt should fall into the hole
  runIdle(w, 10);

  // The dirt should no longer be at digY-1 (it fell)
  expect(matAtWorld(w, digX, digY - 1)).toBe(Material.Empty);
  // It should be at digY or below (settled on stone)
  let foundDirt = false;
  for (let y = digY; y <= digY + 3; y++) {
    if (matAtWorld(w, digX, y) === Material.Dirt) {
      foundDirt = true;
      break;
    }
  }
  expect(foundDirt).toBe(true);
});

// --- Collection ---

test("collect picks up loose ore near player", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Place a loose ore particle near the player
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);

  // Place ore on solid ground so it doesn't fall away.
  // Use a 3-cell wide stone platform so the ore can't fall diagonally
  // past the ground (the player spawns above the surface, so neighboring
  // cells at this depth may be empty sky).
  for (let dx = -1; dx <= 1; dx++) {
    setMatAtWorld(w, px + dx, py + 8, Material.Stone); // ground below
  }
  setMatAtWorld(w, px, py + 7, Material.TinOre); // ore resting on ground

  // The dig step itself runs collect at the end, so the ore may be collected
  // during this step. Capture the collected items.
  const collectedFromDig = w.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: true, mouseX: px, mouseY: py + 7, digRadius: 0,
  });

  // Check if collected during the dig step
  let tinCollected = collectedFromDig.find((c) => c.mat === Material.TinOre);

  // If not collected during dig, run another idle step
  if (!tinCollected) {
    const collectedIdle = w.step({
      left: false, right: false, up: false, down: false,
      jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
    });
    tinCollected = collectedIdle.find((c) => c.mat === Material.TinOre);
  }

  // Should have collected some tin ore in one of the two steps
  expect(tinCollected).toBeDefined();
  expect(tinCollected!.count).toBeGreaterThan(0);
});

test("collect does not pick up frozen ore (embedded in stone)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Place ore but don't dig it (stays frozen)
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  setMatAtWorld(w, px + 2, py, Material.TinOre);

  // Run a step without digging — the ore is frozen (never dug)
  const collected = w.step({
    left: false, right: false, up: false, down: false,
    jump: false, mouseDown: false, mouseX: 0, mouseY: 0, digRadius: 3,
  });

  // Should NOT have collected the frozen ore
  const tinCollected = collected.find((c) => c.mat === Material.TinOre);
  expect(tinCollected).toBeUndefined();
});

// --- Freeze optimization ---

test("dug cells have wakeTick set (unfrozen)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;
  // Place stone at digY and above it so dig converts above to dirt
  setMatAtWorld(w, digX, digY, Material.Stone);
  setMatAtWorld(w, digX, digY - 1, Material.Stone);

  const tickBefore = w.currentTick;
  runDig(w, digX, digY, 0);

  // The dug cell itself is cleared (wakeTick = 0)
  const chunk = w.getChunkAt(digX, digY);
  const { cx, cy } = w.worldToChunk(digX, digY);
  const localX = digX - cx * CHUNK_W;
  const localY = digY - cy * CHUNK_H;
  const localIdx = localY * CHUNK_W + localX;
  expect(chunk.wakeTick[localIdx]).toBe(0);

  // The cell above (converted to dirt) should have wakeTick set (unfrozen)
  const aboveLocalIdx = (localY - 1) * CHUNK_W + localX;
  expect(chunk.wakeTick[aboveLocalIdx]).toBeGreaterThan(tickBefore);
});

test("wakeTick expires after FREEZE_TICKS (re-freeze)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const digX = Math.floor(w.player.x);
  const digY = Math.floor(w.player.y) + 20;
  setMatAtWorld(w, digX, digY, Material.Stone);
  setMatAtWorld(w, digX, digY - 1, Material.Stone);

  // Dig to unfreeze (clears digY, converts digY-1 to dirt and unfreezes it)
  runDig(w, digX, digY, 0);
  const chunk = w.getChunkAt(digX, digY);
  const { cx, cy } = w.worldToChunk(digX, digY);
  const localX = digX - cx * CHUNK_W;
  const localY = digY - cy * CHUNK_H;
  // Check the cell above (which was converted to dirt and unfrozen)
  const aboveLocalIdx = (localY - 1) * CHUNK_W + localX;

  expect(chunk.wakeTick[aboveLocalIdx]).toBeGreaterThan(0);

  // Verify the wakeTick was set to currentTick + FREEZE_TICKS
  const tickAfterDig = w.currentTick;
  expect(chunk.wakeTick[aboveLocalIdx]).toBe(tickAfterDig + FREEZE_TICKS);
});

// --- Player physics ---

test("player falls due to gravity", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialY = w.player.y;

  // Run several steps — player should fall (or land on ground)
  runIdle(w, 30);

  // Player should have moved down (y increases) or landed on ground
  expect(w.player.y).toBeGreaterThanOrEqual(initialY);
});

test("player health decreases when touching lava", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialHealth = w.player.health;

  // Place lava around the player
  const px = Math.floor(w.player.x);
  const py = Math.floor(w.player.y);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = 0; dy < 8; dy++) {
      setMatAtWorld(w, px + dx, py + dy, Material.Lava);
    }
  }

  // Run a few steps — player should take damage
  runIdle(w, 5);

  expect(w.player.health).toBeLessThan(initialHealth);
});

// --- Chunk management ---

test("active grid rebuilds when player crosses chunk boundary", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  const initialLoaded = w.getLoadedChunkCount();

  // Move player far to the right (cross multiple chunk boundaries)
  w.player.x += CHUNK_W * 3;

  runIdle(w, 1);

  // Should have loaded new chunks
  const newLoaded = w.getLoadedChunkCount();
  expect(newLoaded).toBeGreaterThanOrEqual(initialLoaded);
});

test("chunk data is not corrupted during rebuild (origin sync bug)", () => {
  const w = new ChunkWorld();
  runIdle(w, 1);

  // Place a distinctive material (Stone, gravity=0 so it won't fall) at a
  // known world position above the surface (in empty space)
  const markerX = Math.floor(w.player.x) + 5;
  const markerY = Math.floor(w.player.y) - 5; // above player (in sky)
  setMatAtWorld(w, markerX, markerY, Material.Stone);

  // Sync the active grid to chunks (so the marker is persisted)
  runIdle(w, 1);

  // Read the marker from chunk storage
  const chunkBefore = w.getChunkAt(markerX, markerY);
  const { cx, cy } = w.worldToChunk(markerX, markerY);
  const localMx = markerX - cx * CHUNK_W;
  const localMy = markerY - cy * CHUNK_H;
  const markerIdx = localMy * CHUNK_W + localMx;
  expect(chunkBefore.grid[markerIdx] & 0xff).toBe(Material.Stone);

  // Move player to trigger a rebuild (cross a chunk boundary)
  w.player.x += CHUNK_W;
  runIdle(w, 1);

  // Move player back to trigger another rebuild
  w.player.x -= CHUNK_W;
  runIdle(w, 1);

  // The marker should still be in chunk storage at the same position
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
