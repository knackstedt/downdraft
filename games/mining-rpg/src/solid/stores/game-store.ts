// ============================================================================
// Solid game store — worker-owned single source of truth for UI state.
//
// This store mirrors the zustand GameState from the React fallback path but
// uses Solid's createStore for fine-grained reactivity. It runs entirely in
// the UI worker. The main thread pushes per-frame scalars via the UiStatsSAB
// and event-driven data via postMessage (bridge protocol).
//
// Actions that are UI-only (toggle panels, select build) mutate the store
// directly. Actions with main-thread side effects (pause, teleport, save)
// are forwarded to the main thread via postToMain() AND mutate the store
// optimistically where appropriate.
// ============================================================================

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { ACHIEVEMENTS, checkAchievements, type Achievement } from "../../shared/achievements";
import {
    BASE_INVENTORY_SIZE,
    BUILD_MATERIAL_ID,
    BUILD_MATERIAL_PRICES,
    INVENTORY_SIZE_UPGRADE_INCREMENT,
    OXYGEN_MAX_TICKS,
    SELL_PRICES,
    upgradePrice,
    type BuildMaterialType,
    type UpgradeConfig,
} from "../../shared/constants";
import { canCraft, consumeInputs, CRAFTED_SELL_PRICES, type CraftingRecipe } from "../../shared/crafting-recipes";
import type {
    BuildMaterials,
    CraftedItemId,
    CraftedItems,
    InventoryEntry,
    PlayerStats,
    PlayerUpgrades,
} from "../../shared/types";
import { createCraftedItems, createPlayerStats } from "../../shared/types";
import type { MainToWorkerEvent, RendererSnapshotEvent, WorkerToMainAction } from "../bridge-protocol";
import { readUiStats } from "../ui-stats-sab";

// --- Store shape ---

export interface SolidGameState {
  fps: number | null;
  health: number;
  oxygen: number;
  depth: number;
  paused: boolean;
  gameOver: boolean;
  deathCause: number;
  deathQuip: string;
  digRadius: number;
  inventory: InventoryEntry[];
  upgrades: PlayerUpgrades;
  loadedChunks: number;
  activeChunks: number;
  showInventory: boolean;
  showEscapeMenu: boolean;
  currency: number;
  nearSignpost: boolean;
  buildMode: boolean;
  selectedBuild: BuildMaterialType;
  buildMaterials: BuildMaterials;
  noclip: boolean;
  headlampOn: boolean;
  stats: PlayerStats;
  showStats: boolean;
  unlockedAchievements: string[];
  showAchievements: boolean;
  recentAchievement: Achievement | null;
  craftedItems: CraftedItems;
  showTitleScreen: boolean;
  lastSaveTime: number;
  showMinimap: boolean;
  teleportCooldown: number;
  goldFlashTime: number;
  showHUD: boolean;
  playerFacing: number;
  playerSpeed: number;
  glowstickCount: number;
  bombCount: number;
  zoom: number;
  onGround: boolean;
  welcomeBack: string | null;
  showFPS: boolean;
  showHelp: boolean;
  showShop: boolean;
  // Particle effects — callbacks set by the ParticleEffects/ScreenShake components
  _spawnParticles?: (x: number, y: number, color: string, count: number) => void;
  _spawnFloatingText?: (x: number, y: number, text: string, color: string) => void;
  _triggerScreenShake?: (intensity: number) => void;
  // Internal: last death tick for survival time calculation
  _lastDeathTick: number;
}

// --- Post-to-main callback (set by the worker entry) ---

let _postToMain: ((action: WorkerToMainAction) => void) | null = null;

/** Set the postToMain callback. Called once by the worker entry. */
export function setPostToMain(fn: (action: WorkerToMainAction) => void): void {
  _postToMain = fn;
}

function postToMain(action: WorkerToMainAction): void {
  _postToMain?.(action);
}

// --- Store instance ---

