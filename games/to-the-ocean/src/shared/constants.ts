// ============================================================================
// Game Constants & Tuning Values
// ============================================================================

import { BiomeType, GameMode, IslandSize, PortSize, SecurityLevel } from "./types";

// --- Simulation ---

export const SIM_TICK_RATE = 60;           // Hz
export const SIM_TICK_DT = 1 / SIM_TICK_RATE;
export const PHYSICS_SUBSTEPS = 3;
export const MAX_ENTITIES = 8192;
export const MAX_PLAYERS = 8;
export const CHUNK_SIZE = 256;             // meters
export const RENDER_DISTANCE = 2048;       // meters
export const CHUNKS_VISIBLE = Math.ceil(RENDER_DISTANCE / CHUNK_SIZE) + 2; // +2 chunk margin beyond render distance

// --- SharedArrayBuffer Sizes ---

export const SIM_HEADER_SIZE = 256;
export const SIM_ENTITY_SLOT_SIZE = 128;
export const SIM_PLAYER_SLOT_SIZE = 256;

export const SIM_BUFFER_SIZE = SIM_HEADER_SIZE + MAX_ENTITIES * SIM_ENTITY_SLOT_SIZE + MAX_PLAYERS * SIM_PLAYER_SLOT_SIZE;

export const INPUT_HEADER_SIZE = 64;
export const INPUT_SLOT_SIZE = 128;
export const INPUT_BUFFER_SIZE = INPUT_HEADER_SIZE + MAX_PLAYERS * INPUT_SLOT_SIZE;

export const WATER_GRID_SIZE = 256;
export const WATER_HEADER_SIZE = 64;
export const WATER_HEIGHT_BYTES = WATER_GRID_SIZE * WATER_GRID_SIZE * 4;   // f32
export const WATER_NORMAL_BYTES = WATER_GRID_SIZE * WATER_GRID_SIZE * 12; // f32x3
export const WATER_FLOW_BYTES = WATER_GRID_SIZE * WATER_GRID_SIZE * 8;    // f32x2
export const WATER_BUFFER_SIZE = WATER_HEADER_SIZE + WATER_HEIGHT_BYTES + WATER_NORMAL_BYTES + WATER_FLOW_BYTES;

// --- Player ---

export const PLAYER_MAX_HEALTH = 100000;
export const PLAYER_MAX_HUNGER = 100;
export const PLAYER_MAX_THIRST = 100;
export const PLAYER_MAX_OXYGEN = 100;
export const PLAYER_MAX_TEMPERATURE = 100;
export const PLAYER_OXYGEN_DRAIN_RATE = 5;    // per second underwater
export const PLAYER_OXYGEN_RECOVER_RATE = 20; // per second above water
export const PLAYER_HUNGER_RATE = 0.8;        // per second
export const PLAYER_THIRST_RATE = 1.0;        // per second
export const PLAYER_TEMP_COLD_RATE = 2.0;     // per second in cold biome
export const PLAYER_TEMP_HOT_RATE = 2.0;      // per second in hot biome
export const PLAYER_FALL_DAMAGE_THRESHOLD = 8; // meters
export const PLAYER_FALL_DAMAGE_MULTIPLIER = 5;
export const PLAYER_SWIM_SPEED = 4;           // m/s
export const PLAYER_WALK_SPEED = 5;           // m/s
export const PLAYER_RUN_SPEED = 8;            // m/s
export const PLAYER_FLOAT_FORCE = 12;         // m/s² upward when holding space in water
export const PLAYER_DIVE_FORCE = 10;          // m/s² downward when holding shift in water
export const PLAYER_WATER_SINK_RATE = 2;      // m/s² gentle sink when no vertical input in water
export const PLAYER_WATER_DRAG = 0.88;        // velocity multiplier per tick in water
export const PLAYER_SWIM_VERTICAL_MAX = 6;    // max vertical speed in water (m/s)
export const PLAYER_GRAVITY = 9.8;            // m/s²
export const PLAYER_JUMP_FORCE = 6;           // m/s upward velocity when jumping
export const PLAYER_HEIGHT = 1.8;             // meters — full body height (also entity.scale for players)
export const PLAYER_RADIUS = 0.4;             // meters — collision capsule radius
export const PLAYER_EYE_HEIGHT = PLAYER_HEIGHT * 0.9; // eye height above feet (~1.62m)

// --- Inventory ---

export const PLAYER_INV_WIDTH = 20;
export const PLAYER_INV_HEIGHT = 15;
export const BOAT_HOLD_INV_WIDTH = 16;
export const BOAT_HOLD_INV_HEIGHT = 10;
export const HOTBAR_SLOTS = 10;

// --- Boat Cell Types ---

export const BoatCellType = {
  HULL: 0,
  BOW: 1,
  CABIN: 2,
  MAST: 3,
  DECK: 4,
  RAIL: 5,
  WALL_STRAIGHT: 6,   // Thin straight wall — rotation 0/2 runs along Z, 1/3 along X
  HULL_CURVE_L: 7,   // Left-curving hull segment (port side narrowing)
  HULL_CURVE_R: 8,   // Right-curving hull segment (starboard side narrowing)
  BOW_MODERN: 9,      // Modern raked bow with curved profile
  STERN: 10,          // Stern / transom section (wide, flat back)
  PONTOON: 11,        // Cylindrical pontoon for catamaran hulls
  BRIDGE: 12,         // Catamaran bridge deck connecting pontoons
  HELM: 13,           // Enclosed helm / wheelhouse structure
  WALL_CORNER: 14,    // L-shaped corner wall (two walls merged)
  WALL_CURVED: 15,    // Quarter-circle curved wall segment
  WALL_DIAGONAL: 16,  // Diagonal wall cutting across cell corner-to-corner
  LARGE_SAIL: 17,     // Large sail spanning multiple vertical layers (1x3x1)
  BED: 18,            // Bed occupying 2 cells in depth (1x1x2)
  LANTERN: 19,         // Lantern — emits point light, decoration category
} as const;

