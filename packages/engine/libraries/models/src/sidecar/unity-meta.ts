// ============================================================================
// Unity .meta — parse Unity asset metadata for model import settings
// ============================================================================
// Unity .meta files are YAML. We use targeted regex for the few fields we
// need (scaleFactor, useFileUnits) rather than a full YAML parser.
//

import type { ImportSettings } from "./types";

interface UnityModelImporter {
  scaleFactor?: number;
  useFileUnits?: boolean;
  meshCompression?: number;
}

/**
 * Parse a Unity .meta file (YAML format) for model import settings.
 * Returns partial ImportSettings mapped from Unity's fields, or null if
 * the file is not a ModelImporter .meta.
 */
export function parseUnityMeta(metaText: string): Partial<ImportSettings> | null {
  // Unity .meta files start with "fileFormatVersion:" and have a
  // "guid:" field. ModelImporter .meta files have "ModelImporter:" header.
  if (!metaText.includes("ModelImporter")) return null;

  const importer: UnityModelImporter = {};

  // Extract scaleFactor — it's a top-level property in ModelImporter
  const scaleMatch = metaText.match(/^[\s]*scaleFactor:\s*([\d.]+)/m);
  if (scaleMatch) {
    importer.scaleFactor = parseFloat(scaleMatch[1]);
  }

  // Extract useFileUnits
  const unitsMatch = metaText.match(/^[\s]*useFileUnits:\s*(\w+)/m);
  if (unitsMatch) {
    importer.useFileUnits = unitsMatch[1] === "1" || unitsMatch[1] === "true";
  }

  // Extract meshCompression (informational only)
  const compressionMatch = metaText.match(/^[\s]*meshCompression:\s*(\d+)/m);
  if (compressionMatch) {
    importer.meshCompression = parseInt(compressionMatch[1], 10);
  }

  if (importer.scaleFactor === undefined) return null;

  // Unity's scaleFactor converts the model to meters. For FBX files exported
  // in centimeters (Unity default), scaleFactor is typically 0.01.
  // We map this to our `scale` multiplier.
  const result: Partial<ImportSettings> = {
    scale: importer.scaleFactor,
    source: "unity",
  };

  // If useFileUnits is true, Unity uses the file's native units (e.g. cm for FBX).
  // The scaleFactor already accounts for this conversion.
  // If useFileUnits is false, Unity treats everything as meters.

  return result;
}
