// ============================================================================
// Normalize Model — orchestrate the full import normalization pipeline
// ============================================================================
// Applies the resolved ImportSettings to a ModelData:
//   1. Up-axis conversion (Z-up → Y-up)
//   2. Unit scale (source units → meters)
//   3. Node-transform baking (glTF/FBX node hierarchy → mesh vertices)
//   4. Root pre-rotation (settings.rotation)
//   5. User scale (settings.scale)
//   6. Bounds computation
//   7. Center to origin (if enabled)
//   8. Auto-fit (if enabled)
//
// The transform math lives in @downdraft/core (model-normalizer.ts).
// This module orchestrates the pipeline and handles the plugin-level
// concerns (node-transform baking, sidecar resolution).
//

import {
  applyUpAxisConversion,
  applyUnitScale,
  applyRootRotation,
  applyRootScale,
  computeBounds,
  centerToOrigin as centerMeshesToOrigin,
  autoFit as autoFitMeshes,
  isExtremeScale,
  type Bounds,
} from "@downdraft/core";
import type { ModelData } from "./types";
import type { ImportSettings } from "./sidecar/types";
import { bakeNodeTransforms } from "./bake-node-transforms";
import { resolveImportSettings, resolveImportSettingsSync, type ResolveOptions } from "./sidecar/resolver";

export { resolveImportSettings, resolveImportSettingsSync };
export type { ResolveOptions };

/**
 * Normalize a ModelData using the given ImportSettings.
 * Mutates modelData in place (matching existing parser patterns).
 *
 * Returns the mutated ModelData with `bounds` and `normalizationWarnings`
 * populated.
 */
export function normalizeModel(modelData: ModelData, settings: ImportSettings): ModelData {
  const warnings: string[] = [];

  // 1. Up-axis conversion (Z-up → Y-up)
  if (settings.upAxis === "z") {
    applyUpAxisConversion(modelData.meshes, "z");
  }

  // 2. Unit scale (source units → meters)
  applyUnitScale(modelData.meshes, settings.units);

  // 3. Node-transform baking
  if (settings.nodeTransforms === "apply") {
    bakeNodeTransforms(modelData);
  }

  // 4. Root pre-rotation
  if (settings.rotation) {
    applyRootRotation(modelData.meshes, settings.rotation);
  }

  // 5. User scale multiplier
  if (settings.scale && settings.scale !== 1.0) {
    applyRootScale(modelData.meshes, settings.scale);
  }

  // 6. Compute bounds
  const bounds: Bounds = computeBounds(modelData.meshes);
  modelData.bounds = bounds;

  // Check for extreme scale (for dev-mode auto-fit prompt)
  if (isExtremeScale(bounds)) {
    const maxDim = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
    warnings.push(`Model has extreme scale: max dimension = ${maxDim.toFixed(4)}m. Consider auto-fit or adjusting scale in .ddmeta.json.`);
  }

  // 7. Center to origin
  if (settings.centerToOrigin) {
    centerMeshesToOrigin(modelData.meshes, bounds);
    // Recompute bounds after centering
    modelData.bounds = computeBounds(modelData.meshes);
  }

  // 8. Auto-fit
  if (settings.autoFit !== null && settings.autoFit > 0) {
    const currentBounds = modelData.bounds;
    const currentMax = Math.max(
      currentBounds.max[0] - currentBounds.min[0],
      currentBounds.max[1] - currentBounds.min[1],
      currentBounds.max[2] - currentBounds.min[2],
    );
    if (currentMax > 0) {
      autoFitMeshes(modelData.meshes, currentBounds, settings.autoFit);
      modelData.bounds = computeBounds(modelData.meshes);
      warnings.push(`Auto-fit applied: scaled to ${settings.autoFit}m max dimension (was ${currentMax.toFixed(4)}m).`);
    }
  }

  if (warnings.length > 0) {
    modelData.normalizationWarnings = warnings;
  }

  return modelData;
}

/**
 * Full normalization pipeline: resolve import settings, then normalize.
 * Convenience function that combines resolveImportSettings + normalizeModel.
 */
export async function normalizeModelWithResolution(
  modelData: ModelData,
  modelPath: string,
  opts?: Omit<ResolveOptions, "modelPath" | "modelData">,
): Promise<ModelData> {
  const settings = await resolveImportSettings({
    ...opts,
    modelPath,
    modelData,
  });
  return normalizeModel(modelData, settings);
}
