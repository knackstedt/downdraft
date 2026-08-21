// ============================================================================
// Achievement definitions — long-term goals that provide a sense of progression.
//
// Each achievement has an ID, name, description, icon (emoji), and a check
// function that receives the current PlayerStats + game state and returns true
// when the achievement is unlocked. The renderer checks all locked achievements
// every second (not every frame — achievements don't need 60Hz checking).
//
// Achievement categories:
//   - Depth milestones (reach certain depths)
//   - Collection milestones (mine/collect N of something)
//   - Economic milestones (earn/spend gold)
//   - Discovery milestones (find rare ores)
//   - Combat/survival milestones (deaths, bombs)
//   - Upgrade milestones (max out upgrades)
// ============================================================================

import type { PlayerStats, PlayerUpgrades } from "./types";

export interface AchievementContext {
  stats: PlayerStats;
  upgrades: PlayerUpgrades;
  currency: number;
}

export interface Achievement {
  /** Unique ID (used as the key in the unlocked set). */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  /** Description of how to unlock it. */
  description: string;
  /** Emoji icon for visual flair. */
  icon: string;
  /** Category for grouping in the UI. */
  category: "depth" | "collection" | "economy" | "discovery" | "combat" | "upgrade";
  /** Check function — returns true when the achievement should unlock. */
  check: (ctx: AchievementContext) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  // --- Depth milestones ---
  {
    id: "first-dig",
    name: "First Dig",
    description: "Mine your first block",
    icon: "⛏️",
    category: "depth",
    check: (ctx) => ctx.stats.totalCellsMined >= 1,
  },
  {
    id: "depth-100",
    name: "Shallow Explorer",
    description: "Reach 100m depth",
    icon: "🕳️",
    category: "depth",
    check: (ctx) => ctx.stats.maxDepthCells >= 100,
  },
  {
    id: "depth-500",
    name: "Deep Diver",
    description: "Reach 500m depth",
    icon: "🌊",
    category: "depth",
    check: (ctx) => ctx.stats.maxDepthCells >= 500,
  },
  {
    id: "depth-1000",
    name: "Abyss Walker",
    description: "Reach 1000m depth (where gold appears)",
    icon: "🌑",
    category: "depth",
    check: (ctx) => ctx.stats.maxDepthCells >= 1000,
  },
  {
    id: "depth-2000",
    name: "Mantle Pioneer",
    description: "Reach 2000m depth",
    icon: "🌋",
    category: "depth",
    check: (ctx) => ctx.stats.maxDepthCells >= 2000,
  },

  // --- Collection milestones ---
  {
    id: "collect-100",
    name: "Gatherer",
    description: "Collect 100 items",
    icon: "📦",
    category: "collection",
    check: (ctx) => ctx.stats.totalItemsCollected >= 100,
  },
  {
    id: "collect-1000",
    name: "Hoarder",
    description: "Collect 1,000 items",
    icon: "🗃️",
    category: "collection",
    check: (ctx) => ctx.stats.totalItemsCollected >= 1000,
  },
  {
    id: "collect-10000",
    name: "Mountain Mover",
    description: "Collect 10,000 items",
    icon: "🏔️",
    category: "collection",
    check: (ctx) => ctx.stats.totalItemsCollected >= 10000,
  },
  {
    id: "mine-1000",
    name: "Quarry Worker",
    description: "Mine 1,000 blocks",
    icon: "⚒️",
    category: "collection",
    check: (ctx) => ctx.stats.totalCellsMined >= 1000,
  },
  {
    id: "mine-10000",
    name: "Excavator",
    description: "Mine 10,000 blocks",
    icon: "🚜",
    category: "collection",
    check: (ctx) => ctx.stats.totalCellsMined >= 10000,
  },

  // --- Economy milestones ---
  {
    id: "first-gold",
    name: "First Profit",
    description: "Earn your first gold piece",
    icon: "🪙",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 1,
  },
  {
    id: "gold-100",
    name: "Pocket Change",
    description: "Earn 100 gold total",
    icon: "💰",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 100,
  },
  {
    id: "gold-1000",
    name: "Prosperous Miner",
    description: "Earn 1,000 gold total",
    icon: "💎",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 1000,
  },
  {
    id: "gold-10000",
    name: "Mining Magnate",
    description: "Earn 10,000 gold total",
    icon: "🏦",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 10000,
  },
  {
    id: "spend-1000",
    name: "Big Spender",
    description: "Spend 1,000 gold on upgrades & materials",
    icon: "🛒",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldSpent >= 1000,
  },

  // --- Discovery milestones (finding rare ores) ---
  {
    id: "find-iron",
    name: "Iron Will",
    description: "Collect your first Iron Ore",
    icon: "🔩",
    category: "discovery",
    check: (ctx) => (ctx.stats.collectedByMaterial[54] ?? 0) >= 1, // Material.IronOre
  },
  {
    id: "find-silver",
    name: "Silver Lining",
    description: "Collect your first Silver Ore",
    icon: "🥈",
    category: "discovery",
    check: (ctx) => (ctx.stats.collectedByMaterial[56] ?? 0) >= 1, // Material.SilverOre
  },
  {
    id: "find-gold-ore",
    name: "Gold Rush",
    description: "Collect your first Gold Ore",
    icon: "👑",
    category: "discovery",
    check: (ctx) => (ctx.stats.collectedByMaterial[57] ?? 0) >= 1, // Material.GoldOre
  },
  {
    id: "find-cobalt",
    name: "Cobalt Hunter",
    description: "Collect your first Cobalt Ore",
    icon: "🔷",
    category: "discovery",
    check: (ctx) => (ctx.stats.collectedByMaterial[58] ?? 0) >= 1, // Material.CobaltOre
  },

