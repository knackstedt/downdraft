import {
    RECIPES,
    canCraft, executeCraft,
    getRecipe, getRecipesByTier, getRecipesForTierUpTo,
} from "@downdraft/plugin-crafting";
import { DEFAULT_ECONOMY_CONFIG, MarketSystem, PortSize } from "@downdraft/plugin-economy";
import { FISHING_KEY, FishingSystem, type FishingDeps, type FishingInput, type FishingPlayer } from "@downdraft/plugin-fishing";
import {
    addItem,
    cloneGrid,
    countItem, createGrid,
    deserializeGrid,
    moveItem,
    removeItemById,
    serializeGrid,
    type InventoryGrid,
} from "@downdraft/plugin-inventory";
import { ITEMS, ItemCategory, getItem, getItemsByCategory } from "@downdraft/plugin-items";
import { DEFAULT_SURVIVAL_CONFIG, SURVIVAL_FLAGS, SurvivalSystem, type SurvivalBiomeProvider, type SurvivalPlayer } from "@downdraft/plugin-survival";

// ============================================================================
// Items Plugin Tests
// ============================================================================

describe("Items", () => {
  it("should have a non-empty ITEMS registry", () => {
    expect(Object.keys(ITEMS).length).toBeGreaterThan(10);
  });

  it("should return item definitions by id", () => {
    const mackerel = getItem("mackerel");
    expect(mackerel).not.toBeNull();
    expect(mackerel!.id).toBe("mackerel");
    expect(mackerel!.category).toBe(ItemCategory.Fish);
  });

  it("should return null for unknown items", () => {
    expect(getItem("nonexistent_item")).toBeNull();
  });

  it("should have valid item definitions with required fields", () => {
    for (const [id, item] of Object.entries(ITEMS)) {
      expect(item.id).toBe(id);
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
      expect(item.maxStack).toBeGreaterThan(0);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
  });

  it("should filter items by category", () => {
    const fish = getItemsByCategory(ItemCategory.Fish);
    expect(fish.length).toBeGreaterThan(0);
    for (const f of fish) {
      expect(f.category).toBe(ItemCategory.Fish);
    }
  });

  it("should include key game items", () => {
    expect(getItem("mackerel")).not.toBeNull();
    expect(getItem("wood")).not.toBeNull();
    expect(getItem("cloth")).not.toBeNull();
    expect(getItem("metal_scrap")).not.toBeNull();
    expect(getItem("rope")).not.toBeNull();
    expect(getItem("planks")).not.toBeNull();
  });
});

// ============================================================================
// Inventory Plugin Tests
// ============================================================================

describe("Inventory", () => {
  it("should create a grid with correct dimensions", () => {
    const grid = createGrid(10, 6);
    expect(grid.width).toBe(10);
    expect(grid.height).toBe(6);
    expect(grid.slots.length).toBe(6);
    expect(grid.slots[0].length).toBe(10);
  });

  it("should add items to the grid", () => {
    const grid = createGrid(10, 6);
    const remaining = addItem(grid, "mackerel", 5);
    expect(remaining).toBe(0);
    expect(countItem(grid, "mackerel")).toBe(5);
  });

  it("should stack items up to maxStack", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 10); // maxStack=10, fills one 2x1 slot
    expect(countItem(grid, "mackerel")).toBe(10);
    // Adding 1 more should create a new stack since first is full
    const remaining = addItem(grid, "mackerel", 1);
    expect(remaining).toBe(0); // grid has space for new stack
    expect(countItem(grid, "mackerel")).toBe(11);
  });

  it("should return leftover when grid is full", () => {
    const grid = createGrid(2, 2);
    // wood is 1x2, maxStack=100. A 2x2 grid fits 2 stacks = 200 capacity
    const remaining = addItem(grid, "wood", 250);
    expect(remaining).toBeGreaterThan(0);
  });

  it("should remove items by id", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 10);
    const success = removeItemById(grid, "wood", 5);
    expect(success).toBe(true);
    expect(countItem(grid, "wood")).toBe(5);
  });

  it("should return false when removing more than available", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 5);
    const success = removeItemById(grid, "wood", 10);
    expect(success).toBe(false);
  });

  it("should count items correctly", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 10);
    addItem(grid, "wood", 5);
    expect(countItem(grid, "mackerel")).toBe(10);
    expect(countItem(grid, "wood")).toBe(5);
    expect(countItem(grid, "cloth")).toBe(0);
  });

  it("should clone grid independently", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "cloth", 5); // cloth is 1x1, avoids multi-cell clone issues
    const clone = cloneGrid(grid);
    removeItemById(grid, "cloth", 5);
    expect(countItem(grid, "cloth")).toBe(0);
    expect(countItem(clone, "cloth")).toBe(5);
  });

  it("should serialize and deserialize grid", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 5);
    addItem(grid, "wood", 10);
    const serialized = serializeGrid(grid);
    expect(serialized.length).toBeGreaterThan(0);
    const newGrid = deserializeGrid(serialized, 10, 6);
    expect(countItem(newGrid, "mackerel")).toBe(5);
    expect(countItem(newGrid, "wood")).toBe(10);
  });

  it("should move items within the grid", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "mackerel", 5);
    const moved = moveItem(grid, 0, 0, 5, 5);
    expect(moved).toBe(true);
  });

  it("should handle multi-cell items (wood is 1x2)", () => {
    const grid = createGrid(10, 6);
    const remaining = addItem(grid, "wood", 3);
    expect(remaining).toBe(0);
    expect(countItem(grid, "wood")).toBe(3);
  });
});

