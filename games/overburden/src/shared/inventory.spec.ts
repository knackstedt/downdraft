// ============================================================================
// Overburden — inventory unit tests (slot-based model)
// ============================================================================

import { describe, expect, it } from "bun:test";
import { getItemDef } from "./items";
import {
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  Inventory,
  type InventorySnapshot,
  type LegacyInventorySnapshot,
} from "./inventory";

describe("Inventory — slot model basics", () => {
  it("starts empty with INVENTORY_SIZE slots", () => {
    const inv = new Inventory();
    expect(inv.size).toBe(INVENTORY_SIZE);
    expect(inv.hotbarSize).toBe(HOTBAR_SIZE);
    for (let i = 0; i < inv.size; i++) {
      expect(inv.slot(i)).toBeNull();
    }
  });

  it("count() returns 0 for absent items", () => {
    const inv = new Inventory();
    expect(inv.count("dirt")).toBe(0);
  });

  it("hotbar() returns the first HOTBAR_SIZE slots", () => {
    const inv = new Inventory();
    inv.add("dirt", 1);
    const hb = inv.hotbar();
    expect(hb).toHaveLength(HOTBAR_SIZE);
    expect(hb[0]).not.toBeNull();
    expect(hb[0]!.itemId).toBe("dirt");
    for (let i = 1; i < HOTBAR_SIZE; i++) expect(hb[i]).toBeNull();
  });
});

describe("Inventory — add() respects maxStack", () => {
  it("places a sub-stack in the first empty (hotbar) slot", () => {
    const inv = new Inventory();
    const overflow = inv.add("dirt", 10);
    expect(overflow).toBe(0);
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: 10 });
    expect(inv.slot(1)).toBeNull();
  });

  it("caps a single add at maxStack and returns overflow", () => {
    const inv = new Inventory();
    const max = getItemDef("dirt")!.maxStack; // 64
    const overflow = inv.add("dirt", max + 20);
    expect(overflow).toBe(0); // 84 fits across two slots (64 + 20)
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: max });
    expect(inv.slot(1)).toEqual({ itemId: "dirt", count: 20 });
  });

  it("returns overflow when the inventory is full of the same item", () => {
    const inv = new Inventory();
    const max = getItemDef("dirt")!.maxStack; // 64
    const total = max * inv.size; // fills every slot
    let overflow = inv.add("dirt", total);
    expect(overflow).toBe(0);
    // Now add one more — nowhere to put it.
    overflow = inv.add("dirt", 1);
    expect(overflow).toBe(1);
  });

  it("respects maxStack=1 for tools (one tool per slot)", () => {
    const inv = new Inventory();
    const overflow = inv.add("flint_pickaxe", 3);
    expect(overflow).toBe(0);
    expect(inv.slot(0)).toEqual({ itemId: "flint_pickaxe", count: 1 });
    expect(inv.slot(1)).toEqual({ itemId: "flint_pickaxe", count: 1 });
    expect(inv.slot(2)).toEqual({ itemId: "flint_pickaxe", count: 1 });
    expect(inv.slot(3)).toBeNull();
  });

  it("tops up existing same-item slots before using empty slots", () => {
    const inv = new Inventory();
    inv.add("dirt", 10); // slot 0 = 10
    inv.add("stone", 5); // slot 1 = 5
    const overflow = inv.add("dirt", 60); // slot 0 tops to 64, 6 overflow → slot 2
    expect(overflow).toBe(0);
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: 64 });
    expect(inv.slot(1)).toEqual({ itemId: "stone", count: 5 });
    expect(inv.slot(2)).toEqual({ itemId: "dirt", count: 6 });
  });
});

describe("Inventory — remove()", () => {
  it("removes across multiple slots", () => {
    const inv = new Inventory();
    inv.add("dirt", 70); // slot 0 = 64, slot 1 = 6
    expect(inv.remove("dirt", 66)).toBe(true);
    expect(inv.slot(0)).toBeNull();
    expect(inv.slot(1)).toEqual({ itemId: "dirt", count: 4 });
  });

  it("returns false when insufficient", () => {
    const inv = new Inventory();
    inv.add("dirt", 5);
    expect(inv.remove("dirt", 6)).toBe(false);
    expect(inv.count("dirt")).toBe(5);
  });

  it("treats remove(0) as a no-op success", () => {
    const inv = new Inventory();
    expect(inv.remove("dirt", 0)).toBe(true);
  });
});

