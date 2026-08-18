// ============================================================================
// Mining RPG — material override system
//
// The mining game uses materials from @downdraft/library-sand as a base, but
// needs game-specific behavior that differs from the sandbox defaults. This
// module provides:
//
// 1. **Precomputed array patches** — `applyMaterialOverrides()` patches the
//    sand engine's precomputed typed arrays (MAT_GRAVITY_DIR, MAT_GRAVITY,
//    MAT_DENSITY, MAT_FLAGS, etc.) and the MATERIALS record. This is for
//    permanent, game-wide property overrides (e.g. making a material
//    non-flammable, changing its density for displacement balance).
//
// 2. **Static-until-damaged registry** — `STATIC_UNTIL_DAMAGED` is a Set of
//    material IDs that should have per-cell gravity=0 when generated as
//    terrain (embedded in stone), and only gain gravity when damaged/mined.
//    This is checked by the terrain generator (sets gravity field=0) and
//    the mining system (restores gravity field when the cell is dislodged).
//    The material's MAT_GRAVITY_DIR stays 1 (can fall) so the per-cell
//    gravity field restoration actually works — overriding gravityDir to 0
//    would make the ore NEVER fall, even after mining.
//
// To add a new override: add an entry to MATERIAL_PROPERTY_OVERRIDES or
// STATIC_UNTIL_DAMAGED below. The system is designed to be the single source
// of truth for "how do materials behave in THIS game?"
// ============================================================================

import {
    MAT_CLIMBABLE,
    MAT_DENSITY,
    MAT_FLAGS,
    MAT_FLAMMABLE,
    MAT_GAS,
    MAT_GRAVITY,
    MAT_GRAVITY_DIR,
    MAT_LIFETIME,
    MAT_LIQUID,
    MAT_MAGNETIC,
    MAT_SOLID,
    Material,
    MATERIALS,
    type MaterialDef
} from "@downdraft/library-sand";

// ============================================================================
// Static-until-damaged registry
//
// Materials in this Set are generated with per-cell gravity=0 (frozen in
// place as terrain). When the mining damage system dislodges them (cellDamage
// >= hardness), the gravity field is restored to DEFAULT_GRAVITY and the cell
// begins to fall. The material's gravityDir stays 1 so the restoration works.
//
// All ores + coal: embedded in stone, don't fall until mined.
// ============================================================================
export const STATIC_UNTIL_DAMAGED = new Set<number>([
  Material.TinOre,
  Material.CopperOre,
  Material.IronOre,
  Material.BauxiteOre,
  Material.SilverOre,
  Material.GoldOre,
  Material.CobaltOre,
  Material.Coal,
]);

/** Check if a material should be static (gravity=0) until damaged/mined. */
export function isStaticUntilDamaged(mat: number): boolean {
  return STATIC_UNTIL_DAMAGED.has(mat);
}

// ============================================================================
// Material property overrides
//
// Each entry patches both the MATERIALS record (for code that reads
// MATERIALS[mat].property) and the precomputed typed arrays (for the sand
// engine's hot loops). Properties not listed here keep their library-sand
// defaults.
//
// Currently no permanent property overrides are needed — the ore gravity
// behavior is handled by the static-until-damaged registry + per-cell gravity
// fields, not by patching MAT_GRAVITY_DIR. This table is here for future use
// (e.g. making Coal more/less flammable, adjusting ore densities for
// displacement balance, etc.).
// ============================================================================
type MaterialPropertyOverride = Partial<Pick<MaterialDef,
  | "gravity"
  | "gravityDir"
  | "density"
  | "flammable"
  | "burnTime"
  | "lifetime"
  | "solid"
  | "liquid"
  | "gas"
  | "magnetic"
  | "climbable"
  | "albedo"
  | "reflectivity"
  | "brightness"
>>;

export const MATERIAL_PROPERTY_OVERRIDES: Record<number, MaterialPropertyOverride> = {
  // Example (not active — ore gravity is handled by STATIC_UNTIL_DAMAGED):
  // [Material.Coal]: { flammable: false }, // coal doesn't ignite in mining game
};

// ============================================================================
// Apply all overrides — call once at worker init (before ChunkWorld).
// Patches MATERIALS record + precomputed arrays so the sand engine sees the
// overridden values in its hot loops.
// ============================================================================
export function applyMaterialOverrides(): void {
  for (const [mat, override] of Object.entries(MATERIAL_PROPERTY_OVERRIDES)) {
    const id = Number(mat);
    const def = MATERIALS[id];
    if (!def) continue;

    // Patch the MATERIALS record
    if (override.gravity !== undefined) { def.gravity = override.gravity; MAT_GRAVITY[id] = override.gravity; }
    if (override.gravityDir !== undefined) { def.gravityDir = override.gravityDir; MAT_GRAVITY_DIR[id] = override.gravityDir; }
    if (override.density !== undefined) { def.density = override.density; MAT_DENSITY[id] = override.density; }
    if (override.lifetime !== undefined) { def.lifetime = override.lifetime; MAT_LIFETIME[id] = override.lifetime; }

    // Patch MAT_FLAGS (packed boolean flags)
    if (
      override.flammable !== undefined ||
      override.solid !== undefined ||
      override.liquid !== undefined ||
      override.gas !== undefined ||
      override.magnetic !== undefined ||
      override.climbable !== undefined
    ) {
      let flags = 0;
      const flammable = override.flammable ?? def.flammable;
      const solid = override.solid ?? def.solid;
      const liquid = override.liquid ?? def.liquid;
      const gas = override.gas ?? def.gas;
      const magnetic = override.magnetic ?? def.magnetic;
      const climbable = override.climbable ?? def.climbable;
      if (flammable) flags |= MAT_FLAMMABLE;
      if (solid) flags |= MAT_SOLID;
      if (liquid) flags |= MAT_LIQUID;
      if (gas) flags |= MAT_GAS;
      if (magnetic) flags |= MAT_MAGNETIC;
      if (climbable) flags |= MAT_CLIMBABLE;
      MAT_FLAGS[id] = flags;
      // Also patch the MaterialDef booleans
      def.flammable = flammable;
      def.solid = solid;
      def.liquid = liquid;
      def.gas = gas;
      def.magnetic = magnetic;
      def.climbable = climbable;
    }

    // Patch cosmetic properties (not used in precomputed arrays)
    if (override.burnTime !== undefined) def.burnTime = override.burnTime;
    if (override.albedo !== undefined) def.albedo = override.albedo;
    if (override.reflectivity !== undefined) def.reflectivity = override.reflectivity;
    if (override.brightness !== undefined) def.brightness = override.brightness;
  }
}