const initialState: SolidGameState = {
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
  unlockedAchievements: [],
  showAchievements: false,
  recentAchievement: null,
  craftedItems: createCraftedItems(),
  showTitleScreen: true,
  lastSaveTime: 0,
  showMinimap: true,
  teleportCooldown: 1,
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
  _lastDeathTick: 0,
};

export const [gameStore, setGameStore] = createStore<SolidGameState>(initialState);

// --- Renderer snapshot signal ---
// Updated by the main thread at ~30fps via postMessage. Read by overlay
// components that need camera + entity positions (signpost, bombs, minimap).
export const [rendererSnapshot, setRendererSnapshot] = createSignal<RendererSnapshotEvent | null>(null);

// --- Actions ---

export const actions = {
  setFPS: (fps: number) => setGameStore("fps", fps),
  setHealth: (health: number) => setGameStore("health", health),
  setOxygen: (oxygen: number) => setGameStore("oxygen", oxygen),
  setDepth: (depth: number) => setGameStore("depth", depth),
  setPaused: (paused: boolean) => setGameStore("paused", paused),
  setGameOver: (gameOver: boolean) => setGameStore("gameOver", gameOver),
  setDeathCause: (c: number) => setGameStore("deathCause", c),
  setDeathQuip: (q: string) => setGameStore("deathQuip", q),
  setDigRadius: (r: number) => setGameStore("digRadius", r),
  setInventory: (inv: InventoryEntry[]) => setGameStore("inventory", inv),
  addToInventory: (mat: number, count: number) =>
    setGameStore("inventory", (items) => {
      const existing = items.find((e) => e.mat === mat);
      if (existing) {
        return items.map((e) => (e.mat === mat ? { ...e, count: e.count + count } : e));
      }
      return [...items, { mat, count }];
    }),
  setUpgrades: (upgrades: PlayerUpgrades) => setGameStore("upgrades", upgrades),
  setLoadedChunks: (n: number) => setGameStore("loadedChunks", n),
  setActiveChunks: (n: number) => setGameStore("activeChunks", n),
  setShowInventory: (show: boolean) => setGameStore("showInventory", show),
  setShowEscapeMenu: (show: boolean) => setGameStore("showEscapeMenu", show),
  setCurrency: (c: number) => setGameStore("currency", c),
  addCurrency: (amount: number) => setGameStore("currency", (c) => c + amount),
  setNearSignpost: (near: boolean) => setGameStore("nearSignpost", near),
  sellAll: () => {
    let total = 0;
    for (const entry of gameStore.inventory) {
      const price = SELL_PRICES[entry.mat] ?? 0;
      total += price * entry.count;
    }
    let craftedTotal = 0;
    const newCrafted = { ...gameStore.craftedItems };
    for (const [id, count] of Object.entries(newCrafted)) {
      const price = CRAFTED_SELL_PRICES[id as CraftedItemId] ?? 0;
      craftedTotal += price * count;
      (newCrafted as Record<string, number>)[id] = 0;
    }
    total += craftedTotal;
    if (total > 0) {
      gameStore._spawnFloatingText?.(0, 0, `+${total}g`, "#ffd700");
      actions.triggerGoldFlash();
    }
    setGameStore("inventory", []);
    setGameStore("craftedItems", newCrafted as CraftedItems);
    setGameStore("currency", (c) => c + total);
    setGameStore("stats", "totalGoldEarned", (v) => v + total);
    // Forward to main thread so the worker's inventory is cleared
    postToMain({ kind: "sellAll" });
  },
  getMaxInventory: () => BASE_INVENTORY_SIZE + gameStore.upgrades.inventorySize * INVENTORY_SIZE_UPGRADE_INCREMENT,
  getInventoryCount: () => gameStore.inventory.reduce((sum, e) => sum + e.count, 0),
  setBuildMode: (on: boolean) => setGameStore("buildMode", on),
  toggleBuildMode: () => {
    setGameStore("buildMode", (v) => !v);
    postToMain({ kind: "toggleBuildMode" });
  },
  selectBuild: (type: BuildMaterialType) => {
    setGameStore("selectedBuild", type);
    postToMain({ kind: "selectBuild", type });
  },
  setBuildMaterials: (mats: BuildMaterials) => setGameStore("buildMaterials", { ...mats }),
  getSelectedBuildMatId: () => BUILD_MATERIAL_ID[gameStore.selectedBuild],
  setNoclip: (on: boolean) => setGameStore("noclip", on),
  toggleNoclip: () => {
    setGameStore("noclip", (v) => !v);
    postToMain({ kind: "toggleNoclip" });
  },
  setHeadlamp: (on: boolean) => setGameStore("headlampOn", on),
  toggleHeadlamp: () => {
    setGameStore("headlampOn", (v) => !v);
    postToMain({ kind: "toggleHeadlamp" });
  },
  buyBuildMaterial: (type: BuildMaterialType, qty: number): boolean => {
    const price = BUILD_MATERIAL_PRICES[type] * qty;
    if (gameStore.currency < price) return false;
    setGameStore("currency", (c) => c - price);
    setGameStore("stats", "totalGoldSpent", (v) => v + price);
    postToMain({ kind: "buyBuildMaterial", type, qty });
    return true;
  },
  purchaseUpgrade: (config: UpgradeConfig): boolean => {
    const currentLevel = gameStore.upgrades[config.key];
    if (currentLevel >= config.maxLevel) return false;
    const price = upgradePrice(config, currentLevel);
    if (gameStore.currency < price) return false;
    setGameStore("currency", (c) => c - price);
    setGameStore("upgrades", config.key, currentLevel + 1);
    setGameStore("stats", "totalGoldSpent", (v) => v + price);
    postToMain({ kind: "buyUpgrade", config });
    return true;
  },
  setStats: (stats: PlayerStats) => setGameStore("stats", stats),
  setShowStats: (show: boolean) => setGameStore("showStats", show),
  toggleStats: () => setGameStore("showStats", (v) => !v),
  recordCollected: (items: InventoryEntry[]) =>
    setGameStore(
      produce((s: SolidGameState) => {
        for (const item of items) {
          s.stats.collectedByMaterial[item.mat] = (s.stats.collectedByMaterial[item.mat] ?? 0) + item.count;
          s.stats.totalItemsCollected += item.count;
        }
      }),
    ),
  recordDeath: (cause: number) =>
    setGameStore(
      produce((s: SolidGameState) => {
        const survivalTicks = s.stats.totalTicks - s._lastDeathTick;
        s.stats.longestSurvivalTicks = Math.max(s.stats.longestSurvivalTicks, survivalTicks);
        s.stats.totalDeaths += 1;
        s.stats.deathsByCause[cause] = (s.stats.deathsByCause[cause] ?? 0) + 1;
        s._lastDeathTick = s.stats.totalTicks;
      }),
    ),
  recordGoldEarned: (amount: number) => setGameStore("stats", "totalGoldEarned", (v) => v + amount),
  recordGoldSpent: (amount: number) => setGameStore("stats", "totalGoldSpent", (v) => v + amount),
  recordBombThrown: () => setGameStore("stats", "totalBombsThrown", (v) => v + 1),
  recordGlowstickThrown: () => setGameStore("stats", "totalGlowsticksThrown", (v) => v + 1),
  recordBlocksPlaced: (count: number) => setGameStore("stats", "totalBlocksPlaced", (v) => v + count),
  recordBarsCrafted: (count: number) => setGameStore("stats", "totalBarsCrafted", (v) => v + count),
  recordTeleport: () => setGameStore("stats", "totalTeleports", (v) => v + 1),
  recordCellsMined: (count: number) => setGameStore("stats", "totalCellsMined", (v) => v + count),
  recordDepth: (depthCells: number) =>
    setGameStore(
      produce((s: SolidGameState) => {
        if (depthCells > s.stats.maxDepthCells) s.stats.maxDepthCells = depthCells;
      }),
    ),
  recordTicks: (ticks: number) => setGameStore("stats", "totalTicks", (v) => v + ticks),
  resetStats: () => setGameStore("stats", createPlayerStats()),
  setUnlockedAchievements: (ids: string[]) => setGameStore("unlockedAchievements", [...ids]),
  setShowAchievements: (show: boolean) => setGameStore("showAchievements", show),
  toggleAchievements: () => setGameStore("showAchievements", (v) => !v),
  clearRecentAchievement: () => setGameStore("recentAchievement", null),
  checkAndUnlockAchievements: (): number => {
    const ctx = { stats: gameStore.stats, upgrades: gameStore.upgrades, currency: gameStore.currency };
    const unlockedSet = new Set(gameStore.unlockedAchievements);
    const newlyUnlocked = checkAchievements(unlockedSet, ctx);
    if (newlyUnlocked.length === 0) return 0;
    for (const id of newlyUnlocked) unlockedSet.add(id);
    const recent = ACHIEVEMENTS.find((a) => a.id === newlyUnlocked[newlyUnlocked.length - 1]) ?? null;
    setGameStore("unlockedAchievements", [...unlockedSet]);
    setGameStore("recentAchievement", recent);
    return newlyUnlocked.length;
  },
  resetAchievements: () => {
    setGameStore("unlockedAchievements", []);
    setGameStore("recentAchievement", null);
  },
  setCraftedItems: (items: CraftedItems) => setGameStore("craftedItems", { ...items }),
  craft: (recipe: CraftingRecipe): boolean => {
    if (!canCraft(recipe, gameStore.inventory)) return false;
    const newInventory = consumeInputs(recipe, gameStore.inventory);
    const newCrafted = { ...gameStore.craftedItems };
    newCrafted[recipe.output] = newCrafted[recipe.output] + recipe.outputCount;
    gameStore._spawnFloatingText?.(0, 0, `+${recipe.outputCount} ${recipe.outputName}`, recipe.color);
    setGameStore("inventory", newInventory);
    setGameStore("craftedItems", newCrafted);
    setGameStore("stats", "totalBarsCrafted", (v) => v + recipe.outputCount);
    postToMain({ kind: "setInventory", inventory: newInventory });
    postToMain({ kind: "craft", recipe });
    return true;
  },
  sellCraftedItems: (): number => {
    let total = 0;
    for (const [id, count] of Object.entries(gameStore.craftedItems)) {
      const price = CRAFTED_SELL_PRICES[id as CraftedItemId] ?? 0;
      total += price * count;
    }
    if (total === 0) return 0;
    setGameStore("craftedItems", createCraftedItems());
    setGameStore("currency", (c) => c + total);
    setGameStore("stats", "totalGoldEarned", (v) => v + total);
    return total;
  },
  resetCraftedItems: () => setGameStore("craftedItems", createCraftedItems()),
  setShowTitleScreen: (show: boolean) => {
    setGameStore("showTitleScreen", show);
    postToMain({ kind: "setShowTitleScreen", show });
  },
  setLastSaveTime: (time: number) => setGameStore("lastSaveTime", time),
  toggleMinimap: () => setGameStore("showMinimap", (v) => !v),
  setTeleportCooldown: (v: number) => setGameStore("teleportCooldown", v),
  triggerGoldFlash: () => setGameStore("goldFlashTime", Date.now()),
  toggleHUD: () => setGameStore("showHUD", (v) => !v),
  setPlayerFacing: (f: number) => setGameStore("playerFacing", f),
  setPlayerSpeed: (s: number) => setGameStore("playerSpeed", s),
  setGlowstickCount: (n: number) => setGameStore("glowstickCount", n),
  setBombCount: (n: number) => setGameStore("bombCount", n),
  setZoom: (z: number) => {
    setGameStore("zoom", z);
    postToMain({ kind: "setZoom", zoom: z });
  },
  setOnGround: (v: boolean) => setGameStore("onGround", v),
  setWelcomeBack: (msg: string | null) => setGameStore("welcomeBack", msg),
  toggleFPS: () => setGameStore("showFPS", (v) => !v),
  toggleHelp: () => setGameStore("showHelp", (v) => !v),
  toggleShop: () => {
    setGameStore("showShop", (v) => !v);
    postToMain({ kind: "toggleShop" });
  },
  setShowShop: (show: boolean) => {
    setGameStore("showShop", show);
    postToMain({ kind: "setShowShop", show });
  },
  // Pause/resume — forward to main thread for sim control
  pause: () => {
    setGameStore("paused", true);
    postToMain({ kind: "pause" });
  },
  resume: () => {
    setGameStore("paused", false);
    postToMain({ kind: "resume" });
  },
  teleport: () => {
    postToMain({ kind: "teleport" });
  },
  respawn: () => {
    setGameStore("gameOver", false);
    setGameStore("health", 100);
    setGameStore("oxygen", OXYGEN_MAX_TICKS);
    setGameStore("paused", false);
    postToMain({ kind: "respawn" });
  },
  save: () => {
    postToMain({ kind: "save" });
  },
  startGame: () => {
    setGameStore("showTitleScreen", false);
    postToMain({ kind: "startGame" });
  },
  deleteSave: () => {
    postToMain({ kind: "deleteSave" });
  },
  // Particle effect callbacks — set by components
  spawnParticles: (x: number, y: number, color: string, count: number) => {
    gameStore._spawnParticles?.(x, y, color, count);
  },
  spawnFloatingText: (x: number, y: number, text: string, color: string) => {
    gameStore._spawnFloatingText?.(x, y, text, color);
  },
  triggerScreenShake: (intensity: number) => {
    gameStore._triggerScreenShake?.(intensity);
  },
};

