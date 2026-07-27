// ============================================================================
// Boat Design Runtime Geometry — watertight mesh, mass, collision, and buoyancy
// ============================================================================

import type { Vec2, Vec3, Quat, BoatDesign, HullBody, DeckLevel } from "./types";

const EPS = 1e-6;

export interface Triangle {
  v0: Vec3;
  v1: Vec3;
  v2: Vec3;
  normal: Vec3;
  area: number;
  isWatertight: boolean;
  material?: string;
}

export interface MassProperties {
  mass: number;
  invMass: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  Ixx: number;
  Iyy: number;
  Izz: number;
  invIxx: number;
  invIyy: number;
  invIzz: number;
  radius: number;
  halfLength: number;
  halfWidth: number;
}

export interface VerticalInterval {
  y0: number;
  y1: number;
}

export interface Bounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface WaterSampler {
  (worldX: number, worldZ: number): number;
}

export interface BuoyancySampleResult {
  totalForceY: number;
  totalTorqueX: number;
  totalTorqueZ: number;
  submergedVolume: number;
  submergedSamples: number;
}

interface SampleGrid {
  x0: number;
  z0: number;
  step: number;
  requestedStep: number;
  nx: number;
  nz: number;
  intervals: (VerticalInterval[] | null)[];
}

export const DEFAULT_HULL_DENSITY = 800; // kg/m³ (fiberglass / wood composite)

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function quatRotate(q: Quat, v: Vec3): Vec3 {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

function transformPoint(pos: Vec3, rot: Quat, p: Vec3): Vec3 {
  const r = quatRotate(rot, p);
  return { x: r.x + pos.x, y: r.y + pos.y, z: r.z + pos.z };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function mul(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function lenSq(a: Vec3): number {
  return dot(a, a);
}

function normalize(a: Vec3): Vec3 {
  const l = Math.sqrt(lenSq(a));
  if (l < EPS) return { x: 0, y: 0, z: 0 };
  const s = 1 / l;
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function polyCentroid2D(points: Vec2[]): Vec2 {
  let cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    cx += points[i].x;
    cy += points[i].y;
  }
  const n = points.length || 1;
  return { x: cx / n, y: cy / n };
}

function polygonPerimeter(points: Vec2[]): number {
  let len = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/** Resample a closed 2D polygon to target count by walking edges at even spacing. */
function resamplePolygon(points: Vec2[], target: number): Vec2[] {
  if (points.length === target) return points;
  if (points.length < 3 || target < 3) return points;
  const perim = polygonPerimeter(points);
  if (perim < EPS) return points;
  const step = perim / target;
  const out: Vec2[] = [];
  let remaining = 0;
  let segIdx = 0;
  let segLen = 0;
  let segDx = 0, segDy = 0;
  let p0 = points[0];

  function initSeg(): void {
    const p1 = points[(segIdx + 1) % points.length];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen > EPS) {
      segDx = dx / segLen;
      segDy = dy / segLen;
    } else {
      segDx = 0;
      segDy = 0;
    }
  }

  initSeg();

  for (let i = 0; i < target; i++) {
    let dist = i * step + remaining;
    while (segLen > EPS && dist > segLen - EPS) {
      dist -= segLen;
      segIdx = (segIdx + 1) % points.length;
      p0 = points[segIdx];
      initSeg();
    }
    if (segLen > EPS) {
      out.push({ x: p0.x + segDx * dist, y: p0.y + segDy * dist });
    } else {
      out.push({ x: p0.x, y: p0.y });
    }
  }
  return out;
}

/** Triangulate a convex-ish polygon as a fan from its centroid. */
function triangulateFan(points: Vec2[]): number[] {
  const n = points.length;
  if (n < 3) return [];
  const c = polyCentroid2D(points);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    // centroid, p_i, p_{i+1}
    idx.push(0, i + 1, i1 + 1); // 0 is centroid index
  }
  return idx;
}

/** Build a 3D vertex list for a polygon fan at z = constant (hull station cap). */
function buildPolygonFan(points: Vec2[], z: number): { v: Vec3[]; idx: number[] } {
  const c = polyCentroid2D(points);
  const v: Vec3[] = [{ x: c.x, y: c.y, z }];
  for (let i = 0; i < points.length; i++) {
    v.push({ x: points[i].x, y: points[i].y, z });
  }
  const idx = triangulateFan(points);
  return { v, idx };
}

/** Build a 3D vertex list for a deck fan at y = constant (points are X/Z). */
function buildPolygonFanXZ(points: Vec2[], y: number): { v: Vec3[]; idx: number[] } {
  const c = polyCentroid2D(points);
  const v: Vec3[] = [{ x: c.x, y, z: c.y }];
  for (let i = 0; i < points.length; i++) {
    v.push({ x: points[i].x, y, z: points[i].y });
  }
  const idx = triangulateFan(points);
  return { v, idx };
}

function appendMesh(dst: { v: Vec3[]; idx: number[] }, src: { v: Vec3[]; idx: number[] }): void {
  const base = dst.v.length;
  for (let i = 0; i < src.v.length; i++) dst.v.push(src.v[i]);
  for (let i = 0; i < src.idx.length; i++) dst.idx.push(src.idx[i] + base);
}

/** Build the side surface between two station polygons (same vertex count). */
function loftStations(
  a: { z: number; points: Vec2[] },
  b: { z: number; points: Vec2[] },
): { v: Vec3[]; idx: number[] } {
  const n = a.points.length;
  const v: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    v.push({ x: a.points[i].x, y: a.points[i].y, z: a.z });
  }
  for (let i = 0; i < n; i++) {
    v.push({ x: b.points[i].x, y: b.points[i].y, z: b.z });
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    const a0 = i;
    const a1 = i1;
    const b0 = i + n;
    const b1 = i1 + n;
    // Note: orientation is fixed later by volume sign flip
    idx.push(a0, b0, a1, b0, b1, a1);
  }
  return { v, idx };
}

/** Generate raw position/index buffers for one hull body. */
function generateHullBodyMesh(body: HullBody): { v: Vec3[]; idx: number[] } {
  const mesh: { v: Vec3[]; idx: number[] } = { v: [], idx: [] };
  if (body.stations.length < 2) return mesh;

  // Common resampled point count
  let target = 12;
  for (let i = 0; i < body.stations.length; i++) {
    if (body.stations[i].points.length > target) target = body.stations[i].points.length;
  }
  if (target < 3) target = 3;

  const resampled: { z: number; points: Vec2[] }[] = [];
  for (let i = 0; i < body.stations.length; i++) {
    const s = body.stations[i];
    resampled.push({ z: s.z, points: resamplePolygon(s.points, target) });
  }

  // Side surface
  for (let i = 0; i < resampled.length - 1; i++) {
    const side = loftStations(resampled[i], resampled[i + 1]);
    appendMesh(mesh, side);
  }

  // Bow cap (first station)
  const bow = buildPolygonFan(resampled[0].points, resampled[0].z);
  appendMesh(mesh, bow);

  // Stern cap (last station) — flip so normal points +Z
  const stern = buildPolygonFan(resampled[resampled.length - 1].points, resampled[resampled.length - 1].z);
  for (let i = 0; i < stern.idx.length; i += 3) {
    const t0 = stern.idx[i];
    const t1 = stern.idx[i + 1];
    const t2 = stern.idx[i + 2];
    stern.idx[i] = t0;
    stern.idx[i + 1] = t2;
    stern.idx[i + 2] = t1;
  }
  appendMesh(mesh, stern);

  // Transform vertices into body-local space (then into boat-local)
  for (let i = 0; i < mesh.v.length; i++) {
    mesh.v[i] = transformPoint(body.position, body.rotation, mesh.v[i]);
  }

  return mesh;
}

/** Generate a deck slab: top surface + vertical walls down to height - thickness. */
function generateDeckMesh(deck: DeckLevel): { v: Vec3[]; idx: number[] } {
  const mesh: { v: Vec3[]; idx: number[] } = { v: [], idx: [] };
  const h = deck.height;
  const th = Math.max(0, deck.thickness ?? 0.12);
  const top = buildPolygonFanXZ(deck.outline, h);
  appendMesh(mesh, top);

  if (th > EPS) {
    const n = deck.outline.length;
    const base = mesh.v.length;
    for (let i = 0; i < n; i++) {
      const p = deck.outline[i];
      mesh.v.push({ x: p.x, y: h, z: p.y });
      mesh.v.push({ x: p.x, y: h - th, z: p.y });
    }
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const t0 = base + i * 2;
      const t1 = base + i1 * 2;
      const b0 = base + i * 2 + 1;
      const b1 = base + i1 * 2 + 1;
      // outward-facing quad
      mesh.idx.push(t0, b0, t1, t1, b0, b1);
    }
    // underside cap
    const underside = buildPolygonFanXZ(deck.outline, h - th);
    for (let i = 0; i < underside.idx.length; i += 3) {
      const t0 = underside.idx[i];
      const t1 = underside.idx[i + 1];
      const t2 = underside.idx[i + 2];
      underside.idx[i] = t0;
      underside.idx[i + 1] = t2;
      underside.idx[i + 2] = t1;
    }
    appendMesh(mesh, underside);
  }
  return mesh;
}

