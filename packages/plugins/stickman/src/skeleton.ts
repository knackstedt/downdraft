// Stickman skeleton computation — shared between games.
//
// Produces a flat list of line segments `[ax, ay, bx, by, ...]` in world-cell
// coordinates, given a pose. The wrapper uploads these into a thick-line quad
// vertex buffer each frame. Segment count is constant, so GPU buffers can be
// allocated once.
//
// Segment types:
//   - Line segments: endpointA = start, endpointB = end (z=0), cornerVec = (t, side)
//   - Circle segment (head): endpointA = (cx, cy, 0), endpointB = (cx, cy, radius),
//     cornerVec = (cornerX, cornerY) where each is ±1. The shader detects
//     circle mode via endpointB.z > 0 and renders a perfect SDF circle ring.

import {
    ARM_LEN,
    ARM_SWING,
    ELBOW_BEND,
    FOOT_LIFT,
    HEAD_CY,
    HEAD_R,
    HIP_Y,
    IDLE_ARM_OUT,
    IDLE_SWING,
    JUMP_ARM_SWING,
    JUMP_LEG_SWING,
    KNEE_BEND,
    LEG_LEN,
    LEG_SWING,
    NECK_Y,
    SHOULDER_Y,
    UPPER_LIMB_FRAC,
} from "./proportions";

export interface StickmanPose {
  /** player center X in world cell coords */
  cx: number;
  /** player top-of-bounding-box Y in world cell coords (increases downward) */
  topY: number;
  /** 1 = facing right, -1 = facing left */
  facing: number;
  /** animation frame counter (ticks) */
  animFrame: number;
  /** horizontal velocity (cells/tick) — drives walk vs idle */
  vx: number;
  /** true if the player is on the ground */
  onGround: boolean;
}

// Segment layout: 1 head circle + 1 spine + 4 arm segs + 4 leg segs = 10.
export const STICKMAN_SEGMENT_COUNT = 1 + 1 + 4 + 4;
export const STICKMAN_FLOATS_PER_SEGMENT = 4;
export const STICKMAN_SKELETON_FLOATS = STICKMAN_SEGMENT_COUNT * STICKMAN_FLOATS_PER_SEGMENT;

/**
 * Compute the stickman skeleton as a flat Float32Array of segment endpoints.
 * The returned array is a fresh, exactly-sized buffer; reuse it via the
 * optional `out` argument to avoid per-frame allocation.
 *
 * Segment 0 is the head circle: [centerX, centerY, centerX, centerY + radius*0].
 * The thick-line builder encodes the radius in endpointB.z (see thick-line.ts).
 */
