import { Material } from "@downdraft/library-sand";
import { create } from "zustand";
import { ACHIEVEMENTS, checkAchievements, type Achievement } from "../shared/achievements";
import { BASE_INVENTORY_SIZE, BUILD_MATERIAL_ID, BUILD_MATERIAL_PRICES, DeathCause, INVENTORY_SIZE_UPGRADE_INCREMENT, OXYGEN_MAX_TICKS, SELL_PRICES, upgradePrice, type BuildMaterialType, type UpgradeConfig } from "../shared/constants";
import type { BuildMaterials, InventoryEntry, PlayerStats, PlayerUpgrades } from "../shared/types";
import { createPlayerStats } from "../shared/types";

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
    "I know it may be a bit late to say this, but don't stand on fire",
    "Warning: Death by fire is not covered under your health plan"
  ],
  [Material.Plasma]: [
    "that's some premium incineration",
    "plasma: not just a state of matter, it's a lifestyle",
    "what the hell was that?"
  ],
  [Material.FuseFire]: [
    "should've cut the red wire",
    "Now you know why it says 'Parental Supervision required'.",
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
    "Buried alive — then you become dead",
    "Next time, watch where you dig",
    "You should have paid attention to the cracks in the ceiling"
  ],
  [DeathCause.Falling]: [
    "It's not the fall that kills you, it's the sudden stop",
    "Gravity called, you answered",
    "Should've packed a parachute",
    "The ground came up fast, didn't it?",
    "Splat. That's the technical term.",
    "Next time, try landing on your feet",
    "You fell for it — literally!",
    "That was quite the leap of faith.",
    "Did you forget your umbrella?",
    "Terminal velocity is not a suggestion"
  ],
  [DeathCause.Drowning]: [
    "You should have come up for air",
    "Glub glub glub",
    "This just in: you are not a fish.",
    "Waterboarding: not just for interrogations anymore!",
    "Should've taken swimming lessons",
    "You held your breath for a really long time, just not long enough",
    "Reminder: breathing is compulsory",
    "Who would have thought that you couldn't drink all that water",
    "Looks like you forgot your floaty",
    "Maybe next time try the kiddie pool",
    "Congratulations, you just learned that you can drown in this game",
  ],
};

// Fallback for unrecognized death causes (shouldn't happen, but just in case)
const FALLBACK_QUIPS = [
  "The mine claims another soul",
  "Your health insurance plan isn't unlimited you know",
  "Act 2; The Consequences of your actions",
  "While you don't feel pain, he does",
  "How'd you manage that",
  "What are you doing, running around like you have free healthcare"
];

/** Pick a random death quip for the given cause (Material ID or DeathCause ID). */
export function pickDeathQuip(deathCause: number): string {
  const quips = DEATH_MESSAGES[deathCause] ?? FALLBACK_QUIPS;
  return quips[Math.floor(Math.random() * quips.length)];
}

export interface GameState {
  fps: number | null;
  health: number;
  oxygen: number; // remaining oxygen ticks (OXYGEN_MAX_TICKS = full breath)
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
  // Dev cheats
  noclip: boolean; // true when noclip (free flight through terrain) is active
  // Lighting
  headlampOn: boolean; // true when the player headlamp is on (toggle with L)
  // Statistics
  stats: PlayerStats; // cumulative playthrough statistics (persisted)
  showStats: boolean; // true when the stats panel is open (toggle with Tab)
  // Achievements
  unlockedAchievements: Set<string>; // IDs of unlocked achievements (persisted)
  showAchievements: boolean; // true when the achievements panel is open (toggle with A)
  recentAchievement: Achievement | null; // most recently unlocked (for toast notification)

