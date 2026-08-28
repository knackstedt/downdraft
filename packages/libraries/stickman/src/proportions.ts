// Stickman proportions in world-cell units.
//
// All offsets are relative to `topY = py` (the top of the player's bounding
// box) and `cx = px` (the horizontal center). `py` increases downward (screen
// convention), so larger Y = lower on screen. The player's bounding box is
// PLAYER_W cells wide and PLAYER_H cells tall; the feet land at
// `topY + PLAYER_H`.
//
// These constants are the single source of truth shared by:
//   - the WGSL stickman shader (via computeSkeleton)
//   - the DOM/SVG NPC overlay in games that use stickman rendering
//
// Keep them in sync with the player collision box in each game.

export const PLAYER_W = 3;
export const PLAYER_H = 7;

// Vertical joint offsets from topY (top of bounding box).
export const HEAD_CY = 1.0; // head center Y
export const HEAD_R = 0.8; // head radius (cells)
export const HEAD_SEGMENTS = 24; // circle outline segment count (smooth circle)
export const NECK_Y = 1.8; // neck (top of spine)
export const SHOULDER_Y = 2.2; // shoulder pivot
export const HIP_Y = 4.5; // hip pivot (bottom of spine)
export const ARM_LEN = 1.5; // full arm length (shoulder -> hand)
export const LEG_LEN = 2.0; // full leg length (hip -> foot)

// 2-segment limb split: upper segment (shoulder->elbow / hip->knee) is this
// fraction of the full limb length; the remainder is the lower segment.
export const UPPER_LIMB_FRAC = 0.55;

// Walk-cycle / pose amplitudes (in cells, applied per-limb).
export const LEG_SWING = 0.5; // forward/back foot offset
export const ARM_SWING = 0.4; // forward/back hand offset
export const KNEE_BEND = 0.35; // knee lateral offset during walk
export const ELBOW_BEND = 0.25; // elbow lateral offset during walk
export const FOOT_LIFT = 0.45; // vertical foot lift during swing phase
export const IDLE_SWING = 0.05; // idle breathing amplitude
export const IDLE_ARM_OUT = 0.35; // idle: hands rest this far out from center
export const JUMP_LEG_SWING = 0.3;
export const JUMP_ARM_SWING = 0.5;

// Render defaults. Line width is in cell units so strokes scale with zoom
// (matches the SVG NPC overlay's strokeW = max(1, scale * 0.25)).
export const DEFAULT_LINE_WIDTH = 0.25;
