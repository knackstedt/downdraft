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
// For skinned meshes, the same transforms (1, 2, 4, 5, 7, 8) are also applied
// to the skin data (bone rest transforms + inverse bind matrices) so that
// vertices and bone data stay in the same coordinate space. Step 3 (node-
// transform baking) is skipped for skinned meshes — the skin matrices encode
// the bone hierarchy and baking would double-transform the vertices.
//
// The transform math lives in @downdraft/core (model-normalizer.ts).
// This module orchestrates the pipeline and handles the plugin-level
// concerns (node-transform baking, sidecar resolution, skin normalization).
//

import {
    applyRootRotation,
    applyRootScale,
    applyUnitScale,
    applyUpAxisConversion,
    autoFit as autoFitMeshes,
    centerToOrigin as centerMeshesToOrigin,
    computeBounds,
    isExtremeScale,
    UNIT_TO_METERS,
    type Bounds
} from "@downdraft/core";
import { bakeNodeTransforms } from "./bake-node-transforms";
import { resolveImportSettings, resolveImportSettingsSync, type ResolveOptions } from "./sidecar/resolver";
import type { ImportSettings } from "./sidecar/types";
import type { ModelData } from "./types";

export { resolveImportSettings, resolveImportSettingsSync };
export type { ResolveOptions };

// Local tuple type (the core's Quat from sim/types is an object type, but
// ImportSettings.rotation uses a tuple).
type Quat = [number, number, number, number];

// ── 4x4 matrix utilities (column-major, matching WebGPU convention) ──

function matMultiply(a: Float32Array, b: Float32Array): Float32Array {
  // Compute A * B in column-major layout.
  // out[col=i, row=j] = sum_k A[col=k, row=j] * B[col=i, row=k]
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[0 * 4 + j] * b[i * 4 + 0] +
        a[1 * 4 + j] * b[i * 4 + 1] +
        a[2 * 4 + j] * b[i * 4 + 2] +
        a[3 * 4 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

function matTranslate(tx: number, ty: number, tz: number): Float32Array {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]);
}

function matScale(s: number): Float32Array {
  return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);
}

function matFromQuat(q: Quat): Float32Array {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return new Float32Array([
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ]);
}

/**
 * Normalize a ModelData using the given ImportSettings.
 * Mutates modelData in place (matching existing parser patterns).
 *
 * Returns the mutated ModelData with `bounds` and `normalizationWarnings`
 * populated.
 */
export function normalizeModel(modelData: ModelData, settings: ImportSettings): ModelData {
  const warnings: string[] = [];

  // Track the accumulated normalization transform for skin data. This is the
  // combined transform T such that v' = T * v for vertices. The same transform
  // is applied to bone rest data and inverse bind matrices at the end.
  const hasSkin = !!modelData.skin && modelData.skin.bones.length > 0;
  let skinTransform: Float32Array | null = null;
  function accumulateTransform(t: Float32Array): void {
    skinTransform = skinTransform ? matMultiply(t, skinTransform) : t;
  }

  // 1. Up-axis conversion (Z-up → Y-up): (x,y,z) → (x,z,-y)
  if (settings.upAxis === "z") {
    applyUpAxisConversion(modelData.meshes, "z");
    if (hasSkin) {
      // -90° rotation around X: column-major [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]
      accumulateTransform(new Float32Array([1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]));
    }
  }

  // 2. Unit scale (source units → meters)
  const unitFactor = UNIT_TO_METERS[settings.units] ?? 1.0;
  if (unitFactor !== 1.0) {
    applyUnitScale(modelData.meshes, settings.units);
    if (hasSkin) accumulateTransform(matScale(unitFactor));
  }

  // 3. Node-transform baking (skipped for skinned meshes inside bakeNodeTransforms)
  if (settings.nodeTransforms === "apply") {
    bakeNodeTransforms(modelData);
  }

  // 4. Root pre-rotation
  if (settings.rotation) {
    applyRootRotation(modelData.meshes, settings.rotation);
    if (hasSkin) accumulateTransform(matFromQuat(settings.rotation));
  }

  // 5. User scale multiplier
  if (settings.scale && settings.scale !== 1.0) {
    applyRootScale(modelData.meshes, settings.scale);
    if (hasSkin) accumulateTransform(matScale(settings.scale));
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
    if (hasSkin) {
      const cx = (bounds.min[0] + bounds.max[0]) / 2;
      const cy = (bounds.min[1] + bounds.max[1]) / 2;
      const cz = (bounds.min[2] + bounds.max[2]) / 2;
      accumulateTransform(matTranslate(-cx, -cy, -cz));
    }
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
      const fitFactor = settings.autoFit / currentMax;
      autoFitMeshes(modelData.meshes, currentBounds, settings.autoFit);
      modelData.bounds = computeBounds(modelData.meshes);
      if (hasSkin) accumulateTransform(matScale(fitFactor));
      warnings.push(`Auto-fit applied: scaled to ${settings.autoFit}m max dimension (was ${currentMax.toFixed(4)}m).`);
    }
  }

  // Store the accumulated normalization transform on the skin data. The
  // animator will conjugate skin matrices with it (T * skinMatrix * T^-1) so
  // that skinned vertices — which were transformed by T — map to the correct
  // normalized world positions. Bone rest data stays in its original coordinate
  // space; only the final skin matrices are transformed.
  if (hasSkin && skinTransform) {
    modelData.skin!.normalizationMatrix = skinTransform;
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
