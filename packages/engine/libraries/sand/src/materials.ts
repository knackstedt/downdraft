export enum Material {
  Empty = 0,
  Sand = 1,
  Water = 2,
  Stone = 3,
  Wood = 4,
  Fire = 5,
  Smoke = 6,
  Oil = 7,
  Gunpowder = 8,
  Iron = 9,
  Lava = 10,
  Steam = 11,
  Plant = 12,
  Flesh = 13,
  // New materials
  Dirt = 14,
  Seed = 15,
  Leaf = 16,
  Antimatter = 17,
  Mystery = 18,       // ???
  Flour = 19,
  Gasoline = 20,
  GasVapor = 21,      // vaporized gasoline gas
  Hydrogen = 22,
  Plastic = 23,
  Toast = 24,
  Salt = 25,
  Wall = 26,
  Fireflies = 27,
  Grass = 28,
  Snow = 29,
  Honey = 30,
  Mercury = 31,
  Fuse = 32,
  C4 = 33,
  Dynamite = 34,
  Wax = 35,
  ConcretePowder = 36,
  DryIce = 37,
  LiquidNitrogen = 38,
  Plasma = 39,
  Nanobots = 40,
  MagicPowder = 41,
  Glitter = 42,
  Popcorn = 43,
  Rubber = 44,
  Root = 45,          // tree root (internal)
  Brine = 46,         // salt+water mixture
  MoltenSalt = 47,    // heated salt → destructive liquid
  Concrete = 48,      // hardened concrete
  TreeWood = 49,      // wood grown from seed (same behavior as wood)
  FuseFire = 50,      // yellow fuse fire (separate from normal red fire)
  BurningOil = 51,    // slow-burning oil fire (flows like liquid, controlled decay/spread)
  // --- Ores (solid, become falling particles when dug) ---
  TinOre = 52,
  CopperOre = 53,
  IronOre = 54,       // ore form (distinct from pure-metal Iron block above)
  BauxiteOre = 55,
  SilverOre = 56,
  GoldOre = 57,
  CobaltOre = 58,
  // --- Gases (toxic, rise) ---
  MethaneGas = 59,    // flammable, rises
  SulfurGas = 60,     // toxic, non-flammable, rises
  // --- Coal (solid, flammable, becomes falling when dug) ---
  Coal = 61,
  // --- Stone debris (from mining stone) ---
  Gravel = 62,      // fine crushed stone — flows like a liquid, settles in place
  LooseStone = 63,  // coarse stone chunk — falls like a solid, re-settles to Stone
  // --- Ingredients ---
  // Ice (frozen water — produced by cooling)
  Ice = 64,
  // Liquids
  Ether = 65,            // ethereal solvent — light, volatile, glowing
  Blood = 66,            // viscous, necrotic-tinted
  Syrup = 67,            // thick, dense, sweet (binding agent)
  NightshadeExtract = 68,// toxic liquid
  TrollBlood = 69,       // viscous, healing + necrotic
  LiquidShadow = 70,     // dense, light-absorbing
  LoveEssence = 71,      // psychic liquid
  HateEssence = 72,      // psychic liquid, corrosive
  DreamMist = 73,        // ethereal + psychic, gas-like liquid
  VoidEssence = 74,      // dense, necrotic, reality-bending
  // Powders (solid, fall)
  Sulfur = 75,           // yellow powder, flammable, corrosive
  GroundEyeOfNewt = 76,  // psychic powder
  GroundBatWing = 77,    // ethereal powder
  BoneDust = 78,         // necrotic powder
  IronFilings = 79,      // kinetic + dense powder, magnetic
  MoonstoneDust = 80,    // luminous + ethereal powder
  CrystalDust = 81,      // luminous + kinetic powder
  MushroomSpores = 82,   // toxic + psychic powder, grows
  DragonScale = 83,      // thermal + kinetic, very dense
  PhoenixFeather = 84,   // thermal + healing, light
  UnicornHorn = 85,      // healing + luminous, rare
  MandrakeRoot = 86,     // toxic + psychic, solid root
  SpiderSilk = 87,       // kinetic + ethereal, very light
  GraveDust = 88,        // necrotic + dense
  StarShard = 89,        // luminous + ethereal + kinetic, glowing crystal
  TimeSand = 90,         // kinetic + ethereal, reality-bending
  // Gases
  EtherealVapor = 91,    // ether + fire byproduct, rises, glowing
  AlchemicalSlag = 92,   // waste byproduct of failed reactions, dense, inert
  // --- Build materials (placeable by the player) ---
  Scaffolding = 93,  // wooden plank — solid, static, stand on it
  Ladder = 94,       // wooden ladder — non-solid, climbable
  Rope = 95,         // fiber rope — non-solid, climbable
  Torch = 96,        // placeable torch — static, emits light
  ColdVapor = 97,    // cold white vapor from liquid nitrogen — static, dissipates slowly
  // --- Chemistry: acid + base ---
  Acid = 98,         // corrosive liquid — eats adjacent materials, 50% consumed per eat
  Base = 99,         // alkaline liquid — neutralizes acid → salt + steam
  // --- Phase-change + exotic materials ---
  Obsidian = 100,    // volcanic glass — lava quenched by water/cold (static solid)
  Spore = 101,       // floating mold spore — drifts as a gas, germinates into Mold on wood/plant/leaf
  Mold = 102,        // grows on wood/plant/leaf, consumes them, releases a spore cloud when starved
  Glitch = 103,      // randomly swaps with any neighboring material
  Tar = 104,         // very slow, very dense liquid
  Duplicator = 105,  // static — locks onto the first material that touches it and clones it forever
  Void = 106,        // static — swallows up any material that touches it (like a black hole)
}