// --- UiStatsSAB connection ---

let _uiStatsSab: SharedArrayBuffer | null = null;
let _statsTickRunning = false;

// --- Minimap SAB connection ---
// The main thread writes minimap pixel data (RGBA) to this SAB each frame.
// The minimap component reads it and does putImageData.
let _minimapSab: SharedArrayBuffer | null = null;
export const MINIMAP_SIZE = 160; // CSS pixels (must match the component)

/** Connect the store to the UiStatsSAB and start the per-frame sync. */
export function connectUiStats(sab: SharedArrayBuffer): void {
  _uiStatsSab = sab;
  if (_statsTickRunning) return;
  _statsTickRunning = true;
  // The rAF loop is driven by the worker entry (which also drains undertow
  // replies + events). We just expose the tick function.
}

/** Connect the minimap SAB. Called once by the worker entry. */
export function connectMinimap(sab: SharedArrayBuffer): void {
  _minimapSab = sab;
}

/** Read the minimap pixel data from the SAB. Returns a Uint8ClampedArray view. */
export function readMinimapPixels(): Uint8ClampedArray | null {
  if (!_minimapSab) return null;
  const size = MINIMAP_SIZE * MINIMAP_SIZE * 4;
  return new Uint8ClampedArray(_minimapSab, 0, size);
}

