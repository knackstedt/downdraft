// ============================================================================
// CharacterPreview — a self-contained mini model-viewer that renders a
// slowly-rotating preview of a player model on a dedicated canvas, using its
// own GPUDevice + ModelRenderer. Used by the ESC menu's "Character" tab.
//
// Thin adapter over @downdraft/library-character's CharacterPreview — the
// shared class owns the GPU device, orbit camera, depth buffer, and rAF
// loop; this wires in the game's model registry + loader + animator.
// ============================================================================

import {
    CharacterPreview as SharedCharacterPreview
} from "@downdraft/library-character";
import { PlayerAnimator } from "./player-animator";
import { loadPlayerModel } from "./player-model-loader";
import { getPlayerModelDef } from "./player-models";

export class CharacterPreview extends SharedCharacterPreview {
  constructor(canvas: HTMLCanvasElement) {
    super(canvas, {
      loadModel: async (modelId) => {
        const def = getPlayerModelDef(modelId);
        if (!def) return null;
        const modelData = await loadPlayerModel(def);
        return { modelData, meshBaseUrl: def.meshBaseUrl };
      },
      createAnimator: (modelData) => new PlayerAnimator(modelData),
    });
  }
}
