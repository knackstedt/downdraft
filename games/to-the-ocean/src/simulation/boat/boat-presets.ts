import { BoatCellType } from "../../shared/constants";

export interface BoatPresetCell {
  type: number;
  rotation: number;
  gridX: number;
  gridY: number;
  gridZ: number;
}

export type BoatPresetName =
  | "monohull" | "catamaran" | "pontoon"
  | "yacht_small" | "yacht_medium" | "yacht_large" | "superyacht";

export interface BoatPreset {
  name: BoatPresetName;
  label: string;
  description: string;
  cells: BoatPresetCell[];
}

function c(type: number, x: number, y: number, z: number, rot = 0): BoatPresetCell {
  return { type, rotation: rot, gridX: x, gridY: y, gridZ: z };
}

function hullRow(width: number, z: number, y = 0): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.HULL, x, y, z));
  return cells;
}

function sternRow(width: number, z: number, y = 0): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.STERN, x, y, z));
  return cells;
}

function wallRow(width: number, z: number, y = 1): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.WALL_STRAIGHT, x, y, z, 0));
  return cells;
}

function cabinRow(width: number, z: number, y = 1): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.CABIN, x, y, z));
  return cells;
}

function railRow(width: number, z: number, y = 1): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.RAIL, x, y, z));
  return cells;
}

function pontoonLine(x: number, z0: number, z1: number, y = 0): BoatPresetCell[] {
  const cells: BoatPresetCell[] = [];
  for (let z = z0; z <= z1; z++) cells.push(c(BoatCellType.PONTOON, x, y, z));
  return cells;
}

function bridgeRow(width: number, z: number, y = 1): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.BRIDGE, x, y, z));
  return cells;
}

function deckRow(width: number, z: number, y = 1): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  const cells: BoatPresetCell[] = [];
  for (let x = -half; x <= half; x++) cells.push(c(BoatCellType.DECK, x, y, z));
  return cells;
}

function gunwalePair(width: number, z: number, y = 1): BoatPresetCell[] {
  const half = Math.floor(width / 2);
  return [c(BoatCellType.WALL_STRAIGHT, -half, y, z, 3), c(BoatCellType.WALL_STRAIGHT, half, y, z, 1)];
}

// --- Presets ---

const monohull: BoatPresetCell[] = [
  c(BoatCellType.BOW_MODERN, 0, 0, -4),
  c(BoatCellType.HULL_CURVE_L, -1, 0, -3),
  c(BoatCellType.HULL_CURVE_R, 1, 0, -3),
  ...hullRow(3, -2), ...hullRow(5, -1), ...hullRow(5, 0), ...hullRow(4, 1),
  ...sternRow(4, 2),
  // Layer 1
  ...gunwalePair(5, -1), ...gunwalePair(5, 0), c(BoatCellType.WALL_STRAIGHT, -2, 1, 1, 3),
  c(BoatCellType.WALL_STRAIGHT, -1, 1, -2, 0), c(BoatCellType.HELM, 0, 1, -2), c(BoatCellType.WALL_STRAIGHT, 1, 1, -2, 0),
  c(BoatCellType.WALL_STRAIGHT, -2, 1, 2, 3), c(BoatCellType.WALL_STRAIGHT, 1, 1, 2, 1),
  c(BoatCellType.MAST, 0, 1, 2),
  c(BoatCellType.RAIL, -1, 1, 2), c(BoatCellType.RAIL, 0, 1, 2), c(BoatCellType.RAIL, 0, 1, -4),
];

const catamaran: BoatPresetCell[] = [
  ...pontoonLine(-3, -3, 2), ...pontoonLine(3, -3, 2),
  ...bridgeRow(7, -2), ...bridgeRow(7, -1), ...bridgeRow(7, 0), ...bridgeRow(7, 1),
  c(BoatCellType.HELM, 0, 2, 0),
  ...railRow(7, -2, 2), ...railRow(7, 1, 2),
];

