// ============================================================================
// @downdraft/library-character — skinned character plumbing
//
// The character pipeline every rigged-model game needs:
//  - `createCharacterModelLoader` — fetch + parse + external texture
//    resolution + accessory-mesh filtering + animation-file merging, cached.
//  - `LocomotionAnimator` — Idle/Walk/Run/airborne state machine with
//    hysteresis, driven by {grounded, speed, override}.
//  - `CharacterAnimator` — SkeletonAnimator → skin matrices with the model's
//    normalization conjugation, for ModelRenderer.updateSkinMatrices.
//  - `CharacterPreview` — self-contained orbiting model preview canvas.
//  - Humanoid bone-name resolver + procedural locomotion clip builders.
// ============================================================================

export {
    CharacterAnimator, buildLocomotionClips, findBoneIndex, positionTrack, resolveHumanoidBones, rotationTrack, type HumanoidBoneIndices
} from "./character-animator";
export {
    createCharacterModelLoader, DEFAULT_OPTIONAL_MESH_PATTERNS, filterOptionalMeshes,
    isDecodableImage, loadExternalTextures, type CharacterAnimationDef, type CharacterModelDef,
    type CharacterModelLoader, type CharacterModelLoaderOptions
} from "./loader";
export {
    LocomotionAnimator, type LocomotionConfig, type LocomotionInput, type LocomotionThresholds
} from "./locomotion";
export { CharacterPreview, type CharacterPreviewOptions } from "./preview";
