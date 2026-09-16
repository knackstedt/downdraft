import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
import { create } from "zustand";
import { ACHIEVEMENTS, checkAchievements, type Achievement } from "../shared/achievements";
import { BASE_INVENTORY_SIZE, BUILD_MATERIAL_ID, BUILD_MATERIAL_PRICES, INVENTORY_SIZE_UPGRADE_INCREMENT, OXYGEN_MAX_TICKS, SELL_PRICES, upgradePrice, type BuildMaterialType, type UpgradeConfig } from "../shared/constants";
import { canCraft, consumeInputs, CRAFTED_SELL_PRICES, type CraftingRecipe } from "../shared/crafting-recipes";
import type { BuildMaterials, CraftedItemId, CraftedItems, InventoryEntry, PlayerStats, PlayerUpgrades } from "../shared/types";
import { createCraftedItems, createPlayerStats } from "../shared/types";

// Re-export pickDeathQuip for backward compatibility (it was previously
// defined inline here; now shared with the Solid worker store).
export { pickDeathQuip } from "../shared/death-messages";

export interface GameState extends Omit<BaseGameStoreState<unknown>, "fps"> {
  fps: number | null;
  oxygen: number; // remaining oxygen ticks (OXYGEN_MAX_TICKS = full breath)
  depth: number; // player depth in chunks (0 = surface)
  gameOver: boolean; // true when player health reaches 0
  deathCause: number; // Material ID that caused death (0 = none)
  deathQuip: string; // cause-of-death message, set once per death event
  digRadius: number;
  inventory: InventoryEntry[];
  upgrades: PlayerUpgrades;
  loadedChunks: number;
  activeChunks: number;
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
  // Crafting
  craftedItems: CraftedItems; // counts of crafted bars (persisted)
  // Title screen
  lastSaveTime: number; // timestamp of last save (0 = never)
  showMinimap: boolean; // minimap visibility (toggle with M)

  setOxygen: (oxygen: number) => void;
  setDepth: (depth: number) => void;
  setGameOver: (g: boolean) => void;
  setDeathCause: (c: number) => void;
  setDeathQuip: (q: string) => void;
  setDigRadius: (r: number) => void;
  setInventory: (inv: InventoryEntry[]) => void;
  addToInventory: (mat: number, count: number) => void;
  setUpgrades: (upgrades: PlayerUpgrades) => void;
  setLoadedChunks: (n: number) => void;
  setActiveChunks: (n: number) => void;
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
  /** Record bars crafted (smelted at the furnace). */
  recordBarsCrafted: (count: number) => void;
  /** Record a teleport to surface. */
  recordTeleport: () => void;
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
  // Crafting
  setCraftedItems: (items: CraftedItems) => void;
  /**
   * Craft a recipe: consume input materials from inventory, add the output
   * item to craftedItems. Returns true on success, false if not enough
   * materials. Does NOT sync to the worker — crafted items are renderer-side
   * only (they're virtual inventory items, not grid materials).
   */
  craft: (recipe: CraftingRecipe) => boolean;
  /**
   * Sell all crafted items (bars) for gold. Adds the total value to currency
   * and clears the crafted items. Returns the amount earned.
   */
  sellCraftedItems: () => number;
  /** Reset crafted items to zero (called on world reset). */
  resetCraftedItems: () => void;
  // Title screen
  setLastSaveTime: (time: number) => void;
  toggleMinimap: () => void;
  // Particle effects
  spawnParticles: (x: number, y: number, color: string, count: number) => void;
  spawnFloatingText: (x: number, y: number, text: string, color: string) => void;
  triggerScreenShake: (intensity: number) => void;
  teleportCooldown: number; // 0-1, 1 = ready, 0 = just used
  setTeleportCooldown: (v: number) => void;
  goldFlashTime: number; // timestamp of last gold gain (for flash effect)
  triggerGoldFlash: () => void;
  showHUD: boolean; // HUD visibility (toggle with F11)
  toggleHUD: () => void;
  playerFacing: number; // 1 = right, -1 = left
  setPlayerFacing: (f: number) => void;
  playerSpeed: number; // current movement speed in cells/sec
  setPlayerSpeed: (s: number) => void;
  glowstickCount: number; // active glowsticks in the world
  setGlowstickCount: (n: number) => void;
  bombCount: number; // active bombs in the world
  setBombCount: (n: number) => void;
  zoom: number; // camera zoom level
  setZoom: (z: number) => void;
  onGround: boolean; // true if player is standing on ground
  setOnGround: (v: boolean) => void;
  welcomeBack: string | null; // welcome back message when loading a save
  setWelcomeBack: (msg: string | null) => void;
  showFPS: boolean; // whether to show the FPS counter
  toggleFPS: () => void;
  showHelp: boolean; // whether to show the help/keybindings bar (toggle with H)
  toggleHelp: () => void;
  showShop: boolean; // whether the shop panel is open (toggle with O, only near signpost)
  toggleShop: () => void;
  setShowShop: (show: boolean) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  ...createBaseGameStoreState<unknown>(set, get),
  fps: null,
  oxygen: OXYGEN_MAX_TICKS,
  depth: 0,
  gameOver: false,
  deathCause: 0,
  deathQuip: "",
  digRadius: 3,
  inventory: [],
  upgrades: { damage: 0, radius: 0, rate: 0, inventorySize: 0 },
  loadedChunks: 0,
  activeChunks: 0,
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
  craftedItems: createCraftedItems(),
  showTitleScreen: true,
  lastSaveTime: 0,
  showMinimap: true,
  teleportCooldown: 1, // 1 = ready, 0 = on cooldown
  goldFlashTime: 0,
  showHUD: true,
  playerFacing: 1,
  playerSpeed: 0,
  glowstickCount: 0,
  bombCount: 0,
  zoom: 1,
  onGround: true,
  welcomeBack: null,
  showFPS: true,
  showHelp: false,
  showShop: false,