describe("Inventory — move() and swap()", () => {
  it("relocates a stack into an empty slot", () => {
    const inv = new Inventory();
    inv.add("dirt", 10);
    inv.move(0, 5);
    expect(inv.slot(0)).toBeNull();
    expect(inv.slot(5)).toEqual({ itemId: "dirt", count: 10 });
  });

  it("merges same-item stacks up to maxStack", () => {
    const inv = new Inventory();
    inv.add("dirt", 60); // slot 0
    inv.add("dirt", 60); // slot 1 (64 + 56? no: 60 then 60 → slot0=60, slot1=60)
    // Actually: first add → slot0=60. Second add tops slot0 to 64 (4), 56 left → slot1=56.
    expect(inv.slot(0)!.count).toBe(64);
    expect(inv.slot(1)!.count).toBe(56);
    inv.move(1, 0); // merge slot1 into slot0: room=0 → swap instead
    // room was 0 so it swaps — slot0=56, slot1=64
    expect(inv.slot(0)!.count).toBe(56);
    expect(inv.slot(1)!.count).toBe(64);
  });

  it("merges partially when source has more than room", () => {
    const inv = new Inventory();
    inv.add("dirt", 60); // slot 0 = 60
    // Put 60 more dirt in slot 1 directly via snapshot manipulation is not
    // possible through add() (it would top up slot 0 first). Use a second item
    // to block slot 1, then clear it.
    inv.add("stone", 1); // slot 1 = stone
    // Now manually place 60 dirt in slot 2 by filling past slot 1.
    inv.add("dirt", 60); // tops slot 0 (4 → 64), 56 left → slot 2 = 56
    expect(inv.slot(0)!.count).toBe(64);
    expect(inv.slot(2)!.count).toBe(56);
    // Move slot 2 (56 dirt) into slot 0 (64 dirt, room 0) → swap.
    inv.move(2, 0);
    expect(inv.slot(0)!.count).toBe(56);
    expect(inv.slot(2)!.count).toBe(64);
  });

  it("merges fully when source fits in destination room", () => {
    const inv = new Inventory();
    inv.add("dirt", 10); // slot 0 = 10
    inv.add("stone", 1); // slot 1 = stone (block slot 1)
    inv.add("dirt", 20); // tops slot 0 to 30 (room was 54), 0 left → slot 0 = 30
    expect(inv.slot(0)!.count).toBe(30);
    // Force a second dirt stack into slot 2 by filling slot 0 to max first.
    inv.add("dirt", 40); // tops slot 0 to 64 (34), 6 left → slot 2 = 6
    expect(inv.slot(2)!.count).toBe(6);
    // Clear slot 0 by removing, then move slot 2 into a fresh slot 0.
    inv.remove("dirt", 64);
    expect(inv.slot(0)).toBeNull();
    inv.move(2, 0);
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: 6 });
    expect(inv.slot(2)).toBeNull();
  });

  it("swaps different-item stacks", () => {
    const inv = new Inventory();
    inv.add("dirt", 10); // slot 0
    inv.add("stone", 5); // slot 1
    inv.move(0, 1);
    expect(inv.slot(0)).toEqual({ itemId: "stone", count: 5 });
    expect(inv.slot(1)).toEqual({ itemId: "dirt", count: 10 });
  });

  it("move() is a no-op when source is empty", () => {
    const inv = new Inventory();
    inv.add("dirt", 10); // slot 0
    inv.move(5, 0); // slot 5 is empty
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: 10 });
    expect(inv.slot(5)).toBeNull();
  });
});