export const MAX_MATERIAL = 256;

export interface MaterialDef {
  id: number;
  name: string;
  gravity: number;
  gravityDir: 1 | -1 | 0;
  /**
   * Density in g/cm³. Used for solid-liquid and liquid-liquid displacement:
   * a denser material sinks through a less-dense one. Sand (2.0) sinks in
   * water (1.0) but floats on mercury (13.5). Wood (0.6) floats on water.
   * Gases use ~0 since they're always displaced by solids/liquids.
   */
  density: number;
  flammable: boolean;
  burnTime: number;
  /** Initial lifetime (in sim ticks) when this material is placed/ignited. 0 = no decay. */
  lifetime: number;
  solid: boolean;
  liquid: boolean;
  gas: boolean;
  magnetic: boolean;
  /**
   * Climbable cells (ladders, ropes) are non-solid so the player can pass
   * through them, but while overlapping one the player can move vertically
   * (climb) and gravity is suspended. Falling sand is still blocked by them
   * (they're non-empty, non-gas, non-liquid, non-solid → trySwap returns
   * false), so they act as physical objects that only the player traverses.
   */
  climbable: boolean;
  color: [number, number, number, number];
  albedo: number;
  reflectivity: number;
  brightness: number;
}

function def(
  id: number, name: string, color: [number, number, number, number],
  opts: Partial<Omit<MaterialDef, "id" | "name" | "color">> = {},
): MaterialDef {
  return {
    id, name, color,
    gravity: opts.gravity ?? 0,
    gravityDir: opts.gravityDir ?? 0,
    density: opts.density ?? 0,
    flammable: opts.flammable ?? false,
    burnTime: opts.burnTime ?? 0,
    lifetime: opts.lifetime ?? 0,
    solid: opts.solid ?? false,
    liquid: opts.liquid ?? false,
    gas: opts.gas ?? false,
    magnetic: opts.magnetic ?? false,
    climbable: opts.climbable ?? false,
    albedo: opts.albedo ?? 0.5,
    reflectivity: opts.reflectivity ?? 0.05,
    brightness: opts.brightness ?? 1.0,
  };
}

