// ============================================================================
// Built-in reaction rules — migrated from applyReactions().
//
// These rules replace the hardcoded if-else chains in applyReactions() with
// a declarative format. The rule engine evaluates conditions and executes
// actions based on these definitions.
//
// Complex reactions from applySpecialReactions() remain as custom handlers
// in the rule engine — they use flood-fill, radius effects, and other logic
// that's not easily expressed as simple rules.
// ============================================================================

import { IS_FIRE, IS_HOT, MAT_FLAMMABLE, MAT_FLAGS, Material } from "../materials";
import { DIR, type ReactionRule } from "./rule-types";

export const builtinRules: ReactionRule[] = [
  // --- Water reactions ---
  // Water + Lava → Steam + Stone (highest priority)
  {
    material: Material.Water,
    priority: -10,
    requireNeighbors: [{ directions: DIR.ALL_8, match: { kind: "material", mat: Material.Lava } }],
    actions: [
      { type: "transform_self", mat: Material.Steam, lifetime: 120 },
      { type: "transform_neighbor", mat: Material.Stone, match: { kind: "material", mat: Material.Lava } },
    ],
  },
  // Water + Fire → Steam + Smoke (chance-based, extinguishes flame)
  {
    material: Material.Water,
    priority: -5,
    chance: 0.25,
    requireNeighbors: [{ directions: DIR.ALL_8, match: { kind: "is_fire" } }],
    actions: [
      { type: "transform_self", mat: Material.Steam, lifetime: 120 },
      { type: "transform_neighbor", mat: Material.Smoke, lifetime: 40, match: { kind: "is_fire" } },
    ],
  },
  // Water + high temp → Steam (evaporation)
  {
    material: Material.Water,
    priority: -3,
    minTemp: 1.5,
    chance: 0.02, // simplified — original scales with temp
    actions: [{ type: "transform_self", mat: Material.Steam, lifetime: 120 }],
  },
  // Water + Plant → Plant (growth)
  {
    material: Material.Water,
    priority: -2,
    chance: 0.02,
    requireNeighbors: [{ directions: DIR.ALL_8, match: { kind: "material", mat: Material.Plant } }],
    actions: [{ type: "transform_self", mat: Material.Plant }],
  },
  // Water + low temp → Ice (freezing)
  {
    material: Material.Water,
    priority: -1,
    maxTemp: 0.35,
    chance: 0.02, // simplified — original scales with temp
    actions: [{ type: "transform_self", mat: Material.Ice }],
  },

  // --- Fire reactions ---
  // Fire + low temp → Smoke (dies faster in cold)
  {
    material: Material.Fire,
    priority: 0,
    maxTemp: 0.5,
    chance: 0.05, // simplified — original scales with temp
    actions: [{ type: "transform_self", mat: Material.Smoke, lifetime: 60 }],
  },
  // Also applies to FuseFire and BurningOil (IS_FIRE class)
  {
    material: Material.FuseFire,
    priority: 0,
    maxTemp: 0.5,
    chance: 0.05,
    actions: [{ type: "transform_self", mat: Material.Smoke, lifetime: 60 }],
  },
  {
    material: Material.BurningOil,
    priority: 0,
    maxTemp: 0.5,
    chance: 0.05,
    actions: [{ type: "transform_self", mat: Material.Smoke, lifetime: 60 }],
  },

  // --- Ice reactions ---
  // Ice + hot neighbor → Water (melts)
  {
    material: Material.Ice,
    priority: 0,
    chance: 0.3,
    requireNeighbors: [{ directions: DIR.ALL_8, match: { kind: "is_hot" } }],
    actions: [{ type: "transform_self", mat: Material.Water }],
  },
  // Ice + high ambient temp → Water (melts)
  {
    material: Material.Ice,
    priority: 1,
    minTemp: 1.3,
    chance: 0.02, // simplified — original scales with temp
    actions: [{ type: "transform_self", mat: Material.Water }],
  },
];

// Re-export material flags for the rule engine
export { IS_FIRE, IS_HOT, MAT_FLAMMABLE, MAT_FLAGS };