export const BOAT_CELL_NAMES: Record<number, string> = {
  [BoatCellType.HULL]: "Hull",
  [BoatCellType.BOW]: "Bow",
  [BoatCellType.CABIN]: "Cabin",
  [BoatCellType.MAST]: "Mast",
  [BoatCellType.DECK]: "Deck",
  [BoatCellType.RAIL]: "Rail",
  [BoatCellType.WALL_STRAIGHT]: "Wall",
  [BoatCellType.WALL_CORNER]: "Corner Wall",
  [BoatCellType.WALL_CURVED]: "Curved Wall",
  [BoatCellType.WALL_DIAGONAL]: "Diag Wall",
  [BoatCellType.HULL_CURVE_L]: "Curve L",
  [BoatCellType.HULL_CURVE_R]: "Curve R",
  [BoatCellType.BOW_MODERN]: "Mod Bow",
  [BoatCellType.STERN]: "Stern",
  [BoatCellType.PONTOON]: "Pontoon",
  [BoatCellType.BRIDGE]: "Bridge",
  [BoatCellType.HELM]: "Helm",
  [BoatCellType.LARGE_SAIL]: "Sail",
  [BoatCellType.BED]: "Bed",
  [BoatCellType.LANTERN]: "Lantern",
};

// --- Boat Cell Categories ---
// Foundational: pontoons, walls, floors, ceilings, roofs — full weight, drag, buoyancy,
//   stability, and collision (hitboxes that block movement).
// Functional: crafting benches, pilot wheels, rudders, masts, anchors, motors —
//   weight only; drag, buoyancy, and stability are optional.
// Decoration: potted plants, rugs, baubles — weight only; drag, buoyancy, and
//   stability are optional. No collision.

export enum CellCategory {
  Foundational = 0,
  Functional = 1,
  Decoration = 2,
}

export const CELL_CATEGORY: Record<number, CellCategory> = {
  [BoatCellType.HULL]: CellCategory.Foundational,
  [BoatCellType.BOW]: CellCategory.Foundational,
  [BoatCellType.CABIN]: CellCategory.Foundational,
  [BoatCellType.DECK]: CellCategory.Foundational,
  [BoatCellType.WALL_STRAIGHT]: CellCategory.Foundational,
  [BoatCellType.WALL_CORNER]: CellCategory.Foundational,
  [BoatCellType.WALL_CURVED]: CellCategory.Foundational,
  [BoatCellType.WALL_DIAGONAL]: CellCategory.Foundational,
  [BoatCellType.HULL_CURVE_L]: CellCategory.Foundational,
  [BoatCellType.HULL_CURVE_R]: CellCategory.Foundational,
  [BoatCellType.BOW_MODERN]: CellCategory.Foundational,
  [BoatCellType.STERN]: CellCategory.Foundational,
  [BoatCellType.PONTOON]: CellCategory.Foundational,
  [BoatCellType.BRIDGE]: CellCategory.Foundational,
  [BoatCellType.MAST]: CellCategory.Functional,
  [BoatCellType.RAIL]: CellCategory.Functional,
  [BoatCellType.HELM]: CellCategory.Functional,
  [BoatCellType.LARGE_SAIL]: CellCategory.Functional,
  [BoatCellType.BED]: CellCategory.Functional,
  [BoatCellType.LANTERN]: CellCategory.Decoration,
};

export function isFoundationalCell(cellType: number): boolean {
  return CELL_CATEGORY[cellType] === CellCategory.Foundational;
}

export function isFunctionalCell(cellType: number): boolean {
  return CELL_CATEGORY[cellType] === CellCategory.Functional;
}

export function isDecorationCell(cellType: number): boolean {
  return CELL_CATEGORY[cellType] === CellCategory.Decoration;
}

// Whether a cell type should have a solid collision hitbox that blocks movement.
// All foundational cells get full collision. Some functional cells (mast, helm)
// are also solid because they are physical objects you cannot walk through.
export function hasSolidCollision(cellType: number): boolean {
  const cat = CELL_CATEGORY[cellType];
  if (cat === CellCategory.Foundational) return true;
  if (cat === CellCategory.Functional) {
    return cellType === BoatCellType.MAST || cellType === BoatCellType.HELM || cellType === BoatCellType.BED;
  }
  return false;
}

// Whether a cell type is part of the watertight hull shell and should generate
// buoyancy forces. Only the outer hull shell (hull, bow, stern, pontoons, curves)
// displaces water. Internal foundational cells (bridge, deck, wall, cabin) are
// above the waterline and do not contribute to buoyancy.
export function isHullShellCell(cellType: number): boolean {
  return cellType === BoatCellType.HULL ||
    cellType === BoatCellType.BOW ||
    cellType === BoatCellType.HULL_CURVE_L ||
    cellType === BoatCellType.HULL_CURVE_R ||
    cellType === BoatCellType.BOW_MODERN ||
    cellType === BoatCellType.STERN ||
    cellType === BoatCellType.PONTOON;
}

// Whether a cell type is a walkable surface (floor) that the player stands ON TOP of.
// These cells provide floor detection but do NOT block horizontal movement —
// the player can walk freely across them without being pushed away.
// BRIDGE and DECK are walkable surfaces; the player stands on top at cellMaxY.
export function isWalkableSurface(cellType: number): boolean {
  return cellType === BoatCellType.BRIDGE || cellType === BoatCellType.DECK;
}

// ============================================================================
// CELL GEOMETRY — SINGLE SOURCE OF TRUTH
// ============================================================================
// Every cell type's 3D shape is defined HERE and ONLY HERE.
// Both the renderer (visual mesh) and all collision systems (cell collision,
// Rapier physics, raycast) derive from this record.
//
// y0: bottom of cell, relative to layer base (gridY * BOAT_LAYER_HEIGHT)
// y1: top of cell, relative to layer base
// sizeX/sizeY/sizeZ: grid units spanned from origin (min corner)
//
// To add a new cell type, add an entry here. Everything else updates automatically.
// ============================================================================