export const MATERIALS: Record<number, MaterialDef> = {
  // --- Original materials ---
  [Material.Empty]: def(0, "Empty", [0, 0, 0, 0], { density: 0, albedo: 0, reflectivity: 0, brightness: 0, gas: true }),
  [Material.Sand]: def(1, "Sand", [0.76, 0.70, 0.50, 1.0], { gravity: 1, gravityDir: 1, density: 2.0, solid: true, albedo: 0.6 }),
  [Material.Water]: def(2, "Water", [0.12, 0.42, 0.85, 0.9], { gravity: 2, gravityDir: 1, density: 1.0, liquid: true, albedo: 0.3, reflectivity: 0.8, brightness: 0.8 }),
  [Material.Stone]: def(3, "Stone", [0.45, 0.45, 0.48, 1.0], { density: 2.5, solid: true, albedo: 0.5, reflectivity: 0.1 }),
  [Material.Wood]: def(4, "Wood", [0.55, 0.35, 0.18, 1.0], { density: 0.6, solid: true, flammable: true, burnTime: 240, albedo: 0.5 }),
  [Material.Fire]: def(5, "Fire", [1.0, 0.3, 0.05, 1.0], { gravity: 4, gravityDir: -1, density: 0.1, gas: true, burnTime: 30, lifetime: 30, albedo: 0, reflectivity: 0, brightness: 1.5 }),
  [Material.FuseFire]: def(50, "FuseFire", [1.0, 0.85, 0.15, 1.0], { gravity: 2, gravityDir: -1, density: 0.1, gas: true, burnTime: 15, lifetime: 15, albedo: 0, reflectivity: 0, brightness: 1.5 }),
  [Material.BurningOil]: def(51, "Burning Oil", [1.0, 0.35, 0.05, 1.0], { gravity: 1, gravityDir: 1, density: 0.8, liquid: true, lifetime: 60, albedo: 0, reflectivity: 0, brightness: 1.4 }),
  [Material.Smoke]: def(6, "Smoke", [0.5, 0.5, 0.5, 0.7], { gravity: 3, gravityDir: -1, density: 0.3, gas: true, lifetime: 120, albedo: 0.1, brightness: 0.5 }),
  [Material.Oil]: def(7, "Oil", [0.15, 0.12, 0.08, 0.95], { gravity: 1, gravityDir: 1, density: 0.8, liquid: true, flammable: true, burnTime: 300, albedo: 0.2, reflectivity: 0.3, brightness: 0.7 }),
  [Material.Gunpowder]: def(8, "Gunpowder", [0.2, 0.2, 0.2, 1.0], { gravity: 1, gravityDir: 1, density: 1.7, solid: true, flammable: true, burnTime: 10, albedo: 0.3 }),
  [Material.Iron]: def(9, "Iron", [0.65, 0.65, 0.70, 1.0], { gravity: 1, gravityDir: 1, density: 7.8, solid: true, albedo: 0.6, reflectivity: 0.4 }),
  [Material.Lava]: def(10, "Lava", [0.9, 0.25, 0.05, 1.0], { gravity: 3, gravityDir: 1, density: 3.0, liquid: true, albedo: 0.1, reflectivity: 0.2, brightness: 2.5 }),
  [Material.Steam]: def(11, "Steam", [0.85, 0.85, 0.9, 0.5], { gravity: 2, gravityDir: -1, density: 0.2, gas: true, lifetime: 120, albedo: 0.2, brightness: 0.6 }),
  [Material.Plant]: def(12, "Plant", [0.15, 0.65, 0.20, 1.0], { density: 0.8, solid: true, flammable: true, burnTime: 120, albedo: 0.4 }),
  [Material.Flesh]: def(13, "Flesh", [0.85, 0.55, 0.55, 1.0], { gravity: 1, gravityDir: 1, density: 1.0, solid: true, flammable: true, burnTime: 180, albedo: 0.5, reflectivity: 0.1 }),

  // --- New: Terrain ---
  [Material.Dirt]: def(14, "Dirt", [0.35, 0.25, 0.15, 1.0], { gravity: 1, gravityDir: 1, density: 1.5, solid: true, albedo: 0.5 }),
  [Material.Wall]: def(26, "Wall", [0.3, 0.3, 0.35, 1.0], { density: 3.0, solid: true, albedo: 0.4, reflectivity: 0.15 }),
  [Material.Snow]: def(29, "Snow", [0.92, 0.92, 0.95, 1.0], { gravity: 0.5, gravityDir: 1, density: 0.3, solid: true, albedo: 0.8, reflectivity: 0.2, brightness: 1.1 }),
  [Material.ConcretePowder]: def(36, "Concrete Powder", [0.6, 0.6, 0.58, 1.0], { gravity: 1, gravityDir: 1, density: 1.5, solid: true, albedo: 0.5 }),
  [Material.Concrete]: def(48, "Concrete", [0.55, 0.55, 0.53, 1.0], { density: 2.4, solid: true, albedo: 0.5, reflectivity: 0.1 }),

  // --- New: Biological ---
  [Material.Seed]: def(15, "Seed", [0.6, 0.5, 0.2, 1.0], { gravity: 1, gravityDir: 1, density: 0.8, solid: true, albedo: 0.5 }),
  [Material.Leaf]: def(16, "Leaf", [0.1, 0.55, 0.15, 1.0], { density: 0.5, solid: true, flammable: true, burnTime: 80, albedo: 0.4 }),
  [Material.Grass]: def(28, "Grass", [0.2, 0.7, 0.15, 1.0], { gravity: 1, gravityDir: 1, density: 0.5, solid: true, flammable: true, burnTime: 60, albedo: 0.4 }),
  [Material.Root]: def(45, "Root", [0.4, 0.3, 0.15, 1.0], { density: 0.8, solid: true, flammable: true, burnTime: 200, albedo: 0.4 }),
  [Material.TreeWood]: def(49, "Tree Wood", [0.5, 0.32, 0.16, 1.0], { density: 0.6, solid: true, flammable: true, burnTime: 240, albedo: 0.5 }),
  [Material.Fireflies]: def(27, "Fireflies", [0.9, 0.85, 0.3, 0.9], { density: 0.1, gas: true, lifetime: 255, albedo: 0, brightness: 1.8 }),

  // --- New: Liquids ---
  [Material.Honey]: def(30, "Honey", [0.9, 0.65, 0.15, 0.95], { gravity: 1.5, gravityDir: 1, density: 1.4, liquid: true, albedo: 0.3, reflectivity: 0.3, brightness: 0.9 }),
  [Material.Mercury]: def(31, "Mercury", [0.75, 0.75, 0.78, 1.0], { gravity: 4, gravityDir: 1, density: 13.5, liquid: true, albedo: 0.2, reflectivity: 0.9, brightness: 1.0 }),
  [Material.Brine]: def(46, "Brine", [0.2, 0.5, 0.7, 0.9], { gravity: 2.5, gravityDir: 1, density: 1.2, liquid: true, albedo: 0.3, reflectivity: 0.6, brightness: 0.8 }),
  [Material.MoltenSalt]: def(47, "Molten Salt", [0.95, 0.5, 0.2, 1.0], { gravity: 3, gravityDir: 1, density: 1.5, liquid: true, albedo: 0.1, reflectivity: 0.3, brightness: 2.0 }),
  [Material.LiquidNitrogen]: def(38, "Liquid Nitrogen", [0.5, 0.7, 0.9, 0.85], { gravity: 2, gravityDir: 1, density: 0.8, liquid: true, albedo: 0.3, reflectivity: 0.5, brightness: 0.9 }),

  // --- New: Gases / light ---
  [Material.GasVapor]: def(21, "Gas Vapor", [0.7, 0.7, 0.65, 0.4], { gravity: 1, gravityDir: -1, density: 0.1, gas: true, flammable: true, burnTime: 0, lifetime: 200, albedo: 0.1, brightness: 0.6 }),
  [Material.Hydrogen]: def(22, "Hydrogen", [0.9, 0.9, 0.95, 0.1], { gravity: 1, gravityDir: -1, density: 0.05, gas: true, flammable: true, burnTime: 0, lifetime: 200, albedo: 0, brightness: 0.3 }),
  [Material.Glitter]: def(42, "Glitter", [0.85, 0.75, 0.5, 0.9], { gravity: 0.2, gravityDir: 1, density: 1.0, solid: true, flammable: true, burnTime: 30, albedo: 0.1, reflectivity: 0.8, brightness: 1.3 }),
  [Material.DryIce]: def(37, "Dry Ice", [0.7, 0.8, 0.9, 0.8], { gravity: 1, gravityDir: 1, density: 1.5, solid: true, albedo: 0.3, reflectivity: 0.3, brightness: 0.7 }),

  // --- New: Explosives / reactive ---
  [Material.Antimatter]: def(17, "Antimatter", [0.9, 0.1, 0.9, 1.0], { gravity: 1, gravityDir: 1, density: 22.0, solid: true, albedo: 0.1, reflectivity: 0.5, brightness: 1.5 }),
  [Material.Mystery]: def(18, "???", [0.6, 0.0, 0.6, 1.0], { gravity: 1, gravityDir: 1, density: 5.0, solid: true, albedo: 0.1, reflectivity: 0.3, brightness: 1.2 }),
  [Material.Plasma]: def(39, "Plasma", [0.2, 0.8, 1.0, 1.0], { gravity: 1, gravityDir: -1, density: 0.05, gas: true, lifetime: 30, albedo: 0, reflectivity: 0, brightness: 3.0 }),
  [Material.Fuse]: def(32, "Fuse", [0.3, 0.2, 0.1, 1.0], { density: 1.5, solid: true, flammable: true, burnTime: 1200, albedo: 0.3 }),
  [Material.C4]: def(33, "C4", [0.8, 0.6, 0.2, 1.0], { density: 1.5, solid: true, flammable: true, burnTime: 400, albedo: 0.4 }),
  [Material.Dynamite]: def(34, "Dynamite", [0.7, 0.2, 0.15, 1.0], { gravity: 1, gravityDir: 1, density: 1.3, solid: true, flammable: true, burnTime: 5, albedo: 0.4 }),
  [Material.Wax]: def(35, "Wax", [0.9, 0.88, 0.7, 1.0], { density: 0.9, solid: true, flammable: true, burnTime: 400, albedo: 0.5, reflectivity: 0.1 }),

  // --- New: Misc ---
  [Material.Flour]: def(19, "Flour", [0.92, 0.88, 0.75, 1.0], { gravity: 1, gravityDir: 1, density: 1.5, solid: true, flammable: true, burnTime: 15, albedo: 0.6 }),
  [Material.Gasoline]: def(20, "Gasoline", [0.6, 0.5, 0.1, 0.9], { gravity: 1.5, gravityDir: 1, density: 0.7, liquid: true, flammable: true, burnTime: 60, albedo: 0.2, reflectivity: 0.3, brightness: 0.7 }),
  [Material.Plastic]: def(23, "Plastic", [0.8, 0.8, 0.85, 1.0], { density: 1.2, solid: true, flammable: true, burnTime: 100, albedo: 0.5, reflectivity: 0.2 }),
  [Material.Toast]: def(24, "Toast", [0.8, 0.65, 0.35, 1.0], { gravity: 1, gravityDir: 1, density: 0.3, solid: true, flammable: true, burnTime: 80, albedo: 0.5 }),
  [Material.Salt]: def(25, "Salt", [0.95, 0.95, 0.92, 1.0], { gravity: 1, gravityDir: 1, density: 2.2, solid: true, albedo: 0.6, reflectivity: 0.1 }),
  [Material.Nanobots]: def(40, "Nanobots", [0.6, 0.6, 0.65, 0.9], { gravity: 0.5, gravityDir: -1, density: 0.1, gas: true, lifetime: 255, albedo: 0.3, reflectivity: 0.5, brightness: 1.2 }),
  [Material.MagicPowder]: def(41, "Magic Powder", [0.8, 0.3, 0.9, 1.0], { gravity: 1, gravityDir: 1, density: 0.5, solid: true, lifetime: 60, albedo: 0.2, reflectivity: 0.3, brightness: 1.3 }),
  [Material.Popcorn]: def(43, "Popcorn", [0.95, 0.9, 0.7, 1.0], { gravity: 0.3, gravityDir: 1, density: 0.05, solid: true, albedo: 0.5 }),
  [Material.Rubber]: def(44, "Rubber", [0.15, 0.15, 0.15, 1.0], { density: 1.2, solid: true, flammable: true, burnTime: 300, albedo: 0.3, reflectivity: 0.15 }),

  // --- Ores (solid, fall when dug, non-flammable) ---
  [Material.TinOre]: def(52, "Tin Ore", [0.70, 0.72, 0.74, 1.0], { gravity: 1, gravityDir: 1, density: 7.3, solid: true, albedo: 0.55, reflectivity: 0.35 }),
  [Material.CopperOre]: def(53, "Copper Ore", [0.72, 0.45, 0.25, 1.0], { gravity: 1, gravityDir: 1, density: 8.9, solid: true, albedo: 0.5, reflectivity: 0.3 }),
  [Material.IronOre]: def(54, "Iron Ore", [0.55, 0.45, 0.40, 1.0], { gravity: 1, gravityDir: 1, density: 7.8, solid: true, albedo: 0.45, reflectivity: 0.2 }),
  [Material.BauxiteOre]: def(55, "Bauxite Ore", [0.75, 0.50, 0.40, 1.0], { gravity: 1, gravityDir: 1, density: 2.5, solid: true, albedo: 0.5, reflectivity: 0.15 }),
  [Material.SilverOre]: def(56, "Silver Ore", [0.85, 0.85, 0.88, 1.0], { gravity: 1, gravityDir: 1, density: 10.5, solid: true, albedo: 0.6, reflectivity: 0.6 }),
  [Material.GoldOre]: def(57, "Gold Ore", [0.90, 0.78, 0.20, 1.0], { gravity: 1, gravityDir: 1, density: 19.3, solid: true, albedo: 0.55, reflectivity: 0.5 }),
  [Material.CobaltOre]: def(58, "Cobalt Ore", [0.25, 0.35, 0.80, 1.0], { gravity: 1, gravityDir: 1, density: 8.9, solid: true, albedo: 0.5, reflectivity: 0.3 }),

  // --- Coal (solid, flammable, falls when dug) ---
  [Material.Coal]: def(61, "Coal", [0.10, 0.10, 0.11, 1.0], { gravity: 1, gravityDir: 1, density: 1.3, solid: true, flammable: true, burnTime: 120, albedo: 0.15, reflectivity: 0.05, brightness: 0.8 }),

  // --- Stone debris (from mining stone) ---
  // Gravel: fine crushed stone. Marked solid (so it doesn't displace like a
  // liquid) but has special flow logic in SandWorld.tryMove that lets it
  // spread horizontally like a liquid when unsupported, then settle firmly
  // in place when supported from below. Re-settles to Stone after being
  // stationary + stably supported for GRAVEL_SETTLE_TICKS (handled in
  // applyAging via the lifetime field as a settle timer). All mined stone
  // becomes Gravel.
  [Material.Gravel]: def(62, "Gravel", [0.45, 0.45, 0.48, 1.0], { gravity: 1, gravityDir: 1, density: 2.0, solid: true, albedo: 0.5, reflectivity: 0.1 }),
  // LooseStone: legacy coarse stone chunk. No longer created — all stone
  // debris now becomes Gravel. Kept for backwards compat with old saves that
  // still contain LooseStone cells; applyAging still re-settles them to Stone.
  [Material.LooseStone]: def(63, "Loose Stone", [0.45, 0.45, 0.48, 1.0], { gravity: 1, gravityDir: 1, density: 2.5, solid: true, albedo: 0.5, reflectivity: 0.1 }),

  // --- Gases (toxic, rise) ---
  [Material.MethaneGas]: def(59, "Methane Gas", [0.75, 0.78, 0.65, 0.35], { gravity: 1, gravityDir: -1, density: 0.07, gas: true, flammable: true, burnTime: 0, lifetime: 200, albedo: 0.1, brightness: 0.5 }),
  [Material.SulfurGas]: def(60, "Sulfur Gas", [0.85, 0.80, 0.30, 0.4], { gravity: 1, gravityDir: -1, density: 0.15, gas: true, lifetime: 200, albedo: 0.1, brightness: 0.6 }),

  // --- Ice (cooling byproduct) ---
  [Material.Ice]: def(64, "Ice", [0.7, 0.85, 0.95, 0.9], { density: 0.92, solid: true, albedo: 0.4, reflectivity: 0.5, brightness: 1.0 }),

  // --- Liquids ---
  [Material.Ether]: def(65, "Ether", [0.55, 0.45, 0.85, 0.8], { gravity: 1.5, gravityDir: 1, density: 0.7, liquid: true, flammable: true, burnTime: 40, albedo: 0.2, reflectivity: 0.4, brightness: 1.1 }),
  [Material.Blood]: def(66, "Blood", [0.7, 0.05, 0.05, 0.95], { gravity: 2, gravityDir: 1, density: 1.06, liquid: true, albedo: 0.3, reflectivity: 0.2, brightness: 0.8 }),
  [Material.Syrup]: def(67, "Syrup", [0.6, 0.4, 0.15, 0.95], { gravity: 1, gravityDir: 1, density: 1.4, liquid: true, albedo: 0.3, reflectivity: 0.3, brightness: 0.9 }),
  [Material.NightshadeExtract]: def(68, "Nightshade Extract", [0.3, 0.05, 0.35, 0.95], { gravity: 2, gravityDir: 1, density: 1.1, liquid: true, albedo: 0.2, reflectivity: 0.1, brightness: 0.7 }),
  [Material.TrollBlood]: def(69, "Troll Blood", [0.4, 0.2, 0.15, 0.95], { gravity: 2, gravityDir: 1, density: 1.2, liquid: true, albedo: 0.25, reflectivity: 0.15, brightness: 0.8 }),
  [Material.LiquidShadow]: def(70, "Liquid Shadow", [0.05, 0.05, 0.12, 0.98], { gravity: 3, gravityDir: 1, density: 2.0, liquid: true, albedo: 0.0, reflectivity: 0.0, brightness: 0.3 }),
  [Material.LoveEssence]: def(71, "Love Essence", [0.95, 0.4, 0.6, 0.9], { gravity: 1.5, gravityDir: 1, density: 0.9, liquid: true, albedo: 0.3, reflectivity: 0.4, brightness: 1.0 }),
  [Material.HateEssence]: def(72, "Hate Essence", [0.2, 0.1, 0.15, 0.9], { gravity: 2, gravityDir: 1, density: 1.3, liquid: true, albedo: 0.2, reflectivity: 0.2, brightness: 0.7 }),
  [Material.DreamMist]: def(73, "Dream Mist", [0.6, 0.7, 0.95, 0.6], { gravity: 1, gravityDir: -1, density: 0.3, liquid: true, albedo: 0.2, reflectivity: 0.5, brightness: 1.2 }),
  [Material.VoidEssence]: def(74, "Void Essence", [0.1, 0.0, 0.2, 0.95], { gravity: 4, gravityDir: 1, density: 3.0, liquid: true, albedo: 0.0, reflectivity: 0.1, brightness: 0.5 }),

  // --- Alchemy game: powders (solid, fall) ---
  [Material.Sulfur]: def(75, "Sulfur", [0.9, 0.85, 0.2, 1.0], { gravity: 1, gravityDir: 1, density: 2.0, solid: true, flammable: true, burnTime: 60, albedo: 0.5, reflectivity: 0.1, brightness: 0.9 }),
  [Material.GroundEyeOfNewt]: def(76, "Ground Eye of Newt", [0.5, 0.35, 0.2, 1.0], { gravity: 1, gravityDir: 1, density: 1.2, solid: true, albedo: 0.4, brightness: 0.8 }),
  [Material.GroundBatWing]: def(77, "Ground Bat Wing", [0.3, 0.25, 0.35, 1.0], { gravity: 0.8, gravityDir: 1, density: 0.6, solid: true, albedo: 0.3, brightness: 0.7 }),
  [Material.BoneDust]: def(78, "Bone Dust", [0.85, 0.82, 0.75, 1.0], { gravity: 1, gravityDir: 1, density: 1.5, solid: true, albedo: 0.5, brightness: 0.8 }),
  [Material.IronFilings]: def(79, "Iron Filings", [0.55, 0.55, 0.6, 1.0], { gravity: 1.5, gravityDir: 1, density: 7.8, solid: true, magnetic: true, albedo: 0.5, reflectivity: 0.3 }),
  [Material.MoonstoneDust]: def(80, "Moonstone Dust", [0.8, 0.85, 0.95, 1.0], { gravity: 1, gravityDir: 1, density: 1.0, solid: true, albedo: 0.4, reflectivity: 0.5, brightness: 1.3 }),
  [Material.CrystalDust]: def(81, "Crystal Dust", [0.6, 0.9, 0.95, 1.0], { gravity: 1, gravityDir: 1, density: 2.5, solid: true, albedo: 0.3, reflectivity: 0.6, brightness: 1.2 }),
  [Material.MushroomSpores]: def(82, "Mushroom Spores", [0.6, 0.5, 0.4, 0.9], { gravity: 0.5, gravityDir: 1, density: 0.4, solid: true, albedo: 0.3, brightness: 0.8 }),
  [Material.DragonScale]: def(83, "Dragon Scale", [0.5, 0.15, 0.1, 1.0], { gravity: 1.5, gravityDir: 1, density: 5.0, solid: true, albedo: 0.4, reflectivity: 0.3, brightness: 1.0 }),
  [Material.PhoenixFeather]: def(84, "Phoenix Feather", [0.95, 0.5, 0.15, 0.9], { gravity: 0.3, gravityDir: 1, density: 0.3, solid: true, flammable: true, burnTime: 200, albedo: 0.4, brightness: 1.4 }),
  [Material.UnicornHorn]: def(85, "Unicorn Horn", [0.95, 0.9, 1.0, 1.0], { gravity: 1, gravityDir: 1, density: 1.8, solid: true, albedo: 0.5, reflectivity: 0.5, brightness: 1.5 }),
  [Material.MandrakeRoot]: def(86, "Mandrake Root", [0.5, 0.4, 0.25, 1.0], { gravity: 1, gravityDir: 1, density: 1.3, solid: true, albedo: 0.4, brightness: 0.7 }),
  [Material.SpiderSilk]: def(87, "Spider Silk", [0.9, 0.9, 0.85, 0.8], { gravity: 0.2, gravityDir: 1, density: 0.2, solid: true, albedo: 0.4, reflectivity: 0.2, brightness: 0.9 }),
  [Material.GraveDust]: def(88, "Grave Dust", [0.3, 0.28, 0.25, 1.0], { gravity: 1, gravityDir: 1, density: 1.8, solid: true, albedo: 0.3, brightness: 0.6 }),
  [Material.StarShard]: def(89, "Star Shard", [0.7, 0.8, 1.0, 1.0], { gravity: 1, gravityDir: 1, density: 2.0, solid: true, albedo: 0.3, reflectivity: 0.7, brightness: 1.6 }),
  [Material.TimeSand]: def(90, "Time Sand", [0.4, 0.3, 0.6, 0.9], { gravity: 1, gravityDir: 1, density: 1.5, solid: true, albedo: 0.3, reflectivity: 0.4, brightness: 1.2 }),

  // --- Alchemy game: gases + byproducts ---
  [Material.EtherealVapor]: def(91, "Ethereal Vapor", [0.6, 0.5, 0.9, 0.5], { gravity: 1, gravityDir: -1, density: 0.08, gas: true, lifetime: 180, albedo: 0.1, brightness: 1.3 }),
  [Material.AlchemicalSlag]: def(92, "Alchemical Slag", [0.25, 0.22, 0.2, 1.0], { gravity: 2, gravityDir: 1, density: 2.8, solid: true, albedo: 0.2, reflectivity: 0.05, brightness: 0.5 }),

  // --- Mining RPG: build materials (placeable by the player) ---
  // Scaffolding: wooden plank. Solid + static (gravity=0) so the player can
  // stand on it. Flammable. Mined away (cleared, not collected as ore).
  [Material.Scaffolding]: def(93, "Scaffolding", [0.62, 0.42, 0.22, 1.0], { density: 0.6, solid: true, flammable: true, burnTime: 200, albedo: 0.5, reflectivity: 0.05 }),
  // Ladder: wooden ladder. Non-solid + climbable so the player climbs through
  // it; gravity=0 so it stays put. Flammable. Blocks falling particles.
  [Material.Ladder]: def(94, "Ladder", [0.55, 0.36, 0.18, 1.0], { density: 0.5, flammable: true, burnTime: 180, climbable: true, albedo: 0.45 }),
  // Rope: fiber rope. Non-solid + climbable; gravity=0 so it stays put.
  // Flammable. Blocks falling particles.
  [Material.Rope]: def(95, "Rope", [0.78, 0.66, 0.40, 1.0], { density: 0.3, flammable: true, burnTime: 120, climbable: true, albedo: 0.4 }),
  // Torch: placeable light source. Static (gravity=0), non-solid, emits warm
  // orange light (handled by the game's lighting system, not physics).
  // Non-flammable so it doesn't burn away. Bright color so it's visible.
  [Material.Torch]: def(96, "Torch", [0.9, 0.5, 0.2, 1.0], { density: 0.4, albedo: 0.6, brightness: 1.5 }),
  // ColdVapor: visible white vapor produced when liquid nitrogen evaporates.
  // Static (gravityDir=0) so it doesn't rise — cold vapor is denser than air
  // and pools near the ground. MAT_HAS_REACTIONS keeps it in the active list
  // so applyAging can slowly dissipate it (~30 seconds at 60fps).
  [Material.ColdVapor]: def(97, "Cold Vapor", [0.85, 0.85, 0.9, 0.5], { density: 0.8, gas: true, lifetime: 255, albedo: 0.3, brightness: 0.7 }),
  // Acid: corrosive liquid. Flows like water (density 1.2, slightly denser).
  // Eats adjacent materials — each eat destroys the neighbor and has a 50%
  // chance of consuming the acid particle too. So 1000 sand + 1000 acid →
  // ~500 acid remaining. Does NOT eat Wall, Acid, Base, or Empty.
  // Base neutralizes it (acid + base → salt + steam).
  [Material.Acid]: def(98, "Acid", [0.55, 0.95, 0.25, 0.85], { gravity: 2, gravityDir: 1, density: 1.2, liquid: true, albedo: 0.2, reflectivity: 0.4, brightness: 1.0 }),
  // Base: alkaline liquid. Flows like water (density 1.1). Reacts with acid
  // on contact — 1 base + 1 acid → 1 salt + 1 steam (neutralization).
  [Material.Base]: def(99, "Base", [0.85, 0.75, 0.95, 0.85], { gravity: 2, gravityDir: 1, density: 1.1, liquid: true, albedo: 0.2, reflectivity: 0.4, brightness: 0.9 }),

  // --- Phase-change + exotic materials ---
  // Obsidian: volcanic glass. Produced when lava is quenched rapidly by
  // water, dry ice, liquid nitrogen, ice, or snow. Static solid, denser than
  // stone, non-flammable. Distinct from Stone (the slow-cooling byproduct of
  // the legacy lava+water rule, now repurposed to obsidian for rapid quench).
  [Material.Obsidian]: def(100, "Obsidian", [0.06, 0.05, 0.08, 1.0], { density: 2.6, solid: true, albedo: 0.15, reflectivity: 0.25, brightness: 0.7 }),
  // Spore: floating mold spore. A light gas that drifts upward and lingers.
  // When it touches wood/plant/leaf/tree wood/root/grass it germinates into
  // Mold (the spore is consumed). Long lifetime so it can travel far before
  // landing on a food source; dissipates to empty if it never finds one.
  [Material.Spore]: def(101, "Spore", [0.55, 0.62, 0.35, 0.7], { gravity: 0.5, gravityDir: -1, density: 0.05, gas: true, lifetime: 240, albedo: 0.3, brightness: 0.9 }),
  // Mold: grows on wood/plant/leaf/tree wood/root/grass. Static solid that
  // spreads very slowly to adjacent food cells, consuming them. When no food
  // remains adjacent, it releases a cloud of Spore into surrounding empty
  // space and dies (clears to empty). MAT_HAS_REACTIONS keeps it in the
  // active list even though gravityDir=0.
  [Material.Mold]: def(102, "Mold", [0.35, 0.42, 0.22, 1.0], { density: 0.4, solid: true, albedo: 0.3, brightness: 0.8 }),
  // Glitch: a corrupted cell that randomly swaps places with any neighboring
  // non-empty material. Falls like a normal solid when it can't swap.
  // Visually a harsh magenta/cyan so it reads as "broken".
  [Material.Glitch]: def(103, "Glitch", [0.95, 0.05, 0.75, 1.0], { gravity: 1, gravityDir: 1, density: 1.0, solid: true, albedo: 0.2, reflectivity: 0.1, brightness: 1.2 }),
  // Tar: a very slow, very dense liquid. Sinks through water and most
  // liquids. High friction (handled in tryMove, like honey) so it barely
  // flows — oozes rather than pours.
  [Material.Tar]: def(104, "Tar", [0.07, 0.06, 0.05, 1.0], { gravity: 1, gravityDir: 1, density: 2.0, liquid: true, flammable: true, burnTime: 200, albedo: 0.1, reflectivity: 0.15, brightness: 0.5 }),
  // Duplicator: a static solid that clones the first material to touch it.
  // The locked material id is stored in the lifetime field (0 = not yet
  // locked). Each frame it spawns the locked material into adjacent empty
  // cells. Does not move, does not react otherwise (acid-immune, skipped by
  // antimatter). MAT_HAS_REACTIONS keeps it in the active list.
  [Material.Duplicator]: def(105, "Duplicator", [0.85, 0.85, 0.30, 1.0], { density: 3.0, solid: true, albedo: 0.4, reflectivity: 0.3, brightness: 1.1 }),
  // Void: a static solid that swallows up any material that touches it.
  // Any adjacent non-empty, non-wall, non-void, non-duplicator cell is
  // destroyed (set to empty) each frame. The void itself is permanent —
  // acid-immune, antimatter barrier, never falls. Visually a deep black
  // with a faint purple edge so it reads as a "black hole".
  [Material.Void]: def(106, "Void", [0.02, 0.0, 0.05, 1.0], { density: 5.0, solid: true, albedo: 0.0, reflectivity: 0.0, brightness: 0.3 }),
};