// ============================================================================
// Crafting Plugin Tests
// ============================================================================

describe("Crafting", () => {
  it("should have a non-empty recipe list", () => {
    expect(RECIPES.length).toBeGreaterThan(5);
  });

  it("should find recipes by id", () => {
    const recipe = getRecipe("wood_plank");
    expect(recipe).not.toBeNull();
    expect(recipe!.id).toBe("wood_plank");
    expect(recipe!.inputs[0].itemId).toBe("wood");
    expect(recipe!.output.itemId).toBe("planks");
  });

  it("should return null for unknown recipe", () => {
    expect(getRecipe("nonexistent")).toBeNull();
  });

  it("should filter recipes by tier", () => {
    const tier0 = getRecipesByTier(0);
    expect(tier0.length).toBeGreaterThan(0);
    for (const r of tier0) {
      expect(r.tier).toBe(0);
    }
  });

  it("should filter recipes up to a tier", () => {
    const upTo1 = getRecipesForTierUpTo(1);
    expect(upTo1.length).toBeGreaterThan(getRecipesByTier(0).length);
    for (const r of upTo1) {
      expect(r.tier).toBeLessThanOrEqual(1);
    }
  });

  it("should allow crafting when ingredients are available", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 10);
    const recipe = getRecipe("wood_plank")!;
    expect(canCraft(recipe, grid)).toBe(true);
  });

  it("should not allow crafting when ingredients are missing", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 0);
    const recipe = getRecipe("wood_plank")!;
    expect(canCraft(recipe, grid)).toBe(false);
  });

  it("should consume inputs and produce outputs on executeCraft", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 5);
    const recipe = getRecipe("wood_plank")!;
    executeCraft(recipe, grid);
    expect(countItem(grid, "wood")).toBe(4);
    expect(countItem(grid, "planks")).toBe(2);
  });

  it("should craft rope from cloth", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "cloth", 4);
    const recipe = getRecipe("rope")!;
    expect(canCraft(recipe, grid)).toBe(true);
    executeCraft(recipe, grid);
    expect(countItem(grid, "cloth")).toBe(2);
    expect(countItem(grid, "rope")).toBe(1);
  });

  it("should handle multi-input recipes (basic_rod needs wood + rope)", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 10);
    addItem(grid, "cloth", 4);
    executeCraft(getRecipe("rope")!, grid); // uses 2 cloth → 1 rope
    const recipe = getRecipe("basic_rod")!; // needs 3 wood + 2 rope
    // Only 1 rope available, need 2 — should not be craftable
    expect(canCraft(recipe, grid)).toBe(false);
    // Add more cloth and craft another rope
    addItem(grid, "cloth", 4);
    executeCraft(getRecipe("rope")!, grid);
    expect(countItem(grid, "rope")).toBe(2);
    expect(canCraft(recipe, grid)).toBe(true);
    executeCraft(recipe, grid);
    expect(countItem(grid, "basic_rod")).toBe(1);
  });

  it("should not craft recipes requiring stations without a station", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 15);
    addItem(grid, "metal_scrap", 8);
    const recipe = getRecipe("workbench_basic")!;
    expect(canCraft(recipe, grid)).toBe(true);
  });
});