interface MeshPart {
  v: Vec3[];
  idx: number[];
  isWatertight: boolean;
  material?: string;
}

function buildTriangleSoup(design: BoatDesign): { triangles: Triangle[]; bounds: Bounds; parts: MeshPart[] } {
  const parts: MeshPart[] = [];

  for (let bi = 0; bi < design.hullBodies.length; bi++) {
    const body = design.hullBodies[bi];
    const bodyMesh = generateHullBodyMesh(body);
    parts.push({ v: bodyMesh.v, idx: bodyMesh.idx, isWatertight: body.isWatertight, material: body.material });
  }

  for (let di = 0; di < design.decks.length; di++) {
    const deck = design.decks[di];
    const deckMesh = generateDeckMesh(deck);
    parts.push({ v: deckMesh.v, idx: deckMesh.idx, isWatertight: false, material: deck.material });
  }

  const triangles: Triangle[] = [];
  const v: Vec3[] = [];
  const idx: number[] = [];

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const base = v.length;
    for (let i = 0; i < part.v.length; i++) v.push(part.v[i]);
    for (let i = 0; i < part.idx.length; i++) idx.push(part.idx[i] + base);
  }

  for (let i = 0; i < idx.length; i += 3) {
    const p0 = v[idx[i]];
    const p1 = v[idx[i + 1]];
    const p2 = v[idx[i + 2]];
    if (!isFiniteVec3(p0) || !isFiniteVec3(p1) || !isFiniteVec3(p2)) continue;
    const e0 = sub(p1, p0);
    const e1 = sub(p2, p0);
    const n = cross(e0, e1);
    const area = Math.sqrt(lenSq(n)) * 0.5;
    triangles.push({
      v0: p0,
      v1: p1,
      v2: p2,
      normal: normalize(n),
      area,
      isWatertight: true,
      material: "hull",
    });
  }

  // Fix overall winding if signed volume is negative
  let signedVol = 0;
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    signedVol += dot(t.v0, cross(t.v1, t.v2)) / 6;
  }
  if (signedVol < 0) {
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i];
      const tmp = t.v1;
      t.v1 = t.v2;
      t.v2 = tmp;
      t.normal = mul(t.normal, -1);
    }
  }

  let triOffset = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const triCount = part.idx.length / 3;
    for (let i = 0; i < triCount; i++) {
      const t = triangles[triOffset + i];
      if (t) {
        t.isWatertight = part.isWatertight;
        t.material = part.material;
      }
    }
    triOffset += triCount;
  }

  const bounds: Bounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (p.x < bounds.minX) bounds.minX = p.x;
    if (p.x > bounds.maxX) bounds.maxX = p.x;
    if (p.y < bounds.minY) bounds.minY = p.y;
    if (p.y > bounds.maxY) bounds.maxY = p.y;
    if (p.z < bounds.minZ) bounds.minZ = p.z;
    if (p.z > bounds.maxZ) bounds.maxZ = p.z;
  }

  return { triangles, bounds, parts };
}

