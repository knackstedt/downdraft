import { create } from "zustand";
import type { AlchemyRenderer } from "../renderer/alchemy-renderer";
import type {
  IngredientInventory, Potion, ProcessStep, SaveMetadata, Visitor,
} from "../shared/types";
import type { SaveEntry } from "./save-system";

export interface GameState {
  fps: number | null;
  paused: boolean;
  // Cauldron interaction
  selectedIngredient: number;   // material id of the currently-selected ingredient
  brushRadius: number;
  renderer: AlchemyRenderer | null;
  // Mixture analysis (updated from renderer each frame)
  mixtureHistogram: Uint32Array;
  lastMixtureUpdate: number;
  processHistory: ProcessStep[];
  // Player resources
  money: number;
  ingredientInventory: IngredientInventory[]; // owned ingredient doses
  potions: Potion[];                          // bottled potions
  unlockedTiers: number[];                    // tier numbers unlocked
  discoveredRecipes: string[];                // recipe ids discovered
  // UI panel visibility
  showShop: boolean;
  showRecipes: boolean;
  showBooth: boolean;
  showInventory: boolean;
  showSaves: boolean;
  // Visitors
  activeVisitor: Visitor | null;
  visitorQueue: Visitor[];
  // Saves
  saves: SaveMetadata[];
  // Station state
  activeStation: "heat" | "cool" | "settle" | null;
  stationProgress: number;

  // Setters
  setFPS: (fps: number) => void;
  setPaused: (p: boolean) => void;
  setSelectedIngredient: (m: number) => void;
  setBrushRadius: (r: number) => void;
  setRenderer: (r: AlchemyRenderer | null) => void;
  setMixtureHistogram: (h: Uint32Array) => void;
  addProcessStep: (step: ProcessStep) => void;
  resetProcessHistory: () => void;
  setMoney: (m: number) => void;
  addMoney: (delta: number) => void;
  addIngredient: (mat: number, count: number) => void;
  removeIngredient: (mat: number, count: number) => boolean;
  addPotion: (p: Potion) => void;
  removePotion: (id: string) => void;
  unlockTier: (tier: number) => void;
  discoverRecipe: (id: string) => void;
  setShowShop: (s: boolean) => void;
  setShowRecipes: (s: boolean) => void;
  setShowBooth: (s: boolean) => void;
  setShowInventory: (s: boolean) => void;
  setShowSaves: (s: boolean) => void;
  setActiveVisitor: (v: Visitor | null) => void;
  setVisitorQueue: (q: Visitor[]) => void;
  setSaves: (s: SaveMetadata[]) => void;
  setActiveStation: (s: "heat" | "cool" | "settle" | null) => void;
  setStationProgress: (p: number) => void;
  loadFullState: (state: Partial<GameState>) => void;
}

export const STARTING_MONEY = 100;

export const useGameStore = create<GameState>((set) => ({
  fps: null,
  paused: false,
  selectedIngredient: 2, // Water by default
  brushRadius: 4,
  renderer: null,
  mixtureHistogram: new Uint32Array(256),
  lastMixtureUpdate: 0,
  processHistory: [],
  money: STARTING_MONEY,
  ingredientInventory: [
    { mat: 2, count: 10 }, // Water
    { mat: 25, count: 5 }, // Salt
  ],
  potions: [],
  unlockedTiers: [0],
  discoveredRecipes: [],
  showShop: false,
  showRecipes: false,
  showBooth: false,
  showInventory: false,
  showSaves: false,
  activeVisitor: null,
  visitorQueue: [],
  saves: [],
  activeStation: null,
  stationProgress: 0,

  setFPS: (fps) => set({ fps }),
  setPaused: (paused) => set({ paused }),
  setSelectedIngredient: (selectedIngredient) => set({ selectedIngredient }),
  setBrushRadius: (brushRadius) => set({ brushRadius }),
  setRenderer: (renderer) => set({ renderer }),
  setMixtureHistogram: (h) => set({ mixtureHistogram: h, lastMixtureUpdate: performance.now() }),
  addProcessStep: (step) => set((s) => ({ processHistory: [...s.processHistory, step] })),
  resetProcessHistory: () => set({ processHistory: [] }),
  setMoney: (money) => set({ money }),
  addMoney: (delta) => set((s) => ({ money: Math.max(0, s.money + delta) })),
  addIngredient: (mat, count) => set((s) => {
    const inv = [...s.ingredientInventory];
    const idx = inv.findIndex((e) => e.mat === mat);
    if (idx >= 0) {
      inv[idx] = { ...inv[idx], count: inv[idx].count + count };
    } else {
      inv.push({ mat, count });
    }
    return { ingredientInventory: inv };
  }),
  removeIngredient: (mat, count) => {
    let ok = false;
    set((s) => {
      const inv = [...s.ingredientInventory];
      const idx = inv.findIndex((e) => e.mat === mat);
      if (idx < 0 || inv[idx].count < count) return {};
      inv[idx] = { ...inv[idx], count: inv[idx].count - count };
      ok = true;
      return { ingredientInventory: inv };
    });
    return ok;
  },
  addPotion: (p) => set((s) => ({ potions: [...s.potions, p] })),
  removePotion: (id) => set((s) => ({ potions: s.potions.filter((p) => p.id !== id) })),
  unlockTier: (tier) => set((s) => ({
    unlockedTiers: s.unlockedTiers.includes(tier) ? s.unlockedTiers : [...s.unlockedTiers, tier],
  })),
  discoverRecipe: (id) => set((s) => ({
    discoveredRecipes: s.discoveredRecipes.includes(id) ? s.discoveredRecipes : [...s.discoveredRecipes, id],
  })),
  setShowShop: (showShop) => set({ showShop }),
  setShowRecipes: (showRecipes) => set({ showRecipes }),
  setShowBooth: (showBooth) => set({ showBooth }),
  setShowInventory: (showInventory) => set({ showInventory }),
  setShowSaves: (showSaves) => set({ showSaves }),
  setActiveVisitor: (activeVisitor) => set({ activeVisitor }),
  setVisitorQueue: (visitorQueue) => set({ visitorQueue }),
  setSaves: (saves) => set({ saves }),
  setActiveStation: (activeStation) => set({ activeStation }),
  setStationProgress: (stationProgress) => set({ stationProgress }),
  loadFullState: (state) => set(state),
}));

// Re-export SaveEntry type for convenience
export type { SaveEntry };
