// ============================================================================
// Sidecar Resolver — resolve ImportSettings from sidecar files or defaults
// ============================================================================
// Tries sidecar files in priority order:
//   1. .ddmeta.json (our format, comment-json)
//   2. Unity .meta (YAML)
//   3. Godot .import (INI)
//   4. Blender extras (from modelData, already parsed from glTF asset.extras)
//   5. Parser-detected defaults (sourceUpAxis, sourceUnits from ModelData)
//
// Each external sidecar is mapped to our ImportSettings shape, then merged
// with priority: ddmeta > unity > godot > blender > parser defaults.
//

import type { ModelData } from "../types";
import type { ImportSettings, SettingsSource } from "./types";
import { createDefaultImportSettings, mergeImportSettings } from "./types";
import { parseDdmeta } from "./ddmeta";
import { parseUnityMeta } from "./unity-meta";
import { parseGodotImport } from "./godot-import";
import { parseBlenderExtras } from "./blender-extras";

export interface ResolveOptions {
  /** Fetch function for sidecar files. Defaults to global fetch. */
  fetchFn?: (uri: string) => Promise<Response>;
  /** The model file URI (used to derive sidecar URIs). */
  modelPath: string;
  /** The parsed model data (for parser-detected defaults + Blender extras). */
  modelData: ModelData;
}

/**
 * Derive the .ddmeta.json sidecar URI from a model path.
 * "models/character.fbx" → "models/character.ddmeta.json"
 */
export function ddmetaPath(modelPath: string): string {
  return modelPath.replace(/\.[^.]+$/, ".ddmeta.json");
}

/**
 * Derive the Unity .meta sidecar URI from a model path.
 * "models/character.fbx" → "models/character.fbx.meta"
 */
export function unityMetaPath(modelPath: string): string {
  return modelPath + ".meta";
}

/**
 * Derive the Godot .import sidecar URI from a model path.
 * "models/character.gltf" → "models/character.gltf.import"
 */
export function godotImportPath(modelPath: string): string {
  return modelPath + ".import";
}

async function tryFetch(
  fetchFn: (uri: string) => Promise<Response>,
  uri: string,
): Promise<string | null> {
  try {
    const resp = await fetchFn(uri);
    if (!resp.ok) return null;
    const text = await resp.text();
    // Guard against HTML fallback pages (Vite SPA fallback returns 200 + HTML)
    if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * Resolve import settings for a model by trying sidecar files in priority
 * order, then falling back to parser-detected defaults.
 */
export async function resolveImportSettings(opts: ResolveOptions): Promise<ImportSettings> {
  const fetchFn = opts.fetchFn ?? ((uri: string) => fetch(uri));
  const { modelPath, modelData } = opts;

  // Start with parser-detected defaults
  const parserDefaults = createDefaultImportSettings(
    modelData.sourceUpAxis,
    modelData.sourceUnits,
  );
  parserDefaults.source = "parser" as SettingsSource;

  let merged: ImportSettings = parserDefaults;
  let currentSource: SettingsSource = "parser";

  // 4. Try Blender extras (from modelData — already parsed from glTF JSON)
  // We need to check if the modelData has glTF asset extras. The glTF parser
  // already detected sourceUpAxis from Blender extras, so this is redundant
  // for up-axis. But we keep it for completeness if future Blender settings
  // are added.
  // (Blender extras are already reflected in modelData.sourceUpAxis)

  // 3. Try Godot .import
  const godotText = await tryFetch(fetchFn, godotImportPath(modelPath));
  if (godotText) {
    const godotSettings = parseGodotImport(godotText);
    if (godotSettings) {
      merged = mergeImportSettings(merged, godotSettings, "godot");
      currentSource = "godot";
    }
  }

  // 2. Try Unity .meta
  const unityText = await tryFetch(fetchFn, unityMetaPath(modelPath));
  if (unityText) {
    const unitySettings = parseUnityMeta(unityText);
    if (unitySettings) {
      merged = mergeImportSettings(merged, unitySettings, "unity");
      currentSource = "unity";
    }
  }

  // 1. Try .ddmeta.json (highest priority)
  const ddmetaText = await tryFetch(fetchFn, ddmetaPath(modelPath));
  if (ddmetaText) {
    const ddmetaSettings = parseDdmeta(ddmetaText);
    if (ddmetaSettings) {
      merged = mergeImportSettings(merged, ddmetaSettings, "ddmeta");
      currentSource = "ddmeta";
    }
  }

  merged.source = currentSource;
  return merged;
}

/**
 * Synchronous version of resolveImportSettings that only uses parser-detected
 * defaults and Blender extras (no sidecar file fetching). Used when sidecar
 * resolution is disabled or for offline processing.
 */
export function resolveImportSettingsSync(modelData: ModelData): ImportSettings {
  const settings = createDefaultImportSettings(
    modelData.sourceUpAxis,
    modelData.sourceUnits,
  );
  settings.source = "parser";
  return settings;
}
