// ============================================================================
// Core Type Definitions — shared across all threads (main, sim, renderer)
// ============================================================================

// --- Math ---

export interface Vec2 { x: number; y: number; }
export interface Vec3 { x: number; y: number; z: number; }
export interface Vec4 { x: number; y: number; z: number; w: number; }
export type Quat = Vec4;

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

// --- Identifiers ---

export type EntityId = number;
export type PlayerId = number;

// --- Enums ---

export enum GameMode {
  Creative = "creative",
  Survival = "survival",
  Hardcore = "hardcore",
  Custom = "custom",
}

export enum CameraMode {
  FirstPerson = 0,
  ThirdPerson = 1,
  FreeCam = 2,
}

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

export enum EntityFlags {
  None = 0,
  Static = 1 << 0,
  NoCollision = 1 << 1,
  Underwater = 1 << 2,
  Onboard = 1 << 3,    // entity is on a ship
  Docked = 1 << 4,
  Sleeping = 1 << 5,
  Dead = 1 << 6,
  Hostile = 1 << 7,
  Tameable = 1 << 8,
  Bioluminescent = 1 << 9,
}

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

// --- Entity Component Data ---

export interface EntityData {
  id: EntityId;
  type: EntityType;
  flags: number;
  transform: Transform;
  velocity: Vec3;
  angularVelocity: Vec3;
  health: number;
  maxHealth: number;
  parentId: EntityId;     // ship/island this entity is on (0 = none)
  chunkX: number;
  chunkZ: number;
  // Type-specific data stored as a compact blob
  data: Float32Array;
}

export interface PlayerState {
  id: PlayerId;
  entityId: EntityId;
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  maxOxygen: number;
  temperature: number;
  cameraMode: CameraMode;
  activeSlot: number;      // hotbar active slot
  flags: number;           // sleeping, dead, etc.
  viewportX: number;        // split-screen viewport
  viewportY: number;
  viewportW: number;
  viewportH: number;
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

// --- Messages ---

export interface SimToRendererMessage {
  kind: "entity_spawn" | "entity_despawn" | "ui_event" | "state_snapshot" | "weather_update" | "market_update" | "catch_result" | "trade_result" | "notification" | "player_update";
  data: any;
}

export interface RendererToSimMessage {
  kind: "input_action" | "build_request" | "fish_cast" | "fish_reel" | "trade" | "place_item" | "remove_item" | "sleep" | "respawn" | "customization" | "gamemode" | "save" | "load" | "settings";
  data: any;
}

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
  | "transfer_from_ship";

export interface SimCommand {
  type: SimCommandType;
  playerId: number;
  payload: Record<string, unknown>;
}

export interface MainToSimMessage {
  kind: "init" | "pause" | "resume" | "save" | "load" | "set_gamemode" | "set_setting" | "add_player" | "remove_player" | "shutdown" | "respawn" | "debug_mode" | "command" | "world_command" | "set_weather" | "set_time_of_day";
  data: any;
}

export type WorldCommandType =
  | "override_biome"
  | "force_port"
  | "force_island"
  | "remove_port"
  | "remove_island"
  | "clear_overrides"
  | "set_seed";

export interface WorldCommand {
  type: WorldCommandType;
  payload: {
    chunkX?: number;
    chunkZ?: number;
    biome?: number;
    portSize?: number;
    islandSize?: number;
    seed?: number;
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

export interface SimToMainMessage {
  kind: "ready" | "saved" | "loaded" | "error" | "performance" | "player_died" | "weather_changed" | "gc_stats" | "boat_design_update" | "boat_design_remove" | "collision_log" | "fishing_result" | "terrain_deformed" | "terrain_lod_changed" | "ship_hold_update";
  data: any;
}

export interface DbRequest {
  id: number;
  type: "init" | "query" | "shutdown";
  dataDir?: string;
  sql?: string;
  params?: Record<string, unknown>;
}

export interface DbResponse {
  id: number;
  type: string;
  result?: unknown;
  error?: string;
}

// --- Split-Screen ---

export type SplitscreenLayoutType =
  | "1p"
  | "2p-horizontal"
  | "2p-vertical"
  | "3p-top-wide"
  | "3p-bottom-wide"
  | "4p-corners";

export interface ViewportSlot {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

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
}
