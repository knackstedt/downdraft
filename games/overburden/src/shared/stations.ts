// ============================================================================
// Overburden — crafting station registry
//
// Links station block IDs to their recipe station type and fuel configuration.
// Fueled stations (campfire, kiln, furnace, metalwork bench) consume fuel
// while crafting. Unfueled stations (workbench, craft bench, etc.) craft
// without fuel.
// ============================================================================

import {
  BLOCK_BUILDER_BENCH,
  BLOCK_CAMPFIRE,
  BLOCK_COMPOST_BIN,
  BLOCK_CRAFT_BENCH,
  BLOCK_FURNACE,
  BLOCK_KILN,
  BLOCK_METALWORK_BENCH,
  BLOCK_TAILOR_BENCH,
  BLOCK_TOOL_BENCH,
  BLOCK_WOODWORK_BENCH,
  BLOCK_WORKBENCH,
} from "./constants";
import type { CraftStation } from "./types";

export interface StationDef {
  blockId: number;
  station: CraftStation;
  name: string;
  fueled: boolean;
  fuelSlots: number; // 0 (unfueled) or 10 (fueled)
  fuelBurnTime: number; // seconds per fuel slot (default 10)
  acceptsFuel: number[]; // fuelValue levels accepted (e.g. [1,2] for campfire)
}

export const STATIONS: StationDef[] = [
  {
    blockId: BLOCK_WORKBENCH,
    station: "workbench",
    name: "Workbench",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
  {
    blockId: BLOCK_CRAFT_BENCH,
    station: "craft_bench",
    name: "Craft Bench",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
  {
    blockId: BLOCK_TOOL_BENCH,
    station: "tool_bench",
    name: "Tool Bench",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
  {
    blockId: BLOCK_WOODWORK_BENCH,
    station: "woodwork_bench",
    name: "Woodwork Bench",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
  {
    blockId: BLOCK_CAMPFIRE,
    station: "campfire",
    name: "Campfire",
    fueled: true,
    fuelSlots: 10,
    fuelBurnTime: 10,
    acceptsFuel: [1, 2], // sticks, wood, torches, scaffolding
  },
  {
    blockId: BLOCK_KILN,
    station: "kiln",
    name: "Kiln",
    fueled: true,
    fuelSlots: 10,
    fuelBurnTime: 10,
    acceptsFuel: [1, 2, 3], // wood, coal, charcoal
  },
  {
    blockId: BLOCK_FURNACE,
    station: "furnace",
    name: "Furnace",
    fueled: true,
    fuelSlots: 10,
    fuelBurnTime: 10,
    acceptsFuel: [2, 3, 5], // wood, coal, charcoal (higher tier)
  },
  {
    blockId: BLOCK_METALWORK_BENCH,
    station: "metalwork_bench",
    name: "Metalwork Bench",
    fueled: true,
    fuelSlots: 10,
    fuelBurnTime: 10,
    acceptsFuel: [2, 3, 5],
  },
  {
    blockId: BLOCK_BUILDER_BENCH,
    station: "builder_bench",
    name: "Builder's Bench",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
  {
    blockId: BLOCK_TAILOR_BENCH,
    station: "tailor_bench",
    name: "Tailor's Bench",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
  {
    blockId: BLOCK_COMPOST_BIN,
    station: "compost_bin",
    name: "Compost Bin",
    fueled: false,
    fuelSlots: 0,
    fuelBurnTime: 10,
    acceptsFuel: [],
  },
];

const byBlock = new Map<number, StationDef>();
const byStation = new Map<CraftStation, StationDef>();
for (const def of STATIONS) {
  byBlock.set(def.blockId, def);
  byStation.set(def.station, def);
}

export function getStationByBlock(blockId: number): StationDef | undefined {
  return byBlock.get(blockId);
}

export function getStationByType(station: CraftStation): StationDef | undefined {
  return byStation.get(station);
}

export function getAllStations(): StationDef[] {
  return STATIONS;
}