const pontoon: BoatPresetCell[] = [
  // Layer 0: Hull floor — curved bow front, pontoons sides, flat stern
  c(BoatCellType.BOW_MODERN, 0, 0, -6),
  c(BoatCellType.HULL_CURVE_L, -2, 0, -5),
  c(BoatCellType.HULL, -1, 0, -5),
  c(BoatCellType.HULL, 0, 0, -5),
  c(BoatCellType.HULL, 1, 0, -5),
  c(BoatCellType.HULL_CURVE_R, 2, 0, -5),
  ...pontoonLine(-2, -4, 3),
  ...pontoonLine(2, -4, 3),
  ...hullRow(3, -4), ...hullRow(3, -3), ...hullRow(3, -2), ...hullRow(3, -1),
  ...hullRow(3, 0), ...hullRow(3, 1), ...hullRow(3, 2), ...hullRow(3, 3),
  ...sternRow(5, 4),

  // Layer 1: Deck floor (3-wide interior, z=-4 to 4) + perimeter walls
  ...deckRow(3, -4), ...deckRow(3, -3), ...deckRow(3, -2), ...deckRow(3, -1),
  ...deckRow(3, 0), ...deckRow(3, 1), ...deckRow(3, 2), ...deckRow(3, 3),
  ...deckRow(3, 4),

  // Front wall (full 5 wide at z=-5, above curved bow floor)
  c(BoatCellType.WALL_STRAIGHT, -2, 1, -5, 0),
  c(BoatCellType.WALL_STRAIGHT, -1, 1, -5, 0),
  c(BoatCellType.WALL_STRAIGHT, 0, 1, -5, 0),
  c(BoatCellType.WALL_STRAIGHT, 1, 1, -5, 0),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, -5, 0),

  // Left side walls with door gap at center (z=-1, 0)
  c(BoatCellType.WALL_STRAIGHT, -2, 1, -4, 3),
  c(BoatCellType.WALL_STRAIGHT, -2, 1, -3, 3),
  c(BoatCellType.WALL_STRAIGHT, -2, 1, -2, 3),
  // door gap at z=-1, 0
  c(BoatCellType.WALL_STRAIGHT, -2, 1, 1, 3),
  c(BoatCellType.WALL_STRAIGHT, -2, 1, 2, 3),
  c(BoatCellType.WALL_STRAIGHT, -2, 1, 3, 3),

  // Right side walls with door gap at center (z=-1, 0)
  c(BoatCellType.WALL_STRAIGHT, 2, 1, -4, 1),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, -3, 1),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, -2, 1),
  // door gap at z=-1, 0
  c(BoatCellType.WALL_STRAIGHT, 2, 1, 1, 1),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, 2, 1),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, 3, 1),

  // Layer 2: Helm near front
  c(BoatCellType.HELM, 0, 2, -4),
];

const yacht_small: BoatPresetCell[] = [
  c(BoatCellType.BOW_MODERN, 0, 0, -3),
  c(BoatCellType.HULL_CURVE_L, -1, 0, -2), c(BoatCellType.HULL_CURVE_R, 1, 0, -2),
  ...hullRow(3, -1), ...hullRow(3, 0), ...hullRow(3, 1), ...sternRow(3, 2),
  // Layer 1: gunwales + cabin hold + helm
  ...gunwalePair(3, -1), ...gunwalePair(3, 0),
  ...cabinRow(3, 1),
  c(BoatCellType.WALL_STRAIGHT, -1, 1, -2, 0), c(BoatCellType.HELM, 0, 1, -2), c(BoatCellType.WALL_STRAIGHT, 1, 1, -2, 0),
  ...railRow(3, 2),
  c(BoatCellType.DECK, 0, 1, 0), c(BoatCellType.DECK, 0, 1, -1),
];

const yacht_medium: BoatPresetCell[] = [
  c(BoatCellType.BOW_MODERN, 0, 0, -5),
  c(BoatCellType.HULL_CURVE_L, -1, 0, -4), c(BoatCellType.HULL_CURVE_R, 1, 0, -4),
  ...hullRow(3, -3), ...hullRow(5, -2), ...hullRow(5, -1), ...hullRow(5, 0),
  ...hullRow(5, 1), ...sternRow(5, 2),
  // Layer 1: gunwales
  ...gunwalePair(5, -1), ...gunwalePair(5, 0), ...gunwalePair(5, 1),
  // Forward bulkhead + helm
  ...wallRow(5, -2), // overwrite center with helm below
  c(BoatCellType.HELM, 0, 1, -2),
  // Cabin hold (2 rows)
  ...cabinRow(3, 0), ...cabinRow(3, 1),
  // Aft bulkhead
  c(BoatCellType.WALL_STRAIGHT, -2, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, -1, 1, 2, 2),
  c(BoatCellType.WALL_STRAIGHT, 1, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, 2, 1, 2, 2),
  c(BoatCellType.MAST, 0, 1, 2),
  c(BoatCellType.RAIL, -1, 1, 2), c(BoatCellType.RAIL, 0, 1, 2),
  // Deck + bow rail
  c(BoatCellType.DECK, -1, 1, -1), c(BoatCellType.DECK, 0, 1, -1), c(BoatCellType.DECK, 1, 1, -1),
  c(BoatCellType.RAIL, 0, 1, -5),
];

const yacht_large: BoatPresetCell[] = [
  c(BoatCellType.BOW_MODERN, 0, 0, -7),
  c(BoatCellType.HULL_CURVE_L, -1, 0, -6), c(BoatCellType.HULL_CURVE_R, 1, 0, -6),
  ...hullRow(5, -5), ...hullRow(7, -4), ...hullRow(7, -3), ...hullRow(7, -2),
  ...hullRow(7, -1), ...hullRow(7, 0), ...hullRow(7, 1), ...sternRow(7, 2),
  // Layer 1: gunwales
  ...gunwalePair(7, -2), ...gunwalePair(7, -1), ...gunwalePair(7, 0), ...gunwalePair(7, 1),
  // Forward bulkhead + dual helm
  ...wallRow(7, -3),
  c(BoatCellType.HELM, -1, 1, -3), c(BoatCellType.HELM, 1, 1, -3),
  // Large cabin hold (4 rows x 5-wide)
  ...cabinRow(5, -2), ...cabinRow(5, -1), ...cabinRow(5, 0), ...cabinRow(5, 1),
  // Aft bulkhead
  c(BoatCellType.WALL_STRAIGHT, -3, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, -2, 1, 2, 2),
  c(BoatCellType.WALL_STRAIGHT, -1, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, 1, 1, 2, 2),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, 3, 1, 2, 2),
  c(BoatCellType.MAST, 0, 1, 2),
  c(BoatCellType.RAIL, -2, 1, 2), c(BoatCellType.RAIL, -1, 1, 2),
  c(BoatCellType.RAIL, 0, 1, 2), c(BoatCellType.RAIL, 1, 1, 2),
  c(BoatCellType.RAIL, 0, 1, -7),
  c(BoatCellType.DECK, -2, 1, -3), c(BoatCellType.DECK, 2, 1, -3),
];

