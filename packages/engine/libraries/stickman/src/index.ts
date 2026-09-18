export {
    ARM_LEN, ARM_SWING, DEFAULT_LINE_WIDTH, ELBOW_BEND,
    FOOT_LIFT, HEAD_CY,
    HEAD_R,
    HEAD_SEGMENTS, HIP_Y, IDLE_ARM_OUT, IDLE_SWING, JUMP_ARM_SWING, JUMP_LEG_SWING, KNEE_BEND, LEG_LEN, LEG_SWING, NECK_Y, PLAYER_H, PLAYER_W, SHOULDER_Y, UPPER_LIMB_FRAC
} from "./proportions";

export {
    computeSkeleton, getHeadRadius, STICKMAN_FLOATS_PER_SEGMENT, STICKMAN_SEGMENT_COUNT, STICKMAN_SKELETON_FLOATS, type StickmanPose
} from "./skeleton";

export {
    buildThickLineIndices,
    buildThickLineVertices, STICKMAN_INDEX_COUNT, STICKMAN_VERTEX_COUNT, STICKMAN_VERTEX_STRIDE, type ThickLineGeometry
} from "./thick-line";

export { STICKMAN_WGSL } from "./shader";

export { StickmanPass } from "./stickman-pass";
export type { StickmanDrawState } from "./stickman-pass";

// Declarative library descriptor
export { StickmanLib, StickmanTok } from "./library";
export type { StickmanLibConfig } from "./library";