export interface CellGeometry {
  y0: number;     // bottom relative to layer base (can be negative for cells that extend below)
  y1: number;     // top relative to layer base
  sizeX: number;  // grid cells in X (width)
  sizeY: number;  // grid cells in Y (height/layers)
  sizeZ: number;  // grid cells in Z (depth/length)
}

export const CELL_GEOMETRY: Record<number, CellGeometry> = {
  [BoatCellType.HULL]:          { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.BOW]:           { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.BOW_MODERN]:    { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.HULL_CURVE_L]:  { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.HULL_CURVE_R]:  { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.STERN]:         { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.PONTOON]:       { y0: -0.3, y1: 0.5, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.WALL_STRAIGHT]: { y0: -0.1, y1: 0.6, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.WALL_CORNER]:   { y0: -0.1, y1: 0.6, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.WALL_CURVED]:   { y0: -0.1, y1: 0.6, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.WALL_DIAGONAL]: { y0: -0.1, y1: 0.6, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.CABIN]:         { y0:  0.1, y1: 0.35, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.MAST]:          { y0: -0.1, y1: 2.0, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.HELM]:          { y0: -0.1, y1: 0.4, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.RAIL]:          { y0: -0.1, y1: 0.35, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.DECK]:          { y0: -0.1, y1: 0.0, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.BRIDGE]:        { y0: -0.1, y1: 0.0, sizeX: 1, sizeY: 1, sizeZ: 1 },
  [BoatCellType.LARGE_SAIL]:    { y0: -0.1, y1: 2.9, sizeX: 1, sizeY: 3, sizeZ: 1 },
  [BoatCellType.BED]:           { y0: -0.1, y1: 0.3, sizeX: 1, sizeY: 1, sizeZ: 2 },
  [BoatCellType.LANTERN]:       { y0: 0.0, y1: 0.5, sizeX: 1, sizeY: 1, sizeZ: 1 },
};

// Default geometry for cell types not in the record.
const DEFAULT_CELL_GEOMETRY: CellGeometry = { y0: -0.3, y1: 0.9, sizeX: 1, sizeY: 1, sizeZ: 1 };

export function getCellGeometry(cellType: number): CellGeometry {
  return CELL_GEOMETRY[cellType] ?? DEFAULT_CELL_GEOMETRY;
}

// --- Wall helpers ---

// Wall thickness as a fraction of cell size. Walls are thin compared to full cells.
// Collision top Y: derived from CELL_GEOMETRY (single source of truth).
// This is the world-space Y of the top surface of a cell.
export function getCellCollisionTopY(cellType: number, gridY: number): number {
  const geo = getCellGeometry(cellType);
  return gridY * BOAT_LAYER_HEIGHT + geo.y1;
}

// Collision bottom Y: derived from CELL_GEOMETRY (single source of truth).
export function getCellCollisionBottomY(cellType: number, gridY: number): number {
  const geo = getCellGeometry(cellType);
  return gridY * BOAT_LAYER_HEIGHT + geo.y0;
}

export const WALL_THICKNESS = 0.3; // world units (cell is BOAT_CELL_WORLD_SIZE = 2.0)

// Whether a cell type is any wall variant.
export function isWallType(cellType: number): boolean {
  return cellType === BoatCellType.WALL_STRAIGHT ||
    cellType === BoatCellType.WALL_CORNER ||
    cellType === BoatCellType.WALL_CURVED ||
    cellType === BoatCellType.WALL_DIAGONAL;
}

// Collision box relative to cell center: offset + half-extents
export interface CollisionBox {
  offsetX: number;
  offsetZ: number;
  halfX: number;
  halfZ: number;
}

// Returns collision boxes for a cell. Non-wall cells get a single full-cell box.
// Wall cells get edge-offset boxes matching their visual shape.
export function getWallCollisionBoxes(
  cellType: number,
  rotation: number,
): CollisionBox[] {
  const s = BOAT_CELL_WORLD_SIZE / 2;
  if (!isWallType(cellType)) return [{ offsetX: 0, offsetZ: 0, halfX: s, halfZ: s }];

  const wt = WALL_THICKNESS / 2;
  const rot = rotation % 4;

  if (cellType === BoatCellType.WALL_STRAIGHT) {
    // Wall at one edge of the cell, spanning the full opposite axis
    // rot 0=front(-Z), 1=right(+X), 2=back(+Z), 3=left(-X)
    if (rot === 0) return [{ offsetX: 0, offsetZ: -s + wt, halfX: s, halfZ: wt }];
    if (rot === 1) return [{ offsetX: s - wt, offsetZ: 0, halfX: wt, halfZ: s }];
    if (rot === 2) return [{ offsetX: 0, offsetZ: s - wt, halfX: s, halfZ: wt }];
    return [{ offsetX: -s + wt, offsetZ: 0, halfX: wt, halfZ: s }];
  }

  if (cellType === BoatCellType.WALL_CORNER) {
    // L-shape at a corner: two edge arms
    // rot 0=front-left, 1=front-right, 2=back-right, 3=back-left
    const front = { offsetX: 0, offsetZ: -s + wt, halfX: s, halfZ: wt };
    const back = { offsetX: 0, offsetZ: s - wt, halfX: s, halfZ: wt };
    const right = { offsetX: s - wt, offsetZ: 0, halfX: wt, halfZ: s };
    const left = { offsetX: -s + wt, offsetZ: 0, halfX: wt, halfZ: s };
    if (rot === 0) return [front, left];
    if (rot === 1) return [front, right];
    if (rot === 2) return [back, right];
    return [back, left];
  }

  if (cellType === BoatCellType.WALL_CURVED) {
    // Quarter-circle at a corner — approximate with quarter-cell box
    // rot 0=front-left, 1=front-right, 2=back-right, 3=back-left
    const q = s / 2;
    if (rot === 0) return [{ offsetX: -q, offsetZ: -q, halfX: q, halfZ: q }];
    if (rot === 1) return [{ offsetX: q, offsetZ: -q, halfX: q, halfZ: q }];
    if (rot === 2) return [{ offsetX: q, offsetZ: q, halfX: q, halfZ: q }];
    return [{ offsetX: -q, offsetZ: q, halfX: q, halfZ: q }];
  }

  // WALL_DIAGONAL: spans corner-to-corner, use full cell
  return [{ offsetX: 0, offsetZ: 0, halfX: s, halfZ: s }];
}

