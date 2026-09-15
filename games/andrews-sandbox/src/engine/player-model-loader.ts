// ============================================================================
// Player Model Loader — loads a builtin player FBX + resolves external
// textures from its sibling texture directories.
//
// Ports the proven pattern from games/model-viewer/src/model-loader.ts
// (loadExternalTextures + loadModelWithTextures), adapted to the builtin
// player-model registry's textureDirs.
// ============================================================================

import {
    loadModel,
    resolveImportSettings,
    type AnimationData,
    type ModelData
} from "@downdraft/library-models";
import { PLAYER_ANIMATIONS, resolveAnimationUrl, type PlayerModelDef } from "./player-models";

/** True if the first 4 bytes are a browser-decodable image signature. */
function isDecodableImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // WebP (RIFF)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true;
  return false;
}

/**
 * Resolve external textures for materials whose embedded textureData is not
 * browser-decodable (e.g. TGA/BMP), or materials that have only a textureUri.
 *
 * Tries each textureDir with:
 *   1. The exact filename from the FBX (e.g. "ash_skinB.png")
 *   2. The filename with a "T_" prefix (e.g. "T_ash_skinB.png") — common in
 *      Unreal-style assets where the FBX omits the "T_" prefix
 *   3. A fuzzy match: any PNG in the directory whose name contains the FBX
 *      filename's base (without extension)
 *
 * Verifies the fetched bytes are a real image (PNG/JPEG/WebP) so Vite's SPA
 * HTML fallback (200 + HTML for missing files) is rejected.
 *
 * After resolution, textureUri is cleared so the ModelRenderer doesn't try
 * to fetch from the mesh base URL (which would fail for cross-directory
 * textures).
 */
async function loadExternalTextures(
  modelData: ModelData,
  textureDirs: string[],
): Promise<void> {
  if (!modelData.materials) return;

  for (let mi = 0; mi < modelData.materials.length; mi++) {
    const mat = modelData.materials[mi];

    // Keep decodable embedded textures as-is.
    let hasDecodableEmbedded = false;
    if (mat.textureData && mat.textureData.byteLength > 4) {
      const bytes = new Uint8Array(mat.textureData, 0, 4);
      if (isDecodableImage(bytes)) hasDecodableEmbedded = true;
    }
    if (hasDecodableEmbedded) {
      // Don't let the ModelRenderer try to fetch from the mesh base URL.
      mat.textureUri = undefined;
      continue;
    }

    // Try to find an external replacement.
    let foundExternal = false;
    if (mat.textureUri) {
      // Build candidate filenames to try.
      const origName = mat.textureUri;
      const candidates = [
        origName,                    // exact: ash_skinB.png
        `T_${origName}`,             // T_ prefix: T_ash_skinB.png
      ];
      // Also try stripping a T_ prefix if present (FBX has T_ but file doesn't).
      if (origName.startsWith("T_")) {
        candidates.push(origName.slice(2));
      }

      for (const dir of textureDirs) {
        if (foundExternal) break;
        for (const candidate of candidates) {
          const url = `${dir}${candidate}`;
          try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const data = await resp.arrayBuffer();
            if (data.byteLength > 4 && isDecodableImage(new Uint8Array(data, 0, 4))) {
              mat.textureData = data;
              foundExternal = true;
              console.log(`[PlayerModel] Material[${mi}] "${mat.name}": loaded ${candidate} from ${dir}`);
              break;
            }
          } catch {
            // try next candidate/dir
          }
        }
      }
    }

    // Clear non-decodable embedded textures so createImageBitmap doesn't fail.
    if (!foundExternal && mat.textureData && !hasDecodableEmbedded) {
      mat.textureData = null;
    }
    // Always clear textureUri so the ModelRenderer doesn't try to fetch from
    // the mesh base URL (which would fail for cross-directory textures).
    mat.textureUri = undefined;
  }
}

/**
 * Filter out optional / non-visual meshes (backpack, mask, vest, headgear,
 * accessories, collider, etc.) so only the base body is rendered.
 *
 * Uses the ModelData.nodes array (which has names) to identify which mesh
 * indices belong to optional items, then filters the meshes array.
 */
const OPTIONAL_PATTERNS = [
    /backpack/i,
    /mask/i,
    /vest/i,
    /headgear/i,
    /headwear/i,
    /headphone/i,
    /legpouch/i,
    /leg_acc/i,
    /eye_acc/i,
    /face_acc/i,
    /collider/i,
    /_acc/i,
];

function isOptionalMeshName(name: string): boolean {
    return OPTIONAL_PATTERNS.some((p) => p.test(name));
}

