// ============================================================================
// Import Settings — per-model normalization configuration (core types)
// ============================================================================
// These settings control how a model is normalized at import time:
// up-axis conversion, unit scaling, node-transform baking, centering, auto-fit.
//
// Defined in core (not plugin-models) so the ImportCache can store them
// without a cross-package dependency. Module-models re-exports these.
//

export type UpAxis = "y" | "z";

export type UnitSystem = "meters" | "centimeters" | "inches" | "millimeters" | "units";

export type SettingsSource = "ddmeta" | "unity" | "godot" | "blender" | "parser" | "default";

export interface ImportSettings {
  /** Source up-axis. The engine is Y-up. If the source is Z-up, vertices and
   * normals are rotated -90° around X: (x, y, z) → (x, z, -y). */
  upAxis: UpAxis;
  /** Source unit system. Positions are scaled to meters: cm→0.01, inch→0.0254,
   * mm→0.001, units→1.0 (unknown, no conversion). */
  units: UnitSystem;
  /** Additional user scale multiplier, applied after unit conversion. Default: 1.0 */
  scale: number;
  /** Optional quaternion pre-rotation [x, y, z, w] applied to the root. Default: [0,0,0,1] */
  rotation: [number, number, number, number];
  /** Subtract bounding-box center to place the model at the origin. Default: false */
  centerToOrigin: boolean;
  /** Auto-fit: null = off, or target max-dimension in meters. When set, the model
   * is uniformly scaled so its largest dimension equals this value. */
  autoFit: number | null;
  /** Node transform handling: "apply" = bake the node hierarchy transforms into
   * mesh vertices, "ignore" = use raw mesh data only. Default: "apply" */
  nodeTransforms: "apply" | "ignore";
  /** Where these settings came from (for debugging / UI display). */
  source: SettingsSource;
}

export function createDefaultImportSettings(
  parserUpAxis?: UpAxis,
  parserUnits?: UnitSystem,
): ImportSettings {
  return {
    upAxis: parserUpAxis ?? "y",
    units: parserUnits ?? "meters",
    scale: 1.0,
    rotation: [0, 0, 0, 1],
    centerToOrigin: false,
    autoFit: null,
    nodeTransforms: "apply",
    source: "default",
  };
}

/** Merge two ImportSettings, with `override` taking priority on non-undefined fields. */
export function mergeImportSettings(
  base: ImportSettings,
  override: Partial<ImportSettings>,
  source: SettingsSource,
): ImportSettings {
  return {
    upAxis: override.upAxis ?? base.upAxis,
    units: override.units ?? base.units,
    scale: override.scale ?? base.scale,
    rotation: override.rotation ?? base.rotation,
    centerToOrigin: override.centerToOrigin ?? base.centerToOrigin,
    autoFit: override.autoFit ?? base.autoFit,
    nodeTransforms: override.nodeTransforms ?? base.nodeTransforms,
    source,
  };
}