  setOxygen: (oxygen) => set({ oxygen }),
  setDepth: (depth) => set({ depth }),
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
      // Also sell crafted items (bars)
      let craftedTotal = 0;
      const newCrafted = { ...s.craftedItems };
      for (const [id, count] of Object.entries(newCrafted)) {
        const price = CRAFTED_SELL_PRICES[id as CraftedItemId] ?? 0;
        craftedTotal += price * count;
        (newCrafted as Record<string, number>)[id] = 0;
      }
      total += craftedTotal;
      // Spawn floating gold text at player's screen position
      if (total > 0) {
        const r = s.renderer as { getPlayerScreenPos?: () => { x: number; y: number } } | null;
        const pos = r?.getPlayerScreenPos?.();
        if (pos) {
          s.spawnFloatingText(pos.x, pos.y - 30, `+${total}g`, "#ffd700");
        }
        s.triggerGoldFlash();
      }
      return {
        inventory: [],
        craftedItems: newCrafted as CraftedItems,
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
    set((s) => {
      // Calculate survival time since last death
      const lastDeathTick = (s as any)._lastDeathTick ?? 0;
      const survivalTicks = s.stats.totalTicks - lastDeathTick;
      const longestSurvival = Math.max(s.stats.longestSurvivalTicks, survivalTicks);
      return {
        stats: {
          ...s.stats,
          totalDeaths: s.stats.totalDeaths + 1,
          deathsByCause: {
            ...s.stats.deathsByCause,
            [cause]: (s.stats.deathsByCause[cause] ?? 0) + 1,
          },
          longestSurvivalTicks: longestSurvival,
        },
        _lastDeathTick: s.stats.totalTicks,
      } as any;
    }),
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
  recordBarsCrafted: (count) =>
    set((s) => ({ stats: { ...s.stats, totalBarsCrafted: s.stats.totalBarsCrafted + count } })),
  recordTeleport: () =>
    set((s) => ({ stats: { ...s.stats, totalTeleports: s.stats.totalTeleports + 1 } })),
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
  // Crafting
  setCraftedItems: (items) => set({ craftedItems: { ...items } }),
  craft: (recipe) => {
    const s = get();
    if (!canCraft(recipe, s.inventory)) return false;
    const newInventory = consumeInputs(recipe, s.inventory);
    const newCrafted = { ...s.craftedItems };
    newCrafted[recipe.output] = newCrafted[recipe.output] + recipe.outputCount;
    // Spawn floating crafting text
    const r = s.renderer as { getPlayerScreenPos?: () => { x: number; y: number } } | null;
    const pos = r?.getPlayerScreenPos?.();
    if (pos) {
      s.spawnFloatingText(pos.x, pos.y - 30, `+${recipe.outputCount} ${recipe.outputName}`, recipe.color);
    }
    set({
      inventory: newInventory,
      craftedItems: newCrafted,
      stats: { ...s.stats, totalBarsCrafted: s.stats.totalBarsCrafted + recipe.outputCount },
    });
    return true;
  },
  sellCraftedItems: () => {
    const s = get();
    let total = 0;
    for (const [id, count] of Object.entries(s.craftedItems)) {
      const price = CRAFTED_SELL_PRICES[id as CraftedItemId] ?? 0;
      total += price * count;
    }
    if (total === 0) return 0;
    set({
      craftedItems: createCraftedItems(),
      currency: s.currency + total,
      stats: { ...s.stats, totalGoldEarned: s.stats.totalGoldEarned + total },
    });
    return total;
  },
  resetCraftedItems: () => set({ craftedItems: createCraftedItems() }),
  setLastSaveTime: (lastSaveTime) => set({ lastSaveTime }),
  toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
  spawnParticles: () => {}, // overridden by ParticleEffects component
  spawnFloatingText: () => {}, // overridden by ParticleEffects component
  triggerScreenShake: () => {}, // overridden by ScreenShake component
  setTeleportCooldown: (teleportCooldown) => set({ teleportCooldown }),
  triggerGoldFlash: () => set({ goldFlashTime: Date.now() }),
  toggleHUD: () => set((s) => ({ showHUD: !s.showHUD })),
  setPlayerFacing: (playerFacing) => set({ playerFacing }),
  setPlayerSpeed: (playerSpeed) => set({ playerSpeed }),
  setGlowstickCount: (glowstickCount) => set({ glowstickCount }),
  setBombCount: (bombCount) => set({ bombCount }),
  setZoom: (zoom) => set({ zoom }),
  setOnGround: (onGround) => set({ onGround }),
  setWelcomeBack: (welcomeBack) => set({ welcomeBack }),
  toggleFPS: () => set((s) => ({ showFPS: !s.showFPS })),
  toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),
  toggleShop: () => set((s) => ({ showShop: !s.showShop })),
  setShowShop: (showShop) => set({ showShop }),
}));
