// ============================================================================
// Gameplay Test — inventory, crafting, economy, fishing, survival
// ============================================================================

import {
    RECIPES,
    canCraft, executeCraft
} from "@to-the-ocean/plugin-crafting";
import { DEFAULT_ECONOMY_CONFIG, MarketSystem, PortSize } from "@to-the-ocean/plugin-economy";
import { FishingSystem, type FishingDeps, type FishingInput, type FishingPlayer } from "@to-the-ocean/plugin-fishing";
import {
    addItem,
    createGrid,
    type InventoryGrid
} from "@to-the-ocean/plugin-inventory";
import { getItem } from "@to-the-ocean/plugin-items";
import { DEFAULT_SURVIVAL_CONFIG, SurvivalSystem, type SurvivalBiomeProvider, type SurvivalPlayer } from "@to-the-ocean/plugin-survival";

export interface GameplayState {
  inventory: InventoryGrid;
  market: MarketSystem;
  fishing: FishingSystem;
  survival: SurvivalSystem;
  fishingPlayers: FishingPlayer[];
  survivalPlayers: SurvivalPlayer[];
  fishingEvents: { kind: string; data: unknown }[];
  craftResults: { recipeId: string; success: boolean }[];
}

// Mock biome provider for survival
const mockBiomeProvider: SurvivalBiomeProvider = {
  getBiomeAt: () => 7, // ocean
  isColdBiome: () => false,
  isHotBiome: () => false,
  getAmbientTemperature: (_biome: number, _timeOfDay: number) => 25,
};

// Mock weather for survival
const mockWeather = {
  getTemperature: () => 22,
};

// Mock water provider for fishing
const mockWaterProvider = {
  getPatchSize: () => 4,
  getOrigin: () => ({ x: 0, z: 0 }),
  sampleHeight: (_gx: number, _gz: number) => 0.5,
};

// Mock biome provider for fishing
const mockFishingBiomeProvider = {
  getBiomeAt: (_x: number, _z: number) => 7, // ocean
};

// Mock weather provider for fishing
const mockFishingWeatherProvider = {
  getState: () => ({ type: 0, visibility: 1.0 }),
};

// Mock fishing input
const mockFishingInput: FishingInput = {
  isKeyDown: (_player: number, key: number) => key === 70, // F key always "pressed"
  isMouseDown: () => true, // mouse always down (reeling)
};