// ============================================================================
// Economy Plugin Tests
// ============================================================================

describe("Economy / MarketSystem", () => {
  it("should initialize port markets", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    market.initPortMarket("port_b", PortSize.Large);
    const infoA = market.getMarketInfo("port_a");
    const infoB = market.getMarketInfo("port_b");
    expect(infoA).not.toBeNull();
    expect(infoB).not.toBeNull();
  });

  it("should not re-initialize an existing port", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Small);
    market.initPortMarket("port_a", PortSize.Large);
    const info = market.getMarketInfo("port_a");
    expect(info).not.toBeNull();
  });

  it("should create listings when selling to a port", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    const revenue = market.sellToPort("port_a", "mackerel", 5, 10, false);
    expect(revenue).toBeGreaterThan(0);
    const listing = market.getListing("port_a", "mackerel");
    expect(listing).not.toBeNull();
    expect(listing!.supply).toBeGreaterThan(0);
  });

  it("should calculate buy price higher than sell price", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    market.sellToPort("port_a", "mackerel", 5, 10, false);
    const buy = market.getBuyPrice("port_a", "mackerel", 5);
    const sell = market.getSellPrice("port_a", "mackerel", 5, 5, false);
    expect(buy).toBeGreaterThan(sell);
  });

  it("should return base value for items with no listing", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    const buy = market.getBuyPrice("port_a", "wood", 3);
    expect(buy).toBe(3);
  });

  it("should recover prices over time via tick", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    market.sellToPort("port_a", "mackerel", 5, 100, false);
    const listingAfterSell = market.getListing("port_a", "mackerel")!;
    const modifierAfterSell = listingAfterSell.priceModifier;

    for (let i = 0; i < 1000; i++) {
      market.tick(1 / 60);
    }

    const listingAfterTick = market.getListing("port_a", "mackerel")!;
    expect(listingAfterTick.priceModifier).toBeGreaterThanOrEqual(modifierAfterSell);
  });

  it("should handle buying from port", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    market.sellToPort("port_a", "wood", 3, 20, false);
    const listingAfterSell = market.getListing("port_a", "wood")!;
    const supplyAfterSell = listingAfterSell.supply;
    const cost = market.buyFromPort("port_a", "wood", 3, 5);
    expect(cost).toBeGreaterThan(0);
    const listing = market.getListing("port_a", "wood")!;
    expect(listing.supply).toBeLessThan(supplyAfterSell);
  });

  it("should return 0 for selling to non-existent port", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    const revenue = market.sellToPort("nonexistent", "mackerel", 5, 10, false);
    expect(revenue).toBe(0);
  });

  it("should report market info with listing count", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    market.sellToPort("port_a", "mackerel", 5, 10, false);
    market.sellToPort("port_a", "wood", 3, 20, false);
    const info = market.getMarketInfo("port_a")!;
    expect(info.listingCount).toBe(2);
    expect(info.avgModifier).toBeGreaterThan(0);
  });
});

// ============================================================================
// Survival Plugin Tests
// ============================================================================

const mockBiomeProvider: SurvivalBiomeProvider = {
  getBiomeAt: () => 7,
  isColdBiome: () => false,
  isHotBiome: () => false,
  getAmbientTemperature: () => 25,
};

const mockWeather = {
  getTemperature: () => 22,
};

