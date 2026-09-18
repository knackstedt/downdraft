import { describe, expect, it } from "bun:test";
import {
    ARM_LEN,
    HEAD_R,
    HIP_Y,
    IDLE_ARM_OUT,
    LEG_LEN,
    PLAYER_H,
    PLAYER_W,
    SHOULDER_Y,
    STICKMAN_FLOATS_PER_SEGMENT,
    STICKMAN_INDEX_COUNT,
    STICKMAN_SEGMENT_COUNT,
    STICKMAN_SKELETON_FLOATS,
    STICKMAN_VERTEX_COUNT,
    STICKMAN_VERTEX_STRIDE,
    UPPER_LIMB_FRAC,
    buildThickLineIndices,
    buildThickLineVertices,
    computeSkeleton,
    getHeadRadius,
} from "./index";

const cx = 10;
const topY = 20;

function expectInBounds(x: number, y: number, label: string): void {
  const minX = cx - PLAYER_W / 2 - 2;
  const maxX = cx + PLAYER_W / 2 + 2;
  const minY = topY - 2;
  const maxY = topY + PLAYER_H + 2;
  expect(x, `${label} x in bounds`).toBeGreaterThanOrEqual(minX);
  expect(x, `${label} x in bounds`).toBeLessThanOrEqual(maxX);
  expect(y, `${label} y in bounds`).toBeGreaterThanOrEqual(minY);
  expect(y, `${label} y in bounds`).toBeLessThanOrEqual(maxY);
}

function expectNoNaN(arr: Float32Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (Number.isNaN(arr[i])) throw new Error(`NaN at ${label}[${i}]`);
  }
}

function expectAllSegmentsInBounds(arr: Float32Array, label: string): void {
  for (let s = 0; s < STICKMAN_SEGMENT_COUNT; s++) {
    const b = s * STICKMAN_FLOATS_PER_SEGMENT;
    expectInBounds(arr[b], arr[b + 1], `${label} seg ${s} A`);
    expectInBounds(arr[b + 2], arr[b + 3], `${label} seg ${s} B`);
  }
}

describe("computeSkeleton", () => {
  it("produces a correctly-sized Float32Array with 10 segments", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    expect(idle.length).toBe(STICKMAN_SKELETON_FLOATS);
    // 1 head circle + 1 spine + 4 arm segs + 4 leg segs = 10
    expect(STICKMAN_SEGMENT_COUNT).toBe(10);
    expect(idle.length).toBe(STICKMAN_SEGMENT_COUNT * STICKMAN_FLOATS_PER_SEGMENT);
  });

  it("head circle segment encodes center as both endpoints", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    // Segment 0 = head circle: [centerX, centerY, centerX, centerY]
    expect(idle[0]).toBe(cx);
    expect(idle[1]).toBeCloseTo(topY + 1, 5); // HEAD_CY = 1.0
    expect(idle[2]).toBe(cx);
    expect(idle[3]).toBeCloseTo(topY + 1, 5);
  });

  it("getHeadRadius returns HEAD_R", () => {
    expect(getHeadRadius()).toBe(HEAD_R);
  });

  it("spine segment is neck -> hip", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    const b = 1 * STICKMAN_FLOATS_PER_SEGMENT; // segment 1 = spine
    expect(idle[b]).toBe(cx);
    expect(idle[b + 1]).toBeCloseTo(topY + 1.8, 5); // NECK_Y
    expect(idle[b + 2]).toBe(cx);
    expect(idle[b + 3]).toBeCloseTo(topY + HIP_Y, 5);
  });

  it("idle pose: no NaN, all joints in bounds", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    expectNoNaN(idle, "idle");
    expectAllSegmentsInBounds(idle, "idle");
  });

  it("idle pose: knees are straight (on the hip->foot line)", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    // Legs start at segment 6 (0=head, 1=spine, 2-5=arms, 6-9=legs)
    const legsBase = 6 * STICKMAN_FLOATS_PER_SEGMENT;
    const kneeLx = idle[legsBase + 2]; // B endpoint of leg seg 0
    const kneeLy = idle[legsBase + 3];
    const kneeRx = idle[legsBase + 2 * STICKMAN_FLOATS_PER_SEGMENT + 2]; // B of leg seg 2
    const kneeRy = idle[legsBase + 2 * STICKMAN_FLOATS_PER_SEGMENT + 3];
    expect(kneeLx).toBeCloseTo(cx, 5);
    expect(kneeLy).toBeCloseTo(topY + HIP_Y + LEG_LEN * UPPER_LIMB_FRAC, 5);
    expect(kneeRx).toBeCloseTo(cx, 5);
    expect(kneeRy).toBeCloseTo(topY + HIP_Y + LEG_LEN * UPPER_LIMB_FRAC, 5);
  });

  it("idle pose: arms rest slightly outward from center", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    // Arms start at segment 2 (0=head, 1=spine, 2-5=arms)
    const armsBase = 2 * STICKMAN_FLOATS_PER_SEGMENT;
    // handL = B endpoint of arm seg 1 (segment 3)
    const handLx = idle[armsBase + STICKMAN_FLOATS_PER_SEGMENT + 2];
    // handR = B endpoint of arm seg 3 (segment 5)
    const handRx = idle[armsBase + 3 * STICKMAN_FLOATS_PER_SEGMENT + 2];
    expect(handLx).toBeLessThan(cx);
    expect(handRx).toBeGreaterThan(cx);
    expect(handLx).toBeCloseTo(cx - IDLE_ARM_OUT, 5);
    expect(handRx).toBeCloseTo(cx + IDLE_ARM_OUT, 5);
    const handLy = idle[armsBase + STICKMAN_FLOATS_PER_SEGMENT + 3];
    expect(handLy).toBeCloseTo(topY + SHOULDER_Y + ARM_LEN, 5);
  });

  it("walk pose: no NaN, all joints in bounds, feet lift >= 0", () => {
    const walk = computeSkeleton({ cx, topY, facing: 1, animFrame: 10, vx: 0.5, onGround: true });
    expectNoNaN(walk, "walk");
    expectAllSegmentsInBounds(walk, "walk");
    const plantedFootY = topY + HIP_Y + LEG_LEN;
    // footL = B endpoint of leg seg 1 (segment 7)
    const footLBase = 7 * STICKMAN_FLOATS_PER_SEGMENT;
    // footR = B endpoint of leg seg 3 (segment 9)
    const footRBase = 9 * STICKMAN_FLOATS_PER_SEGMENT;
    expect(walk[footLBase + 3]).toBeLessThanOrEqual(plantedFootY + 1e-5);
    expect(walk[footRBase + 3]).toBeLessThanOrEqual(plantedFootY + 1e-5);
  });

  it("jump pose (in air, facing left): no NaN, all joints in bounds", () => {
    const jump = computeSkeleton({ cx, topY, facing: -1, animFrame: 5, vx: 0, onGround: false });
    expectNoNaN(jump, "jump");
    expectAllSegmentsInBounds(jump, "jump");
  });

  it("reuses an out buffer when provided", () => {
    const reuse = new Float32Array(STICKMAN_SKELETON_FLOATS);
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    const same = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true }, reuse);
    expect(same).toBe(reuse);
    expect(reuse[0]).toBe(idle[0]);
  });
});