/** Compute mass properties from a triangle soup assuming uniform density. */
function computeMassProperties(triangles: Triangle[], density: number): MassProperties {
  let totalVol = 0;
  let cx = 0, cy = 0, cz = 0;

  // Accumulate centroid-weighted signed volume
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const v0 = t.v0, v1 = t.v1, v2 = t.v2;
    const vol = dot(v0, cross(v1, v2)) / 6;
    const tetCentroid = {
      x: (v0.x + v1.x + v2.x) * 0.25,
      y: (v0.y + v1.y + v2.y) * 0.25,
      z: (v0.z + v1.z + v2.z) * 0.25,
    };
    totalVol += vol;
    cx += vol * tetCentroid.x;
    cy += vol * tetCentroid.y;
    cz += vol * tetCentroid.z;
  }

  if (Math.abs(totalVol) < EPS) {
    return {
      mass: 0, invMass: 0,
      centerX: 0, centerY: 0, centerZ: 0,
      Ixx: 0, Iyy: 0, Izz: 0,
      invIxx: 0, invIyy: 0, invIzz: 0,
      radius: 1, halfLength: 1, halfWidth: 1,
    };
  }

  cx /= totalVol;
  cy /= totalVol;
  cz /= totalVol;

  const mass = totalVol * density;
  const invMass = mass > 0 ? 1 / mass : 0;

  // Inertia by point masses at tet centroids about origin, then translate to COM
  let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const v0 = t.v0, v1 = t.v1, v2 = t.v2;
    const vol = dot(v0, cross(v1, v2)) / 6;
    const m = vol * density;
    const r = {
      x: (v0.x + v1.x + v2.x) * 0.25,
      y: (v0.y + v1.y + v2.y) * 0.25,
      z: (v0.z + v1.z + v2.z) * 0.25,
    };
    const rx2 = r.x * r.x, ry2 = r.y * r.y, rz2 = r.z * r.z;
    ixx += m * (ry2 + rz2);
    iyy += m * (rx2 + rz2);
    izz += m * (rx2 + ry2);
    ixy -= m * r.x * r.y;
    ixz -= m * r.x * r.z;
    iyz -= m * r.y * r.z;
  }

  // Parallel axis theorem to COM
  const rx2 = cx * cx, ry2 = cy * cy, rz2 = cz * cz;
  const pxx = mass * (ry2 + rz2);
  const pyy = mass * (rx2 + rz2);
  const pzz = mass * (rx2 + ry2);
  const pxy = -mass * cx * cy;
  const pxz = -mass * cx * cz;
  const pyz = -mass * cy * cz;

  const Ixx = ixx - pxx;
  const Iyy = iyy - pyy;
  const Izz = izz - pzz;

  // For games we treat off-diagonal terms as small and use principal diagonal inertias
  return {
    mass,
    invMass,
    centerX: cx, centerY: cy, centerZ: cz,
    Ixx: Math.max(0, Ixx),
    Iyy: Math.max(0, Iyy),
    Izz: Math.max(0, Izz),
    invIxx: Ixx > 0 ? 1 / Ixx : 0,
    invIyy: Iyy > 0 ? 1 / Iyy : 0,
    invIzz: Izz > 0 ? 1 / Izz : 0,
    radius: 1,
    halfLength: 1,
    halfWidth: 1,
  };
}

