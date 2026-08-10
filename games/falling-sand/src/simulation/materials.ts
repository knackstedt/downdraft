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
}

export interface MaterialDef {
  id: number;
  name: string;
  gravity: number; // cells per frame; 0 = float up, higher = fall slower
  gravityDir: 1 | -1 | 0; // 1 = down, -1 = up, 0 = gas (moves with wind)
  flammable: boolean;
  burnTime: number;
  solid: boolean;
  liquid: boolean;
  gas: boolean;
  magnetic: boolean;
  color: [number, number, number, number];
}

export const MATERIALS: Record<Material, MaterialDef> = {
  [Material.Empty]: {
    id: 0, name: "Empty", gravity: 0, gravityDir: 0,
    flammable: false, burnTime: 0, solid: false, liquid: false, gas: true,
    magnetic: false, color: [0, 0, 0, 0],
  },
  [Material.Sand]: {
    id: 1, name: "Sand", gravity: 1, gravityDir: 1,
    flammable: false, burnTime: 0, solid: true, liquid: false, gas: false,
    magnetic: false, color: [0.76, 0.70, 0.50, 1.0],
  },
  [Material.Water]: {
    id: 2, name: "Water", gravity: 1, gravityDir: 1,
    flammable: false, burnTime: 0, solid: false, liquid: true, gas: false,
    magnetic: false, color: [0.12, 0.42, 0.85, 0.9],
  },
  [Material.Stone]: {
    id: 3, name: "Stone", gravity: 0, gravityDir: 0,
    flammable: false, burnTime: 0, solid: true, liquid: false, gas: false,
    magnetic: false, color: [0.45, 0.45, 0.48, 1.0],
  },
  [Material.Wood]: {
    id: 4, name: "Wood", gravity: 1, gravityDir: 1,
    flammable: true, burnTime: 240, solid: true, liquid: false, gas: false,
    magnetic: false, color: [0.55, 0.35, 0.18, 1.0],
  },
  [Material.Fire]: {
    id: 5, name: "Fire", gravity: 2, gravityDir: -1,
    flammable: false, burnTime: 30, solid: false, liquid: false, gas: true,
    magnetic: false, color: [0.95, 0.55, 0.10, 1.0],
  },
  [Material.Smoke]: {
    id: 6, name: "Smoke", gravity: 3, gravityDir: -1,
    flammable: false, burnTime: 180, solid: false, liquid: false, gas: true,
    magnetic: false, color: [0.5, 0.5, 0.5, 0.7],
  },
  [Material.Oil]: {
    id: 7, name: "Oil", gravity: 1, gravityDir: 1,
    flammable: true, burnTime: 300, solid: false, liquid: true, gas: false,
    magnetic: false, color: [0.15, 0.12, 0.08, 0.95],
  },
  [Material.Gunpowder]: {
    id: 8, name: "Gunpowder", gravity: 1, gravityDir: 1,
    flammable: true, burnTime: 10, solid: true, liquid: false, gas: false,
    magnetic: false, color: [0.2, 0.2, 0.2, 1.0],
  },
  [Material.Iron]: {
    id: 9, name: "Iron", gravity: 1, gravityDir: 1,
    flammable: false, burnTime: 0, solid: true, liquid: false, gas: false,
    magnetic: true, color: [0.65, 0.65, 0.70, 1.0],
  },
  [Material.Lava]: {
    id: 10, name: "Lava", gravity: 1, gravityDir: 1,
    flammable: false, burnTime: 0, solid: false, liquid: true, gas: false,
    magnetic: false, color: [0.9, 0.25, 0.05, 1.0],
  },
  [Material.Steam]: {
    id: 11, name: "Steam", gravity: 2, gravityDir: -1,
    flammable: false, burnTime: 120, solid: false, liquid: false, gas: true,
    magnetic: false, color: [0.85, 0.85, 0.9, 0.5],
  },
  [Material.Plant]: {
    id: 12, name: "Plant", gravity: 0, gravityDir: 0,
    flammable: true, burnTime: 120, solid: true, liquid: false, gas: false,
    magnetic: false, color: [0.15, 0.65, 0.20, 1.0],
  },
  [Material.Flesh]: {
    id: 13, name: "Flesh", gravity: 1, gravityDir: 1,
    flammable: false, burnTime: 0, solid: true, liquid: false, gas: false,
    magnetic: false, color: [0.85, 0.55, 0.55, 1.0],
  },
};

export function getMaterialColor(mat: Material): [number, number, number, number] {
  return MATERIALS[mat]?.color ?? [0, 0, 0, 0];
}