export function computeSkeleton(pose: StickmanPose, out?: Float32Array): Float32Array {
  const seg = out && out.length >= STICKMAN_SKELETON_FLOATS ? out : new Float32Array(STICKMAN_SKELETON_FLOATS);
  const { cx, topY, facing: f, animFrame, vx, onGround } = pose;

  const headCx = cx;
  const headCy = topY + HEAD_CY;
  const neckX = cx, neckY = topY + NECK_Y;
  const hipX = cx, hipY = topY + HIP_Y;
  const shoulderX = cx, shoulderY = topY + SHOULDER_Y;

  // --- Pose / swing ---
  const moving = Math.abs(vx) > 0.01;
  const inAir = !onGround;
  const t = animFrame * 0.25;
  const s = Math.sin(t);

  let legSwingL: number, legSwingR: number, armSwingL: number, armSwingR: number;
  let liftL: number, liftR: number;
  // Bend amounts scale with pose: 0 at idle (straight limbs), dynamic during
  // walk (more bend when foot is lifted), 1 during jump.
  let kneeBendL: number, kneeBendR: number;
  let elbowBendL: number, elbowBendR: number;
  // At idle the hands rest slightly outward from the body center.
  let armOutL: number, armOutR: number;
  // Body bob: vertical offset during walk (whole skeleton dips and rises).
  let bodyBob: number;

  if (inAir) {
    // Jump: legs apart + tucked, arms out.
    legSwingL = JUMP_LEG_SWING; legSwingR = -JUMP_LEG_SWING;
    armSwingL = -JUMP_ARM_SWING; armSwingR = JUMP_ARM_SWING;
    liftL = FOOT_LIFT * 0.6; liftR = FOOT_LIFT * 0.6;
    kneeBendL = 1; kneeBendR = 1;
    elbowBendL = 1; elbowBendR = 1;
    armOutL = 0; armOutR = 0;
    bodyBob = 0;
  } else if (moving) {
    legSwingL = s * LEG_SWING; legSwingR = -s * LEG_SWING;
    armSwingL = -s * ARM_SWING; armSwingR = s * ARM_SWING;
    // Lift each foot during its forward swing phase.
    const liftPhaseL = Math.max(0, s);
    const liftPhaseR = Math.max(0, -s);
    liftL = liftPhaseL * FOOT_LIFT;
    liftR = liftPhaseR * FOOT_LIFT;
    // Knee bends more when the foot is lifted, straightens when planted.
    kneeBendL = liftPhaseL;
    kneeBendR = liftPhaseR;
    // Elbows bend slightly and constantly during walk.
    elbowBendL = 0.5; elbowBendR = 0.5;
    armOutL = 0; armOutR = 0;
    // Body bobs up when a foot is lifted (mid-step), dips when both feet are near ground.
    bodyBob = (liftPhaseL + liftPhaseR) * 0.15;
  } else {
    // Idle: gentle breathing sway, straight legs, arms resting outward.
    const idle = Math.sin(animFrame * 0.05) * IDLE_SWING;
    legSwingL = idle; legSwingR = -idle;
    armSwingL = -idle; armSwingR = idle;
    liftL = 0; liftR = 0;
    kneeBendL = 0; kneeBendR = 0;
    elbowBendL = 0; elbowBendR = 0;
    armOutL = -IDLE_ARM_OUT + idle;
    armOutR = IDLE_ARM_OUT - idle;
    bodyBob = 0;
  }

  // Apply body bob to the whole skeleton (shifts all joints up by bodyBob).
  const bobY = -bodyBob; // negative = up (Y increases downward)

  const headCyB = headCy + bobY;
  const neckYB = neckY + bobY;
  const shoulderYB = shoulderY + bobY;
  const hipYB = hipY + bobY;

  // --- Limb joints ---
  const upperLegLen = LEG_LEN * UPPER_LIMB_FRAC;
  const upperArmLen = ARM_LEN * UPPER_LIMB_FRAC;

  // Knees: on the hip->foot line when bend=0 (straight leg); biased forward
  // by KNEE_BEND when bend>0 (walk/jump). The knee X interpolates between
  // the hip X (straight) and the foot X (fully bent forward).
  const kneeLx = cx + legSwingL * f * UPPER_LIMB_FRAC + KNEE_BEND * f * kneeBendL;
  const kneeLy = hipYB + upperLegLen;
  const kneeRx = cx + legSwingR * f * UPPER_LIMB_FRAC - KNEE_BEND * f * kneeBendR;
  const kneeRy = hipYB + upperLegLen;

  const footLx = cx + legSwingL * f;
  const footLy = hipYB + LEG_LEN - liftL;
  const footRx = cx + legSwingR * f;
  const footRy = hipYB + LEG_LEN - liftR;

  // Hands + elbows.
  const handLx = cx + armSwingL * f + armOutL;
  const handLy = shoulderYB + ARM_LEN;
  const handRx = cx + armSwingR * f + armOutR;
  const handRy = shoulderYB + ARM_LEN;

  const elbowLx = cx + armSwingL * f * UPPER_LIMB_FRAC + armOutL * UPPER_LIMB_FRAC - ELBOW_BEND * f * elbowBendL;
  const elbowLy = shoulderYB + upperArmLen;
  const elbowRx = cx + armSwingR * f * UPPER_LIMB_FRAC + armOutR * UPPER_LIMB_FRAC + ELBOW_BEND * f * elbowBendR;
  const elbowRy = shoulderYB + upperArmLen;

  // --- Emit segments ---
  let i = 0;
  const push = (ax: number, ay: number, bx: number, by: number) => {
    seg[i++] = ax; seg[i++] = ay; seg[i++] = bx; seg[i++] = by;
  };

  // Head circle: encoded as [centerX, centerY, centerX, centerY].
  // The thick-line builder puts the radius in endpointB.z (see thick-line.ts).
  push(headCx, headCyB, headCx, headCyB);

  // Spine (neck -> hip).
  push(neckX, neckYB, hipX, hipYB);

  // Arms: shoulder -> elbow -> hand (2 segments each).
  push(shoulderX, shoulderYB, elbowLx, elbowLy);
  push(elbowLx, elbowLy, handLx, handLy);
  push(shoulderX, shoulderYB, elbowRx, elbowRy);
  push(elbowRx, elbowRy, handRx, handRy);

  // Legs: hip -> knee -> foot (2 segments each).
  push(hipX, hipYB, kneeLx, kneeLy);
  push(kneeLx, kneeLy, footLx, footLy);
  push(hipX, hipYB, kneeRx, kneeRy);
  push(kneeRx, kneeRy, footRx, footRy);

  return seg;
}

/**
 * Get the head circle radius (used by the thick-line builder to encode it
 * in the vertex data).
 */
export function getHeadRadius(): number {
  return HEAD_R;
}
