import { describe, expect, test } from "bun:test";
import {
    BLOCK_AIR,
    BLOCK_GRASS,
    BLOCK_LEAF_APPLE,
    BLOCK_SAPLING,
    BLOCK_WATER,
    BLOCK_WOOD_APPLE
} from "../shared/constants";
import { getSpeciesIndex, getTreeTag, makeTaggedBlock, TREE_SPECIES } from "../shared/tree-species";
import { fellTree } from "./tree-fell";
import { stepTreeDaily, type TreeBlockWorld, type TreeDropEntity } from "./tree-sim";

const W = 32;
const H = 32;

function makeGrid(): Uint16Array {
  return new Uint16Array(W * H);
}

function makeVfx(): Uint32Array {
  return new Uint32Array(W * H);
}

function setFg(fg: Uint16Array, x: number, y: number, id: number): void {
  fg[y * W + x] = id;
}

function setBg(bg: Uint16Array, x: number, y: number, id: number): void {
  bg[y * W + x] = id;
}

function getBg(bg: Uint16Array, x: number, y: number): number {
  return bg[y * W + x] & 0xFF;
}

// vfx encoding helper (must match tree-sim.ts)
function packSaplingVfx(speciesIdx: number, targetH: number, currentH: number, days: number): number {
  return (speciesIdx & 0xF) |
    ((targetH & 0xF) << 4) |
    ((currentH & 0xF) << 8) |
    ((days & 0xFF) << 12);
}

// Mock BlockWorld that just wraps the arrays
function makeWorld(fg: Uint16Array, bg: Uint16Array, vfx: Uint32Array): TreeBlockWorld {
  return {
    activeForeground: fg,
    activeBackground: bg,
    activeVfx: vfx,
    getActiveOriginCx: () => 0,
    getActiveOriginCy: () => 0,
    setActiveBackground(ax: number, ay: number, blockId: number) {
      bg[ay * W + ax] = blockId;
    },
    setActiveVfx(ax: number, ay: number, value: number) {
      vfx[ay * W + ax] = value;
    },
  };
}

// Find the apple species index
const appleSpecies = TREE_SPECIES.find((s) => s.id === "apple")!;
const appleIdx = getSpeciesIndex(appleSpecies);

// Helper: make a fruit drop entity
function makeFruitDrop(x: number, y: number, age: number, fallen: boolean): TreeDropEntity {
  return {
    x: x + 0.5, y: y + 0.5, vx: 0, vy: 0,
    spin: 0, spinSpeed: 2, itemCode: 22, // DROP_APPLE
    count: 1, lifetime: Infinity, onGround: !fallen,
    kind: 1, speciesIdx: 0, age, fallen,
  };
}

// Helper: make a seed drop entity
function makeSeedDrop(x: number, y: number, age: number, fallen: boolean): TreeDropEntity {
  return {
    x: x + 0.5, y: y + 0.5, vx: 0, vy: 0,
    spin: 0, spinSpeed: 2, itemCode: 33, // DROP_SEED
    count: 1, lifetime: Infinity, onGround: !fallen,
    kind: 2, speciesIdx: appleIdx, age, fallen,
  };
}

