// ============================================================================
// Core Type Definitions — shared across all threads (main, sim, renderer)
// Engine-level types re-exported from @downdraft/core.
// Game-specific types (biomes, ports, fishing, economy, etc.) remain here.
// ============================================================================

// --- Engine-level types (re-exported from core) ---
export { CameraMode, EntityFlags } from "@downdraft/core";
export type { DbRequest, DbResponse, EntityData, EntityId, MainToSimMessage, PlayerId, PlayerState, Quat, RendererToSimMessage, SimToMainMessage, SimToRendererMessage, Transform, Vec2, Vec3, Vec4 } from "@downdraft/core";

// Re-export for backward compat — these are now in core
import type { EntityId, PlayerId, Quat, Vec3 } from "@downdraft/core";

// --- Game Modes ---

export enum GameMode {
  Creative = "creative",
  Survival = "survival",
  Hardcore = "hardcore",
  Custom = "custom",
}

// --- Game-Specific Enums ---

export enum BiomeType {
  Lake = 0,
  Arctic = 1,
  Desert = 2,
  BorealForest = 3,
  Tropical = 4,
  SubTropical = 5,
  Freshwater = 6,
  Ocean = 7,
  DeepOcean = 8,
  CoralReef = 9,
  KelpForest = 10,
  Volcanic = 11,
  GarbagePatch = 12,
  Hell = 13,
}

export enum SecurityLevel {
  Safe = 0,       // green
  Moderate = 1,   // yellow
  High = 2,       // red
  Extreme = 3,    // black
}

export enum WeatherType {
  Clear = 0,
  PartlyCloudy = 1,
  Overcast = 2,
  Rain = 3,
  Storm = 4,
  Fog = 5,
  Eclipse = 6,
  FullMoon = 7,
  HellStorm = 8,
  Snow = 9,
}

export enum PortSize {
  Small = 0,
  Medium = 1,
  Large = 2,
}

export enum PortTheme {
  Tropical = "tropical",
  Industrial = "industrial",
  Pirate = "pirate",
  Mafia = "mafia",
  Fishing = "fishing",
  Military = "military",
  Research = "research",
  Resort = "resort",
  Trading = "trading",
  Salvage = "salvage",
  Arctic = "arctic",
  Volcanic = "volcanic",
  Ghost = "ghost",
}

export enum IslandSize {
  Small = 0,
  Medium = 1,
  Large = 2,
}

export enum EntityType {
  Player = 0,
  Ship = 1,
  SmallCraft = 2,
  Fish = 3,
  Shark = 4,
  Eel = 5,
  Jellyfish = 6,
  DevilShrimp = 7,
  Whale = 8,
  Dolphin = 9,
  Turtle = 10,
  Crustacean = 11,
  Coral = 12,
  Moose = 13,
  Pirate = 14,
  PirateShip = 15,
  Island = 16,
  Port = 17,
  Reef = 18,
  Wreck = 19,
  Pet = 20,
  Livestock = 21,
  Plant = 22,
  Placeable = 23,
  RainCollector = 24,
  Treasure = 25,
}

export const EntityTypeNames: Record<number, string> = {
  [EntityType.Player]: "Player",
  [EntityType.Ship]: "Ship",
  [EntityType.SmallCraft]: "SmallCraft",
  [EntityType.Fish]: "Fish",
  [EntityType.Shark]: "Shark",
  [EntityType.Eel]: "Eel",
  [EntityType.Jellyfish]: "Jellyfish",
  [EntityType.DevilShrimp]: "DevilShrimp",
  [EntityType.Whale]: "Whale",
  [EntityType.Dolphin]: "Dolphin",
  [EntityType.Turtle]: "Turtle",
  [EntityType.Crustacean]: "Crustacean",
  [EntityType.Coral]: "Coral",
  [EntityType.Moose]: "Moose",
  [EntityType.Pirate]: "Pirate",
  [EntityType.PirateShip]: "PirateShip",
  [EntityType.Island]: "Island",
  [EntityType.Port]: "Port",
  [EntityType.Reef]: "Reef",
  [EntityType.Wreck]: "Wreck",
  [EntityType.Pet]: "Pet",
  [EntityType.Livestock]: "Livestock",
  [EntityType.Plant]: "Plant",
  [EntityType.Placeable]: "Placeable",
  [EntityType.RainCollector]: "RainCollector",
  [EntityType.Treasure]: "Treasure",
};

export enum SmallCraftType {
  Rowboat = 0,
  Dinghy = 1,
  Submersible = 2,
}

export enum FishingMethod {
  LineFishing = 0,
  NetHauling = 1,
  TrapChecking = 2,
}

