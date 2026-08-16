import { MATERIALS, Material } from "@downdraft/library-sand";
import type {
    Effect, EffectDimension, EffectVector, IngredientInfo, PackageType, PotionProperties,
} from "../shared/types";

// ============================================================================
// Alchemy effect composition engine
//
// Each ingredient contributes an effect vector over 12 dimensions. Mixing
// sums the vectors weighted by cell count; processing steps (heat/cool/settle)
// transform the vector; effects emerge by thresholding the final vector.
// ============================================================================

export const EFFECT_DIMENSIONS: EffectDimension[] = [
  "toxic", "corrosive", "healing", "luminous", "volatile",
  "reactive", "dense", "ethereal", "thermal", "necrotic",
  "psychic", "kinetic",
];

export function zeroEffectVector(): EffectVector {
  return {
    toxic: 0, corrosive: 0, healing: 0, luminous: 0, volatile: 0,
    reactive: 0, dense: 0, ethereal: 0, thermal: 0, necrotic: 0,
    psychic: 0, kinetic: 0,
  };
}

function vec(values: Partial<EffectVector>): EffectVector {
  return { ...zeroEffectVector(), ...values };
}

// ============================================================================
// Ingredient effect vectors + metadata
// ============================================================================

export const INGREDIENT_EFFECTS: Record<number, EffectVector> = {
  // --- Reused existing materials ---
  [Material.Water]:           vec({ dense: 0.3, thermal: 0.2, reactive: 0.1 }),
  [Material.Salt]:            vec({ corrosive: 0.4, dense: 0.5, toxic: 0.2 }),
  [Material.Sand]:            vec({ dense: 0.7, kinetic: 0.3 }),
  [Material.Oil]:             vec({ volatile: 0.6, thermal: 0.4, corrosive: 0.2 }),
  [Material.Fire]:            vec({ thermal: 0.9, volatile: 0.7, luminous: 0.6, reactive: 0.5 }),
  [Material.Lava]:            vec({ thermal: 1.0, dense: 0.8, reactive: 0.6, luminous: 0.5 }),
  [Material.Ice]:             vec({ thermal: -0.6, dense: 0.5, reactive: -0.2 }),
  [Material.Mercury]:         vec({ toxic: 0.7, dense: 0.9, corrosive: 0.3, kinetic: 0.2 }),
  [Material.Honey]:           vec({ healing: 0.4, dense: 0.7, reactive: 0.1 }),
  // --- Alchemy liquids ---
  [Material.Ether]:           vec({ ethereal: 0.8, volatile: 0.6, luminous: 0.4, psychic: 0.2 }),
  [Material.Blood]:           vec({ necrotic: 0.5, toxic: 0.3, healing: 0.2, dense: 0.4 }),
  [Material.Syrup]:           vec({ dense: 0.8, healing: 0.2, reactive: 0.1 }),
  [Material.NightshadeExtract]: vec({ toxic: 0.9, necrotic: 0.4, psychic: 0.3 }),
  [Material.TrollBlood]:      vec({ healing: 0.7, necrotic: 0.4, dense: 0.5, reactive: 0.3 }),
  [Material.LiquidShadow]:    vec({ necrotic: 0.7, dense: 0.8, ethereal: 0.3, luminous: -0.5 }),
  [Material.LoveEssence]:     vec({ psychic: 0.8, healing: 0.3, luminous: 0.3 }),
  [Material.HateEssence]:     vec({ psychic: 0.7, corrosive: 0.5, necrotic: 0.3 }),
  [Material.DreamMist]:       vec({ ethereal: 0.6, psychic: 0.6, luminous: 0.3, volatile: 0.3 }),
  [Material.VoidEssence]:     vec({ necrotic: 0.8, dense: 0.9, ethereal: 0.5, kinetic: 0.4, toxic: 0.4 }),
  // --- Alchemy powders ---
  [Material.Sulfur]:          vec({ corrosive: 0.6, volatile: 0.5, thermal: 0.3, toxic: 0.2 }),
  [Material.GroundEyeOfNewt]: vec({ psychic: 0.7, toxic: 0.3, ethereal: 0.2 }),
  [Material.GroundBatWing]:   vec({ ethereal: 0.6, kinetic: 0.3, volatile: 0.2 }),
  [Material.BoneDust]:        vec({ necrotic: 0.6, dense: 0.4, kinetic: 0.2 }),
  [Material.IronFilings]:     vec({ kinetic: 0.6, dense: 0.8, corrosive: 0.2 }),
  [Material.MoonstoneDust]:   vec({ luminous: 0.7, ethereal: 0.5, healing: 0.2 }),
  [Material.CrystalDust]:     vec({ luminous: 0.6, kinetic: 0.5, reactive: 0.3 }),
  [Material.MushroomSpores]:  vec({ toxic: 0.5, psychic: 0.5, reactive: 0.3 }),
  [Material.DragonScale]:     vec({ thermal: 0.7, kinetic: 0.6, dense: 0.9, reactive: 0.3 }),
  [Material.PhoenixFeather]:  vec({ thermal: 0.6, healing: 0.6, luminous: 0.5, volatile: 0.4 }),
  [Material.UnicornHorn]:     vec({ healing: 0.9, luminous: 0.7, ethereal: 0.4 }),
  [Material.MandrakeRoot]:    vec({ toxic: 0.6, psychic: 0.5, necrotic: 0.3 }),
  [Material.SpiderSilk]:      vec({ kinetic: 0.5, ethereal: 0.4, dense: 0.2 }),
  [Material.GraveDust]:       vec({ necrotic: 0.8, dense: 0.6, toxic: 0.3 }),
  [Material.StarShard]:       vec({ luminous: 0.8, ethereal: 0.6, kinetic: 0.5, reactive: 0.4 }),
  [Material.TimeSand]:        vec({ kinetic: 0.7, ethereal: 0.7, necrotic: 0.3, reactive: 0.4 }),
};

