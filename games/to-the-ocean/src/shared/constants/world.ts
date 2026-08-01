// World generation, port system, and island entity data constants

import { PortSize } from "../types";

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
