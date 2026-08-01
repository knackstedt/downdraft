// Boat cell types, categories, geometry, collision, and build templates

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
  BED: 18,            // Bed occupying 2 cells in depth (1x1z2)
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