// ============================================================================
// Ingredient info (name, tier, package, dose, price, color)
// ============================================================================

function matColor(mat: number): [number, number, number] {
  const c = MATERIALS[mat]?.color;
  if (!c) return [0, 0, 0];
  return [c[0], c[1], c[2]];
}

function ing(mat: number, name: string, tier: number, pkg: PackageType, doseSize: number, dosePrice: number): IngredientInfo {
  return {
    mat, name, tier, packageType: pkg, doseSize, dosePrice,
    effectVector: INGREDIENT_EFFECTS[mat] ?? zeroEffectVector(),
    color: matColor(mat),
  };
}

export const INGREDIENTS: IngredientInfo[] = [
  // Tier 0 — starters
  ing(Material.Water, "Water", 0, "flask", 40, 2),
  ing(Material.Salt, "Salt", 0, "box", 30, 3),
  ing(Material.Sand, "Sand", 0, "box", 30, 2),
  ing(Material.Sulfur, "Sulfur", 0, "box", 25, 5),
  ing(Material.BoneDust, "Bone Dust", 0, "box", 25, 5),
  ing(Material.IronFilings, "Iron Filings", 0, "box", 25, 6),
  // Tier 1
  ing(Material.Oil, "Oil", 1, "flask", 35, 8),
  ing(Material.Honey, "Honey", 1, "flask", 30, 10),
  ing(Material.Mercury, "Mercury", 1, "flask", 30, 15),
  ing(Material.Blood, "Blood", 1, "flask", 30, 12),
  ing(Material.GroundEyeOfNewt, "Ground Eye of Newt", 1, "vial", 20, 12),
  ing(Material.GroundBatWing, "Ground Bat Wing", 1, "vial", 20, 10),
  ing(Material.MushroomSpores, "Mushroom Spores", 1, "sack", 25, 10),
  ing(Material.MandrakeRoot, "Mandrake Root", 1, "box", 20, 14),
  // Tier 2
  ing(Material.Ether, "Ether", 2, "flask", 30, 20),
  ing(Material.Syrup, "Syrup", 2, "flask", 30, 18),
  ing(Material.NightshadeExtract, "Nightshade Extract", 2, "vial", 20, 22),
  ing(Material.TrollBlood, "Troll Blood", 2, "flask", 25, 25),
  ing(Material.MoonstoneDust, "Moonstone Dust", 2, "vial", 20, 24),
  ing(Material.CrystalDust, "Crystal Dust", 2, "vial", 20, 22),
  ing(Material.GraveDust, "Grave Dust", 2, "box", 25, 20),
  ing(Material.SpiderSilk, "Spider Silk", 2, "sack", 20, 18),
  // Tier 3
  ing(Material.LiquidShadow, "Liquid Shadow", 3, "vial", 20, 35),
  ing(Material.LoveEssence, "Love Essence", 3, "vial", 20, 38),
  ing(Material.HateEssence, "Hate Essence", 3, "vial", 20, 38),
  ing(Material.DreamMist, "Dream Mist", 3, "vial", 20, 40),
  ing(Material.DragonScale, "Dragon Scale", 3, "box", 15, 42),
  ing(Material.PhoenixFeather, "Phoenix Feather", 3, "box", 15, 45),
  // Tier 4
  ing(Material.UnicornHorn, "Unicorn Horn", 4, "vial", 12, 70),
  ing(Material.StarShard, "Star Shard", 4, "vial", 12, 75),
  // Tier 5
  ing(Material.VoidEssence, "Void Essence", 5, "vial", 10, 120),
  ing(Material.TimeSand, "Time Sand", 5, "vial", 10, 130),
];

