// ============================================================================
// KenneyScanner — discovers Kenney model-pack GLBs from a Vite glob import
// and converts them into ContentEntry[] for the ContentRegistry.
//
// Kenney packs live under src/assets/kenney_<pack-name>/Models/.../*.glb.
// They are public-domain (https://kenney.nl) and use only
// KHR_materials_unlit / KHR_texture_transform (no Draco/meshopt), so they
// parse cleanly in a Web Worker via @downdraft/library-models' loadModel().
// ============================================================================

import type { ContentEntry } from "./content-registry";

/** Map of Vite glob path → resolved URL (from import.meta.glob with query:'?url'). */
export type KenneyGlobMap = Record<string, string>;

const DEFAULT_PHYSICS = { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 };

/** Convert a kenney pack folder name into a human label ("space-kit" → "Space Kit"). */
export function packLabelFromName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\b(\d+\.\d+)\b/, " $1")
    .trim();
}

/** Derive a shape from an id/filename heuristic. */
function inferShape(id: string): "box" | "sphere" {
  const lower = id.toLowerCase();
  if (lower.includes("sphere") || lower.includes("ball") || lower.includes("orb")) return "sphere";
  return "box";
}

/** Derive a display name from a filename ("tower-square-mid-windows.glb" → "Tower Square Mid Windows"). */
function deriveName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Scan a Vite glob of Kenney GLB URLs and produce ContentEntry[].
 *
 * @param globMap result of import.meta.glob with eager:true, query:"?url",
 *   import:"default" over the Kenney assets directory (all .glb files).
 * @param packFilter optional set of pack names to include (default: all)
 */
export function scanKenneyPacks(globMap: KenneyGlobMap, packFilter?: ReadonlySet<string>): ContentEntry[] {
  const entries: ContentEntry[] = [];
  for (const [path, url] of Object.entries(globMap)) {
    // path looks like "../assets/kenney_space-kit/Models/GLTF format/alien.glb"
    const match = path.match(/kenney_([^/]+)\//);
    const packName = match ? match[1] : "unknown";
    if (packFilter && !packFilter.has(packName)) continue;
    const pack = `kenney_${packName}`;
    const packLabel = packLabelFromName(packName);
    const filename = path.split("/").pop() ?? "model.glb";
    const id = `${pack}:${filename}`;
    const shape = inferShape(filename);
    entries.push({
      id,
      name: deriveName(filename),
      category: "prop",
      modelUri: url,
      pluginSource: pack,
      pack,
      packLabel,
      physics: { ...DEFAULT_PHYSICS },
      scale: 1.0,
      paintable: true,
      shape,
    });
  }
  // Stable sort by pack then name so the UI is deterministic.
  entries.sort((a, b) => (a.pack === b.pack ? a.name.localeCompare(b.name) : a.pack.localeCompare(b.pack)));
  return entries;
}