describe("buildThickLineIndices", () => {
  it("produces a static index buffer with the correct quad pattern", () => {
    const indices = buildThickLineIndices();
    expect(indices.length).toBe(STICKMAN_INDEX_COUNT);
    expect(indices[0]).toBe(0);
    expect(indices[1]).toBe(1);
    expect(indices[2]).toBe(2);
    expect(indices[3]).toBe(0);
    expect(indices[4]).toBe(2);
    expect(indices[5]).toBe(3);
    // Second segment base = 4.
    expect(indices[6]).toBe(4);
    expect(indices[7]).toBe(5);
    expect(indices[8]).toBe(6);
  });
});

describe("buildThickLineVertices", () => {
  it("expands skeleton into quad vertices", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    const geom = buildThickLineVertices(idle);
    expect(geom.vertexCount).toBe(STICKMAN_VERTEX_COUNT);
    expect(geom.indexCount).toBe(STICKMAN_INDEX_COUNT);
    expect(geom.vertices.length).toBe(STICKMAN_VERTEX_COUNT * 8);
    expect(geom.indices.length).toBe(STICKMAN_INDEX_COUNT);
    expect(STICKMAN_VERTEX_STRIDE).toBe(32);
  });

  it("head circle vertex 0: endpointA = center, endpointB.z = radius, cornerVec = (-1,-1)", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    const geom = buildThickLineVertices(idle);
    // Vertex 0 = first vertex of segment 0 (head circle).
    // Layout: endpointA(3) endpointB(3) cornerVec(2) = 8 floats per vertex.
    expect(geom.vertices[0]).toBe(cx);       // endpointA.x = center X
    expect(geom.vertices[1]).toBeCloseTo(topY + 1, 5); // endpointA.y = center Y
    expect(geom.vertices[2]).toBe(0);        // endpointA.z = 0
    expect(geom.vertices[3]).toBe(cx);       // endpointB.x = center X
    expect(geom.vertices[4]).toBeCloseTo(topY + 1, 5); // endpointB.y = center Y
    expect(geom.vertices[5]).toBeCloseTo(HEAD_R, 5); // endpointB.z = radius (circle signal)
    expect(geom.vertices[6]).toBe(-1);       // cornerVec.x = -1
    expect(geom.vertices[7]).toBe(-1);       // cornerVec.y = -1
  });

  it("line segment vertex: endpointB.z = 0 (no circle signal)", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    const geom = buildThickLineVertices(idle);
    // Segment 1 = spine, vertex 0 = at index 4*8 = 32.
    const v0 = 4 * 8;
    expect(geom.vertices[v0 + 5]).toBe(0); // endpointB.z = 0 (line, not circle)
  });

  it("reuses a geom's vertices buffer when passed back in", () => {
    const idle = computeSkeleton({ cx, topY, facing: 1, animFrame: 0, vx: 0, onGround: true });
    const walk = computeSkeleton({ cx, topY, facing: 1, animFrame: 10, vx: 0.5, onGround: true });
    const geom = buildThickLineVertices(idle);
    const geom2 = buildThickLineVertices(walk, geom);
    expect(geom2).toBe(geom);
    expect(geom.vertices[0]).toBe(walk[0]);
  });

  it("throws on a too-small skeleton", () => {
    expect(() => buildThickLineVertices(new Float32Array(4))).toThrow(/skeleton too small/);
  });
});
