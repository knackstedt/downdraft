// ============================================================================
// Blender extras — parse Blender glTF export settings from asset.extras
// ============================================================================
// Blender's glTF exporter stores settings in json.asset.extras.glTF2ExportSettings.
// The most relevant field is "YUP" (boolean) — if false, the model is Z-up.
//

import type { ImportSettings } from "./types";

/**
 * Parse Blender glTF export settings from the parsed glTF JSON's asset.extras.
 * Returns partial ImportSettings, or null if no Blender extras are present.
 */
export function parseBlenderExtras(assetExtras: Record<string, unknown> | undefined): Partial<ImportSettings> | null {
  if (!assetExtras) return null;

  const exportSettings = assetExtras["glTF2ExportSettings"] as Record<string, unknown> | undefined;
  if (!exportSettings) return null;

  const result: Partial<ImportSettings> = {
    source: "blender",
  };

  // YUP flag — if false, the source is Z-up
  if (exportSettings["YUP"] === false) {
    result.upAxis = "z";
  } else if (exportSettings["YUP"] === true) {
    result.upAxis = "y";
  }

  // Only return if we found at least one useful setting
  if (result.upAxis === undefined) {
    return null;
  }

  return result;
}
