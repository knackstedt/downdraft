// Thick-line geometry builder.
//
// Expands each skeleton segment into a camera-facing quad (2 triangles).
// Two segment types:
//
//   Line segments (index > 0): endpointA = start, endpointB = end, cornerVec = (t, side).
//     The shader extrudes a constant-width stroke perpendicular to the segment.
//
//   Circle segment (index 0, the head): endpointA = endpointB = center.
//     The builder encodes the radius in endpointB.z. cornerVec = (±1, ±1).
//     The shader expands the quad to the circle's bounding box and uses an
//     SDF in the fragment shader to draw a perfect circle ring.
//
// Vertex layout (arrayStride = 32 bytes):
//   location 0: float32x3  endpointA
//   location 1: float32x3  endpointB  (z = radius for circle, 0 for line)
//   location 2: float32x2  cornerVec  (t,side for line; cornerX,cornerY for circle)

import { STICKMAN_FLOATS_PER_SEGMENT, STICKMAN_SEGMENT_COUNT, getHeadRadius } from "./skeleton";

// Line segment corners: (t=0,side=-1), (t=0,side=+1), (t=1,side=+1), (t=1,side=-1).
const LINE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [1, 1],
  [1, -1],
];

// Circle quad corners: (-1,-1), (1,-1), (1,1), (-1,1) — full bounding box.
const CIRCLE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export const STICKMAN_VERTEX_COUNT = STICKMAN_SEGMENT_COUNT * 4;
export const STICKMAN_INDEX_COUNT = STICKMAN_SEGMENT_COUNT * 6;
export const STICKMAN_VERTEX_STRIDE = 32; // bytes: 3 + 3 + 2 floats

export interface ThickLineGeometry {
  /** Float32Array of length STICKMAN_VERTEX_COUNT * 8 (reused each frame). */
  vertices: Float32Array;
  /** Uint16Array of length STICKMAN_INDEX_COUNT (built once, static). */
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * Build the static index buffer for the stickman quads. Call once at init.
 */
export function buildThickLineIndices(out?: Uint16Array): Uint16Array {
  const idx = out && out.length >= STICKMAN_INDEX_COUNT ? out : new Uint16Array(STICKMAN_INDEX_COUNT);
  let p = 0;
  for (let s = 0; s < STICKMAN_SEGMENT_COUNT; s++) {
    const b = s * 4;
    idx[p++] = b + 0; idx[p++] = b + 1; idx[p++] = b + 2;
    idx[p++] = b + 0; idx[p++] = b + 2; idx[p++] = b + 3;
  }
  return idx;
}

/**
 * Expand a skeleton into quad vertices. Segment 0 is the head circle (radius
 * encoded in endpointB.z); all other segments are thick lines.
 *
 * @param skeleton Float32Array from `computeSkeleton` (length >= STICKMAN_SKELETON_FLOATS).
 * @param geom Optional existing geometry to reuse (its `vertices` buffer is overwritten).
 */
export function buildThickLineVertices(skeleton: Float32Array, geom?: ThickLineGeometry): ThickLineGeometry {
  if (skeleton.length < STICKMAN_SEGMENT_COUNT * STICKMAN_FLOATS_PER_SEGMENT) {
    throw new Error(`skeleton too small: ${skeleton.length} < ${STICKMAN_SEGMENT_COUNT * STICKMAN_FLOATS_PER_SEGMENT}`);
  }
  const vertices = geom?.vertices && geom.vertices.length >= STICKMAN_VERTEX_COUNT * 8
    ? geom.vertices
    : new Float32Array(STICKMAN_VERTEX_COUNT * 8);
  const indices = geom?.indices ?? buildThickLineIndices();
  const headR = getHeadRadius();

  let v = 0;
  for (let s = 0; s < STICKMAN_SEGMENT_COUNT; s++) {
    const base = s * STICKMAN_FLOATS_PER_SEGMENT;
    const ax = skeleton[base + 0];
    const ay = skeleton[base + 1];
    const bx = skeleton[base + 2];
    const by = skeleton[base + 3];

    if (s === 0) {
      // Head circle: endpointA = center, endpointB.z = radius.
      // cornerVec = (cornerX, cornerY) ∈ {-1,+1}².
      for (let c = 0; c < 4; c++) {
        const [cx, cy] = CIRCLE_CORNERS[c];
        vertices[v++] = ax; vertices[v++] = ay; vertices[v++] = 0;       // endpointA = center
        vertices[v++] = ax; vertices[v++] = ay; vertices[v++] = headR;    // endpointB = (center, radius)
        vertices[v++] = cx; vertices[v++] = cy;                            // cornerVec
      }
    } else {
      // Line segment: endpointA = start, endpointB = end (z=0).
      // cornerVec = (t, side).
      for (let c = 0; c < 4; c++) {
        const [t, side] = LINE_CORNERS[c];
        vertices[v++] = ax; vertices[v++] = ay; vertices[v++] = 0;
        vertices[v++] = bx; vertices[v++] = by; vertices[v++] = 0;
        vertices[v++] = t;  vertices[v++] = side;
      }
    }
  }

  if (geom) {
    geom.vertices = vertices;
    geom.indices = indices;
    geom.vertexCount = STICKMAN_VERTEX_COUNT;
    geom.indexCount = STICKMAN_INDEX_COUNT;
    return geom;
  }
  return {
    vertices,
    indices,
    vertexCount: STICKMAN_VERTEX_COUNT,
    indexCount: STICKMAN_INDEX_COUNT,
  };
}
