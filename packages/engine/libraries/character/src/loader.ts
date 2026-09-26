// ============================================================================
// Character model loader — skinned-model loading with external texture
// resolution, optional-accessory mesh filtering, and an animation registry.
//
// Extracted from andrews-sandbox's player-model-loader (which was itself
// ported from model-viewer's model-loader) so new games get the proven
// texture-resolution + accessory-filtering pipeline without copying it.
// ============================================================================

import {
    loadModel,
    resolveImportSettings,
    type AnimationData,
    type ModelData
} from "@downdraft/engine/libraries/models";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

/** A character model the loader can resolve. */
export interface CharacterModelDef {
  /** Stable id used by save state + UI. */
  id: string;
  /** Display name. */
  name: string;
  /** Mesh URL (typically Vite-resolved). */
  meshUri: string;
  /** Mesh filename (drives loader format detection). */
  filename: string;
  /** Base URL (directory) of the mesh, for resolving relative texture URIs. */
  meshBaseUrl: string;
  /** Texture search directories (absolute URLs) tried in order when a
   *  material's embedded texture is not browser-decodable. */
  textureDirs: string[];
}

/** An external animation file mapped to an animation-state name. */
export interface CharacterAnimationDef {
  /** Animation state name (matches SkeletonAnimator state). */
  state: string;
  /** Filename inside the animation directory. */
  filename: string;
}

/** True if the first 4 bytes are a browser-decodable image signature. */
export function isDecodableImage(bytes: Uint8Array): boolean {
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
 *   1. The exact filename from the model (e.g. "ash_skinB.png")
 *   2. The filename with a "T_" prefix (e.g. "T_ash_skinB.png") — common in
 *      Unreal-style assets where the mesh omits the "T_" prefix
 *   3. The filename with a "T_" prefix stripped, when present
 *
 * Verifies the fetched bytes are a real image (PNG/JPEG/WebP) so a dev
 * server's SPA HTML fallback (200 + HTML for missing files) is rejected.
 *
 * After resolution, textureUri is cleared so the renderer doesn't try to
 * fetch from the mesh base URL (which would fail for cross-directory
 * textures).
 */
export async function loadExternalTextures(
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
      // Don't let the renderer try to fetch from the mesh base URL.
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
      // Also try stripping a T_ prefix if present (mesh has T_ but file doesn't).
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
              log.info("CharacterModel", `Material[${mi}] "${mat.name}": loaded ${candidate} from ${dir}`);
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
    // Always clear textureUri so the renderer doesn't try to fetch from the
    // mesh base URL (which would fail for cross-directory textures).
    mat.textureUri = undefined;
  }
}

/**
 * Default name patterns for optional / non-visual meshes (backpack, mask,
 * vest, headgear, accessories, collider, etc.) filtered out so only the base
 * body is rendered.
 */
