// ============================================================================
// Godot .import — parse Godot asset import settings
// ============================================================================
// Godot .import files are INI format with [remap] and [params] sections.
// For 3D scenes/meshes, relevant params include scale, offset, rotation.
//

import type { ImportSettings } from "./types";

/**
 * Parse a Godot .import file (INI format) for model import settings.
 * Returns partial ImportSettings mapped from Godot's fields, or null if
 * the file doesn't contain relevant import settings.
 */
export function parseGodotImport(importText: string): Partial<ImportSettings> | null {
  // Godot .import files have a [remap] section with a "path" to the imported
  // resource and a [params] section with import settings.
  if (!importText.includes("[remap]")) return null;

  const result: Partial<ImportSettings> = {
    source: "godot",
  };

  // Parse INI-style sections
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = "";

  for (const line of importText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentSection = trimmed.slice(1, -1);
      sections[currentSection] = {};
    } else if (currentSection && trimmed.includes("=")) {
      const eqIdx = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      sections[currentSection][key] = value;
    }
  }

  const params = sections["params"] ?? {};

  // Godot mesh import settings
  if (params["scale"]) {
    const scale = parseFloat(params["scale"]);
    if (isFinite(scale)) {
      result.scale = scale;
    }
  }

  if (params["rotation"]) {
    // Godot stores rotation as Euler angles in degrees, space-separated or comma-separated
    const parts = params["rotation"].split(/[\s,]+/).map(parseFloat);
    if (parts.length >= 3 && parts.every(isFinite)) {
      // Convert Euler degrees to quaternion (XYZ order)
      const ex = parts[0] * Math.PI / 180;
      const ey = parts[1] * Math.PI / 180;
      const ez = parts[2] * Math.PI / 180;
      const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
      const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
      const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
      // XYZ extrinsic = ZYX intrinsic
      result.rotation = [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
      ];
    }
  }

  // Godot import format type — check if it's a 3D scene
  const remap = sections["remap"] ?? {};
  const importer = remap["importer"];
  if (importer && !importer.includes("scene") && !importer.includes("mesh") && !importer.includes("gltf")) {
    // Not a 3D model import — don't return settings
    return null;
  }

  // Only return if we found at least one useful setting
  if (result.scale === undefined && result.rotation === undefined) {
    return null;
  }

  return result;
}