export function getMaterialColor(mat: Material): [number, number, number, number] {
  return MATERIALS[mat]?.color ?? [0, 0, 0, 0];
}

// ============================================================================
// Parallel typed arrays for hot-path material property lookups.
//
// These are precomputed from MATERIALS at module load time. In simulation hot
// loops (millions of cell iterations/sec), indexing a typed array is
// significantly faster than a Record<number, object> property lookup with
// optional chaining (MATERIALS[mat]?.gravity). They also avoid any object
// allocation.
//
// MAT_FLAGS packs boolean properties into bits:
//   bit 0 = flammable, bit 1 = solid, bit 2 = liquid, bit 3 = gas,
//   bit 4 = magnetic
// ============================================================================

export const MAT_FLAMMABLE = 0x01;
export const MAT_SOLID = 0x02;
export const MAT_LIQUID = 0x04;
export const MAT_GAS = 0x08;
export const MAT_MAGNETIC = 0x10;
export const MAT_CLIMBABLE = 0x20;

/** gravity multiplier as float (0-4). 0 = no gravity. */
export const MAT_GRAVITY = new Float32Array(MAX_MATERIAL);
/** density in g/cm³. Used for solid-liquid and liquid-liquid displacement. */
export const MAT_DENSITY = new Float32Array(MAX_MATERIAL);
/** gravity direction: 1 = down, -1 = up, 0 = static. */
export const MAT_GRAVITY_DIR = new Int8Array(MAX_MATERIAL);
/** packed boolean flags (MAT_FLAMMABLE | MAT_SOLID | ...). */
export const MAT_FLAGS = new Uint8Array(MAX_MATERIAL);
/** initial lifetime when placed/ignited. */
export const MAT_LIFETIME = new Uint8Array(MAX_MATERIAL);