/** Read the UiStatsSAB and update the store. Called each rAF by the worker entry. */
export function tickUiStats(): void {
  if (!_uiStatsSab) return;
  const data = readUiStats(_uiStatsSab);
  // Only update fields that actually changed — Solid's createStore auto-tracks
  // which signals are read by components, so setting a field that no component
  // reads is a no-op. But we still avoid redundant writes for cleanliness.
  if (gameStore.fps !== data.fps) setGameStore("fps", data.fps);
  // Guard health/oxygen/gameOver with simReady: before the sim writes its
  // first frame, the SAB is zero-initialized (health=0, oxygen=0, gameOver=0).
  // Writing those zeros to the store would trigger the DangerVignette (red
  // flash for low health, blue flash for low oxygen) even though the player
  // is at full health. Skip until the sim is actually running.
  if (data.simReady && data.tick > 0) {
    if (gameStore.health !== data.health) setGameStore("health", data.health);
    if (gameStore.oxygen !== data.oxygen) setGameStore("oxygen", data.oxygen);
    if (gameStore.gameOver !== data.gameOver) setGameStore("gameOver", data.gameOver);
    if (gameStore.deathCause !== data.deathCause) setGameStore("deathCause", data.deathCause);
  }
  if (gameStore.depth !== data.depth) setGameStore("depth", data.depth);
  if (gameStore.loadedChunks !== data.loadedChunks) setGameStore("loadedChunks", data.loadedChunks);
  if (gameStore.activeChunks !== data.activeChunks) setGameStore("activeChunks", data.activeChunks);
  if (gameStore.nearSignpost !== data.nearSignpost) setGameStore("nearSignpost", data.nearSignpost);
  if (gameStore.onGround !== data.onGround) setGameStore("onGround", data.onGround);
  if (gameStore.playerFacing !== data.playerFacing) setGameStore("playerFacing", data.playerFacing);
  if (gameStore.playerSpeed !== data.playerSpeed) setGameStore("playerSpeed", data.playerSpeed);
  if (gameStore.glowstickCount !== data.glowstickCount) setGameStore("glowstickCount", data.glowstickCount);
  if (gameStore.bombCount !== data.bombCount) setGameStore("bombCount", data.bombCount);
  if (gameStore.zoom !== data.zoom) setGameStore("zoom", data.zoom);
  if (gameStore.teleportCooldown !== data.teleportCooldown) setGameStore("teleportCooldown", data.teleportCooldown);
  // Record depth + ticks (only when sim is running)
  if (!data.gameOver && !gameStore.paused) {
    // Depth in cells below surface — approximate using depth in chunks * 128
    // The renderer computes the exact value; we use the chunk depth as a proxy
    // for stats tracking. The main thread sends exact values via events if needed.
    // Actually, the renderer already calls recordDepth/recordTicks via the
    // achievement check timer. But in worker mode, the renderer doesn't call
    // the Solid store. We need to track depth + ticks here from the SAB.
    if (data.simReady && data.tick > 0) {
      const depthCells = data.depth * 128; // approximate
      actions.recordDepth(depthCells);
    }
  }
}

