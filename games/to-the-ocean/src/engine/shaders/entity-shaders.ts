// ============================================================================
// Entity Renderer WGSL Shaders
// Extracted from EntityRenderer.ts — shader constants for entity rendering
// Shader source lives in companion .wgsl files; this module composes shared
// chunks (lighting, PBR, IBL) with per-shader files at build time.
// ============================================================================

import { BoatCellType } from "@shared/constants";

// --- Raw shader source imports ---
import boatSrc from "./boat.wgsl?raw" with { type: "text" };
import entitySrc from "./entity.wgsl?raw" with { type: "text" };
import hitboxSrc from "./hitbox.wgsl?raw" with { type: "text" };
import holoSrc from "./holo.wgsl?raw" with { type: "text" };
import iblBindingsSrc from "./ibl-bindings.wgsl?raw" with { type: "text" };
import instancedEntitySrc from "./instanced-entity.wgsl?raw" with { type: "text" };
import islandWireframeSrc from "./island-wireframe.wgsl?raw" with { type: "text" };
import islandSrc from "./island.wgsl?raw" with { type: "text" };
import lightStructsSrc from "./light-structs.wgsl?raw" with { type: "text" };
import lightingFnSrc from "./lighting-fn.wgsl?raw" with { type: "text" };
import lightingUniformsSrc from "./lighting-uniforms.wgsl?raw" with { type: "text" };
import pbrFunctionsSrc from "./pbr-functions.wgsl?raw" with { type: "text" };
import playerSrc from "./player.wgsl?raw" with { type: "text" };
import ropeSrc from "./rope.wgsl?raw" with { type: "text" };
import skinnedPlayerSrc from "./skinned-player.wgsl?raw" with { type: "text" };
import skinningComputeSrc from "./skinning-compute.wgsl?raw" with { type: "text" };

// --- Shared shader chunks (composed at runtime) ---

export const LIGHT_STRUCTS = lightStructsSrc;

// File-backed copy of createIBLShaderChunk(2, true) so the WGSL validator can
// resolve IBL symbols via `// wgsl-validate: prelude ./ibl-bindings.wgsl`.
export const PBR_BINDINGS = iblBindingsSrc;

export const PBR_CONST = "const PI: f32 = 3.14159265359;\n";

export const PBR_FUNCTIONS = pbrFunctionsSrc;

export const LIGHTING_FN =
  LIGHT_STRUCTS + "\n" + PBR_FUNCTIONS + "\n" + PBR_BINDINGS + "\n" + lightingFnSrc;

export const LIGHTING_UNIFORMS = lightingUniformsSrc;

// --- Full shader modules (composed from shared chunks + per-shader source) ---

export const ENTITY_WGSL = LIGHTING_FN + "\n" + entitySrc;

export const INSTANCED_ENTITY_WGSL =
  LIGHT_STRUCTS + "\n" + PBR_FUNCTIONS + "\n" + PBR_BINDINGS + "\n" + instancedEntitySrc;

export const PLAYER_WGSL = LIGHTING_FN + "\n" + playerSrc;

export const SKINNING_COMPUTE_WGSL = skinningComputeSrc;

export const SKINNED_PLAYER_WGSL = LIGHTING_FN + "\n" + skinnedPlayerSrc;

export const BOAT_WGSL = LIGHTING_FN + "\n" + boatSrc;

export const ISLAND_WGSL = LIGHTING_FN + "\n" + islandSrc;

export const ISLAND_WIREFRAME_WGSL = islandWireframeSrc;

export const ROPE_WGSL = ropeSrc;

export const HOLO_WGSL = holoSrc;

export const HITBOX_WGSL = hitboxSrc;

const CELL_COLORS: Record<number, [number, number, number]> = {
  [BoatCellType.HULL]: [0.45, 0.35, 0.25],
  [BoatCellType.BOW]: [0.55, 0.40, 0.28],
  [BoatCellType.CABIN]: [0.60, 0.48, 0.30],
  [BoatCellType.MAST]: [0.35, 0.25, 0.15],
  [BoatCellType.DECK]: [0.50, 0.38, 0.22],
  [BoatCellType.RAIL]: [0.40, 0.30, 0.20],
  [BoatCellType.WALL_STRAIGHT]: [0.50, 0.35, 0.20],
  [BoatCellType.WALL_CORNER]: [0.52, 0.36, 0.21],
  [BoatCellType.WALL_CURVED]: [0.48, 0.34, 0.19],
  [BoatCellType.WALL_DIAGONAL]: [0.51, 0.35, 0.20],
  [BoatCellType.HULL_CURVE_L]: [0.42, 0.32, 0.22],
  [BoatCellType.HULL_CURVE_R]: [0.42, 0.32, 0.22],
  [BoatCellType.BOW_MODERN]: [0.50, 0.38, 0.25],
  [BoatCellType.STERN]: [0.48, 0.36, 0.24],
  [BoatCellType.PONTOON]: [0.35, 0.30, 0.28],
  [BoatCellType.BRIDGE]: [0.50, 0.38, 0.22],
  [BoatCellType.HELM]: [0.55, 0.45, 0.30],
  [BoatCellType.LARGE_SAIL]: [0.85, 0.82, 0.75],
  [BoatCellType.BED]: [0.50, 0.35, 0.25],
};

interface CellInfo {
  type: number;
  rotation: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

// Direction offsets: 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X), 4=up(+Y), 5=down(-Y)
const DIR_OFFSETS: [number, number, number][] = [
  [0, 0, -1], // 0: front (-Z)
  [1, 0, 0],  // 1: right (+X)
  [0, 0, 1],  // 2: back (+Z)
  [-1, 0, 0], // 3: left (-X)
  [0, 1, 0],  // 4: up (+Y)
  [0, -1, 0], // 5: down (-Y)
];

// 2D polygon shape for a cell: vertices in clockwise order (viewed from top)
// plus edge info for neighbor culling (dir=-1 means always render)
interface Shape2D {
  polygon: [number, number][]; // [x, z] world coords, clockwise
  edges: { dir: number; p0: number; p1: number }[];
}