export enum ItemCategory {
  Fish = "fish",
  Junk = "junk",
  Material = "material",
  Equipment = "equipment",
  Placeable = "placeable",
  Consumable = "consumable",
  Cosmetic = "cosmetic",
  Tool = "tool",
  Weapon = "weapon",
  Armor = "armor",
  Seed = "seed",
  Bait = "bait",
  Treasure = "treasure",
}

export enum StorageType {
  Generic = "generic",
  FishTank = "fish_tank",
  WeaponLocker = "weapon_locker",
  Refrigerator = "refrigerator",
  Freezer = "freezer",
  CargoHold = "cargo_hold",
}

export enum PetType {
  Cat = "cat",
  Dog = "dog",
  Parrot = "parrot",
  Crow = "crow",
  Raccoon = "raccoon",
  Shark = "shark",
}

export enum PirateRace {
  Swashbuckler = "swashbuckler",
  Mafia = "mafia",
  Corsair = "corsair",
  Smuggler = "smuggler",
  Raider = "raider",
  Marauder = "marauder",
  Buccaneer = "buccaneer",
  Privateer = "privateer",
  Reaver = "reaver",
  Dreadnought = "dreadnought",
  KrakenCult = "kraken_cult",
  GhostFleet = "ghost_fleet",
  AbyssalOrder = "abyssal_order",
}

// --- Items ---

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  width: number;            // grid cells (player inventory)
  height: number;
  maxStack: number;
  value: number;             // base value
  rarity: number;            // 0-5
  spoilRate?: number;        // per-game-hour, if perishable
  icon?: string;
  description?: string;
  biomeRestriction?: BiomeType[];
  cosmetic?: boolean;        // cosmetic placeable
  gag?: boolean;             // gag item (just sells for money)
}

export interface ItemStack {
  itemId: string;
  quantity: number;
  spoilProgress?: number;    // 0 = fresh, 1 = spoiled
}

export interface InventorySlot {
  x: number;
  y: number;
  stack: ItemStack | null;
}

// --- Ships & Building ---

export interface ModuleDef {
  id: string;
  name: string;
  category: "exterior" | "interior";
  width: number;
  height: number;
  depth: number;
  integrity: number;         // structural integrity contribution
  weight: number;
  cost: { itemId: string; quantity: number }[];
  description?: string;
}

export interface HullSection {
  id: string;
  position: Vec3;
  rotation: Quat;
  size: Vec3;
  integrity: number;
  isLeaking: boolean;
}

export interface ShipDesign {
  id: string;
  name: string;
  hullSections: HullSection[];
  modules: { moduleDefId: string; position: Vec3; rotation: Quat }[];
  placeables: { placeableId: string; position: Vec3; rotation: Quat }[];
  createdAt: number;
  updatedAt: number;
}

export interface ShipState {
  id: EntityId;
  designId: string;
  hullIntegrity: number;
  maxHullIntegrity: number;
  buoyancy: number;
  ballast: number;
  speed: number;
  heading: number;
  dockCount: number;
  dockedCraft: EntityId[];
  cargoInventory: InventorySlot[];
  storageInventory: InventorySlot[];
  cargoCapacity: number;
  storageCapacity: number;
}

export interface SmallCraftState {
  id: EntityId;
  type: SmallCraftType;
  fuel: number;
  maxFuel: number;
  health: number;
  maxHealth: number;
  dockedAt: EntityId;       // ship id or 0
  speed: number;
  depthRating: number;
  cargoCapacity: number;
  stealthFactor: number;    // lower = harder for wildlife to detect
}

// --- World ---

export interface PortDef {
  id: string;
  name: string;
  size: PortSize;
  theme: PortTheme;
  position: Vec3;
  securityLevel: SecurityLevel;
  biome: BiomeType;
  marketSpecialties: string[];   // item ids that sell well here
  services: PortService[];
}

export enum PortService {
  Trading = "trading",
  Shipyard = "shipyard",
  HullModification = "hull_modification",
  Fishing = "fishing",
  Inn = "inn",
  Supplies = "supplies",
  Licenses = "licenses",
  Storage = "storage",
}

export interface IslandDef {
  id: string;
  name: string;
  size: IslandSize;
  position: Vec3;
  radius: number;
  biome: BiomeType;
  securityLevel: SecurityLevel;
  hasCoves: boolean;
  hasCaves: boolean;
  resourceNodes: ResourceNode[];
  craftingStations: string[];
  storageAreas: number;
}

export interface ResourceNode {
  type: string;
  position: Vec3;
  amount: number;
  respawnTime: number;
}

export interface ChunkInfo {
  x: number;
  z: number;
  biome: BiomeType;
  securityLevel: SecurityLevel;
  hasPort: boolean;
  hasIsland: boolean;
  waterDepth: number;
}

// --- Fishing ---