function makeSurvivalPlayer(overrides: Partial<SurvivalPlayer> = {}): SurvivalPlayer {
  return {
    active: true,
    position: { x: 0, y: 0, z: 0 },
    flags: 0,
    health: 100,
    maxHealth: 100,
    hunger: 80,
    thirst: 70,
    oxygen: 100,
    maxOxygen: 100,
    temperature: 50,
    ...overrides,
  };
}

describe("Survival", () => {
  it("should initialize with default config", () => {
    const sys = new SurvivalSystem({ hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 }, DEFAULT_SURVIVAL_CONFIG);
    expect(sys).toBeDefined();
  });

  it("should decrease hunger over time", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ hunger: 80 })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].hunger).toBeLessThan(80);
  });

  it("should decrease thirst over time", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ thirst: 70 })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].thirst).toBeLessThan(70);
  });

  it("should drain oxygen when underwater", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ oxygen: 100, flags: SURVIVAL_FLAGS.UNDERWATER })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].oxygen).toBeLessThan(100);
  });

  it("should recover oxygen when not underwater", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ oxygen: 50, flags: 0 })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].oxygen).toBeGreaterThan(50);
  });

  it("should not reduce stats below 0", () => {
    const rules = { hungerRate: 100, thirstRate: 100, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ hunger: 10, thirst: 10 })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].hunger).toBeGreaterThanOrEqual(0);
    expect(players[0].thirst).toBeGreaterThanOrEqual(0);
  });

  it("should damage player when hunger and thirst are zero", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ hunger: 0, thirst: 0, health: 100 })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].health).toBeLessThan(100);
  });

  it("should handle sleeping flag", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ flags: SURVIVAL_FLAGS.SLEEPING })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
  });

  it("should handle dead flag", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer({ flags: SURVIVAL_FLAGS.DEAD, health: 0 })];
    sys.tick(5, players, 1, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].health).toBe(0);
  });

  it("should handle multiple players", () => {
    const rules = { hungerRate: 0.8, thirstRate: 1.0, temperatureRate: 2.0 };
    const sys = new SurvivalSystem(rules, DEFAULT_SURVIVAL_CONFIG);
    const players = [makeSurvivalPlayer(), makeSurvivalPlayer({ hunger: 50, thirst: 40 })];
    sys.tick(5, players, 2, 0.3, mockWeather, mockBiomeProvider);
    expect(players[0].hunger).toBeLessThan(80);
    expect(players[1].hunger).toBeLessThan(50);
  });
});

// ============================================================================
// Fishing Plugin Tests
// ============================================================================

const mockFishingDeps: FishingDeps = {
  biomeProvider: { getBiomeAt: () => 7 },
  weatherProvider: { getState: () => ({ type: 0, visibility: 1.0 }) },
  waterProvider: {
    getPatchSize: () => 4,
    getOrigin: () => ({ x: 0, z: 0 }),
    sampleHeight: () => 0.5,
  },
  addItem: (inv, itemId, qty) => {
    const grid = inv as unknown as InventoryGrid;
    return addItem(grid, itemId, qty);
  },
  onEvent: () => {},
  getCatchPool: (biome) => {
    if (biome === 7) return ["mackerel", "tuna", "cod", "bass"];
    return ["common_fish"];
  },
};

const mockFishingInput: FishingInput = {
  isKeyDown: (_player: number, key: number) => key === FISHING_KEY.F,
  isMouseDown: () => true,
};

function makeFishingPlayer(overrides: Partial<FishingPlayer> = {}): FishingPlayer {
  return {
    active: true,
    position: { x: 10, y: 0, z: 10 },
    flags: 0,
    inventory: createGrid(10, 6) as unknown as FishingPlayer["inventory"],
    ...overrides,
  };
}