// Lookup tables for common multi-material neighbor checks.
// IS_HOT: fire-class + lava + molten salt + plasma (materials that melt snow, boil water, etc.)
// IS_FIRE: fire-class only (Fire, FuseFire, BurningOil)
// IS_ACID_IMMUNE: materials that acid cannot eat (Wall, Acid, Base, Empty)
export const IS_HOT = new Uint8Array(MAX_MATERIAL);
export const IS_FIRE = new Uint8Array(MAX_MATERIAL);
export const IS_ACID_IMMUNE = new Uint8Array(MAX_MATERIAL);
/** Cold materials: actively cool their surroundings. Freeze water → ice,
 *  quench lava → obsidian. DryIce and LiquidNitrogen are active coolants;
 *  Ice and Snow are cold solids that also quench lava on contact. */
export const IS_COLD = new Uint8Array(MAX_MATERIAL);
/** Static materials (gravityDir=0) that still have self-triggered reactions
 *  (rule-engine rules or applySpecialReactions handlers). These must remain
 *  in the active list even though they can't move — excluding them would
 *  skip their reactions. Currently: Ice (melts near heat). Dynamic materials
 *  (gravityDir!=0) are always in the active list and don't need to be listed. */
export const MAT_HAS_REACTIONS = new Uint8Array(MAX_MATERIAL);

