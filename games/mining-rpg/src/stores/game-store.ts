import { Material } from "@downdraft/library-sand";
import { create } from "zustand";
import { BASE_INVENTORY_SIZE, BUILD_MATERIAL_ID, BUILD_MATERIAL_PRICES, DeathCause, INVENTORY_SIZE_UPGRADE_INCREMENT, SELL_PRICES, type BuildMaterialType } from "../shared/constants";
import type { BuildMaterials, InventoryEntry, PlayerUpgrades } from "../shared/types";

// ============================================================================
// Death messages — a single object covering all death causes.
//
// Material-based deaths (lava, fire, gas, etc.) are keyed by Material ID.
// Non-material deaths (suffocation, falling) are keyed by DeathCause IDs
// (1000+). Each cause has a list of quips; one is picked at random.
// ============================================================================
const DEATH_MESSAGES: Record<number, string[]> = {
  // --- Material-based deaths (keyed by Material ID) ---
  [Material.Lava]: [
    "Maybe don't try jumping in lava",
    "That was magma, not a hot tub",
    "Lava: it's not a spa treatment",
    "You do know that lava is hot, right?",
    "Didn't your parents ever teach you to not touch lava?",
    "Caution: lava is hot and may cause severe injury or even death",
    "What made you think that jumping in a pool of lava was a good idea?"
  ],
  [Material.Fire]: [
    "Stop, drop, and roll next time",
    "You got a little too toasty",
    "Fire is hot, who knew",
    "I know it may be a bit late to say this, but don't stand on fire"
  ],
  [Material.Plasma]: [
    "that's some premium incineration",
    "plasma: not just a state of matter, it's a lifestyle",
  ],
  [Material.FuseFire]: [
    "should've cut the red wire",
    "fuse fire: surprisingly effective",
  ],
  [Material.BurningOil]: [
    "Oil and fire — a classic afternoon combo",
    "I don't know why you thought taking a bath in boiling oil was a good idea",
    "Did you know that not swimming in burning oil is a requirement for survival?"
  ],
  [Material.MethaneGas]: [
    "Breathing isn't optional",
    "Methane: the silent killer (well, not that silent)",
    "Should've brought a gas mask",
    "I know you can't see it, but you sure as hell can smell it"
  ],
  [Material.SulfurGas]: [
    "Breathing isn't optional",
    "Sulfur gas: smells like death, tastes like it too",
    "That's some toxic air right there",
    "You could have smelled that from so far away"
  ],

  // --- Non-material deaths (keyed by DeathCause ID) ---
  [DeathCause.Suffocation]: [
    "Crushed under the weight of the earth",
    "The mountain doesn't move, you do",
    "Should've dug faster",
    "Rocks fall, everyone dies",
    "Do you like hugs with extreme force?",
    "Cave-ins are a serious source of injury and death",
    "Buried alive — the mine keeps what it takes",
    "Next time, watch where you dig",
    "You do know that breathing is important, right",
    "You should have paid attention to the cracks in the ceiling"
  ],
  [DeathCause.Falling]: [
    "It's not the fall that kills you, it's the sudden stop",
    "Gravity called, you answered",
    "Should've packed a parachute",
    "The ground came up fast, didn't it?",
    "Splat. That's the technical term.",
    "Next time, try landing on your feet",
    "You fell for it — literally",
    "That was quite the leap of faith",
    "What goes up must come down, hard",
    "Terminal velocity is not just a suggestion"
  ],
};

// Fallback for unrecognized death causes (shouldn't happen, but just in case)
const FALLBACK_QUIPS = [
  "The mine claims another soul",
  "Your health insurance plan isn't unlimited you know",
  "Act 2; The Consequences of your actions",
  "While you don't feel pain, he does",
  "How'd you manage that?"
];

/** Pick a random death quip for the given cause (Material ID or DeathCause ID). */
export function pickDeathQuip(deathCause: number): string {
  const quips = DEATH_MESSAGES[deathCause] ?? FALLBACK_QUIPS;
  return quips[Math.floor(Math.random() * quips.length)];
}

export interface GameState {
  fps: number | null;
  health: number;
  depth: number; // player depth in chunks (0 = surface)
  paused: boolean;
  gameOver: boolean; // true when player health reaches 0
  deathCause: number; // Material ID that caused death (0 = none)
  deathQuip: string; // cause-of-death message, set once per death event
  digRadius: number;
  inventory: InventoryEntry[];
  upgrades: PlayerUpgrades;
  loadedChunks: number;
  activeChunks: number;
  renderer: unknown | null; // set to MiningRenderer at runtime; typed as unknown to avoid circular import
  showInventory: boolean;
  showEscapeMenu: boolean; // true when the ESC pause menu is open
  currency: number; // gold earned from selling materials at the signpost
  nearSignpost: boolean; // true when player is within sell range of the surface signpost
  // Build system
  buildMode: boolean; // true when build mode is active (left-click places)
  selectedBuild: BuildMaterialType; // currently selected build material
  buildMaterials: BuildMaterials; // mirror of worker-authoritative counts (for display)

