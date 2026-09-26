// ============================================================================
// FBX GlobalSettings — UpAxis, UnitScaleFactor, rotation order
// ============================================================================
// Extracts coordinate system and unit information from the GlobalSettings
// node. The parser does NOT convert vertices — that's the normalization
// layer's job, which respects sidecar overrides.
//

import type { FBXNode } from "../types";
import { childNode } from "../types";
import type { DiagnosticsCollector } from "./diagnostics";

export interface FBXGlobalSettings {
  /** "y" or "z" (FBX UpAxis: 0/1 = Y-up, 2 = Z-up). */
  upAxis: "y" | "z";
  /** Raw UnitScaleFactor (units per centimeter). */
  unitScaleFactor: number | undefined;
  /** Classified unit system. */
  units: "meters" | "centimeters" | "inches" | "millimeters" | "units";
  /** Rotation order (0 = XYZ extrinsic = ZYX intrinsic, FBX default). */
  rotationOrder: number;
}

/**
 * Parse GlobalSettings from the FBX node tree.
 *
 * FBX UpAxis values:
 *   0 = Y-up (Maya default, X-right, Z-forward)
 *   1 = Y-up (3ds Max, X-forward, Z-right) — still Y-up
 *   2 = Z-up (Blender / Maya Z-up, X-right, Y-forward)
 *
 * FBX UnitScaleFactor (units per centimeter):
 *   1.0   → centimeters (Maya default)
 *   0.1   → millimeters
 *   2.54  → inches
 *   100   → meters
 */
export function parseGlobalSettings(nodes: FBXNode[], diag: DiagnosticsCollector): FBXGlobalSettings {
  const globalSettings = nodes.find((n) => n.name === "GlobalSettings");
  if (!globalSettings) {
    return { upAxis: "y", unitScaleFactor: undefined, units: "centimeters", rotationOrder: 0 };
  }

  const props70 = childNode(globalSettings, "Properties70");
  if (!props70) {
    return { upAxis: "y", unitScaleFactor: undefined, units: "centimeters", rotationOrder: 0 };
  }

  let upAxis: "y" | "z" = "y";
  let unitScaleFactor: number | undefined;
  let rotationOrder = 0;

  for (let _i = 0, _it = props70.children, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (p.name !== "P" || p.properties.length < 5) continue;
    const propName = String(p.properties[0].value);

    if (propName === "UpAxis") {
      const val = p.properties[4].value as number;
      upAxis = val === 2 ? "z" : "y";
      diag.debug("global-settings", `UpAxis = ${val}`);
    } else if (propName === "UnitScaleFactor") {
      unitScaleFactor = p.properties[4].value as number;
      diag.debug("global-settings", `UnitScaleFactor = ${unitScaleFactor}`);
    } else if (propName === "RotationOrder") {
      // RotationOrder is a 4th property (index 3) in some FBX versions,
      // but usually it's at index 4 like other properties.
      if (p.properties.length >= 5) {
        rotationOrder = p.properties[4].value as number;
      }
    }
  }

  const units = classifyFBXUnits(unitScaleFactor);

  return { upAxis, unitScaleFactor, units, rotationOrder };
}

/**
 * Classify a raw FBX UnitScaleFactor (units per cm) into our UnitSystem enum.
 * Falls back to "units" if the value doesn't match a known unit.
 */
function classifyFBXUnits(
  unitScaleFactor: number | undefined,
): "meters" | "centimeters" | "inches" | "millimeters" | "units" {
  if (unitScaleFactor === undefined) return "centimeters"; // FBX default is cm
  // Common values: 0.1=mm, 1=cm, 2.54=in, 100=m
  if (Math.abs(unitScaleFactor - 100) < 0.01) return "meters";
  if (Math.abs(unitScaleFactor - 1) < 0.01) return "centimeters";
  if (Math.abs(unitScaleFactor - 2.54) < 0.01) return "inches";
  if (Math.abs(unitScaleFactor - 0.1) < 0.01) return "millimeters";
  return "units";
}