function finalizeMassProperties(props: MassProperties, triangles: Triangle[]): MassProperties {
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let maxR = 0;
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    for (let j = 0; j < 3; j++) {
      const p = j === 0 ? t.v0 : j === 1 ? t.v1 : t.v2;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      const dx = p.x - props.centerX;
      const dz = p.z - props.centerZ;
      const r = Math.sqrt(dx * dx + dz * dz);
      if (r > maxR) maxR = r;
    }
  }
  props.halfWidth = (maxX - minX) * 0.5;
  props.halfLength = (maxZ - minZ) * 0.5;
  props.radius = maxR > 0 ? maxR : Math.max(props.halfWidth, props.halfLength) * 1.2;
  return props;
}

function polygonAreaAndCentroid2D(points: Vec2[]): { area: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % n];
    const cross = p0.x * p1.y - p1.x * p0.y;
    a += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (a < 0) {
    a = -a;
    cx = -cx;
    cy = -cy;
  }
  if (a < EPS) {
    return { area: 0, cx: 0, cy: 0 };
  }
  const factor = 1 / (6 * a * 0.5); // a is twice signed area; 6*area = 3*a
  // Wait: area = a/2, and centroid formula divides by 6*area = 3*a.
  return { area: a * 0.5, cx: cx / (3 * a), cy: cy / (3 * a) };
}