  setFPS: (fps: number) => void;
  setHealth: (health: number) => void;
  setDepth: (depth: number) => void;
  setPaused: (p: boolean) => void;
  setGameOver: (g: boolean) => void;
  setDeathCause: (c: number) => void;
  setDeathQuip: (q: string) => void;
  setDigRadius: (r: number) => void;
  setInventory: (inv: InventoryEntry[]) => void;
  addToInventory: (mat: number, count: number) => void;
  setUpgrades: (upgrades: PlayerUpgrades) => void;
  setLoadedChunks: (n: number) => void;
  setActiveChunks: (n: number) => void;
  setRenderer: (r: unknown | null) => void;
  setShowInventory: (show: boolean) => void;
  setShowEscapeMenu: (show: boolean) => void;
  setCurrency: (c: number) => void;
  addCurrency: (amount: number) => void;
  setNearSignpost: (near: boolean) => void;
  sellAll: () => void;
  getMaxInventory: () => number;
  getInventoryCount: () => number;
  // Build system
  setBuildMode: (on: boolean) => void;
  toggleBuildMode: () => void;
  selectBuild: (type: BuildMaterialType) => void;
  setBuildMaterials: (mats: BuildMaterials) => void; // sync from worker events
  /** Get the Material ID of the currently selected build material. */
  getSelectedBuildMatId: () => number;
  /**
   * Buy `qty` of a build material at the signpost shop. Checks currency and
   * returns true on success. Does NOT mutate buildMaterials directly — the
   * caller (renderer) forwards the purchase to the worker, which is the source
   * of truth and emits the updated counts.
   */
  buyBuildMaterial: (type: BuildMaterialType, qty: number) => boolean;
}

export const useGameStore = create<GameState>((set, get) => ({
  fps: null,
  health: 100,
  depth: 0,
  paused: false,
  gameOver: false,
  deathCause: 0,
  deathQuip: "",
  digRadius: 3,
  inventory: [],
  upgrades: { damage: 0, radius: 0, rate: 0, inventorySize: 0 },
  loadedChunks: 0,
  activeChunks: 0,
  renderer: null,
  showInventory: false,
  showEscapeMenu: false,
  currency: 0,
  nearSignpost: false,
  buildMode: false,
  selectedBuild: "scaffolding",
  buildMaterials: { scaffolding: 0, ladder: 0, rope: 0 },

  setFPS: (fps) => set({ fps }),
  setHealth: (health) => set({ health }),
  setDepth: (depth) => set({ depth }),
  setPaused: (paused) => set({ paused }),
  setGameOver: (gameOver) => set({ gameOver }),
  setDeathCause: (deathCause) => set({ deathCause }),
  setDeathQuip: (deathQuip) => set({ deathQuip }),
  setDigRadius: (digRadius) => set({ digRadius }),
  setInventory: (inventory) => set({ inventory }),
  addToInventory: (mat, count) =>
    set((s) => {
      const existing = s.inventory.find((e) => e.mat === mat);
      if (existing) {
        return {
          inventory: s.inventory.map((e) =>
            e.mat === mat ? { ...e, count: e.count + count } : e,
          ),
        };
      }
      return { inventory: [...s.inventory, { mat, count }] };
    }),
  setUpgrades: (upgrades) => set({ upgrades }),
  setLoadedChunks: (loadedChunks) => set({ loadedChunks }),
  setActiveChunks: (activeChunks) => set({ activeChunks }),
  setRenderer: (renderer) => set({ renderer }),
  setShowInventory: (showInventory) => set({ showInventory }),
  setShowEscapeMenu: (showEscapeMenu) => set({ showEscapeMenu }),
  setCurrency: (currency) => set({ currency }),
  addCurrency: (amount) => set((s) => ({ currency: s.currency + amount })),
  setNearSignpost: (nearSignpost) => set({ nearSignpost }),
  sellAll: () =>
    set((s) => {
      let total = 0;
      for (const entry of s.inventory) {
        const price = SELL_PRICES[entry.mat] ?? 0;
        total += price * entry.count;
      }
      return { inventory: [], currency: s.currency + total };
    }),
  getMaxInventory: () => BASE_INVENTORY_SIZE + get().upgrades.inventorySize * INVENTORY_SIZE_UPGRADE_INCREMENT,
  getInventoryCount: () => get().inventory.reduce((sum, e) => sum + e.count, 0),
  setBuildMode: (on) => set({ buildMode: on }),
  toggleBuildMode: () => set((s) => ({ buildMode: !s.buildMode })),
  selectBuild: (type) => set({ selectedBuild: type }),
  setBuildMaterials: (mats) => set({ buildMaterials: { ...mats } }),
  getSelectedBuildMatId: () => BUILD_MATERIAL_ID[get().selectedBuild],
  buyBuildMaterial: (type, qty) => {
    const price = BUILD_MATERIAL_PRICES[type] * qty;
    const s = get();
    if (s.currency < price) return false;
    set({ currency: s.currency - price });
    return true;
  },
}));
