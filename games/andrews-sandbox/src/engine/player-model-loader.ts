// ============================================================================
// Player Model Loader — loads a builtin player FBX + resolves external
// textures from its sibling texture directories.
//
// Now a thin adapter over @downdraft/library-character's
// createCharacterModelLoader (external texture resolution, accessory-mesh
// filtering, Mixamo animation merging, caching). The animation registry +
// model defs live in ./player-models.
// ============================================================================

import { createCharacterModelLoader } from "@downdraft/library-character";
import type { ModelData } from "@downdraft/library-models";
import { PLAYER_ANIMATIONS, resolveAnimationUrl, type PlayerModelDef } from "./player-models";

const loader = createCharacterModelLoader({
  animations: PLAYER_ANIMATIONS,
  resolveAnimationUrl,
});

/**
 * Load a builtin player model (FBX) + external textures + Mixamo animations.
 * Cached by model id.
 */
export async function loadPlayerModel(def: PlayerModelDef): Promise<ModelData> {
  return loader.load(def);
}

/** Clear the model cache (used on hot-reload dispose). */
export function clearPlayerModelCache(): void {
  loader.clearCache();
}
