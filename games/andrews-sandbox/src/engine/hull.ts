// ============================================================================
// Convex hull point-cloud generation for prop colliders.
//
// Props spawn with a placeholder box collider; once their model geometry is
// loaded, the renderer derives a convex hull from the mesh and sends it to the
// sim, which swaps the box for a Rapier convex collider.
//
// The physics backend (Rapier) computes the actual convex hull from the point
// cloud we hand it — `ColliderDesc.convexHull` returns the *smallest* convex
// shape containing all the points and discards interior/collinear points, so
// the resulting hull is the tightest convex enclosure of the mesh with only
// extreme points as vertices. That is already far lower-resolution than the
// mesh (which may have thousands of faces) while following the convex contours
// exactly. We therefore pass the full vertex set rather than downsampling —
// voxel downsampling with outermost-per-voxel was making the hull bulge beyond
// the mesh surface (up to a voxel size of looseness), which is why colliders
// didn't match the meshes.
// ============================================================================

import type { MeshData } from "@downdraft/library-models";

export interface HullResult {
  /** Flat vertex positions in mesh-local space (stride 3). */
  vertices: Float32Array;
  /** Axis-aligned bbox of the source mesh in mesh-local space. */
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Collect the mesh vertex positions into a flat point cloud for Rapier's
 * convexHull. Deduplicates points (exact match) to reduce the input size —
 * Rapier's hull cost scales with point count, and shared vertices across
 * primitives are redundant.
 *
 * @param meshes  Model meshes (vertices are pos3 + normal3, stride 6).
 * @returns points + bbox, or null if the mesh has no usable geometry.
 */
export function computeConvexHullPoints(
  meshes: MeshData[],
): HullResult | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (const mesh of meshes) {
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += 6) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      any = true;
    }
  }
  if (!any) return null;

  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(ext > 0)) return null;

  // Reject near-flat meshes: a coplanar point cloud produces a degenerate
  // (2D) convex hull, which Rapier rejects and falls back to a unit ball —
  // worse than the placeholder box. If the thinnest bbox dimension is a
  // tiny fraction of the longest, leave the box collider in place.
  const minExt = Math.min(maxX - minX, maxY - minY, maxZ - minZ);
  if (minExt < ext * 0.02) return null;

  // Collect unique vertex positions. Exact dedup via a Set of packed keys.
  // Quantize to 1e-5 to merge near-duplicates from different primitives
  // (float rounding) without losing real surface points.
  const seen = new Set<number>();
  const pts: number[] = [];
  for (const mesh of meshes) {
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += 6) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      // Pack into a single integer key (9 bits each, ~0.5mm precision for
      // props up to ~256m — plenty). Avoids string-key overhead.
      const qx = Math.round(x * 1e5) & 0x1ffff;
      const qy = Math.round(y * 1e5) & 0x1ffff;
      const qz = Math.round(z * 1e5) & 0x1ffff;
      const key = (qx << 36) | (qy << 18) | qz;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push(x, y, z);
    }
  }

  return {
    vertices: new Float32Array(pts),
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

// ============================================================================
// 3D convex hull (incremental beneath-beyond) — used for the debug wireframe
// overlay so the collider can be visually compared against the mesh. Returns
// triangle indices into the deduplicated point cloud. Computed once per
// contentId and cached by the caller.
// ============================================================================

interface HullFace {
  a: number; b: number; c: number; // vertex indices (CCW when viewed from outside)
  nx: number; ny: number; nz: number; // outward unit normal
  d: number; // plane: nx*x + ny*y + nz*z + d = 0
}

function facePlane(verts: Float32Array, a: number, b: number, c: number): HullFace {
  const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
  const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
  const cx = verts[c * 3], cy = verts[c * 3 + 1], cz = verts[c * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const d = -(nx * ax + ny * ay + nz * az);
  return { a, b, c, nx, ny, nz, d };
}

/**
 * Compute the convex hull of a point cloud as triangle indices.
 * @param verts  Flat positions, stride 3.
 * @returns Uint32Array of triangle vertex indices (length = 3 × faceCount),
 *          or null if the points are degenerate (coplanar/collinear).
 */
export function computeConvexHullFaces(verts: Float32Array): Uint32Array | null {
  const n = verts.length / 3;
  if (n < 4) return null;

  // Find 4 non-coplanar points for the initial tetrahedron.
  // 0 = first point. 1 = farthest from 0. 2 = farthest from line 0-1.
  // 3 = farthest from plane 0-1-2.
  let i1 = 1;
  let bestD = -1;
  for (let i = 1; i < n; i++) {
    const d = dist2(verts, 0, i);
    if (d > bestD) { bestD = d; i1 = i; }
  }
  if (bestD <= 0) return null;
  let i2 = 1 === i1 ? 0 : 1;
  bestD = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === i1) continue;
    const d = pointLineDist2(verts, 0, i1, i);
    if (d > bestD) { bestD = d; i2 = i; }
  }
  if (bestD <= 1e-12) return null;
  const f0 = facePlane(verts, 0, i1, i2);
  let i3 = -1;
  bestD = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === i1 || i === i2) continue;
    const d = Math.abs(signedDist(verts, i, f0));
    if (d > bestD) { bestD = d; i3 = i; }
  }
  if (i3 < 0 || bestD <= 1e-9) return null; // coplanar

  // Build initial tetrahedron. Winding may be wrong — fixed below by checking
  // each face against the centroid.
  let faces: HullFace[] = [
    facePlane(verts, 0, i1, i2),
    facePlane(verts, 0, i2, i3),
    facePlane(verts, 0, i3, i1),
    facePlane(verts, i1, i3, i2),
  ];
  // Fix winding: for each face, if the centroid is on the positive side
  // (normal points inward), flip the winding so normals point outward.
  const cx = (verts[0] + verts[i1 * 3] + verts[i2 * 3] + verts[i3 * 3]) / 4;
  const cy = (verts[1] + verts[i1 * 3 + 1] + verts[i2 * 3 + 1] + verts[i3 * 3 + 1]) / 4;
  const cz = (verts[2] + verts[i1 * 3 + 2] + verts[i2 * 3 + 2] + verts[i3 * 3 + 2]) / 4;
  for (let f = 0; f < faces.length; f++) {
    const fc = faces[f];
    if (fc.nx * cx + fc.ny * cy + fc.nz * cz + fc.d > 0) {
      faces[f] = facePlane(verts, fc.a, fc.c, fc.b); // flip winding
    }
  }

  const used = new Set([0, i1, i2, i3]);
  const EPS = 1e-9;

  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    used.add(p);

    // Find visible faces (point is outside, positive signed distance).
    const visible = new Set<number>();
    for (let f = 0; f < faces.length; f++) {
      if (signedDist(verts, p, faces[f]) > EPS) visible.add(f);
    }
    if (visible.size === 0) continue; // inside the hull

    // Collect horizon edges: edges of visible faces that border a non-visible
    // face. An edge (a,b) appears once in the visible set (as a→b) — it's the
    // horizon if its reverse (b→a) is NOT an edge of any other visible face.
    // Track edge counts among visible faces; horizon edges appear exactly once.
    const edgeCount = new Map<string, number>();
    const edgeList: Array<[number, number]> = [];
    for (const fi of visible) {
      const fc = faces[fi];
      for (const [u, v] of [[fc.a, fc.b], [fc.b, fc.c], [fc.c, fc.a]] as Array<[number, number]>) {
        const key = u < v ? u + "_" + v : v + "_" + u;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
        edgeList.push([u, v]);
      }
    }
    // Horizon edges: directed edges (u,v) whose undirected pair appears once.
    const horizon: Array<[number, number]> = [];
    for (const [u, v] of edgeList) {
      const key = u < v ? u + "_" + v : v + "_" + u;
      if (edgeCount.get(key) === 1) horizon.push([u, v]);
    }

    // Remove visible faces (build new array keeping non-visible).
    const newFaces: HullFace[] = [];
    for (let f = 0; f < faces.length; f++) {
      if (!visible.has(f)) newFaces.push(faces[f]);
    }
    // Add a new outward face for each horizon edge.
    for (const [u, v] of horizon) {
      newFaces.push(facePlane(verts, u, v, p));
    }
    faces = newFaces;
  }

  const out = new Uint32Array(faces.length * 3);
  for (let f = 0; f < faces.length; f++) {
    out[f * 3] = faces[f].a;
    out[f * 3 + 1] = faces[f].b;
    out[f * 3 + 2] = faces[f].c;
  }
  return out;
}

function dist2(verts: Float32Array, i: number, j: number): number {
  const dx = verts[i * 3] - verts[j * 3];
  const dy = verts[i * 3 + 1] - verts[j * 3 + 1];
  const dz = verts[i * 3 + 2] - verts[j * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

function pointLineDist2(verts: Float32Array, a: number, b: number, p: number): number {
  const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
  const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
  const px = verts[p * 3], py = verts[p * 3 + 1], pz = verts[p * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = px - ax, vy = py - ay, vz = pz - az;
  const dot = ux * vx + uy * vy + uz * vz;
  const ulen2 = ux * ux + uy * uy + uz * uz || 1;
  const t = dot / ulen2;
  const cx = ax + t * ux, cy = ay + t * uy, cz = az + t * uz;
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
}

function signedDist(verts: Float32Array, i: number, f: HullFace): number {
  return f.nx * verts[i * 3] + f.ny * verts[i * 3 + 1] + f.nz * verts[i * 3 + 2] + f.d;
}