export function initGameplayTest(): GameplayState {
  // --- Inventory ---
  const inventory = createGrid(10, 6);
  addItem(inventory, "mackerel", 5);
  addItem(inventory, "wood", 10);
  addItem(inventory, "metal_scrap", 3);
  addItem(inventory, "cloth", 4);

  // --- Market / Economy ---
  const market = new MarketSystem(DEFAULT_ECONOMY_CONFIG);
  market.initPortMarket("port_a", PortSize.Medium);
  market.initPortMarket("port_b", PortSize.Large);

  // Sell some items to port_a to create supply
  market.sellToPort("port_a", "mackerel", getItem("mackerel")!.value, 10, false);
  market.sellToPort("port_a", "wood", getItem("wood")!.value, 20, false);

  // --- Fishing ---
  const fishingEvents: { kind: string; data: unknown }[] = [];
  const fishingDeps: FishingDeps = {
    biomeProvider: mockFishingBiomeProvider,
    weatherProvider: mockFishingWeatherProvider,
    waterProvider: mockWaterProvider,
    addItem: (inv, itemId, qty) => {
      const grid = inv as unknown as InventoryGrid;
      return addItem(grid, itemId, qty);
    },
    onEvent: (event) => {
      fishingEvents.push(event);
    },
    getCatchPool: (biome, _method, tier) => {
      if (biome === 7) return ["mackerel", "tuna", "cod", "bass"];
      return ["common_fish"];
    },
  };

  const fishing = new FishingSystem(fishingDeps);

  const fishingPlayers: FishingPlayer[] = [
    {
      active: true,
      position: { x: 10, y: 0, z: 10 },
      flags: 0,
      inventory: inventory as unknown as FishingPlayer["inventory"],
    },
  ];

  // --- Survival ---
  const survivalRules = {
    hungerRate: 0.8,
    thirstRate: 1.0,
    temperatureRate: 2.0,
  };
  const survival = new SurvivalSystem(survivalRules, DEFAULT_SURVIVAL_CONFIG);

  const survivalPlayers: SurvivalPlayer[] = [
    {
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
    },
  ];

  // --- Crafting ---
  const craftResults: { recipeId: string; success: boolean }[] = [];

  // Test canCraft + executeCraft for wood_plank recipe
  const woodPlankRecipe = RECIPES.find((r) => r.id === "wood_plank")!;
  const canCraftPlank = canCraft(woodPlankRecipe, inventory);
  if (canCraftPlank) {
    executeCraft(woodPlankRecipe, inventory);
    craftResults.push({ recipeId: "wood_plank", success: true });
  } else {
    craftResults.push({ recipeId: "wood_plank", success: false });
  }

  // Test rope recipe (needs cloth x2)
  const ropeRecipe = RECIPES.find((r) => r.id === "rope")!;
  const canCraftRope = canCraft(ropeRecipe, inventory);
  if (canCraftRope) {
    executeCraft(ropeRecipe, inventory);
    craftResults.push({ recipeId: "rope", success: true });
  } else {
    craftResults.push({ recipeId: "rope", success: false });
  }

  return {
    inventory,
    market,
    fishing,
    survival,
    fishingPlayers,
    survivalPlayers,
    fishingEvents,
    craftResults,
  };
}

export function tickGameplayTest(state: GameplayState, dt: number): void {
  // Tick fishing (simulate one fishing attempt)
  state.fishing.tick(dt, mockFishingInput, state.fishingPlayers, 1);

  // Tick survival
  state.survival.tick(
    dt,
    state.survivalPlayers,
    1,
    0.3, // time of day
    mockWeather,
    mockBiomeProvider,
  );

  // Tick market
  state.market.tick(dt);
}

export function getGameplayStateSnapshot(state: GameplayState) {
  const itemCounts: Record<string, number> = {};
  for (let y = 0; y < state.inventory.height; y++) {
    for (let x = 0; x < state.inventory.width; x++) {
      const stack = state.inventory.slots[y][x];
      if (stack) {
        itemCounts[stack.itemId] = (itemCounts[stack.itemId] ?? 0) + stack.quantity;
      }
    }
  }

  const portA = state.market.getMarketInfo("port_a");
  const portB = state.market.getMarketInfo("port_b");

  const mackerelBuyPrice = state.market.getBuyPrice("port_a", "mackerel", getItem("mackerel")!.value);
  const mackerelSellPrice = state.market.getSellPrice("port_a", "mackerel", getItem("mackerel")!.value, 5, false);

  const survivalPlayer = state.survivalPlayers[0];
  const fishingMinigame = state.fishing.getMinigameState(0);

  return {
    inventory: {
      itemCounts,
      totalItems: Object.values(itemCounts).reduce((a, b) => a + b, 0),
    },
    market: {
      portA: portA,
      portB: portB,
      mackerelBuyPrice,
      mackerelSellPrice,
    },
    fishing: {
      isFishing: state.fishing.isFishing(0),
      minigame: fishingMinigame ? {
        tension: fishingMinigame.tension,
        progress: fishingMinigame.progress,
        duration: fishingMinigame.duration,
        catchPool: fishingMinigame.catchPool,
      } : null,
      events: state.fishingEvents.slice(-5),
    },
    survival: {
      health: survivalPlayer.health,
      hunger: survivalPlayer.hunger,
      thirst: survivalPlayer.thirst,
      oxygen: survivalPlayer.oxygen,
      temperature: survivalPlayer.temperature,
    },
    crafting: state.craftResults,
  };
}