  setFPS: (fps: number) => void;
  setHealth: (health: number) => void;
  setOxygen: (oxygen: number) => void;
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
  // Dev cheats
  setNoclip: (on: boolean) => void;
  toggleNoclip: () => void;
  // Lighting
  setHeadlamp: (on: boolean) => void;
  toggleHeadlamp: () => void;
  /**
   * Buy `qty` of a build material at the signpost shop. Checks currency and
   * returns true on success. Does NOT mutate buildMaterials directly — the
   * caller (renderer) forwards the purchase to the worker, which is the source
   * of truth and emits the updated counts.
   */
  buyBuildMaterial: (type: BuildMaterialType, qty: number) => boolean;
  /**
   * Purchase one level of an upgrade at the signpost shop. Checks currency,
   * checks max level, deducts gold, and increments the upgrade level. Does NOT
   * sync to the worker — the caller (renderer) forwards the new upgrades to
   * the worker via setUpgrades(). Returns true on success.
   */
  purchaseUpgrade: (config: UpgradeConfig) => boolean;
  // Statistics
  setStats: (stats: PlayerStats) => void;
  setShowStats: (show: boolean) => void;
  toggleStats: () => void;
  /** Record items collected (updates per-material + total counters). */
  recordCollected: (items: InventoryEntry[]) => void;
  /** Record a death (increments total + per-cause counter). */
  recordDeath: (cause: number) => void;
  /** Record gold earned from selling. */
  recordGoldEarned: (amount: number) => void;
  /** Record gold spent (upgrades + build materials). */
  recordGoldSpent: (amount: number) => void;
  /** Record a bomb thrown. */
  recordBombThrown: () => void;
  /** Record a glowstick thrown. */
  recordGlowstickThrown: () => void;
  /** Record blocks placed in build mode. */
  recordBlocksPlaced: (count: number) => void;
  /** Record cells mined (dislodged from terrain). */
  recordCellsMined: (count: number) => void;
  /** Update max depth if the given depth is deeper than the current record. */
  recordDepth: (depthCells: number) => void;
  /** Add ticks to the total play time counter. */
  recordTicks: (ticks: number) => void;
  /** Reset all stats to zero (called on world reset). */
  resetStats: () => void;
  // Achievements
  setUnlockedAchievements: (ids: Set<string>) => void;
  setShowAchievements: (show: boolean) => void;
  toggleAchievements: () => void;
  /** Clear the recent achievement toast (called after the notification fades). */
  clearRecentAchievement: () => void;
  /**
   * Check all locked achievements against the current game state. Unlocks any
   * that pass their check function and sets the most recent one as
   * recentAchievement for the toast notification. Returns the number of newly
   * unlocked achievements.
   */
  checkAndUnlockAchievements: () => number;
  /** Reset achievements (called on world reset). */
  resetAchievements: () => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  fps: null,
  health: 100,
  oxygen: OXYGEN_MAX_TICKS,
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
  buildMaterials: { scaffolding: 0, ladder: 0, rope: 0, torch: 0 },
  noclip: false,
  headlampOn: true,
  stats: createPlayerStats(),
  showStats: false,
  unlockedAchievements: new Set<string>(),
  showAchievements: false,
  recentAchievement: null,