// --- Main→worker event handler ---

/** Apply an incoming event from the main thread. Called by the worker entry. */
export function applyMainEvent(msg: MainToWorkerEvent): void {
  switch (msg.kind) {
    case "collected":
      for (const item of msg.items) {
        actions.addToInventory(item.mat, item.count);
      }
      if (msg.items.length > 0) {
        actions.recordCollected(msg.items);
      }
      // Sync the new inventory to the sim worker (so it can enforce max size)
      postToMain({ kind: "setInventory", inventory: gameStore.inventory });
      break;
    case "saveLoaded":
      setGameStore("inventory", msg.inventory);
      setGameStore("upgrades", msg.upgrades);
      setGameStore("currency", msg.currency);
      setGameStore("buildMaterials", msg.buildMaterials);
      if (msg.health) setGameStore("health", msg.health);
      setGameStore("stats", msg.stats);
      setGameStore("unlockedAchievements", msg.unlockedAchievements);
      setGameStore("craftedItems", msg.craftedItems);
      setGameStore("welcomeBack", msg.welcomeBack);
      setGameStore("showTitleScreen", false);
      break;
    case "savedAt":
      setGameStore("lastSaveTime", msg.time);
      break;
    case "achievement":
      // The achievement check runs on the main thread (renderer). When one
      // unlocks, it sends this event so the worker store can update its UI.
      actions.checkAndUnlockAchievements();
      break;
    case "floatingText":
      gameStore._spawnFloatingText?.(msg.x, msg.y, msg.text, msg.color);
      break;
    case "screenShake":
      gameStore._triggerScreenShake?.(msg.intensity);
      break;
    case "death":
      setGameStore("deathCause", msg.cause);
      setGameStore("deathQuip", msg.quip);
      setGameStore("gameOver", true);
      actions.recordDeath(msg.cause);
      break;
    case "buildMaterials":
      setGameStore("buildMaterials", msg.mats);
      break;
    case "setInventory":
      setGameStore("inventory", msg.inventory);
      break;
    case "rendererSnapshot":
      setRendererSnapshot(msg);
      break;
  }
}