function buildMaterialTables(): void {
  for (let i = 0; i < MAX_MATERIAL; i++) {
    const def = MATERIALS[i];
    if (!def) continue;
    MAT_GRAVITY[i] = def.gravity;
    MAT_DENSITY[i] = def.density;
    MAT_GRAVITY_DIR[i] = def.gravityDir;
    MAT_LIFETIME[i] = def.lifetime;
    let flags = 0;
    if (def.flammable) flags |= MAT_FLAMMABLE;
    if (def.solid) flags |= MAT_SOLID;
    if (def.liquid) flags |= MAT_LIQUID;
    if (def.gas) flags |= MAT_GAS;
    if (def.magnetic) flags |= MAT_MAGNETIC;
    if (def.climbable) flags |= MAT_CLIMBABLE;
    MAT_FLAGS[i] = flags;
  }
  // Hot materials: melt snow, boil water, ignite flammables, pop popcorn
  IS_HOT[Material.Fire] = 1;
  IS_HOT[Material.FuseFire] = 1;
  IS_HOT[Material.BurningOil] = 1;
  IS_HOT[Material.Lava] = 1;
  IS_HOT[Material.MoltenSalt] = 1;
  IS_HOT[Material.Plasma] = 1;
  // Fire-class: used for extinguish checks, low-temp death, etc.
  IS_FIRE[Material.Fire] = 1;
  IS_FIRE[Material.FuseFire] = 1;
  IS_FIRE[Material.BurningOil] = 1;
  // Cold materials: freeze water on contact, quench lava → obsidian.
  // Only active coolants (DryIce, LiquidNitrogen) are listed here. Ice and
  // Snow are frozen water — they melt from lava's heat (handled by the
  // snow/ice + hot reaction) rather than quenching it to obsidian.
  IS_COLD[Material.DryIce] = 1;
  IS_COLD[Material.LiquidNitrogen] = 1;
  // Acid-immune: acid cannot eat these materials
  IS_ACID_IMMUNE[Material.Empty] = 1;
  IS_ACID_IMMUNE[Material.Wall] = 1;
  IS_ACID_IMMUNE[Material.Acid] = 1;
  IS_ACID_IMMUNE[Material.Base] = 1;
  // Duplicator is immune to acid — it "does not react otherwise" and must
  // persist to keep cloning. Acid eating it would silently destroy it.
  IS_ACID_IMMUNE[Material.Duplicator] = 1;
  // Void is immune to acid — it's a permanent fixture that swallows acid
  // like any other material. Acid can't erode it.
  IS_ACID_IMMUNE[Material.Void] = 1;
  // Static materials with self-triggered reactions (must stay in active list)
  MAT_HAS_REACTIONS[Material.Ice] = 1; // melts near heat / high temp
  MAT_HAS_REACTIONS[Material.ColdVapor] = 1; // dissipates via lifetime decay
  MAT_HAS_REACTIONS[Material.Mold] = 1; // spreads to food + releases spores when starved
  MAT_HAS_REACTIONS[Material.Duplicator] = 1; // clones locked material into adjacent empty cells
  MAT_HAS_REACTIONS[Material.Void] = 1; // swallows adjacent materials each frame
}

buildMaterialTables();