export interface FishSpecies {
  id: string;
  name: string;
  biome: BiomeType[];
  minDepth: number;
  maxDepth: number;
  rarity: number;           // 0-5
  minSize: number;
  maxSize: number;
  baseValue: number;
  method: FishingMethod;
  timeOfDay: "day" | "night" | "any";
  season?: string[];
}

export interface CatchResult {
  species: FishSpecies | null;
  junkItem: ItemDef | null;
  size: number;
  value: number;
  isJunk: boolean;
}

// --- Economy ---

export interface MarketListing {
  itemId: string;
  buyPrice: number;
  sellPrice: number;
  supply: number;
  demand: number;
  priceModifier: number;   // dynamic adjustment from trades
  lastTradeTime: number;
}

export interface TradeOffer {
  itemId: string;
  quantity: number;
  pricePerUnit: number;
  totalPrice: number;
  isBuying: boolean;        // true = player buying, false = player selling
}

// --- Wildlife ---

export interface WildlifeSpecies {
  id: string;
  name: string;
  type: EntityType;
  health: number;
  speed: number;
  damage: number;
  detectionRange: number;
  biomes: BiomeType[];
  minDepth: number;
  maxDepth: number;
  isHostile: boolean;
  isTameable: boolean;
  drops: { itemId: string; chance: number; quantity: number }[];
  spawnWeight: number;
  minGroupSize: number;
  maxGroupSize: number;
}

// --- Player ---

export interface PlayerProfile {
  id: PlayerId;
  name: string;
  character: CharacterCustomization;
  licenses: SmallCraftType[];
  gamemode: GameMode;
  bedEntityId: EntityId;
}

export interface CharacterCustomization {
  bodyType: number;
  bodyScale: Vec3;
  headShape: number;
  hairStyle: number;
  hairColor: number;
  skinTone: number;
  eyeColor: number;
  outfit: number;
  accessories: number[];
}

// --- Weather ---

export interface WeatherState {
  type: WeatherType;
  intensity: number;       // 0-1
  windDirection: Vec3;
  windSpeed: number;
  visibility: number;       // 0-1, 1 = clear
  temperature: number;
  duration: number;         // seconds remaining
  cooldown: number;         // seconds until next change
  isRareEvent: boolean;
}

// --- Progression ---

export interface HullTier {
  tier: number;
  name: string;
  maxSize: Vec3;
  maxModules: number;
  depthRating: number;
  cargoCapacity: number;
  storageCapacity: number;
  requiredMaterials: { itemId: string; quantity: number }[];
}

export interface EquipmentTier {
  tier: number;
  name: string;
  catchPoolRarity: number;  // max rarity this equipment can catch
  effectiveness: number;
  requiredMaterials: { itemId: string; quantity: number }[];
}

// --- Game Commands ---

export type SimCommandType =
  | "trade"
  | "craft"
  | "build"
  | "dock"
  | "license"
  | "drink"
  | "eat"
  | "sleep"
  | "wake"
  | "place_item"
  | "pickup_item"
  | "drop_item"
  | "inventory_move"
  | "ship_hold_move"
  | "transfer_to_ship"
  | "transfer_from_ship"
  | "plant"
  | "harvest"
  | "water";

export interface SimCommand {
  type: SimCommandType;
  playerId: number;
  payload: Record<string, unknown>;
}

export type WorldCommandType =
  | "override_biome"
  | "force_port"
  | "force_island"
  | "remove_port"
  | "remove_island"
  | "clear_overrides"
  | "set_seed"
  | "toggle_event";

export interface WorldCommand {
  type: WorldCommandType;
  payload: {
    chunkX?: number;
    chunkZ?: number;
    biome?: number;
    portSize?: number;
    islandSize?: number;
    seed?: number;
    event?: string;
    action?: string;
  };
}

export interface TerrainDeformationBroadcast {
  chunkX: number;
  chunkZ: number;
  isPort: boolean;
  worldX: number;
  worldY: number;
  worldZ: number;
  entityWorldX: number;
  entityWorldY: number;
  entityWorldZ: number;
  radius: number;
  strength: number;
}

// --- Split-Screen ---
// Re-exported from @downdraft/core for backward compatibility
export type { SplitscreenLayoutType, ViewportSlot } from "@downdraft/core";

// --- Gamemode Rules ---

export interface GameRules {
  pvp: boolean;
  keepInventory: boolean;
  hungerRate: number;
  thirstRate: number;
  oxygenRate: number;
  temperatureRate: number;
  priceRecoveryHours: number;
  pirateSpawnMultiplier: number;
  weatherIntensity: number;
  dayDuration: number;       // seconds for a full day
  nightSkipThreshold: number; // 0.5 = 50% of players
  portGenerationRate: number;   // chance per chunk to generate a port
  islandGenerationRate: number; // chance per chunk to generate an island
  waterUpdateInterval: number;  // sim ticks between water height updates (1=every tick, 2=every 2nd, etc.)
}