  // --- Combat/survival milestones ---
  {
    id: "first-death",
    name: "Learning Experience",
    description: "Die for the first time",
    icon: "💀",
    category: "combat",
    check: (ctx) => ctx.stats.totalDeaths >= 1,
  },
  {
    id: "deaths-10",
    name: "Persistent",
    description: "Die 10 times (and keep playing)",
    icon: "👻",
    category: "combat",
    check: (ctx) => ctx.stats.totalDeaths >= 10,
  },
  {
    id: "bomb-master",
    name: "Demolition Expert",
    description: "Throw 50 bombs",
    icon: "💣",
    category: "combat",
    check: (ctx) => ctx.stats.totalBombsThrown >= 50,
  },
  {
    id: "light-bringer",
    name: "Light Bringer",
    description: "Throw 25 glowsticks",
    icon: "✨",
    category: "combat",
    check: (ctx) => ctx.stats.totalGlowsticksThrown >= 25,
  },
  {
    id: "builder",
    name: "Architect",
    description: "Place 100 blocks in build mode",
    icon: "🏗️",
    category: "combat",
    check: (ctx) => ctx.stats.totalBlocksPlaced >= 100,
  },

  // --- Upgrade milestones ---
  {
    id: "first-upgrade",
    name: "Better Equipment",
    description: "Purchase your first upgrade",
    icon: "⬆️",
    category: "upgrade",
    check: (ctx) =>
      ctx.upgrades.damage > 0 ||
      ctx.upgrades.radius > 0 ||
      ctx.upgrades.rate > 0 ||
      ctx.upgrades.inventorySize > 0,
  },
  {
    id: "max-damage",
    name: "Maxed Out Damage",
    description: "Max out the Mining Damage upgrade",
    icon: "⚔️",
    category: "upgrade",
    check: (ctx) => ctx.upgrades.damage >= 10,
  },
  {
    id: "max-inventory",
    name: "Bottomless Bag",
    description: "Reach inventory capacity level 10",
    icon: "🎒",
    category: "upgrade",
    check: (ctx) => ctx.upgrades.inventorySize >= 10,
  },

  // --- Crafting milestones ---
  {
    id: "first-bar",
    name: "First Bar",
    description: "Smelt your first bar at the furnace",
    icon: "🔥",
    category: "collection",
    check: (ctx) => ctx.stats.totalBarsCrafted >= 1,
  },
  {
    id: "craft-50",
    name: "Smelter",
    description: "Craft 50 bars",
    icon: "🏭",
    category: "collection",
    check: (ctx) => ctx.stats.totalBarsCrafted >= 50,
  },
  {
    id: "craft-500",
    name: "Industrial Forge",
    description: "Craft 500 bars",
    icon: "⚒️",
    category: "collection",
    check: (ctx) => ctx.stats.totalBarsCrafted >= 500,
  },

  // --- Teleport milestones ---
  {
    id: "first-teleport",
    name: "Fast Travel",
    description: "Use the teleport to surface for the first time",
    icon: "🌀",
    category: "economy",
    check: (ctx) => ctx.stats.totalTeleports >= 1,
  },
  {
    id: "teleport-10",
    name: "Frequent Flyer",
    description: "Use the teleport 10 times",
    icon: "✈️",
    category: "economy",
    check: (ctx) => ctx.stats.totalTeleports >= 10,
  },

  // --- Wealth milestones ---
  {
    id: "gold-1000",
    name: "First Fortune",
    description: "Earn 1,000 gold total",
    icon: "💰",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 1000,
  },
  {
    id: "gold-10000",
    name: "Prosperous Miner",
    description: "Earn 10,000 gold total",
    icon: "💎",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 10000,
  },
  {
    id: "gold-100000",
    name: "Mining Tycoon",
    description: "Earn 100,000 gold total",
    icon: "🏦",
    category: "economy",
    check: (ctx) => ctx.stats.totalGoldEarned >= 100000,
  },

  // --- Build milestones ---
  {
    id: "build-100",
    name: "Builder",
    description: "Place 100 blocks in build mode",
    icon: "🧱",
    category: "discovery",
    check: (ctx) => ctx.stats.totalBlocksPlaced >= 100,
  },
  {
    id: "build-1000",
    name: "Architect",
    description: "Place 1,000 blocks in build mode",
    icon: "🏗️",
    category: "discovery",
    check: (ctx) => ctx.stats.totalBlocksPlaced >= 1000,
  },
];

/** Check all locked achievements and return the IDs of newly unlocked ones. */
export function checkAchievements(
  unlocked: Set<string>,
  ctx: AchievementContext,
): string[] {
  const newlyUnlocked: string[] = [];
  for (const achievement of ACHIEVEMENTS) {
    if (unlocked.has(achievement.id)) continue;
    if (achievement.check(ctx)) {
      newlyUnlocked.push(achievement.id);
    }
  }
  return newlyUnlocked;
}

/** Get an achievement by ID (or undefined if not found). */
export function getAchievement(id: string): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}