const superyacht: BoatPresetCell[] = [
  c(BoatCellType.BOW_MODERN, 0, 0, -9),
  c(BoatCellType.HULL_CURVE_L, -1, 0, -8), c(BoatCellType.HULL_CURVE_R, 1, 0, -8),
  ...hullRow(5, -7), ...hullRow(7, -6), ...hullRow(7, -5), ...hullRow(7, -4),
  ...hullRow(7, -3), ...hullRow(7, -2), ...hullRow(7, -1),
  ...hullRow(7, 0), ...hullRow(7, 1), ...hullRow(7, 2), ...sternRow(7, 3),
  // Layer 1: gunwales
  ...gunwalePair(7, -4), ...gunwalePair(7, -3), ...gunwalePair(7, -2),
  ...gunwalePair(7, -1), ...gunwalePair(7, 0), ...gunwalePair(7, 1), ...gunwalePair(7, 2),
  // Forward bulkhead + dual helm
  ...wallRow(7, -5),
  c(BoatCellType.HELM, -1, 1, -5), c(BoatCellType.HELM, 1, 1, -5),
  // Large superstructure (6 rows x 5-wide)
  ...cabinRow(5, -4), ...cabinRow(5, -3), ...cabinRow(5, -2),
  ...cabinRow(5, -1), ...cabinRow(5, 0), ...cabinRow(5, 1),
  // Aft bulkhead
  c(BoatCellType.WALL_STRAIGHT, -3, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, -2, 1, 2, 2),
  c(BoatCellType.WALL_STRAIGHT, -1, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, 1, 1, 2, 2),
  c(BoatCellType.WALL_STRAIGHT, 2, 1, 2, 2), c(BoatCellType.WALL_STRAIGHT, 3, 1, 2, 2),
  // Layer 2: upper deck cabin
  ...cabinRow(3, -3, 2), ...cabinRow(3, -2, 2),
  c(BoatCellType.HELM, 0, 3, -2),
  // Masts
  c(BoatCellType.MAST, 0, 1, 2), c(BoatCellType.MAST, 0, 2, -3),
  // Stern rails
  c(BoatCellType.RAIL, -2, 1, 3), c(BoatCellType.RAIL, -1, 1, 3),
  c(BoatCellType.RAIL, 0, 1, 3), c(BoatCellType.RAIL, 1, 1, 3), c(BoatCellType.RAIL, 2, 1, 3),
  // Upper deck rails
  c(BoatCellType.RAIL, -1, 3, -3), c(BoatCellType.RAIL, 1, 3, -3),
  c(BoatCellType.RAIL, -1, 3, -2), c(BoatCellType.RAIL, 1, 3, -2),
  // Bow rail
  c(BoatCellType.RAIL, 0, 1, -9),
  // Side deck walkways
  c(BoatCellType.DECK, -3, 1, -5), c(BoatCellType.DECK, 3, 1, -5),
];

export const BOAT_PRESETS: Record<BoatPresetName, BoatPreset> = {
  monohull: { name: "monohull", label: "Monohull", description: "Classic fishing boat — tapered bow, wide midship, transom stern", cells: monohull },
  catamaran: { name: "catamaran", label: "Catamaran", description: "Twin pontoons connected by bridge deck with helm", cells: catamaran },
  pontoon: { name: "pontoon", label: "Pontoon", description: "Small compact catamaran — open deck, perfect for fishing", cells: pontoon },
  yacht_small: { name: "yacht_small", label: "Yacht (Small)", description: "Compact yacht — 3-wide hull, small cabin hold, helm station", cells: yacht_small },
  yacht_medium: { name: "yacht_medium", label: "Yacht (Medium)", description: "Mid-size yacht — 5-wide hull, cabin hold, mast, dual bulkheads", cells: yacht_medium },
  yacht_large: { name: "yacht_large", label: "Yacht (Large)", description: "Large yacht — 7-wide hull, multi-cabin hold, dual helm, mast", cells: yacht_large },
  superyacht: { name: "superyacht", label: "Superyacht", description: "Luxury vessel — 7-wide hull, multi-deck superstructure, dual helm, masts", cells: superyacht },
};

export const BOAT_PRESET_LIST = Object.values(BOAT_PRESETS);