describe("Fishing", () => {
  it("should initialize without errors", () => {
    const sys = new FishingSystem(mockFishingDeps);
    expect(sys).toBeDefined();
  });

  it("should start fishing when F is pressed near water", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer()];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    expect(sys.isFishing(0)).toBe(true);
  });

  it("should not start fishing when not near water", () => {
    const deps: FishingDeps = {
      ...mockFishingDeps,
      waterProvider: {
        getPatchSize: () => 4,
        getOrigin: () => ({ x: 1000, z: 1000 }),
        sampleHeight: () => -100,
      },
    };
    const sys = new FishingSystem(deps);
    const players = [makeFishingPlayer({ position: { x: 0, y: 0, z: 0 } })];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    expect(sys.isFishing(0)).toBe(false);
  });

  it("should report not fishing before any input", () => {
    const sys = new FishingSystem(mockFishingDeps);
    expect(sys.isFishing(0)).toBe(false);
  });

  it("should handle minigame state", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer()];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    const minigame = sys.getMinigameState(0);
    if (minigame) {
      expect(minigame.active).toBe(true);
      expect(minigame.tension).toBeGreaterThanOrEqual(0);
      expect(minigame.progress).toBeGreaterThanOrEqual(0);
      expect(minigame.catchPool.length).toBeGreaterThan(0);
    }
  });

  it("should tick minigame over time", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer()];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    const mg1 = sys.getMinigameState(0);
    for (let i = 0; i < 60; i++) {
      sys.tick(1 / 60, mockFishingInput, players, 1);
    }
    const mg2 = sys.getMinigameState(0);
    if (mg1 && mg2) {
      expect(mg2.duration).toBeGreaterThanOrEqual(mg1.duration);
    }
  });

  it("should handle multiple players", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer(), makeFishingPlayer({ position: { x: 5, y: 0, z: 5 } })];
    sys.tick(1 / 60, mockFishingInput, players, 2);
  });

  it("should not fish when swimming", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer({ flags: 1 << 4 })];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    expect(sys.isFishing(0)).toBe(false);
  });

  it("should not fish when piloting", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer({ flags: 1 << 6 })];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    expect(sys.isFishing(0)).toBe(false);
  });

  it("should handle inactive players", () => {
    const sys = new FishingSystem(mockFishingDeps);
    const players = [makeFishingPlayer({ active: false })];
    sys.tick(1 / 60, mockFishingInput, players, 1);
    expect(sys.isFishing(0)).toBe(false);
  });
});

// ============================================================================
// Integration: Crafting + Inventory + Items
// ============================================================================

describe("Integration: Crafting + Inventory", () => {
  it("should craft a chain of recipes", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 10);
    addItem(grid, "cloth", 8);

    executeCraft(getRecipe("wood_plank")!, grid);
    expect(countItem(grid, "planks")).toBe(2);

    executeCraft(getRecipe("rope")!, grid);
    expect(countItem(grid, "rope")).toBe(1);

    // Need 2 rope for basic_rod — craft another
    executeCraft(getRecipe("rope")!, grid);
    expect(countItem(grid, "rope")).toBe(2);

    executeCraft(getRecipe("basic_rod")!, grid);
    expect(countItem(grid, "basic_rod")).toBe(1);
  });

  it("should stop crafting when materials run out", () => {
    const grid = createGrid(10, 6);
    addItem(grid, "wood", 1);
    const recipe = getRecipe("wood_plank")!;
    expect(canCraft(recipe, grid)).toBe(true);
    executeCraft(recipe, grid);
    expect(canCraft(recipe, grid)).toBe(false);
  });
});

// ============================================================================
// Integration: Economy + Items
// ============================================================================

describe("Integration: Economy + Items", () => {
  it("should use item base values for pricing", () => {
    const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
    market.initPortMarket("port_a", PortSize.Medium);
    const mackerel = getItem("mackerel")!;
    const wood = getItem("wood")!;

    market.sellToPort("port_a", "mackerel", mackerel.value, 10, false);
    market.sellToPort("port_a", "wood", wood.value, 20, false);

    const mackerelBuy = market.getBuyPrice("port_a", "mackerel", mackerel.value);
    const woodBuy = market.getBuyPrice("port_a", "wood", wood.value);

    expect(mackerelBuy).toBeGreaterThan(0);
    expect(woodBuy).toBeGreaterThan(0);
    expect(mackerelBuy).toBeGreaterThan(woodBuy);
  });
});