export const INGREDIENT_BY_MAT: Record<number, IngredientInfo> = Object.fromEntries(
  INGREDIENTS.map((i) => [i.mat, i]),
);

// ============================================================================
// Mixture analyzer — reads the cauldron histogram → effect vector + properties
// ============================================================================

export interface MixtureAnalysis {
  effectVector: EffectVector;
  properties: PotionProperties;
  totalCells: number;
  ingredientCounts: { mat: number; count: number }[];
}

export function analyzeMixture(histogram: Uint32Array): MixtureAnalysis {
  const vec = zeroEffectVector();
  let totalCells = 0;
  let maxCount = 0;
  const ingredientCounts: { mat: number; count: number }[] = [];

  // Sum weighted effect vectors
  for (let mat = 0; mat < 256; mat++) {
    const count = histogram[mat];
    if (count === 0) continue;
    const ev = INGREDIENT_EFFECTS[mat];
    if (!ev) continue; // skip non-ingredient materials (walls, byproducts, etc.)
    totalCells += count;
    if (count > maxCount) maxCount = count;
    ingredientCounts.push({ mat, count });
    for (const dim of EFFECT_DIMENSIONS) {
      vec[dim] += ev[dim] * count;
    }
  }

  // Normalize by the maximum ingredient count (not total) so the dominant
  // ingredient's effect strength is preserved. A 2:1 water:sulfur mix gives
  // sulfur's effects at ~50% strength (sulfur_count / max_count), not ~33%.
  if (maxCount > 0) {
    for (const dim of EFFECT_DIMENSIONS) {
      vec[dim] = vec[dim] / maxCount;
    }
  }

  // Clamp to [-1, 1]
  for (const dim of EFFECT_DIMENSIONS) {
    if (vec[dim] > 1) vec[dim] = 1;
    if (vec[dim] < -1) vec[dim] = -1;
  }

  const properties = deriveProperties(vec, ingredientCounts, totalCells);
  return { effectVector: vec, properties, totalCells, ingredientCounts };
}

function deriveProperties(
  vec: EffectVector,
  counts: { mat: number; count: number }[],
  total: number,
): PotionProperties {
  // Color: weighted RGB blend of ingredient colors
  let r = 0, g = 0, b = 0;
  for (const { mat, count } of counts) {
    const c = matColor(mat);
    r += c[0] * count;
    g += c[1] * count;
    b += c[2] * count;
  }
  if (total > 0) { r /= total; g /= total; b /= total; }

  return {
    acidity: Math.max(0, vec.corrosive),
    basicity: Math.max(0, -vec.corrosive + 0.5),
    viscosity: Math.max(0, vec.dense),
    glow: Math.max(0, vec.luminous),
    color: [r, g, b],
    aura: Math.max(0, (vec.ethereal + vec.psychic) / 2),
    sparkle: Math.max(0, (vec.volatile + vec.kinetic) / 2),
  };
}

// ============================================================================
// Process transforms — heat/cool/settle modify the effect vector
// ============================================================================