  setFPS: (fps) => set({ fps }),
  setHealth: (health) => set({ health }),
  setOxygen: (oxygen) => set({ oxygen }),
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
      return {
        inventory: [],
        currency: s.currency + total,
        stats: { ...s.stats, totalGoldEarned: s.stats.totalGoldEarned + total },
      };
    }),
  getMaxInventory: () => BASE_INVENTORY_SIZE + get().upgrades.inventorySize * INVENTORY_SIZE_UPGRADE_INCREMENT,
  getInventoryCount: () => get().inventory.reduce((sum, e) => sum + e.count, 0),
  setBuildMode: (on) => set({ buildMode: on }),
  toggleBuildMode: () => set((s) => ({ buildMode: !s.buildMode })),
  selectBuild: (type) => set({ selectedBuild: type }),
  setBuildMaterials: (mats) => set({ buildMaterials: { ...mats } }),
  getSelectedBuildMatId: () => BUILD_MATERIAL_ID[get().selectedBuild],
  setNoclip: (on) => set({ noclip: on }),
  toggleNoclip: () => set((s) => ({ noclip: !s.noclip })),
  setHeadlamp: (on) => set({ headlampOn: on }),
  toggleHeadlamp: () => set((s) => ({ headlampOn: !s.headlampOn })),
  buyBuildMaterial: (type, qty) => {
    const price = BUILD_MATERIAL_PRICES[type] * qty;
    const s = get();
    if (s.currency < price) return false;
    set({
      currency: s.currency - price,
      stats: { ...s.stats, totalGoldSpent: s.stats.totalGoldSpent + price },
    });
    return true;
  },
  purchaseUpgrade: (config) => {
    const s = get();
    const currentLevel = s.upgrades[config.key];
    if (currentLevel >= config.maxLevel) return false;
    const price = upgradePrice(config, currentLevel);
    if (s.currency < price) return false;
    set({
      currency: s.currency - price,
      upgrades: { ...s.upgrades, [config.key]: currentLevel + 1 },
      stats: { ...s.stats, totalGoldSpent: s.stats.totalGoldSpent + price },
    });
    return true;
  },
  // Statistics
  setStats: (stats) => set({ stats }),
  setShowStats: (showStats) => set({ showStats }),
  toggleStats: () => set((s) => ({ showStats: !s.showStats })),
  recordCollected: (items) =>
    set((s) => {
      const collectedByMaterial = { ...s.stats.collectedByMaterial };
      let totalItems = s.stats.totalItemsCollected;
      for (const item of items) {
        collectedByMaterial[item.mat] = (collectedByMaterial[item.mat] ?? 0) + item.count;
        totalItems += item.count;
      }
      return { stats: { ...s.stats, totalItemsCollected: totalItems, collectedByMaterial } };
    }),
  recordDeath: (cause) =>
    set((s) => ({
      stats: {
        ...s.stats,
        totalDeaths: s.stats.totalDeaths + 1,
        deathsByCause: {
          ...s.stats.deathsByCause,
          [cause]: (s.stats.deathsByCause[cause] ?? 0) + 1,
        },
      },
    })),
  recordGoldEarned: (amount) =>
    set((s) => ({ stats: { ...s.stats, totalGoldEarned: s.stats.totalGoldEarned + amount } })),
  recordGoldSpent: (amount) =>
    set((s) => ({ stats: { ...s.stats, totalGoldSpent: s.stats.totalGoldSpent + amount } })),
  recordBombThrown: () =>
    set((s) => ({ stats: { ...s.stats, totalBombsThrown: s.stats.totalBombsThrown + 1 } })),
  recordGlowstickThrown: () =>
    set((s) => ({ stats: { ...s.stats, totalGlowsticksThrown: s.stats.totalGlowsticksThrown + 1 } })),
  recordBlocksPlaced: (count) =>
    set((s) => ({ stats: { ...s.stats, totalBlocksPlaced: s.stats.totalBlocksPlaced + count } })),
  recordCellsMined: (count) =>
    set((s) => ({ stats: { ...s.stats, totalCellsMined: s.stats.totalCellsMined + count } })),
  recordDepth: (depthCells) =>
    set((s) =>
      depthCells > s.stats.maxDepthCells
        ? { stats: { ...s.stats, maxDepthCells: depthCells } }
        : {},
    ),
  recordTicks: (ticks) =>
    set((s) => ({ stats: { ...s.stats, totalTicks: s.stats.totalTicks + ticks } })),
  resetStats: () => set({ stats: createPlayerStats() }),
  // Achievements
  setUnlockedAchievements: (ids) => set({ unlockedAchievements: new Set(ids) }),
  setShowAchievements: (showAchievements) => set({ showAchievements }),
  toggleAchievements: () => set((s) => ({ showAchievements: !s.showAchievements })),
  clearRecentAchievement: () => set({ recentAchievement: null }),
  checkAndUnlockAchievements: () => {
    const s = get();
    const ctx = { stats: s.stats, upgrades: s.upgrades, currency: s.currency };
    const newlyUnlocked = checkAchievements(s.unlockedAchievements, ctx);
    if (newlyUnlocked.length === 0) return 0;
    const newSet = new Set(s.unlockedAchievements);
    for (const id of newlyUnlocked) newSet.add(id);
    // Set the most recent achievement for the toast notification
    const recent = ACHIEVEMENTS.find((a) => a.id === newlyUnlocked[newlyUnlocked.length - 1]) ?? null;
    set({ unlockedAchievements: newSet, recentAchievement: recent });
    return newlyUnlocked.length;
  },
  resetAchievements: () => set({ unlockedAchievements: new Set<string>(), recentAchievement: null }),
}));