function filterOptionalMeshes(modelData: ModelData): void {
    if (!modelData.nodes || modelData.nodes.length === 0) return;

    // Collect mesh indices to exclude (from nodes with optional item names).
    const exclude = new Set<number>();
    for (const node of modelData.nodes) {
        if (isOptionalMeshName(node.name)) {
            if (node.meshes) {
                for (const idx of node.meshes) exclude.add(idx);
            }
            if (node.mesh !== undefined) exclude.add(node.mesh);
        }
    }

    if (exclude.size === 0) return;

    // Log which meshes are being filtered out for debugging.
    const excludedNames: string[] = [];
    for (const node of modelData.nodes) {
        if (isOptionalMeshName(node.name)) excludedNames.push(node.name);
    }
    console.log(`[PlayerModel] Filtered ${exclude.size} optional item mesh(es): [${excludedNames.join(", ")}]`);

    // Build the filtered meshes array + a remapping from old index → new index.
    const oldToNew = new Map<number, number>();
    const filtered: typeof modelData.meshes = [];
    for (let i = 0; i < modelData.meshes.length; i++) {
        if (exclude.has(i)) continue;
        oldToNew.set(i, filtered.length);
        filtered.push(modelData.meshes[i]);
    }

    console.log(`[PlayerModel] Filtered ${exclude.size} optional item mesh(es), keeping ${filtered.length}/${modelData.meshes.length}`);
    modelData.meshes = filtered;

    // Update node mesh indices to point into the filtered array.
    for (const node of modelData.nodes) {
        if (node.mesh !== undefined) {
            node.mesh = oldToNew.get(node.mesh);
        }
        if (node.meshes) {
            node.meshes = node.meshes
                .map((idx) => oldToNew.get(idx))
                .filter((idx): idx is number => idx !== undefined);
        }
    }
}

/** Cache of loaded ModelData keyed by player model id. */
const _cache = new Map<string, ModelData>();

/** Cache of loaded Mixamo animations (shared across all models). */
let _animCache: Map<string, AnimationData> | null = null;

/**
 * Load all Mixamo animation FBX files and extract their AnimationData.
 * Cached after first load (animations are the same for all models since
 * they all use the same Mixamo skeleton naming).
 */
async function loadMixamoAnimations(): Promise<Map<string, AnimationData>> {
  if (_animCache) return _animCache;

  const anims = new Map<string, AnimationData>();
  for (const animDef of PLAYER_ANIMATIONS) {
    const url = resolveAnimationUrl(animDef.filename);
    if (!url) {
      console.warn(`[PlayerModel] Animation not found: ${animDef.filename}`);
      continue;
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[PlayerModel] Failed to fetch animation ${animDef.filename}: ${resp.status}`);
        continue;
      }
      const buffer = await resp.arrayBuffer();
      const animModel = await loadModel(buffer, animDef.filename);
      if (animModel.animations && animModel.animations.length > 0) {
        // Use the first animation clip (Mixamo FBX files contain one clip each).
        const anim = animModel.animations[0];
        anim.name = animDef.state; // Override name with our state name.
        anims.set(animDef.state, anim);
        console.log(`[PlayerModel] Loaded animation: ${animDef.state} from ${animDef.filename} (${anim.duration.toFixed(2)}s, ${anim.channels.length} channels)`);
      } else {
        console.warn(`[PlayerModel] No animations in ${animDef.filename}`);
      }
    } catch (err) {
      console.warn(`[PlayerModel] Failed to load animation ${animDef.filename}:`, err);
    }
  }

  _animCache = anims;
  return anims;
}

/**
 * Load a builtin player model (FBX) + external textures + Mixamo animations.
 * Cached by model id.
 */
export async function loadPlayerModel(def: PlayerModelDef): Promise<ModelData> {
  const cached = _cache.get(def.id);
  if (cached) return cached;

  const resp = await fetch(def.meshUri);
  if (!resp.ok) throw new Error(`[PlayerModel] Failed to fetch ${def.meshUri}: ${resp.status}`);
  const buffer = await resp.arrayBuffer();

  const modelData = await loadModel(buffer, def.filename, undefined, undefined, {
    sidecarResolver: (_filename, md) =>
      resolveImportSettings({
        modelPath: def.meshUri,
        modelData: md,
        fetchFn: (uri) => fetch(uri),
      }),
  });

  await loadExternalTextures(modelData, def.textureDirs);
  filterOptionalMeshes(modelData);

  // Load Mixamo animations and merge into the model data.
  const anims = await loadMixamoAnimations();
  if (anims.size > 0) {
    modelData.animations = Array.from(anims.values());
    console.log(`[PlayerModel] Attached ${anims.size} Mixamo animations to ${def.id}`);
  }

  _cache.set(def.id, modelData);
  return modelData;
}

/** Clear the model cache (used on hot-reload dispose). */
export function clearPlayerModelCache(): void {
  _cache.clear();
  _animCache = null;
}