describe("stepTreeDaily", () => {
  test("spawns fruit drop entities on leaf blocks (~10% chance)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const drops: TreeDropEntity[] = [];
    const world = makeWorld(fg, bg, vfx);

    // Place 100 leaf blocks in the background
    for (let i = 0; i < 100; i++) {
      const x = 2 + (i % 28);
      const y = 2 + Math.floor(i / 28);
      setBg(bg, x, y, BLOCK_LEAF_APPLE);
    }

    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);

    // Count fruit drop entities (kind=1)
    const fruitCount = drops.filter((d) => d.kind === 1).length;
    expect(fruitCount).toBeGreaterThan(0);
    expect(fruitCount).toBeLessThan(30);
  });

  test("spawns seed drop entities on leaf blocks (~3% chance)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const drops: TreeDropEntity[] = [];
    const world = makeWorld(fg, bg, vfx);

    // Place 200 leaf blocks
    for (let i = 0; i < 200; i++) {
      const x = 1 + (i % 30);
      const y = 1 + Math.floor(i / 30);
      if (y < 31) setBg(bg, x, y, BLOCK_LEAF_APPLE);
    }

    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);

    const seedCount = drops.filter((d) => d.kind === 2).length;
    expect(seedCount).toBeLessThan(20);
  });

  test("fruit ages and falls after 2 days on the tree", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const drops: TreeDropEntity[] = [makeFruitDrop(5, 10, 0, false)];
    const world = makeWorld(fg, bg, vfx);

    // Day 1: age becomes 1 (not yet 2, so no fall)
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);
    expect(drops.length).toBe(1);
    expect(drops[0].age).toBe(1);
    expect(drops[0].fallen).toBe(false);
    expect(drops[0].onGround).toBe(true); // still on tree

    // Day 2: age becomes 2 → falls
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, drops, world);
    expect(drops.length).toBe(1);
    expect(drops[0].age).toBe(2);
    expect(drops[0].fallen).toBe(true);
    expect(drops[0].onGround).toBe(false); // now falling (gravity will apply)
  });

  test("fallen fruit despawns after 1 day on the ground (age 3)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const drops: TreeDropEntity[] = [makeFruitDrop(5, 14, 2, true)];
    const world = makeWorld(fg, bg, vfx);

    // Fruit is fallen, age=2. After daily step → age=3 → despawn
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);
    expect(drops.length).toBe(0);
  });

  test("seed ages and scatters after 7 days on the tree", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const drops: TreeDropEntity[] = [makeSeedDrop(5, 10, 0, false)];
    const world = makeWorld(fg, bg, vfx);

    // Run 6 daily steps (age 0→6, not yet 7)
    for (let day = 0; day < 6; day++) {
      stepTreeDaily(fg, bg, vfx, day * 18000, "spring", W, H, drops, world);
    }
    expect(drops.length).toBe(1);
    expect(drops[0].age).toBe(6);
    expect(drops[0].fallen).toBe(false);

    // Day 7: age becomes 7 → scatter + fall
    stepTreeDaily(fg, bg, vfx, 6 * 18000, "spring", W, H, drops, world);
    expect(drops.length).toBe(1);
    expect(drops[0].age).toBe(7);
    expect(drops[0].fallen).toBe(true);
    expect(drops[0].onGround).toBe(false); // now falling
    // X should have shifted by the scatter offset (within ±7)
    expect(Math.abs(drops[0].x - 5.5)).toBeLessThanOrEqual(7.5);
  });

  test("fallen seed plants a sapling on valid ground (grass)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    // Place a fallen seed at (5, 14), age=7 (about to hit age 8)
    const drops: TreeDropEntity[] = [makeSeedDrop(5, 14, 7, true)];
    // Place grass below
    setFg(fg, 5, 15, BLOCK_GRASS);
    const world = makeWorld(fg, bg, vfx);

    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);

    // Seed should be removed
    expect(drops.length).toBe(0);
    // Sapling should be in the background at (5, 14)
    expect(getBg(bg, 5, 14)).toBe(BLOCK_SAPLING);
  });

  test("fallen seed despawns on invalid ground (water)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const drops: TreeDropEntity[] = [makeSeedDrop(5, 14, 7, true)];
    // Place water below (invalid ground)
    setFg(fg, 5, 15, BLOCK_WATER);
    const world = makeWorld(fg, bg, vfx);

    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);

    // Seed should be removed, no sapling
    expect(drops.length).toBe(0);
    expect(getBg(bg, 5, 14)).toBe(BLOCK_AIR);
  });

  test("sapling grows 1 wood block per day", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Place a sapling at (5, 20) with target height=3, current=0
    setBg(bg, 5, 20, BLOCK_SAPLING);
    vfx[20 * W + 5] = packSaplingVfx(appleIdx, 3, 0, 0);

    // Day 1: grow 1 wood block at (5, 19)
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, [], world);
    expect(getBg(bg, 5, 19)).toBe(BLOCK_WOOD_APPLE);

    // Day 2: grow 1 more wood block at (5, 18)
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, [], world);
    expect(getBg(bg, 5, 18)).toBe(BLOCK_WOOD_APPLE);

    // Day 3: grow 1 more wood block at (5, 17) → trunk reaches target=3
    stepTreeDaily(fg, bg, vfx, 36000, "spring", W, H, [], world);
    expect(getBg(bg, 5, 17)).toBe(BLOCK_WOOD_APPLE);

    // Sapling should have matured into wood block at (5, 20)
    expect(getBg(bg, 5, 20)).toBe(BLOCK_WOOD_APPLE);
  });

  test("sapling grows canopy leaves as trunk grows", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Place a sapling at (10, 20) with target height=3, current=0
    setBg(bg, 10, 20, BLOCK_SAPLING);
    vfx[20 * W + 10] = packSaplingVfx(appleIdx, 3, 0, 0);

    // Run 1 daily step (trunk grows to height 1)
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, [], world);

    // After growth, there should be some leaf blocks near the trunk top
    let leafCount = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (getBg(bg, x, y) === BLOCK_LEAF_APPLE) leafCount++;
      }
    }
    expect(leafCount).toBeGreaterThan(0);
  });

  test("sapling matures into wood block when trunk reaches target height", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Place a sapling at (5, 20) with target height=2, current=0
    setBg(bg, 5, 20, BLOCK_SAPLING);
    vfx[20 * W + 5] = packSaplingVfx(appleIdx, 2, 0, 0);

    // Day 1: trunk grows to height 1
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, [], world);
    expect(getBg(bg, 5, 20)).toBe(BLOCK_SAPLING); // still a sapling
    expect(getBg(bg, 5, 19)).toBe(BLOCK_WOOD_APPLE);

    // Day 2: trunk grows to height 2 → matures
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, [], world);
    expect(getBg(bg, 5, 18)).toBe(BLOCK_WOOD_APPLE);
    expect(getBg(bg, 5, 20)).toBe(BLOCK_WOOD_APPLE); // sapling → wood
  });

  test("does not spawn fruit on a cell that already has a fruit drop", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    // Place a leaf at (5, 10) with an existing fruit drop
    setBg(bg, 5, 10, BLOCK_LEAF_APPLE);
    const drops: TreeDropEntity[] = [makeFruitDrop(5, 10, 0, false)];
    const world = makeWorld(fg, bg, vfx);

    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, drops, world);

    // The existing fruit should have aged (age 1), and no new fruit at (5, 10)
    const fruitsAt510 = drops.filter((d) => d.kind === 1 && Math.floor(d.x) === 5 && Math.floor(d.y) === 10);
    expect(fruitsAt510.length).toBe(1);
    expect(fruitsAt510[0].age).toBe(1);
  });

  test("sapling does not grow in winter (paused by season)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Place a sapling at (5, 20) with target height=3, current=0
    setBg(bg, 5, 20, BLOCK_SAPLING);
    vfx[20 * W + 5] = packSaplingVfx(appleIdx, 3, 0, 0);

    // Run a daily step in winter — trunk should NOT grow
    stepTreeDaily(fg, bg, vfx, 0, "winter", W, H, [], world);
    expect(getBg(bg, 5, 19)).toBe(BLOCK_AIR); // no wood placed
    expect(getBg(bg, 5, 20)).toBe(BLOCK_SAPLING); // still a sapling

    // Now run in spring — trunk should grow
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, [], world);
    expect(getBg(bg, 5, 19)).toBe(BLOCK_WOOD_APPLE);
  });

  test("sapling-grown tree has a non-zero tree tag (felling isolation)", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Place a sapling at (5, 20) with target height=2, current=0
    setBg(bg, 5, 20, BLOCK_SAPLING);
    vfx[20 * W + 5] = packSaplingVfx(appleIdx, 2, 0, 0);

    // Grow to maturity (2 days in spring)
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, [], world);
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, [], world);

    // The sapling base should have matured into tagged wood (not raw BLOCK_WOOD_APPLE)
    const basePacked = bg[20 * W + 5];
    expect(basePacked & 0xFF).toBe(BLOCK_WOOD_APPLE);
    const tag = getTreeTag(basePacked);
    expect(tag).not.toBe(0); // must have a non-zero tag for felling isolation

    // The trunk wood should have the same tag
    const trunkPacked = bg[19 * W + 5];
    expect(trunkPacked & 0xFF).toBe(BLOCK_WOOD_APPLE);
    expect(getTreeTag(trunkPacked)).toBe(tag);
  });

  test("felling a sapling-grown tree does not fell a neighboring tree", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Grow a sapling-grown tree at x=5 (tag from world coords 5,20)
    setBg(bg, 5, 20, BLOCK_SAPLING);
    vfx[20 * W + 5] = packSaplingVfx(appleIdx, 2, 0, 0);
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, [], world);
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, [], world);

    // Place a terrain-gen tree at x=8 with a different tag (tag=99)
    setBg(bg, 8, 20, makeTaggedBlock(BLOCK_WOOD_APPLE, 99));
    setBg(bg, 8, 19, makeTaggedBlock(BLOCK_WOOD_APPLE, 99));
    setBg(bg, 8, 18, makeTaggedBlock(BLOCK_LEAF_APPLE, 99));
    // Connect canopies: leaf from sapling tree at (5,18) and terrain tree at (8,18)
    // They're 3 blocks apart — not connected, so felling one shouldn't affect the other.

    // Fell the sapling-grown tree (mine its trunk at 5,19)
    const felled = fellTree(bg, W, H, 5, 19);
    const felledIds = felled.map((c) => c.blockId);

    // The sapling-grown tree should be felled (2 wood + leaves)
    expect(felledIds).toContain(BLOCK_WOOD_APPLE);

    // The terrain-gen tree at x=8 should NOT be felled
    expect(felled.some((c) => c.x === 8)).toBe(false);
  });

  test("sapling at grid top matures when it hits the ceiling", () => {
    const fg = makeGrid();
    const bg = makeGrid();
    const vfx = makeVfx();
    const world = makeWorld(fg, bg, vfx);

    // Place a sapling at y=1 with target height=5 (can only grow 1 block up to y=0)
    setBg(bg, 5, 1, BLOCK_SAPLING);
    vfx[1 * W + 5] = packSaplingVfx(appleIdx, 5, 0, 0);

    // Day 1: grows 1 block to y=0 (trunk height 1)
    stepTreeDaily(fg, bg, vfx, 0, "spring", W, H, [], world);
    expect(getBg(bg, 5, 0)).toBe(BLOCK_WOOD_APPLE);

    // Day 2: can't grow further (trunkY = 1 - 1 - 1 = -1 < 0) → matures at height 1
    stepTreeDaily(fg, bg, vfx, 18000, "spring", W, H, [], world);
    // Sapling should have matured into wood (not stuck as sapling forever)
    expect(getBg(bg, 5, 1)).toBe(BLOCK_WOOD_APPLE);
  });
});