export function applyProcess(vec: EffectVector, process: "heat" | "cool" | "settle"): EffectVector {
  const v = { ...vec };
  if (process === "heat") {
    v.volatile = clamp(v.volatile * 1.5);
    v.reactive = clamp(v.reactive * 1.3);
    v.thermal = clamp(v.thermal + 0.3);
    v.dense = clamp(v.dense * 0.8);
    v.ethereal = clamp(v.ethereal * 1.2);
    v.luminous = clamp(v.luminous * 1.1);
  } else if (process === "cool") {
    v.reactive = clamp(v.reactive * 0.5);
    v.volatile = clamp(v.volatile * 0.7);
    v.dense = clamp(v.dense * 1.3);
    v.thermal = clamp(v.thermal - 0.3);
    v.ethereal = clamp(v.ethereal * 0.9);
  } else if (process === "settle") {
    v.dense = clamp(v.dense * 1.4);
    v.volatile = clamp(v.volatile * 0.6);
    v.ethereal = clamp(v.ethereal * 0.7);
    v.kinetic = clamp(v.kinetic * 0.8);
    v.toxic = clamp(v.toxic * 1.1);
    v.necrotic = clamp(v.necrotic * 1.1);
  }
  return v;
}

function clamp(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

export function applyProcesses(vec: EffectVector, processes: ("heat" | "cool" | "settle")[]): EffectVector {
  let v = { ...vec };
  for (const p of processes) v = applyProcess(v, p);
  return v;
}

// ============================================================================
// Effects — named magic properties with predicates over the effect vector
// ============================================================================

const g = (v: EffectVector, dim: EffectDimension) => v[dim];

export const EFFECTS: Effect[] = [
  { id: "dissolving-acid", name: "Dissolving Acid", description: "Dissolves organic matter on contact.",
    predicate: (v) => g(v,"corrosive") > 0.35 && g(v,"toxic") > 0.15 },
  { id: "lawn-cleaner", name: "Lawn Cleaner", description: "Kills weeds and cleans lawns. A visitor favorite.",
    predicate: (v) => g(v,"corrosive") > 0.3 && g(v,"reactive") > 0.1 },
  { id: "will-o-wisp", name: "Will-o-Wisp", description: "A glowing ethereal light that leads travelers astray.",
    predicate: (v) => g(v,"luminous") > 0.35 && g(v,"ethereal") > 0.25 },
  { id: "necrotic-blight", name: "Necrotic Blight", description: "Withers living tissue into black sludge.",
    predicate: (v) => g(v,"necrotic") > 0.35 && g(v,"toxic") > 0.15 },
  { id: "healing-draught", name: "Healing Draught", description: "Restores vitality to the drinker.",
    predicate: (v) => g(v,"healing") > 0.3 && g(v,"toxic") < 0.25 },
  { id: "phoenix-tears", name: "Phoenix Tears", description: "A legendary restorative that heals even mortal wounds.",
    predicate: (v) => g(v,"healing") > 0.35 && g(v,"thermal") > 0.25 && g(v,"luminous") > 0.15 },
  { id: "love-philter", name: "Love Philter", description: "Infatuates the drinker with the first face they see.",
    predicate: (v) => g(v,"psychic") > 0.4 && g(v,"healing") > 0.1 && g(v,"luminous") > 0.1 },
  { id: "wrath-elixir", name: "Wrath Elixir", description: "Fills the drinker with righteous fury.",
    predicate: (v) => g(v,"psychic") > 0.3 && g(v,"corrosive") > 0.3 && g(v,"thermal") > 0.15 },
  { id: "dream-vapor", name: "Dream Vapor", description: "Induces vivid prophetic dreams.",
    predicate: (v) => g(v,"ethereal") > 0.3 && g(v,"psychic") > 0.3 && g(v,"volatile") > 0.1 },
  { id: "void-bomb", name: "Void Bomb", description: "A reality-tearing explosion of negation.",
    predicate: (v) => g(v,"necrotic") > 0.4 && g(v,"kinetic") > 0.2 && g(v,"volatile") > 0.15 },
  { id: "starlight-tonic", name: "Starlight Tonic", description: "Glows with the cold light of distant stars.",
    predicate: (v) => g(v,"luminous") > 0.45 && g(v,"ethereal") > 0.25 },
  { id: "time-ender", name: "Time Ender", description: "Stops the drinker's clock for a precious few seconds.",
    predicate: (v) => g(v,"kinetic") > 0.35 && g(v,"ethereal") > 0.35 },
  { id: "dragonfire", name: "Dragonfire", description: "Burns with a heat that clings to everything it touches.",
    predicate: (v) => g(v,"thermal") > 0.4 && g(v,"reactive") > 0.2 && g(v,"dense") > 0.25 },
  { id: "frost-oil", name: "Frost Oil", description: "Coats surfaces in a sheet of impossible cold.",
    predicate: (v) => g(v,"thermal") < -0.2 && g(v,"dense") > 0.25 },
  { id: "liquid-shadow", name: "Living Shadow", description: "A darkness that moves with intent.",
    predicate: (v) => g(v,"necrotic") > 0.3 && g(v,"dense") > 0.4 && g(v,"luminous") < 0.15 },
  { id: "mercury-poison", name: "Quicksilver Poison", description: "A heavy metal toxin that accumulates in the blood.",
    predicate: (v) => g(v,"toxic") > 0.4 && g(v,"dense") > 0.4 },
  { id: "nightshade-venom", name: "Nightshade Venom", description: "A classic poison. Bitter almonds, then nothing.",
    predicate: (v) => g(v,"toxic") > 0.45 && g(v,"psychic") > 0.1 },
  { id: "grave-mist", name: "Grave Mist", description: "The breath of the recently exhumed.",
    predicate: (v) => g(v,"necrotic") > 0.35 && g(v,"ethereal") > 0.15 },
  { id: "spark-powder", name: "Spark Powder", description: "Explodes on impact. Popular with miners and anarchists.",
    predicate: (v) => g(v,"kinetic") > 0.3 && g(v,"volatile") > 0.3 && g(v,"reactive") > 0.1 },
  { id: "moon-brew", name: "Moon Brew", description: "Glows softly. Calms the mind. Tastes like silver.",
    predicate: (v) => g(v,"luminous") > 0.35 && g(v,"ethereal") > 0.25 && g(v,"healing") > 0.1 },
  { id: "troll-regen", name: "Troll Regeneration", description: "Heals wounds at the cost of a terrible thirst.",
    predicate: (v) => g(v,"healing") > 0.35 && g(v,"necrotic") > 0.2 },
  { id: "ether-bomb", name: "Ether Bomb", description: "A volatile blast of raw ethereal energy.",
    predicate: (v) => g(v,"ethereal") > 0.4 && g(v,"volatile") > 0.3 },
  { id: "crystal-resonance", name: "Crystal Resonance", description: "Humming kinetic energy that shatters glass.",
    predicate: (v) => g(v,"kinetic") > 0.3 && g(v,"luminous") > 0.25 && g(v,"reactive") > 0.1 },
  { id: "shadow-burn", name: "Shadow Burn", description: "A darkness that burns what it touches.",
    predicate: (v) => g(v,"necrotic") > 0.3 && g(v,"thermal") > 0.25 },
  { id: "hate-flux", name: "Hate Flux", description: "Corrosive rage given liquid form.",
    predicate: (v) => g(v,"psychic") > 0.35 && g(v,"corrosive") > 0.3 },
  { id: "dream-narcotic", name: "Dream Narcotic", description: "A psychic sedative that traps the mind in reverie.",
    predicate: (v) => g(v,"psychic") > 0.3 && g(v,"ethereal") > 0.25 && g(v,"toxic") > 0.1 },
  { id: "inert-slag", name: "Inert Slag", description: "A useless gray paste. You messed up.",
    predicate: (v) => Math.abs(g(v,"toxic")) < 0.08 && Math.abs(g(v,"corrosive")) < 0.08 &&
      Math.abs(g(v,"healing")) < 0.08 && Math.abs(g(v,"luminous")) < 0.08 &&
      Math.abs(g(v,"volatile")) < 0.08 && Math.abs(g(v,"reactive")) < 0.08 &&
      Math.abs(g(v,"ethereal")) < 0.08 && Math.abs(g(v,"necrotic")) < 0.08 &&
      Math.abs(g(v,"psychic")) < 0.08 && Math.abs(g(v,"kinetic")) < 0.08 },
  { id: "volatile-mix", name: "Volatile Mix", description: "Unstable. Handle with care. Do not shake.",
    predicate: (v) => g(v,"volatile") > 0.35 && g(v,"reactive") > 0.2 },
  { id: "heavy-syrup", name: "Heavy Syrup", description: "Thick, slow, and stubbornly dense.",
    predicate: (v) => g(v,"dense") > 0.45 && g(v,"volatile") < 0.2 },
  { id: "pure-water", name: "Pure Water", description: "It's just water. Why did you bottle this.",
    predicate: (v) => g(v,"dense") < 0.35 && g(v,"toxic") < 0.08 && g(v,"corrosive") < 0.08 &&
      g(v,"healing") < 0.08 && g(v,"luminous") < 0.08 && g(v,"volatile") < 0.08 &&
      g(v,"reactive") < 0.08 && g(v,"ethereal") < 0.08 && g(v,"necrotic") < 0.08 &&
      g(v,"psychic") < 0.08 && g(v,"kinetic") < 0.08 && g(v,"dense") > 0.1 },
];

export const EFFECT_BY_ID: Record<string, Effect> = Object.fromEntries(
  EFFECTS.map((e) => [e.id, e]),
);

export function deriveEffects(vec: EffectVector): Effect[] {
  return EFFECTS.filter((e) => {
    try { return e.predicate(vec); } catch { return false; }
  });
}

// ============================================================================
// Procedural naming for mixed potions (no recipe match)
// ============================================================================

const ADJECTIVES_BY_DIM: Record<EffectDimension, string[]> = {
  toxic: ["Toxic", "Venomous", "Poisoned"],
  corrosive: ["Corrosive", "Acidic", "Eating"],
  healing: ["Healing", "Restorative", "Vital"],
  luminous: ["Glowing", "Luminous", "Radiant"],
  volatile: ["Volatile", "Unstable", "Fizzing"],
  reactive: ["Reactive", "Lively", "Eager"],
  dense: ["Viscous", "Heavy", "Syrupy"],
  ethereal: ["Ethereal", "Ghostly", "Otherworldly"],
  thermal: ["Burning", "Fiery", "Scalding"],
  necrotic: ["Necrotic", "Withered", "Grave-touched"],
  psychic: ["Psychic", "Mindful", "Enchanted"],
  kinetic: ["Kinetic", "Sparkling", "Restless"],
};

const NOUNS_BY_DIM: Record<EffectDimension, string> = {
  toxic: "Venom",
  corrosive: "Acid",
  healing: "Draught",
  luminous: "Glow",
  volatile: "Fizz",
  reactive: "Catalyst",
  dense: "Syrup",
  ethereal: "Mist",
  thermal: "Fire",
  necrotic: "Blight",
  psychic: "Philter",
  kinetic: "Spark",
};

const VOID_NAMES = ["Void Brew", "Nothing Potion", "Empty Flask", "Bottled Emptiness"];

export function nameMixture(vec: EffectVector, effects: Effect[]): string {
  if (effects.length === 0) {
    // Check if it's truly inert or just water
    const total = EFFECT_DIMENSIONS.reduce((s, d) => s + Math.abs(vec[d]), 0);
    if (total < 0.3) return VOID_NAMES[Math.floor(Math.random() * VOID_NAMES.length)];
    return "Strange Brew";
  }

  // If exactly one effect, use its name
  if (effects.length === 1) return effects[0].name;

  // Find the top 2 dimensions by absolute value
  const sorted = EFFECT_DIMENSIONS
    .map((d) => ({ dim: d, val: Math.abs(vec[d]) }))
    .sort((a, b) => b.val - a.val);
  const top1 = sorted[0];
  const top2 = sorted[1];

  if (top1.val < 0.3) return "Mild Brew";

  const adj = ADJECTIVES_BY_DIM[top1.dim];
  const adjective = adj[Math.floor(Math.random() * adj.length)];
  const noun = NOUNS_BY_DIM[top2.dim] ?? NOUNS_BY_DIM[top1.dim];

  return `${adjective} ${noun}`;
}