function computeMassPropertiesFromDesign(design: BoatDesign, density: number): MassProperties {
  let totalMass = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;
  let ixx = 0;
  let iyy = 0;
  let izz = 0;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  function addPart(mass: number, com: Vec3, Ilocal: { Ixx: number; Iyy: number; Izz: number }): void {
    if (mass <= 0 || !Number.isFinite(mass)) return;
    totalMass += mass;
    momentX += mass * com.x;
    momentY += mass * com.y;
    momentZ += mass * com.z;
    const r2 = com.x * com.x + com.y * com.y + com.z * com.z;
    ixx += Ilocal.Ixx + mass * (r2 - com.x * com.x);
    iyy += Ilocal.Iyy + mass * (r2 - com.y * com.y);
    izz += Ilocal.Izz + mass * (r2 - com.z * com.z);
  }

  function updateBounds(p: Vec3): void {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  function boxInertia(m: number, dx: number, dy: number, dz: number): { Ixx: number; Iyy: number; Izz: number } {
    return {
      Ixx: (m / 12) * (dy * dy + dz * dz),
      Iyy: (m / 12) * (dx * dx + dz * dz),
      Izz: (m / 12) * (dx * dx + dy * dy),
    };
  }

  // Hull bodies: integrate station cross-sections as prismatic segments.
  for (let bi = 0; bi < design.hullBodies.length; bi++) {
    const body = design.hullBodies[bi];
    const bodyDensity = body.density ?? density;
    const stations = body.stations;
    if (stations.length < 2) continue;

    const transformedCentroids: Vec3[] = new Array(stations.length);
    const areas: number[] = new Array(stations.length);

    for (let si = 0; si < stations.length; si++) {
      const s = stations[si];
      const ac = polygonAreaAndCentroid2D(s.points);
      areas[si] = ac.area;
      const localCentroid: Vec3 = { x: ac.cx, y: ac.cy, z: s.z };
      transformedCentroids[si] = transformPoint(body.position, body.rotation, localCentroid);

      // Include all station points in bounds
      for (let pi = 0; pi < s.points.length; pi++) {
        const p: Vec3 = { x: s.points[pi].x, y: s.points[pi].y, z: s.z };
        updateBounds(transformPoint(body.position, body.rotation, p));
      }
    }

    for (let si = 0; si < stations.length - 1; si++) {
      const a0 = areas[si];
      const a1 = areas[si + 1];
      if (a0 <= 0 && a1 <= 0) continue;
      const z0 = stations[si].z;
      const z1 = stations[si + 1].z;
      const dz = z1 - z0;
      const vol = ((a0 + a1) * 0.5) * dz;
      const mass = vol * bodyDensity;
      const totalA = a0 + a1;
      const com: Vec3 = totalA > 0
        ? {
            x: (transformedCentroids[si].x * a0 + transformedCentroids[si + 1].x * a1) / totalA,
            y: (transformedCentroids[si].y * a0 + transformedCentroids[si + 1].y * a1) / totalA,
            z: (transformedCentroids[si].z * a0 + transformedCentroids[si + 1].z * a1) / totalA,
          }
        : { x: 0, y: 0, z: 0 };

      // Segment bounding box from the two end stations
      let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity, szMin = Infinity, szMax = -Infinity;
      for (let k = 0; k < 2; k++) {
        const sidx = si + k;
        const s = stations[sidx];
        for (let pi = 0; pi < s.points.length; pi++) {
          const p: Vec3 = { x: s.points[pi].x, y: s.points[pi].y, z: s.z };
          const t = transformPoint(body.position, body.rotation, p);
          if (t.x < sxMin) sxMin = t.x;
          if (t.x > sxMax) sxMax = t.x;
          if (t.y < syMin) syMin = t.y;
          if (t.y > syMax) syMax = t.y;
          if (t.z < szMin) szMin = t.z;
          if (t.z > szMax) szMax = t.z;
        }
      }
      const dx = Math.max(sxMax - sxMin, EPS);
      const dy = Math.max(syMax - syMin, EPS);
      const dzz = Math.max(szMax - szMin, EPS);
      addPart(mass, com, boxInertia(mass, dx, dy, dzz));
    }
  }

  // Decks: uniform slabs in the XZ plane.
  for (let di = 0; di < design.decks.length; di++) {
    const deck = design.decks[di];
    const ac = polygonAreaAndCentroid2D(deck.outline);
    const thickness = deck.thickness ?? 0.12;
    const vol = ac.area * thickness;
    const mass = vol * density;
    const com: Vec3 = { x: ac.cx, y: deck.height - thickness * 0.5, z: ac.cy };

    let dxMin = Infinity, dxMax = -Infinity, dzMin = Infinity, dzMax = -Infinity;
    for (let i = 0; i < deck.outline.length; i++) {
      const p = deck.outline[i];
      if (p.x < dxMin) dxMin = p.x;
      if (p.x > dxMax) dxMax = p.x;
      if (p.y < dzMin) dzMin = p.y;
      if (p.y > dzMax) dzMax = p.y;
    }
    const dx = Math.max(dxMax - dxMin, EPS);
    const dy = thickness;
    const dz = Math.max(dzMax - dzMin, EPS);
    addPart(mass, com, boxInertia(mass, dx, dy, dz));

    for (let i = 0; i < deck.outline.length; i++) {
      const p = deck.outline[i];
      updateBounds({ x: p.x, y: deck.height, z: p.y });
      updateBounds({ x: p.x, y: deck.height - thickness, z: p.y });
    }
  }

  if (totalMass <= 0) {
    return {
      mass: 0, invMass: 0,
      centerX: 0, centerY: 0, centerZ: 0,
      Ixx: 0, Iyy: 0, Izz: 0,
      invIxx: 0, invIyy: 0, invIzz: 0,
      radius: 1, halfLength: 1, halfWidth: 1,
    };
  }

  const invM = 1 / totalMass;
  const invMass = totalMass > 0 ? invM : 0;
  const cx = momentX * invM;
  const cy = momentY * invM;
  const cz = momentZ * invM;

  const R2 = cx * cx + cy * cy + cz * cz;
  const IxxCOM = ixx - totalMass * (R2 - cx * cx);
  const IyyCOM = iyy - totalMass * (R2 - cy * cy);
  const IzzCOM = izz - totalMass * (R2 - cz * cz);

  const dx0 = Math.max(Math.abs(maxX - cx), Math.abs(minX - cx));
  const dy0 = Math.max(Math.abs(maxY - cy), Math.abs(minY - cy));
  const dz0 = Math.max(Math.abs(maxZ - cz), Math.abs(minZ - cz));
  const radius = Math.sqrt(dx0 * dx0 + dz0 * dz0);

  return {
    mass: totalMass,
    invMass,
    centerX: cx,
    centerY: cy,
    centerZ: cz,
    Ixx: Math.max(0, IxxCOM),
    Iyy: Math.max(0, IyyCOM),
    Izz: Math.max(0, IzzCOM),
    invIxx: IxxCOM > 0 ? 1 / IxxCOM : 0,
    invIyy: IyyCOM > 0 ? 1 / IyyCOM : 0,
    invIzz: IzzCOM > 0 ? 1 / IzzCOM : 0,
    radius,
    halfLength: (maxZ - minZ) * 0.5,
    halfWidth: (maxX - minX) * 0.5,
  };
}

function barycentricYAtPoint(
  x: number,
  z: number,
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
): { u: number; v: number; y: number } | null {
  const x0 = p0.x, z0 = p0.z;
  const x1 = p1.x, z1 = p1.z;
  const x2 = p2.x, z2 = p2.z;
  const denom = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0);
  if (Math.abs(denom) < EPS) return null;
  const u = ((x - x0) * (z2 - z0) - (x2 - x0) * (z - z0)) / denom;
  const v = ((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0)) / denom;
  if (u < -EPS || v < -EPS || u + v > 1 + EPS) return null;
  const y = p0.y + u * (p1.y - p0.y) + v * (p2.y - p0.y);
  return { u, v, y };
}

