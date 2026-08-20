// ============================================================================
// Rule system type definitions.
//
// The data-driven rule system replaces hardcoded if-else chains in
// applyReactions() with a declarative rule format. Rules are compiled into
// typed-array lookup tables for hot-path performance.
//
// Each rule specifies:
//   - The material it applies to
//   - Conditions (chance, temperature, neighbor requirements)
//   - Actions (transform self, transform neighbor, etc.)
// ============================================================================

import type { Material } from "../materials";

/** Direction bitmask for neighbor requirements. */
export const DIR = {
  N: 0x01,    // (0, -1)
  S: 0x02,    // (0, +1)
  E: 0x04,    // (+1, 0)
  W: 0x08,    // (-1, 0)
  NE: 0x10,   // (+1, -1)
  NW: 0x20,   // (-1, -1)
  SE: 0x40,   // (+1, +1)
  SW: 0x80,   // (-1, +1)
  ALL_4: 0x0F,
  ALL_8: 0xFF,
  HORIZONTAL: 0x0C,
  VERTICAL: 0x03,
} as const;

/** How to match a neighbor. */
export type NeighborMatch =
  | { kind: "material"; mat: Material }
  | { kind: "material_class"; flag: number }  // MAT_FLAGS bit (e.g. MAT_FLAMMABLE)
  | { kind: "is_hot" }                        // IS_HOT[mat]
  | { kind: "is_fire" }                       // IS_FIRE[mat]
  | { kind: "not_material"; mat: Material }
  | { kind: "not_wall" };

/** A neighbor requirement: look in certain directions for a match. */
export interface NeighborRequirement {
  directions: number;  // DIR bitmask
  match: NeighborMatch;
  minCount?: number;   // default 1
}

/** Action types for reactions. */
export type ReactionAction =
  | { type: "transform_self"; mat: Material; lifetime?: number }
  | { type: "transform_neighbor"; mat: Material; lifetime?: number; match: NeighborMatch }
  | { type: "transform_first_matching_neighbor"; mat: Material; lifetime?: number; match: NeighborMatch }
  | { type: "clear_self" }
  | { type: "clear_neighbor"; match: NeighborMatch }
  | { type: "explode"; radius: number }
  | { type: "impulse"; radius: number; strength: number };

/** A single reaction rule. */
export interface ReactionRule {
  /** The material this rule applies to. */
  material: Material;
  /** Optional chance gate (0-1). If omitted, always fires when conditions met. */
  chance?: number;
  /** Minimum temperature (1.0 = normal). */
  minTemp?: number;
  /** Maximum temperature (1.0 = normal). */
  maxTemp?: number;
  /** Neighbor requirements — all must be satisfied. */
  requireNeighbors?: NeighborRequirement[];
  /** Actions to execute when the rule fires. */
  actions: ReactionAction[];
  /** Optional priority (lower = higher priority). Default 0. */
  priority?: number;
}

/** Context passed to the rule engine for each cell. */
export interface ReactionContext {
  idx: number;
  x: number;
  y: number;
  mat: number;
  lifetime: number;
  flags: number;
  temp: number;  // normalized 0-2 (1.0 = normal)
  frame: number;
}