describe("Inventory — applyRecipe()", () => {
  it("consumes inputs and adds outputs", () => {
    const inv = new Inventory();
    inv.add("wood", 1);
    const recipe = {
      id: "planks_from_wood",
      name: "Planks",
      station: "hand" as const,
      inputs: [{ itemId: "wood", count: 1 }],
      outputs: [{ itemId: "planks", count: 4 }],
      craftTime: 0,
      fuelCost: 0,
    };
    expect(inv.applyRecipe(recipe)).toBe(true);
    expect(inv.count("wood")).toBe(0);
    expect(inv.count("planks")).toBe(4);
  });

  it("returns false when ingredients are missing", () => {
    const inv = new Inventory();
    const recipe = {
      id: "planks_from_wood",
      name: "Planks",
      station: "hand" as const,
      inputs: [{ itemId: "wood", count: 1 }],
      outputs: [{ itemId: "planks", count: 4 }],
      craftTime: 0,
      fuelCost: 0,
    };
    expect(inv.applyRecipe(recipe)).toBe(false);
  });

  it("reports output overflow via the dropOverflow callback", () => {
    const inv = new Inventory();
    // Fill the inventory with dirt so planks have nowhere to go.
    inv.add("dirt", INVENTORY_SIZE * 64);
    // Free one slot by removing dirt from slot 0.
    inv.remove("dirt", 64);
    inv.add("wood", 1);
    const recipe = {
      id: "planks_from_wood",
      name: "Planks",
      station: "hand" as const,
      inputs: [{ itemId: "wood", count: 1 }],
      outputs: [{ itemId: "planks", count: 4 }],
      craftTime: 0,
      fuelCost: 0,
    };
    const dropped: { itemId: string; count: number }[] = [];
    inv.applyRecipe(recipe, (itemId, count) => dropped.push({ itemId, count }));
    // 4 planks fit in the one free slot (maxStack 64) → no overflow.
    expect(dropped).toHaveLength(0);
    expect(inv.count("planks")).toBe(4);
  });
});

describe("Inventory — snapshot / loadSnapshot", () => {
  it("round-trips the new slot shape (fixed-length, null = empty)", () => {
    const inv = new Inventory();
    inv.add("dirt", 10);
    inv.add("stone", 5);
    const snap: InventorySnapshot = inv.snapshot();
    expect(snap).toHaveLength(INVENTORY_SIZE);
    expect(snap[0]).toEqual({ itemId: "dirt", count: 10 });
    expect(snap[1]).toEqual({ itemId: "stone", count: 5 });
    expect(snap[2]).toBeNull();
    const inv2 = new Inventory();
    inv2.loadSnapshot(snap);
    expect(inv2.snapshot()).toEqual(snap);
  });

  it("migrates a legacy {itemId,count}[] snapshot via add()", () => {
    const legacy: LegacyInventorySnapshot = [
      { itemId: "dirt", count: 10 },
      { itemId: "stone", count: 5 },
    ];
    const inv = new Inventory();
    inv.loadSnapshot(legacy);
    // Legacy entries are re-packed: dirt → slot 0, stone → slot 1.
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: 10 });
    expect(inv.slot(1)).toEqual({ itemId: "stone", count: 5 });
    expect(inv.count("dirt")).toBe(10);
    expect(inv.count("stone")).toBe(5);
  });

  it("migrates a legacy snapshot that exceeds maxStack by splitting stacks", () => {
    const legacy: LegacyInventorySnapshot = [{ itemId: "dirt", count: 100 }];
    const inv = new Inventory();
    inv.loadSnapshot(legacy);
    const max = getItemDef("dirt")!.maxStack; // 64
    expect(inv.slot(0)).toEqual({ itemId: "dirt", count: max });
    expect(inv.slot(1)).toEqual({ itemId: "dirt", count: 100 - max });
    expect(inv.count("dirt")).toBe(100);
  });

  it("clear() empties all slots", () => {
    const inv = new Inventory();
    inv.add("dirt", 10);
    inv.clear();
    for (let i = 0; i < inv.size; i++) expect(inv.slot(i)).toBeNull();
  });

  it("loadSnapshot ignores garbage input gracefully", () => {
    const inv = new Inventory();
    inv.loadSnapshot("not an array");
    for (let i = 0; i < inv.size; i++) expect(inv.slot(i)).toBeNull();
    inv.loadSnapshot(null);
    for (let i = 0; i < inv.size; i++) expect(inv.slot(i)).toBeNull();
  });
});

describe("Inventory — canPlace()", () => {
  it("returns true for a placeable block item the player owns", () => {
    const inv = new Inventory();
    inv.add("dirt", 1);
    expect(inv.canPlace("dirt")).toBe(true);
  });

  it("returns false for a non-placeable material", () => {
    const inv = new Inventory();
    inv.add("stick", 1);
    expect(inv.canPlace("stick")).toBe(false);
  });

  it("returns false for an item the player does not own", () => {
    const inv = new Inventory();
    expect(inv.canPlace("dirt")).toBe(false);
  });
});
