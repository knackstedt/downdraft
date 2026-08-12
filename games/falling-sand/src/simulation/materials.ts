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
  BurningOil = 51,    // slow-burning oil fire (stays put, controlled decay/spread)
}

export const MAX_MATERIAL = 64;

export interface MaterialDef {
  id: number;
  name: string;
  gravity: number;
  gravityDir: 1 | -1 | 0;
  flammable: boolean;
  burnTime: number;
  /** Initial lifetime (in sim ticks) when this material is placed/ignited. 0 = no decay. */
  lifetime: number;
  solid: boolean;
  liquid: boolean;
  gas: boolean;
  magnetic: boolean;
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
    flammable: opts.flammable ?? false,
    burnTime: opts.burnTime ?? 0,
    lifetime: opts.lifetime ?? 0,
    solid: opts.solid ?? false,
    liquid: opts.liquid ?? false,
    gas: opts.gas ?? false,
    magnetic: opts.magnetic ?? false,
    albedo: opts.albedo ?? 0.5,
    reflectivity: opts.reflectivity ?? 0.05,
    brightness: opts.brightness ?? 1.0,
  };
}

export const MATERIALS: Record<number, MaterialDef> = {
  // --- Original materials ---
  [Material.Empty]: def(0, "Empty", [0, 0, 0, 0], { albedo: 0, reflectivity: 0, brightness: 0, gas: true }),
  [Material.Sand]: def(1, "Sand", [0.76, 0.70, 0.50, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.6 }),
  [Material.Water]: def(2, "Water", [0.12, 0.42, 0.85, 0.9], { gravity: 2, gravityDir: 1, liquid: true, albedo: 0.3, reflectivity: 0.8, brightness: 0.8 }),
  [Material.Stone]: def(3, "Stone", [0.45, 0.45, 0.48, 1.0], { solid: true, albedo: 0.5, reflectivity: 0.1 }),
  [Material.Wood]: def(4, "Wood", [0.55, 0.35, 0.18, 1.0], { solid: true, flammable: true, burnTime: 240, albedo: 0.5 }),
  [Material.Fire]: def(5, "Fire", [1.0, 0.3, 0.05, 1.0], { gravity: 2, gravityDir: -1, gas: true, burnTime: 30, lifetime: 30, albedo: 0, reflectivity: 0, brightness: 1.5 }),
  [Material.FuseFire]: def(50, "FuseFire", [1.0, 0.85, 0.15, 1.0], { gravity: 2, gravityDir: -1, gas: true, burnTime: 15, lifetime: 15, albedo: 0, reflectivity: 0, brightness: 1.5 }),
  [Material.BurningOil]: def(51, "Burning Oil", [1.0, 0.35, 0.05, 1.0], { gravity: 1, gravityDir: 1, liquid: true, lifetime: 60, albedo: 0, reflectivity: 0, brightness: 1.4 }),
  [Material.Smoke]: def(6, "Smoke", [0.5, 0.5, 0.5, 0.7], { gravity: 3, gravityDir: -1, gas: true, lifetime: 120, albedo: 0.1, brightness: 0.5 }),
  [Material.Oil]: def(7, "Oil", [0.15, 0.12, 0.08, 0.95], { gravity: 1, gravityDir: 1, liquid: true, flammable: true, burnTime: 300, albedo: 0.2, reflectivity: 0.3, brightness: 0.7 }),
  [Material.Gunpowder]: def(8, "Gunpowder", [0.2, 0.2, 0.2, 1.0], { gravity: 1, gravityDir: 1, solid: true, flammable: true, burnTime: 10, albedo: 0.3 }),
  [Material.Iron]: def(9, "Iron", [0.65, 0.65, 0.70, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.6, reflectivity: 0.4 }),
  [Material.Lava]: def(10, "Lava", [0.9, 0.25, 0.05, 1.0], { gravity: 3, gravityDir: 1, liquid: true, albedo: 0.1, reflectivity: 0.2, brightness: 2.5 }),
  [Material.Steam]: def(11, "Steam", [0.85, 0.85, 0.9, 0.5], { gravity: 2, gravityDir: -1, gas: true, lifetime: 120, albedo: 0.2, brightness: 0.6 }),
  [Material.Plant]: def(12, "Plant", [0.15, 0.65, 0.20, 1.0], { solid: true, flammable: true, burnTime: 120, albedo: 0.4 }),
  [Material.Flesh]: def(13, "Flesh", [0.85, 0.55, 0.55, 1.0], { gravity: 1, gravityDir: 1, solid: true, flammable: true, burnTime: 180, albedo: 0.5, reflectivity: 0.1 }),

  // --- New: Terrain ---
  [Material.Dirt]: def(14, "Dirt", [0.35, 0.25, 0.15, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.5 }),
  [Material.Wall]: def(26, "Wall", [0.3, 0.3, 0.35, 1.0], { solid: true, albedo: 0.4, reflectivity: 0.15 }),
  [Material.Snow]: def(29, "Snow", [0.92, 0.92, 0.95, 1.0], { gravity: 0.5, gravityDir: 1, solid: true, albedo: 0.8, reflectivity: 0.2, brightness: 1.1 }),
  [Material.ConcretePowder]: def(36, "Concrete Powder", [0.6, 0.6, 0.58, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.5 }),
  [Material.Concrete]: def(48, "Concrete", [0.55, 0.55, 0.53, 1.0], { solid: true, albedo: 0.5, reflectivity: 0.1 }),

  // --- New: Biological ---
  [Material.Seed]: def(15, "Seed", [0.6, 0.5, 0.2, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.5 }),
  [Material.Leaf]: def(16, "Leaf", [0.1, 0.55, 0.15, 1.0], { solid: true, flammable: true, burnTime: 80, albedo: 0.4 }),
  [Material.Grass]: def(28, "Grass", [0.2, 0.7, 0.15, 1.0], { gravity: 1, gravityDir: 1, solid: true, flammable: true, burnTime: 60, albedo: 0.4 }),
  [Material.Root]: def(45, "Root", [0.4, 0.3, 0.15, 1.0], { solid: true, flammable: true, burnTime: 200, albedo: 0.4 }),
  [Material.TreeWood]: def(49, "Tree Wood", [0.5, 0.32, 0.16, 1.0], { solid: true, flammable: true, burnTime: 240, albedo: 0.5 }),
  [Material.Fireflies]: def(27, "Fireflies", [0.9, 0.85, 0.3, 0.9], { gas: true, lifetime: 255, albedo: 0, brightness: 1.8 }),

  // --- New: Liquids ---
  [Material.Honey]: def(30, "Honey", [0.9, 0.65, 0.15, 0.95], { gravity: 1.5, gravityDir: 1, liquid: true, albedo: 0.3, reflectivity: 0.3, brightness: 0.9 }),
  [Material.Mercury]: def(31, "Mercury", [0.75, 0.75, 0.78, 1.0], { gravity: 4, gravityDir: 1, liquid: true, albedo: 0.2, reflectivity: 0.9, brightness: 1.0 }),
  [Material.Brine]: def(46, "Brine", [0.2, 0.5, 0.7, 0.9], { gravity: 2.5, gravityDir: 1, liquid: true, albedo: 0.3, reflectivity: 0.6, brightness: 0.8 }),
  [Material.MoltenSalt]: def(47, "Molten Salt", [0.95, 0.5, 0.2, 1.0], { gravity: 3, gravityDir: 1, liquid: true, albedo: 0.1, reflectivity: 0.3, brightness: 2.0 }),
  [Material.LiquidNitrogen]: def(38, "Liquid Nitrogen", [0.5, 0.7, 0.9, 0.85], { gravity: 2, gravityDir: 1, liquid: true, albedo: 0.3, reflectivity: 0.5, brightness: 0.9 }),

  // --- New: Gases / light ---
  [Material.GasVapor]: def(21, "Gas Vapor", [0.7, 0.7, 0.65, 0.4], { gravity: 1, gravityDir: -1, gas: true, flammable: true, burnTime: 0, lifetime: 200, albedo: 0.1, brightness: 0.6 }),
  [Material.Hydrogen]: def(22, "Hydrogen", [0.9, 0.9, 0.95, 0.1], { gravity: 1, gravityDir: -1, gas: true, flammable: true, burnTime: 0, lifetime: 200, albedo: 0, brightness: 0.3 }),
  [Material.Glitter]: def(42, "Glitter", [0.85, 0.75, 0.5, 0.9], { gravity: 0.2, gravityDir: 1, solid: true, flammable: true, burnTime: 30, albedo: 0.1, reflectivity: 0.8, brightness: 1.3 }),
  [Material.DryIce]: def(37, "Dry Ice", [0.7, 0.8, 0.9, 0.8], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.3, reflectivity: 0.3, brightness: 0.7 }),

  // --- New: Explosives / reactive ---
  [Material.Antimatter]: def(17, "Antimatter", [0.9, 0.1, 0.9, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.1, reflectivity: 0.5, brightness: 1.5 }),
  [Material.Mystery]: def(18, "???", [0.6, 0.0, 0.6, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.1, reflectivity: 0.3, brightness: 1.2 }),
  [Material.Plasma]: def(39, "Plasma", [0.2, 0.8, 1.0, 1.0], { gravity: 1, gravityDir: -1, gas: true, lifetime: 30, albedo: 0, reflectivity: 0, brightness: 3.0 }),
  [Material.Fuse]: def(32, "Fuse", [0.3, 0.2, 0.1, 1.0], { solid: true, flammable: true, burnTime: 1200, albedo: 0.3 }),
  [Material.C4]: def(33, "C4", [0.8, 0.6, 0.2, 1.0], { solid: true, flammable: true, burnTime: 400, albedo: 0.4 }),
  [Material.Dynamite]: def(34, "Dynamite", [0.7, 0.2, 0.15, 1.0], { gravity: 1, gravityDir: 1, solid: true, flammable: true, burnTime: 5, albedo: 0.4 }),
  [Material.Wax]: def(35, "Wax", [0.9, 0.88, 0.7, 1.0], { solid: true, flammable: true, burnTime: 400, albedo: 0.5, reflectivity: 0.1 }),

  // --- New: Misc ---
  [Material.Flour]: def(19, "Flour", [0.92, 0.88, 0.75, 1.0], { gravity: 1, gravityDir: 1, solid: true, flammable: true, burnTime: 15, albedo: 0.6 }),
  [Material.Gasoline]: def(20, "Gasoline", [0.6, 0.5, 0.1, 0.9], { gravity: 1.5, gravityDir: 1, liquid: true, flammable: true, burnTime: 60, albedo: 0.2, reflectivity: 0.3, brightness: 0.7 }),
  [Material.Plastic]: def(23, "Plastic", [0.8, 0.8, 0.85, 1.0], { solid: true, flammable: true, burnTime: 100, albedo: 0.5, reflectivity: 0.2 }),
  [Material.Toast]: def(24, "Toast", [0.8, 0.65, 0.35, 1.0], { gravity: 1, gravityDir: 1, solid: true, flammable: true, burnTime: 80, albedo: 0.5 }),
  [Material.Salt]: def(25, "Salt", [0.95, 0.95, 0.92, 1.0], { gravity: 1, gravityDir: 1, solid: true, albedo: 0.6, reflectivity: 0.1 }),
  [Material.Nanobots]: def(40, "Nanobots", [0.6, 0.6, 0.65, 0.9], { gravity: 0.5, gravityDir: -1, gas: true, lifetime: 255, albedo: 0.3, reflectivity: 0.5, brightness: 1.2 }),
  [Material.MagicPowder]: def(41, "Magic Powder", [0.8, 0.3, 0.9, 1.0], { gravity: 1, gravityDir: 1, solid: true, lifetime: 60, albedo: 0.2, reflectivity: 0.3, brightness: 1.3 }),
  [Material.Popcorn]: def(43, "Popcorn", [0.95, 0.9, 0.7, 1.0], { gravity: 0.3, gravityDir: 1, solid: true, albedo: 0.5 }),
  [Material.Rubber]: def(44, "Rubber", [0.15, 0.15, 0.15, 1.0], { solid: true, flammable: true, burnTime: 300, albedo: 0.3, reflectivity: 0.15 }),
};

export function getMaterialColor(mat: Material): [number, number, number, number] {
  return MATERIALS[mat]?.color ?? [0, 0, 0, 0];
}
