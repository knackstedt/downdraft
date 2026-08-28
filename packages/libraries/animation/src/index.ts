// ─────────────────────────────────────────────────────────────────────────────
// Animation library — re-exports
// ─────────────────────────────────────────────────────────────────────────────
export { createAnimationEventTrack, getEventsInRange } from "./animation-event";
export type { AnimationEvent, AnimationEventTrack } from "./animation-event";
export { BoneMaskPreset, buildBoneMask, buildCustomBoneMask, registerCustomMask } from "./bone-mask";
export { AnimationClip, buildAnimationClipFromGLTF } from "./clip";
export type { AnimationClipData, KeyframeTrack, TrackPath } from "./clip";
export { DEFAULT_MIXAMO_CONFIG, MixamoRetargeter } from "./mixamo";
export type { MixamoRetargetConfig } from "./mixamo";
export { buildMorphTargetData, createMorphTargetTrack, findMorphKeyframeIndex, sampleMorphWeight } from "./morph-target";
export type { MorphTarget, MorphTargetData, MorphTargetTrack } from "./morph-target";
export { AnimationPlayer, MAX_MORPH_TARGETS } from "./player";
export type { LayerBlendMode, PlayOptions } from "./player";
export { buildRetargetMapping, retargetClip } from "./retarget";
export type { BoneMapping, RetargetMapping } from "./retarget";
export { buildSkeletonFromGLTF, Skeleton } from "./skeleton";
export type { Bone, GLTFSkin, SkeletonData } from "./skeleton";
export { SkeletonAnimator, skinDataToSkeletonData } from "./skeleton-animator";
export type { AnimationChannel, AnimationData, AnimState, BoneData, SkinData } from "./skeleton-animator";
export { AnimationStateMachine } from "./state-machine";
export type { AnimationState, AnimationTransition, BlendTree, BlendTree1D, BlendTree2D } from "./state-machine";