/** Compute all vertical intersections of a ray at (x,z) with a triangle soup. */
function verticalIntersections(triangles: Triangle[], x: number, z: number): number[] {
  const ys: number[] = [];
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const hit = barycentricYAtPoint(x, z, t.v0, t.v1, t.v2);
    if (hit) ys.push(hit.y);
  }
  ys.sort((a, b) => a - b);
  return ys;
}

function buildVerticalIntervals(triangles: Triangle[], x: number, z: number): VerticalInterval[] {
  const ys = verticalIntersections(triangles, x, z);
  // Merge coplanar hits (seams/duplicate faces) so the pairing below represents
  // actual entry/exit points through the hull volume.
  const unique: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    if (i === 0 || Math.abs(ys[i] - ys[i - 1]) > EPS) unique.push(ys[i]);
  }
  const intervals: VerticalInterval[] = [];
  for (let i = 0; i + 1 < unique.length; i += 2) {
    if (unique[i + 1] - unique[i] > EPS) {
      intervals.push({ y0: unique[i], y1: unique[i + 1] });
    }
  }
  return intervals;
}

export class RuntimeBoatGeometry {
  private design: BoatDesign;
  private triangles: Triangle[] = [];
  private watertightTriangles: Triangle[] = [];
  private bounds: Bounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private massProps: MassProperties;
  private density: number;
  private sampleGrid: SampleGrid | null = null;

  // Cached mesh buffers (invalidated on rebuild)
  private meshBuffers: { positions: Float32Array; normals: Float32Array; indices: Uint32Array } | null = null;

  // Cached buoyancy interval result (per-call x,z key)
  private buoyancyIntervalCache: { x: number; z: number; result: VerticalInterval[] } | null = null;

  constructor(design: BoatDesign, density = DEFAULT_HULL_DENSITY) {
    this.design = design;
    this.density = density;
    this.massProps = {
      mass: 0, invMass: 0,
      centerX: 0, centerY: 0, centerZ: 0,
      Ixx: 0, Iyy: 0, Izz: 0,
      invIxx: 0, invIyy: 0, invIzz: 0,
      radius: 1, halfLength: 1, halfWidth: 1,
    };
    this.rebuild(design, density);
  }

  rebuild(design: BoatDesign, density = this.density): void {
    this.design = design;
    this.density = density;
    const soup = buildTriangleSoup(design);
    this.triangles = soup.triangles;
    this.bounds = soup.bounds;
    this.watertightTriangles = [];
    for (let i = 0; i < this.triangles.length; i++) {
      if (this.triangles[i].isWatertight) this.watertightTriangles.push(this.triangles[i]);
    }
    this.massProps = computeMassPropertiesFromDesign(design, density);
    this.sampleGrid = null;
    this.meshBuffers = null;
    this.buoyancyIntervalCache = null;
  }

  getTriangles(): readonly Triangle[] { return this.triangles; }
  getWatertightTriangles(): readonly Triangle[] { return this.watertightTriangles; }
  getBounds(): Bounds { return this.bounds; }
  getMassProperties(): MassProperties { return this.massProps; }
  getCollisionRadius(): number { return this.massProps.radius; }
  getHalfLength(): number { return this.massProps.halfLength; }
  getHalfWidth(): number { return this.massProps.halfWidth; }
  getDesign(): BoatDesign { return this.design; }

  getHeightAt(x: number, z: number): number {
    let bestY = -Infinity;
    let bestAnyY = -Infinity;
    for (let i = 0; i < this.triangles.length; i++) {
      const t = this.triangles[i];
      const hit = barycentricYAtPoint(x, z, t.v0, t.v1, t.v2);
      if (!hit) continue;
      if (hit.y > bestAnyY) bestAnyY = hit.y;
      if (t.normal.y > 0.15 && hit.y > bestY) bestY = hit.y;
    }
    return bestY > -Infinity ? bestY : bestAnyY;
  }

  isOverHull(x: number, z: number): boolean {
    const intervals = buildVerticalIntervals(this.triangles, x, z);
    for (let i = 0; i < intervals.length; i++) {
      if (intervals[i].y1 - intervals[i].y0 > EPS) return true;
    }
    return false;
  }