// --- Multi-cell placement templates ---

export interface CellTemplateEntry {
  dx: number; // offset from placement origin
  dy: number;
  dz: number;
  type: number;
  rotation: number;
}

// Rotate a template by 90-degree steps (0-3). Rotates offsets (dx,dz) and
// adds the rotation to each cell's own rotation value.
export function rotateTemplate(template: CellTemplateEntry[], steps: number): CellTemplateEntry[] {
  const s = ((steps % 4) + 4) % 4;
  if (s === 0) return template;
  const cosA = [1, 0, -1, 0][s];
  const sinA = [0, 1, 0, -1][s];
  const result: CellTemplateEntry[] = [];
  for (let i = 0; i < template.length; i++) {
    const e = template[i];
    result.push({
      dx: e.dx * cosA - e.dz * sinA,
      dy: e.dy,
      dz: e.dx * sinA + e.dz * cosA,
      type: e.type,
      rotation: (e.rotation + s) % 4,
    });
  }
  return result;
}

export const BOAT_TEMPLATES: Record<string, CellTemplateEntry[]> = {
  // Modern monohull bow section: pointed bow + curved hull shoulders
  monohull_bow: [
    { dx: 0, dy: 0, dz: 0, type: BoatCellType.BOW_MODERN, rotation: 0 },
    { dx: -1, dy: 0, dz: 1, type: BoatCellType.HULL_CURVE_L, rotation: 0 },
    { dx: 0, dy: 0, dz: 1, type: BoatCellType.HULL, rotation: 0 },
    { dx: 1, dy: 0, dz: 1, type: BoatCellType.HULL_CURVE_R, rotation: 0 },
    { dx: -1, dy: 0, dz: 2, type: BoatCellType.HULL, rotation: 0 },
    { dx: 0, dy: 0, dz: 2, type: BoatCellType.HULL, rotation: 0 },
    { dx: 1, dy: 0, dz: 2, type: BoatCellType.HULL, rotation: 0 },
  ],
  // Catamaran twin hull + bridge: two 3-cell pontoons connected by bridge deck
  catamaran_hull: [
    { dx: -3, dy: 0, dz: 0, type: BoatCellType.PONTOON, rotation: 0 },
    { dx: -3, dy: 0, dz: 1, type: BoatCellType.PONTOON, rotation: 0 },
    { dx: -3, dy: 0, dz: 2, type: BoatCellType.PONTOON, rotation: 0 },
    { dx: 3, dy: 0, dz: 0, type: BoatCellType.PONTOON, rotation: 0 },
    { dx: 3, dy: 0, dz: 1, type: BoatCellType.PONTOON, rotation: 0 },
    { dx: 3, dy: 0, dz: 2, type: BoatCellType.PONTOON, rotation: 0 },
    { dx: -3, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
    { dx: -2, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
    { dx: -1, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
    { dx: 0, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
    { dx: 1, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
    { dx: 2, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
    { dx: 3, dy: 1, dz: 1, type: BoatCellType.BRIDGE, rotation: 0 },
  ],
  // Stern section: 3-wide transom
  stern_section: [
    { dx: -1, dy: 0, dz: 0, type: BoatCellType.STERN, rotation: 0 },
    { dx: 0, dy: 0, dz: 0, type: BoatCellType.STERN, rotation: 0 },
    { dx: 1, dy: 0, dz: 0, type: BoatCellType.STERN, rotation: 0 },
  ],
};

// Hotbar tool slots — Builder (with right-click cell selection), Delete, Rotate, Gun, Shovel
export const HOTBAR_TOOLS: { name: string; cellType?: number; action: string; template?: CellTemplateEntry[] }[] = [
  { name: "Builder", action: "build" },
  { name: "Delete", cellType: 0, action: "delete" },
  { name: "Rotate", cellType: 0, action: "rotate" },
  { name: "Gun", action: "gun" },
  { name: "Shovel", action: "shovel" },
];

// Cell options available in the Builder right-click wheel menu
export const BUILDER_CELL_OPTIONS: { name: string; cellType?: number; template?: CellTemplateEntry[] }[] = [
  { name: "Hull", cellType: BoatCellType.HULL },
  { name: "Bow", cellType: BoatCellType.BOW },
  { name: "Mod Bow", cellType: BoatCellType.BOW_MODERN },
  { name: "Curve L", cellType: BoatCellType.HULL_CURVE_L },
  { name: "Curve R", cellType: BoatCellType.HULL_CURVE_R },
  { name: "Stern", cellType: BoatCellType.STERN },
  { name: "Wall", cellType: BoatCellType.WALL_STRAIGHT },
  { name: "Corner Wall", cellType: BoatCellType.WALL_CORNER },
  { name: "Curved Wall", cellType: BoatCellType.WALL_CURVED },
  { name: "Diag Wall", cellType: BoatCellType.WALL_DIAGONAL },
  { name: "Cabin", cellType: BoatCellType.CABIN },
  { name: "Helm", cellType: BoatCellType.HELM },
  { name: "Mast", cellType: BoatCellType.MAST },
  { name: "Deck", cellType: BoatCellType.DECK },
  { name: "Rail", cellType: BoatCellType.RAIL },
  { name: "Pontoon", cellType: BoatCellType.PONTOON },
  { name: "Bridge", cellType: BoatCellType.BRIDGE },
  { name: "Sail", cellType: BoatCellType.LARGE_SAIL },
  { name: "Bed", cellType: BoatCellType.BED },
  { name: "Lantern", cellType: BoatCellType.LANTERN },
  { name: "Mono Bow", template: BOAT_TEMPLATES.monohull_bow },
  { name: "Cat Hull", template: BOAT_TEMPLATES.catamaran_hull },
  { name: "Stern Set", template: BOAT_TEMPLATES.stern_section },
];

export const BOAT_GRID_MAX = 16; // max grid radius in cells from center
export const BOAT_CELL_WORLD_SIZE = 2; // world units per grid cell
export const BOAT_LAYER_HEIGHT = 1.0; // world units per vertical layer
export const BOAT_GRID_MAX_HEIGHT = 8; // max build height in layers above deck

// Get effective cell size accounting for rotation (swaps X/Z for 90°/270° rotations).
// Derived from CELL_GEOMETRY (single source of truth).
export function getCellSize(cellType: number, rotation: number): { sizeX: number; sizeY: number; sizeZ: number } {
  const geo = getCellGeometry(cellType);
  const rot = rotation % 4;
  if (rot === 1 || rot === 3) {
    return { sizeX: geo.sizeZ, sizeY: geo.sizeY, sizeZ: geo.sizeX };
  }
  return { sizeX: geo.sizeX, sizeY: geo.sizeY, sizeZ: geo.sizeZ };
}

// --- Ship ---

export const SHIP_BASE_SPEED = 5;             // m/s
export const SHIP_MAX_SPEED = 15;
export const SHIP_BASE_INTEGRITY = 100;
export const SHIP_LEAK_THRESHOLD = 30;        // integrity below this = leaking
export const SHIP_ACCEL_RATE = 2.0;           // throttle change per second
export const SHIP_TURN_RATE = 0.8;            // radians per second at full steering
export const SHIP_TURN_SPEED_FACTOR = 0.3;    // how much speed affects turning
export const SHIP_BOARDING_RANGE = 8;         // meters to board a ship
export const SHIP_DISEMBARK_OFFSET = 3;       // meters to place player beside ship
export const SHIP_REPAIR_RATE = 5;            // health per second when repairing
export const SHIP_REPAIR_COST_PER_HP = 2;     // material cost per HP repaired
export const SHIP_DRAG = 0.5;                 // water drag coefficient
export const SHIP_ANGULAR_DRAG = 0.8;         // angular velocity drag

// --- Ship collision physics ---
export const SHIP_MASS_PER_CELL = 800;        // kg per cell (matches BuoyancySystem)
export const SHIP_COLLISION_RESTITUTION = 0.15; // bounciness (0=plastic, 1=elastic)
export const SHIP_COLLISION_FRICTION = 0.3;
export const SHIP_COLLISION_SLOP = 0.02;      // penetration allowance before correction (m)
export const SHIP_COLLISION_CORRECTION_PCT = 0.8; // positional correction factor
export const SHIP_YAW_DAMPING = 3.0;          // angular velocity.y damping per second
export const SHIP_YAW_MAX = Math.PI * 1.5;    // max yaw rate (rad/s) from collisions
export const SHIP_PITCH_ROLL_COLLISION_MAX = 0.15; // max pitch/roll impulse from collision (rad/s)
export const SHIP_COLLISION_MAX_SUBSTEPS = 3; // max swept collision substeps per tick

// Entity mass by type (kg). Used for collision impulse resolution.
// Islands = Infinity (immovable). Ports = very large (effectively immovable).
// Wildlife mass scales with scale³ × density factor.
export const ENTITY_MASS: Record<number, number> = {
  [1]: 0,    // Ship — computed from cells at runtime
  [2]: 300,  // SmallCraft — light
  [15]: 2000, // PirateShip — medium-heavy
  [16]: Infinity, // Island — immovable
  [17]: 100000, // Port — effectively immovable
  [18]: Infinity, // Reef — immovable
  [19]: 500, // Wreck — moderate
};

// Wildlife density factors (kg/m³) — mass = scale³ × density × 100
export const WILDLIFE_DENSITY: Record<number, number> = {
  [3]: 50,   // Fish — very light
  [4]: 200,  // Shark
  [5]: 100,  // Eel
  [6]: 30,   // Jellyfish — nearly massless
  [7]: 300,  // DevilShrimp
  [8]: 800,  // Whale — very heavy (scale 8 → ~409600 kg)
  [9]: 200,  // Dolphin
  [10]: 150, // Turtle
  [11]: 80,  // Crustacean
  [12]: 50,  // Coral (static)
  [13]: 300, // Moose
};

// Ship entity data slot indices (data[0..9])
export const SHIP_DATA = {
  THROTTLE: 0,       // -1 (reverse) to 1 (full ahead)
  STEERING: 1,       // -1 (port) to 1 (starboard)
  SPEED: 2,          // current forward speed (m/s)
  HEADING: 3,        // current heading (radians)
  HULL_INTEGRITY_PCT: 4, // 0-1
  REPAIRING: 5,      // 0 or 1
  PITCH: 6,          // current pitch angle (radians, X-axis)
  ROLL: 7,           // current roll angle (radians, Z-axis)
  ANCHOR_X: 8,       // world X of anchor (NaN = no anchor deployed)
  ANCHOR_Z: 9,       // world Z of anchor (NaN = no anchor deployed)
} as const;

export const SHIP_DATA_SLOTS = 10; // number of Float32Array slots for ship data

// --- Anchor physics ---
export const ANCHOR_ROPE_LENGTH = 15;     // max rope length (meters)
export const ANCHOR_STIFFNESS = 25.0;     // spring force coefficient
export const ANCHOR_DAMPING = 5.0;        // velocity damping when at rope limit
export const ANCHOR_DEPTH = -6;           // anchor rests 6m below water surface
export const ANCHOR_BOW_OFFSET = 2.5;     // rope attaches this far forward of ship center
export const ANCHOR_DRAG = 1.5;           // drag applied to anchored ship within rope radius

// --- Fishing ---

export const FISHING_CAST_RANGE = 30;
export const FISHING_MINIGAME_DURATION = 30;  // seconds max
export const FISHING_TENSION_MAX = 100;
export const FISHING_TENSION_BREAK = 0;       // below this = line breaks
export const FISHING_TENSION_SLIP = 100;      // above this = fish escapes
export const FISHING_PERFECT_ZONE = 0.15;     // fraction of bar centered on 50 that's "perfect" (±7.5)
export const FISHING_REEL_POWER = 35;          // tension decrease per second when reeling
export const FISHING_FISH_PULL_MULT = 15;      // multiplier for fish pull force
export const FISHING_GOOD_ZONE_MIN = 30;       // tension above this = progress zone start
export const FISHING_GOOD_ZONE_MAX = 70;       // tension below this = progress zone end
export const FISHING_PROGRESS_RATE = 0.25;     // progress per second in good zone
export const FISHING_PERFECT_PROGRESS_RATE = 0.4; // progress per second in perfect zone
export const FISHING_PROGRESS_DECAY = 0.05;    // progress lost per second outside good zone
export const FISHING_REEL_DIR_MIN_TIME = 2;    // min seconds before reel direction changes
export const FISHING_REEL_DIR_MAX_TIME = 4;    // max seconds before reel direction changes

// --- Economy ---

export const PRICE_RECOVERY_HOURS = 3;        // game hours for price to recover
export const PRICE_RECOVERY_PER_TICK = 1 / (PRICE_RECOVERY_HOURS * 3600 * SIM_TICK_RATE);
export const PRICE_IMPACT_THRESHOLD = 0.001;  // fraction of market supply to move price 1%
export const PRICE_MAX_MODIFIER = 2.0;        // price can go up to 2x or down to 0.5x
export const PRICE_MIN_MODIFIER = 0.5;
export const BARGE_INVENTORY_MULTIPLIER = 10; // barge has 10x the inventory of normal ship

// --- Weather ---

export const WEATHER_CLEAR_CHANCE = 0.80;
export const WEATHER_FULL_CLEAR = 0.30;
export const WEATHER_PARTLY_CLOUDY = 0.40;
export const WEATHER_OVERCAST = 0.30;
export const WEATHER_MAX_DURATION = 300;      // seconds
export const WEATHER_MIN_DURATION = 60;
export const WEATHER_RARE_EVENT_CHANCE = 0.02; // per weather change
export const RAIN_COLLECTOR_CAPACITY = 50;
export const RAIN_COLLECTOR_FILL_RATE = 5;   // per second of rain

// --- Wildlife ---

export const WILDLIFE_SPAWN_RADIUS = 200;      // meters around player
export const WILDLIFE_MAX_PER_BIOME = 50;
export const WILDLIFE_DESPAWN_RADIUS = 400;
export const SHARK_ATTACK_DAMAGE = 30;
export const SHARK_DETECT_BOAT_SPEED = 10; // m/s — shark detects players on boats moving faster than this
export const EEL_SHOCK_DAMAGE = 20;
export const JELLYFISH_DOT_DAMAGE = 5;        // per second
export const DEVIL_SHRIP_ATTACK_DAMAGE = 50;

// --- Pirates ---

export const PIRATE_SPAWN_BASE_RATE = 0.001;  // per second per chunk
export const PIRATE_SPAWN_SAFE_MULT = 0.1;
export const PIRATE_SPAWN_EXTREME_MULT = 5.0;
export const PIRATE_TREASURE_MAP_CHANCE = 0.15;

// --- Island Entity Data (data[0..5]) ---

export const ISLAND_DATA = {
  RADIUS: 0,           // island radius in world units
  BIOME: 1,            // BiomeType enum value
  SIZE: 2,             // IslandSize enum value
  HAS_COVES: 3,        // 1 = has coves
  HAS_CAVES: 4,        // 1 = has caves
  RESOURCE_COUNT: 5,   // number of resource nodes
} as const;

// --- World ---

export const WORLD_SEED_DEFAULT = 12345;
export const WORLD_OCEAN_LEVEL = 0;           // y=0 is sea level
export const WORLD_MAX_DEPTH = 500;
export const PORT_SPACING = 2000;             // min meters between ports
export const ISLAND_SPACING = 1600;           // min meters between islands (2x for volumetric terrain)

// --- Port System ---

export const PORT_INTERACTION_RANGE = 80;     // meters for ship to "dock" at port
export const PORT_DETECTION_RANGE = 200;      // meters for port to appear on HUD/map
export const PORT_MOORING_SLOWDOWN = 0.3;     // velocity multiplier when moored
export const PORT_REPAIR_RATE = 3;            // hull HP per second when moored
export const PORT_RESTOCK_RATE = 2;           // supplies per second when moored

// Port entity data slot indices (data[0..5])
export const PORT_DATA = {
  SIZE: 0,           // PortSize enum value (0=small, 1=medium, 2=large)
  SERVICES: 1,       // bitmask of PortService flags
  SECURITY: 2,       // SecurityLevel enum value
  MOORED_SHIP_ID: 3, // entity ID of moored ship (0 = none)
  DOCK_PROGRESS: 4,  // 0-1 docking progress
  BIOME: 5,          // BiomeType enum value
} as const;

// PortService bitmask values for entity data
export const PORT_SERVICE_BITS = {
  Trading: 1 << 0,
  Shipyard: 1 << 1,
  HullModification: 1 << 2,
  Fishing: 1 << 3,
  Supplies: 1 << 4,
  Inn: 1 << 5,
  Licenses: 1 << 6,
  Storage: 1 << 7,
} as const;

// Visual scale per port size (for entity renderer)
export const PORT_SCALE = {
  Small: 15,
  Medium: 25,
  Large: 40,
} as const;

// Raw port mesh dimensions (matches PortMeshGenerator.getDimensions)
// Used for collision shape computation in Rapier and PortSystem
export const PORT_DIMENSIONS = {
  [PortSize.Small]: {
    dockWidth: 18, dockDepth: 12, dockHeight: 1.5,
    pierWidth: 7, pierLength: 10, pierHeight: 1.0,
  },
  [PortSize.Medium]: {
    dockWidth: 32, dockDepth: 20, dockHeight: 2.0,
    pierWidth: 12, pierLength: 16, pierHeight: 1.5,
  },
  [PortSize.Large]: {
    dockWidth: 50, dockDepth: 30, dockHeight: 2.5,
    pierWidth: 18, pierLength: 24, pierHeight: 2.0,
  },
} as const;

// Max extent of port mesh before normalization (used to compute world-space dimensions)
// The renderer normalizes mesh vertices by dividing by this value, then scales by entity.scale
// Computed from: max(halfDockWidth, halfDockDepth + pierLength, lighthouse/breakwater Z extent)
export const PORT_MAX_EXTENT = {
  [PortSize.Small]: 16,
  [PortSize.Medium]: 26,
  [PortSize.Large]: 45,
} as const;

// Compute world-space port collider dimensions given port size and entity scale
export function getPortColliderDims(size: number, scale: number) {
  const dims = (PORT_DIMENSIONS as Record<number, { dockWidth: number; dockDepth: number; dockHeight: number; pierWidth: number; pierLength: number; pierHeight: number }>)[size];
  const maxExtent = (PORT_MAX_EXTENT as Record<number, number>)[size] ?? 16;
  if (!dims) return null;
  const norm = 1 / maxExtent;
  const s = norm * scale;
  return {
    dock: {
      halfW: (dims.dockWidth / 2) * s,
      halfD: (dims.dockDepth / 2) * s,
      halfH: (dims.dockHeight / 2) * s,
      centerY: (dims.dockHeight / 2) * s,
    },
    pier: {
      halfW: (dims.pierWidth / 2) * s,
      halfL: (dims.pierLength / 2) * s,
      halfH: (dims.pierHeight / 2) * s,
      centerY: (dims.pierHeight / 2) * s,
      centerZ: (-(dims.dockDepth / 2) - (dims.pierLength / 2)) * s,
    },
  };
}

// Port structure layout (matches PortMeshGenerator visual positions)
interface PortStructureExtras {
  buildingCount: number;
  craneCount: number;
  hasLighthouse: boolean;
  hasBreakwater: boolean;
}

const PORT_STRUCTURE_EXTRAS: Record<number, PortStructureExtras> = {
  [PortSize.Small]: { buildingCount: 2, craneCount: 0, hasLighthouse: false, hasBreakwater: false },
  [PortSize.Medium]: { buildingCount: 3, craneCount: 1, hasLighthouse: false, hasBreakwater: false },
  [PortSize.Large]: { buildingCount: 4, craneCount: 2, hasLighthouse: true, hasBreakwater: true },
};

export interface PortColliderBox {
  cx: number; cy: number; cz: number;  // center in port-local world space
  halfW: number; halfH: number; halfD: number;  // half-extents
}

// Returns collision boxes for all port structures (buildings, cranes, lighthouse, breakwater)
// Positions match PortMeshGenerator's deterministic layout. Heights are conservative (max possible).
export function getPortCollisionBoxes(size: number, scale: number): PortColliderBox[] {
  const dims = (PORT_DIMENSIONS as Record<number, { dockWidth: number; dockDepth: number; dockHeight: number; pierWidth: number; pierLength: number; pierHeight: number }>)[size];
  const maxExtent = (PORT_MAX_EXTENT as Record<number, number>)[size] ?? 16;
  const extras = PORT_STRUCTURE_EXTRAS[size];
  if (!dims || !extras) return [];

  const norm = 1 / maxExtent;
  const s = norm * scale;

  const dw = dims.dockWidth;
  const dd = dims.dockDepth;
  const dh = dims.dockHeight;
  const halfDW = dw / 2;
  const halfDD = dd / 2;
  const pierLength = dims.pierLength;
  const pierZ = -halfDD - pierLength / 2;

  const boxes: PortColliderBox[] = [];

  // Buildings on back of dock (+z side)
  const buildingAreaDepth = dd * 0.45;
  const buildingZStart = halfDD - buildingAreaDepth;
  const buildingZCenter = (halfDD + buildingZStart) / 2;
  const slotWidth = dw / extras.buildingCount;
  const buildingHeight = 8; // conservative max (mesh uses 3 + rng()*5)
  for (let i = 0; i < extras.buildingCount; i++) {
    const bx = -halfDW + slotWidth * (i + 0.5);
    const bw = slotWidth * 0.7;
    const bd = buildingAreaDepth * 0.75;
    boxes.push({
      cx: bx * s, cy: (dh + buildingHeight / 2) * s, cz: buildingZCenter * s,
      halfW: (bw / 2) * s, halfH: (buildingHeight / 2) * s, halfD: (bd / 2) * s,
    });
  }

  // Crane towers
  const craneTowerHeight = 15; // conservative max (mesh uses 10 + rng()*5)
  for (let i = 0; i < extras.craneCount; i++) {
    const cx = -halfDW * 0.5 + (dw * 0.5) * (i / Math.max(1, extras.craneCount - 1));
    boxes.push({
      cx: cx * s, cy: (dh + craneTowerHeight / 2) * s, cz: 0,
      halfW: 0.6 * s, halfH: (craneTowerHeight / 2) * s, halfD: 0.6 * s,
    });
  }

  // Lighthouse (large ports only)
  if (extras.hasLighthouse) {
    const lhX = 0;
    const lhZ = pierZ - pierLength / 2 - 3;
    const lhHeight = 20;
    boxes.push({
      cx: lhX * s, cy: (dims.pierHeight + lhHeight / 2) * s, cz: lhZ * s,
      halfW: 2.0 * s, halfH: (lhHeight / 2) * s, halfD: 2.0 * s,
    });
  }

  // Breakwater blocks (large ports only)
  if (extras.hasBreakwater) {
    const bwZ = pierZ - pierLength / 2 - 6;
    const bwCount = 7;
    const bwSpacing = dw / bwCount;
    const bwHeight = 3.5; // conservative max (mesh uses 2 + rng()*1.5)
    for (let i = 0; i < bwCount; i++) {
      const bx = -halfDW + bwSpacing * (i + 0.5);
      boxes.push({
        cx: bx * s, cy: (bwHeight / 2) * s, cz: bwZ * s,
        halfW: (bwSpacing * 0.35) * s, halfH: (bwHeight / 2) * s, halfD: 1.5 * s,
      });
    }
  }

  return boxes;
}

// --- Biome Properties ---

export const BIOME_TEMPERATURES: Record<BiomeType, { min: number; max: number }> = {
  [BiomeType.Lake]: { min: 15, max: 25 },
  [BiomeType.Arctic]: { min: -20, max: 5 },
  [BiomeType.Desert]: { min: 30, max: 45 },
  [BiomeType.BorealForest]: { min: -5, max: 15 },
  [BiomeType.Tropical]: { min: 25, max: 35 },
  [BiomeType.SubTropical]: { min: 20, max: 30 },
  [BiomeType.Freshwater]: { min: 10, max: 22 },
  [BiomeType.Ocean]: { min: 15, max: 25 },
  [BiomeType.DeepOcean]: { min: 5, max: 15 },
  [BiomeType.CoralReef]: { min: 22, max: 30 },
  [BiomeType.KelpForest]: { min: 10, max: 18 },
  [BiomeType.Volcanic]: { min: 35, max: 60 },
  [BiomeType.GarbagePatch]: { min: 15, max: 25 },
  [BiomeType.Hell]: { min: 50, max: 80 },
};

export const BIOME_NAMES: Record<BiomeType, string> = {
  [BiomeType.Lake]: "Lake",
  [BiomeType.Arctic]: "Arctic",
  [BiomeType.Desert]: "Desert",
  [BiomeType.BorealForest]: "Boreal Forest",
  [BiomeType.Tropical]: "Tropical",
  [BiomeType.SubTropical]: "Sub-Tropical",
  [BiomeType.Freshwater]: "Freshwater",
  [BiomeType.Ocean]: "Ocean",
  [BiomeType.DeepOcean]: "Deep Ocean",
  [BiomeType.CoralReef]: "Coral Reef",
  [BiomeType.KelpForest]: "Kelp Forest",
  [BiomeType.Volcanic]: "Volcanic",
  [BiomeType.GarbagePatch]: "Garbage Patch",
  [BiomeType.Hell]: "Hell",
};

export const SECURITY_COLORS: Record<SecurityLevel, string> = {
  [SecurityLevel.Safe]: "#4ade80",
  [SecurityLevel.Moderate]: "#facc15",
  [SecurityLevel.High]: "#f87171",
  [SecurityLevel.Extreme]: "#7f1d1d",
};

export const SECURITY_NAMES: Record<SecurityLevel, string> = {
  [SecurityLevel.Safe]: "Safe",
  [SecurityLevel.Moderate]: "Moderate",
  [SecurityLevel.High]: "High Danger",
  [SecurityLevel.Extreme]: "Extreme Danger",
};

// --- Port Properties ---

export const PORT_CAPABILITIES: Record<PortSize, string[]> = {
  [PortSize.Small]: ["trading", "fishing", "inn", "supplies", "licenses"],
  [PortSize.Medium]: ["trading", "fishing", "inn", "supplies", "licenses", "shipyard", "hull_modification", "storage"],
  [PortSize.Large]: ["trading", "fishing", "inn", "supplies", "licenses", "shipyard", "hull_modification", "storage"],
};

export const PORT_MAX_HULL_SIZE: Record<PortSize, number> = {
  [PortSize.Small]: 0,        // can't modify hull
  [PortSize.Medium]: 50,      // limited hull volume
  [PortSize.Large]: 200,     // full hull volume
};

// --- Island Properties ---

export const ISLAND_RESOURCES: Record<IslandSize, number> = {
  [IslandSize.Small]: 5,
  [IslandSize.Medium]: 15,
  [IslandSize.Large]: 30,
};

// --- Day/Night ---

export const DAY_DURATION_SECONDS = 1200;    // 20 minutes real = 1 game day
export const NIGHT_START_FRAC = 0.7;         // 70% through day = night
export const NIGHT_END_FRAC = 0.25;          // 25% through day = dawn

// --- Skinning ---

export const MAX_BONES = 128;

// --- Default Game Rules ---

export const DEFAULT_GAME_RULES = {
  pvp: true,
  keepInventory: false,
  hungerRate: PLAYER_HUNGER_RATE,
  thirstRate: PLAYER_THIRST_RATE,
  oxygenRate: PLAYER_OXYGEN_DRAIN_RATE,
  temperatureRate: PLAYER_TEMP_COLD_RATE,
  priceRecoveryHours: PRICE_RECOVERY_HOURS,
  pirateSpawnMultiplier: 1.0,
  weatherIntensity: 1.0,
  dayDuration: DAY_DURATION_SECONDS,
  nightSkipThreshold: 0.5,
  collisionLodDistance: 250, // meters — entity pairs farther than this from all players skip collision
  portGenerationRate: 0.015,
  islandGenerationRate: 0.00000025,
  waterUpdateInterval: 1, // sim ticks between water height updates
};

export const GAMEMODE_RULES: Record<GameMode, Partial<typeof DEFAULT_GAME_RULES>> = {
  [GameMode.Creative]: {
    pvp: false,
    hungerRate: 0,
    thirstRate: 0,
    oxygenRate: 0,
    temperatureRate: 0,
    keepInventory: true,
    pirateSpawnMultiplier: 0,
    weatherIntensity: 0.5,
  },
  [GameMode.Survival]: {},
  [GameMode.Hardcore]: {
    keepInventory: false,
    pirateSpawnMultiplier: 1.5,
    weatherIntensity: 1.2,
  },
  [GameMode.Custom]: {},
};