export const DEFAULT_OPTIONAL_MESH_PATTERNS: readonly RegExp[] = [
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

/**
 * Filter out meshes whose node names match `patterns` (default:
 * DEFAULT_OPTIONAL_MESH_PATTERNS). Remaps `nodes[].mesh`/`meshes` indices to
 * the filtered array.
 */
export function filterOptionalMeshes(
  modelData: ModelData,
  patterns: readonly RegExp[] = DEFAULT_OPTIONAL_MESH_PATTERNS,
): void {
    if (!modelData.nodes || modelData.nodes.length === 0) return;
    const isOptional = (name: string) => patterns.some((p) => p.test(name));

    // Collect mesh indices to exclude (from nodes with optional item names).
    const exclude = new Set<number>();
    for (const node of modelData.nodes) {
        if (isOptional(node.name)) {
            if (node.meshes) {
                for (const idx of node.meshes) exclude.add(idx);
            }
            if (node.mesh !== undefined) exclude.add(node.mesh);
        }
    }

    if (exclude.size === 0) return;

    const excludedNames: string[] = [];
    for (const node of modelData.nodes) {
        if (isOptional(node.name)) excludedNames.push(node.name);
    }
    log.info("CharacterModel", `Filtered ${exclude.size} optional item mesh(es): [${excludedNames.join(", ")}]`);

    excludeMeshIndices(modelData, exclude);
    log.info("CharacterModel", `Filtered optional meshes, keeping ${modelData.meshes.length}`);
}

/**
 * Rebuild `modelData.meshes` without the given indices, remapping
 * `nodes[].mesh`/`meshes` into the filtered array.
 */
function excludeMeshIndices(modelData: ModelData, exclude: Set<number>): void {
    const oldToNew = new Map<number, number>();
    const filtered: typeof modelData.meshes = [];
    for (let i = 0; i < modelData.meshes.length; i++) {
        if (exclude.has(i)) continue;
        oldToNew.set(i, filtered.length);
        filtered.push(modelData.meshes[i]);
    }
    modelData.meshes = filtered;

    for (const node of modelData.nodes ?? []) {
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

/**
 * Strip the trailing `.NNN` / `_NNN` variant suffix from a node name to get
 * its equipment-slot group (e.g. `f_torso.007` → `f_torso`).
 */
function variantGroupKey(name: string): string {
    return name.replace(/[._]\d+$/, "");
}

/**
 * Modular character kits (Humanling `f_*`, Aisha `ash_*`) ship every outfit /
 * hairstyle / accessory variant as sibling mesh nodes named `slot.NNN`.
 * Rendering all of them stacks every garment on the character at once. This
 * keeps exactly ONE mesh-bearing node per group — the first in node order —
 * so the model renders a single coherent outfit. Single-node groups and
 * non-variant nodes are untouched.
 */
export function selectVariantMeshes(modelData: ModelData): void {
    if (!modelData.nodes || modelData.nodes.length === 0) return;

    const groups = new Map<string, typeof modelData.nodes>();
    for (const node of modelData.nodes) {
        if (node.mesh === undefined && (!node.meshes || node.meshes.length === 0)) continue;
        const key = variantGroupKey(node.name);
        let list = groups.get(key);
        if (!list) { list = []; groups.set(key, list); }
        list.push(node);
    }

    const exclude = new Set<number>();
    const kept: string[] = [];
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        kept.push(list[0].name);
        for (let i = 1; i < list.length; i++) {
            const node = list[i];
            if (node.meshes) for (const idx of node.meshes) exclude.add(idx);
            if (node.mesh !== undefined) exclude.add(node.mesh);
        }
    }

    if (exclude.size === 0) return;
    log.info("CharacterModel", `Variant selection kept [${kept.join(", ")}], dropping ${exclude.size} meshes`);
    excludeMeshIndices(modelData, exclude);
}

export interface CharacterModelLoaderOptions {
  /**
   * External animation files (e.g. Mixamo FBX clips) merged into every loaded
   * model's `animations`. Each file's first clip is renamed to `state` so the
   * state machine can address it.
   */
  animations?: readonly CharacterAnimationDef[];
  /** Resolve an animation filename to a fetchable URL (e.g. via import.meta.glob). */
  resolveAnimationUrl?(filename: string): string | null;
  /** Accessory-mesh name patterns for filterOptionalMeshes. */
  optionalMeshPatterns?: readonly RegExp[];
  /** Set false to keep accessory meshes (default: filter them). */
  filterOptionalMeshes?: boolean;
  /** Keep one mesh node per variant group (`slot.NNN` siblings). Default true. */
  selectVariantMeshes?: boolean;
}

export interface CharacterModelLoader {
  /** Load a model (cached by `def.id`). */
  load(def: CharacterModelDef): Promise<ModelData>;
  /** Clear the model + animation caches (e.g. on hot-reload dispose). */
  clearCache(): void;
}

/**
 * Create a character model loader: fetch → loadModel (with sidecar import
 * settings) → external texture resolution → optional-mesh filtering →
 * animation merge. Model results are cached by `def.id`; animation files are
 * fetched once and shared across all models.
 */
export function createCharacterModelLoader(opts: CharacterModelLoaderOptions = {}): CharacterModelLoader {
  const cache = new Map<string, ModelData>();
  let animCache: Map<string, AnimationData> | null = null;

  async function loadAnimations(): Promise<Map<string, AnimationData>> {
    if (animCache) return animCache;
    const anims = new Map<string, AnimationData>();
    for (const animDef of opts.animations ?? []) {
      const url = opts.resolveAnimationUrl?.(animDef.filename) ?? null;
      if (!url) {
        log.warn("CharacterModel", `Animation not found: ${animDef.filename}`);
        continue;
      }
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          log.warn("CharacterModel", `Failed to fetch animation ${animDef.filename}: ${resp.status}`);
          continue;
        }
        const buffer = await resp.arrayBuffer();
        const animModel = await loadModel(buffer, animDef.filename);
        if (animModel.animations && animModel.animations.length > 0) {
          // Use the first animation clip (single-clip files like Mixamo FBX).
          const anim = animModel.animations[0];
          anim.name = animDef.state; // Override name with the state name.
          anims.set(animDef.state, anim);
          log.info("CharacterModel", `Loaded animation: ${animDef.state} from ${animDef.filename} (${anim.duration.toFixed(2)}s, ${anim.channels.length} channels)`);
        } else {
          log.warn("CharacterModel", `No animations in ${animDef.filename}`);
        }
      } catch (err) {
        log.warn("CharacterModel", `Failed to load animation ${animDef.filename}: ${err}`);
      }
    }
    animCache = anims;
    return anims;
  }

  return {
    async load(def) {
      const cached = cache.get(def.id);
      if (cached) return cached;

      const resp = await fetch(def.meshUri);
      if (!resp.ok) throw new Error(`[CharacterModel] Failed to fetch ${def.meshUri}: ${resp.status}`);
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
      if (opts.filterOptionalMeshes !== false) {
        filterOptionalMeshes(modelData, opts.optionalMeshPatterns);
      }
      if (opts.selectVariantMeshes !== false) {
        selectVariantMeshes(modelData);
      }

      // Load shared animations and merge into the model data.
      const anims = await loadAnimations();
      if (anims.size > 0) {
        modelData.animations = Array.from(anims.values());
        log.info("CharacterModel", `Attached ${anims.size} animations to ${def.id}`);
      }

      cache.set(def.id, modelData);
      return modelData;
    },
    clearCache() {
      cache.clear();
      animCache = null;
    },
  };
}