  getVerticalIntervals(x: number, z: number, watertightOnly = false): VerticalInterval[] {
    const tris = watertightOnly ? this.watertightTriangles : this.triangles;
    return buildVerticalIntervals(tris, x, z);
  }

  buildSampleGrid(step = 0.5): void {
    const b = this.bounds;
    if (!Number.isFinite(b.maxX) || !Number.isFinite(b.minX) ||
        !Number.isFinite(b.maxZ) || !Number.isFinite(b.minZ)) {
      this.sampleGrid = { x0: 0, z0: 0, step, requestedStep: step, nx: 1, nz: 1, intervals: [null] };
      return;
    }
    let effectiveStep = step;
    let nx = Math.max(1, Math.ceil((b.maxX - b.minX) / effectiveStep));
    let nz = Math.max(1, Math.ceil((b.maxZ - b.minZ) / effectiveStep));
    const MAX_SAMPLE_CELLS = 10000;
    if (nx * nz > MAX_SAMPLE_CELLS) {
      const scale = Math.sqrt((nx * nz) / MAX_SAMPLE_CELLS);
      effectiveStep = step * scale;
      nx = Math.max(1, Math.ceil((b.maxX - b.minX) / effectiveStep));
      nz = Math.max(1, Math.ceil((b.maxZ - b.minZ) / effectiveStep));
      console.error(`[GEOM] buildSampleGrid: capped grid from ${Math.ceil((b.maxX - b.minX) / step)}x${Math.ceil((b.maxZ - b.minZ) / step)} to ${nx}x${nz} (step ${effectiveStep.toFixed(2)}) — bounds too large for step ${step}`);
    }
    const intervals: (VerticalInterval[] | null)[] = new Array(nx * nz);
    let idx = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = b.minX + (ix + 0.5) * effectiveStep;
        const z = b.minZ + (iz + 0.5) * effectiveStep;
        const iv = buildVerticalIntervals(this.watertightTriangles, x, z);
        intervals[idx] = iv.length > 0 ? iv : null;
        idx++;
      }
    }
    this.sampleGrid = { x0: b.minX, z0: b.minZ, step: effectiveStep, requestedStep: step, nx, nz, intervals };
  }

  private sampleIntervalsAt(x: number, z: number): VerticalInterval[] | null {
    const g = this.sampleGrid;
    if (!g) return null;
    const ix = Math.max(0, Math.min(g.nx - 1, Math.floor((x - g.x0) / g.step)));
    const iz = Math.max(0, Math.min(g.nz - 1, Math.floor((z - g.z0) / g.step)));
    return g.intervals[iz * g.nx + ix];
  }

  getWatertightVerticalIntervals(x: number, z: number): VerticalInterval[] {
    // Check per-call cache (buoyancy often queries same x,z across frames)
    if (this.buoyancyIntervalCache &&
        this.buoyancyIntervalCache.x === x &&
        this.buoyancyIntervalCache.z === z) {
      return this.buoyancyIntervalCache.result;
    }

    const gridCached = this.sampleIntervalsAt(x, z);
    let result: VerticalInterval[];
    if (gridCached) {
      result = [];
      for (let i = 0; i < gridCached.length; i++) result.push(gridCached[i]);
    } else {
      result = buildVerticalIntervals(this.watertightTriangles, x, z);
    }

    this.buoyancyIntervalCache = { x, z, result };
    return result;
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number): { t: number; point: Vec3; normal: Vec3 } | null {
    let bestT = Infinity;
    let best: { t: number; point: Vec3; normal: Vec3 } | null = null;
    for (let i = 0; i < this.triangles.length; i++) {
      const t = this.triangles[i];
      const e1 = sub(t.v1, t.v0);
      const e2 = sub(t.v2, t.v0);
      const h = cross(dir, e2);
      const a = dot(e1, h);
      if (a > -EPS && a < EPS) continue;
      const f = 1 / a;
      const s = sub(origin, t.v0);
      const u = f * dot(s, h);
      if (u < -EPS || u > 1 + EPS) continue;
      const q = cross(s, e1);
      const v = f * dot(dir, q);
      if (v < -EPS || u + v > 1 + EPS) continue;
      const tt = f * dot(e2, q);
      if (tt > EPS && tt < bestT && tt <= maxDist) {
        bestT = tt;
        const point = { x: origin.x + dir.x * tt, y: origin.y + dir.y * tt, z: origin.z + dir.z * tt };
        best = { t: tt, point, normal: t.normal };
      }
    }
    return best;
  }

  resolvePlayerCollision(
    localX: number,
    localY: number,
    localZ: number,
    radius: number,
    _height: number,
  ): { x: number; z: number; floorY: number; onSurface: boolean } {
    const floorY = this.getHeightAt(localX, localZ);
    let x = localX;
    let z = localZ;
    let onSurface = false;

    if (Number.isFinite(floorY)) {
      if (localY <= floorY + 0.05) {
        onSurface = true;
      }
    } else {
      // No floor at this position — check if player is near the hull edge and push them in.
      // Sample points around the player to find the nearest over-hull direction.
      const searchRadius = radius + 0.5;
      const steps = 8;
      let bestDx = 0, bestDz = 0, bestDist = Infinity;
      for (let s = 0; s < steps; s++) {
        const angle = (s / steps) * Math.PI * 2;
        const sx = localX + Math.cos(angle) * searchRadius;
        const sz = localZ + Math.sin(angle) * searchRadius;
        if (this.isOverHull(sx, sz)) {
          const d = searchRadius;
          if (d < bestDist) {
            bestDist = d;
            bestDx = Math.cos(angle);
            bestDz = Math.sin(angle);
          }
        }
      }
      if (bestDist < Infinity) {
        // Push player toward the nearest over-hull point
        x = localX + bestDx * searchRadius;
        z = localZ + bestDz * searchRadius;
      }
    }

    return { x, z, floorY: Number.isFinite(floorY) ? floorY : -Infinity, onSurface };
  }

  sampleBuoyancy(
    shipPos: Vec3,
    heading: number,
    pitch: number,
    roll: number,
    waterSampler: WaterSampler,
    sampleStep = 0.5,
  ): BuoyancySampleResult {
    if (!this.sampleGrid || this.sampleGrid.requestedStep !== sampleStep) {
      this.buildSampleGrid(sampleStep);
    }

    const g = this.sampleGrid!;
    const rho = 1000; // kg/m³
    const grav = 9.8; // m/s²
    const comX = this.massProps.centerX;
    const comY = this.massProps.centerY;
    const comZ = this.massProps.centerZ;
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);
    const denomY = cosP * cosR;
    if (Math.abs(denomY) < EPS) {
      return { totalForceY: 0, totalTorqueX: 0, totalTorqueZ: 0, submergedVolume: 0, submergedSamples: 0 };
    }

    let totalForceY = 0;
    let totalTorqueX = 0;
    let totalTorqueZ = 0;
    let submergedVolume = 0;
    let submergedSamples = 0;

    for (let iz = 0; iz < g.nz; iz++) {
      for (let ix = 0; ix < g.nx; ix++) {
        const iv = g.intervals[iz * g.nx + ix];
        if (!iv || iv.length === 0) continue;

        const x = g.x0 + (ix + 0.5) * g.step;
        const z = g.z0 + (iz + 0.5) * g.step;
        const armX = x - comX;
        const armZ = z - comZ;
        const yawX = armX * cosH - armZ * sinH;
        const yawZ = armX * sinH + armZ * cosH;
        const waterHeight = waterSampler(shipPos.x + yawX, shipPos.z + yawZ);
        if (!Number.isFinite(waterHeight)) continue;

        // Solve for the local y that maps to waterHeight under pitch and roll.
        const localWaterY = comY + (waterHeight - shipPos.y - armX * sinR + armZ * sinP * cosR) / denomY;

        let submergedLength = 0;
        for (let i = 0; i < iv.length; i++) {
          const y0 = iv[i].y0;
          const y1 = iv[i].y1;
          if (localWaterY <= y0) continue;
          const top = localWaterY < y1 ? localWaterY : y1;
          submergedLength += top - y0;
        }

        if (submergedLength <= 0) continue;
        const sampleArea = g.step * g.step;
        const vol = submergedLength * sampleArea;
        const force = rho * grav * vol;
        totalForceY += force;
        // Use boat-local lever arms (not yaw-rotated) so pitch/roll torque
        // stays decoupled at every heading.
        totalTorqueX += -armZ * force;
        totalTorqueZ += armX * force;
        submergedVolume += vol;
        submergedSamples++;
      }
    }

    return { totalForceY, totalTorqueX, totalTorqueZ, submergedVolume, submergedSamples };
  }

  getMeshBuffers(): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
    if (this.meshBuffers) return this.meshBuffers;
    const count = this.triangles.length * 3;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const indices = new Uint32Array(count);
    let pi = 0;
    let ni = 0;
    let ii = 0;
    for (let i = 0; i < this.triangles.length; i++) {
      const t = this.triangles[i];
      positions[pi++] = t.v0.x; positions[pi++] = t.v0.y; positions[pi++] = t.v0.z;
      positions[pi++] = t.v1.x; positions[pi++] = t.v1.y; positions[pi++] = t.v1.z;
      positions[pi++] = t.v2.x; positions[pi++] = t.v2.y; positions[pi++] = t.v2.z;
      for (let j = 0; j < 3; j++) {
        normals[ni++] = t.normal.x;
        normals[ni++] = t.normal.y;
        normals[ni++] = t.normal.z;
      }
      indices[ii] = ii;
      indices[ii + 1] = ii + 1;
      indices[ii + 2] = ii + 2;
      ii += 3;
    }
    this.meshBuffers = { positions, normals, indices };
    return this.meshBuffers;
  }
}
