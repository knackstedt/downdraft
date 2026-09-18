// ============================================================================
// Model Normalizer — pure transform math for model import normalization
// ============================================================================
// These functions operate on plugin MeshData (interleaved pos+normal, 6 floats
// per vertex: [px, py, pz, nx, ny, nz, ...]). They mutate in place, matching
// the existing convertZUpToYUp pattern.
//
// Higher-level orchestration (sidecar resolution, node-transform baking, the
// full normalize pipeline) lives in @downdraft/engine/libraries/models/normalize.
//

// The normalizer works on the plugin's interleaved [pos(3) + normal(3)] layout
// (6 floats/vertex), NOT the engine's PBR/skinned layouts. We define a minimal
// mesh interface here to avoid coupling core to plugin-models.
type PluginMesh = {
  vertices: Float32Array;
  vertexCount: number;
};

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

const VERTEX_STRIDE = 6; // pos(3) + normal(3)

/** Unit conversion factors: source unit → meters. */
export const UNIT_TO_METERS: Record<string, number> = {
  meters: 1.0,
  centimeters: 0.01,
  inches: 0.0254,
  millimeters: 0.001,
  units: 1.0, // unknown — no conversion
};

/**
 * Rotate vertices and normals from Z-up to Y-up.
 * Transformation: (x, y, z) → (x, z, -y)  [-90° rotation around X]
 * No-op if already Y-up.
 */
export function applyUpAxisConversion(meshes: PluginMesh[], fromAxis: "y" | "z"): void {
  if (fromAxis === "y") return;

  for (const mesh of meshes) {
    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * VERTEX_STRIDE;
      // Position: (x, y, z) → (x, z, -y)
      const py = verts[base + 1];
      const pz = verts[base + 2];
      verts[base + 1] = pz;
      verts[base + 2] = -py;
      // Normal: same rotation
      const ny = verts[base + 4];
      const nz = verts[base + 5];
      verts[base + 4] = nz;
      verts[base + 5] = -ny;
    }
  }
}

/**
 * Scale all vertex positions by a unit conversion factor (source → meters).
 * Normals are unchanged (direction vectors are not affected by uniform scale).
 */
export function applyUnitScale(meshes: PluginMesh[], fromUnits: string): void {
  const factor = UNIT_TO_METERS[fromUnits] ?? 1.0;
  if (factor === 1.0) return;

  for (const mesh of meshes) {
    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * VERTEX_STRIDE;
      verts[base] *= factor;
      verts[base + 1] *= factor;
      verts[base + 2] *= factor;
    }
  }
}

/**
 * Apply a uniform scale factor to all vertex positions.
 * Used for user scale overrides and auto-fit.
 */
export function applyRootScale(meshes: PluginMesh[], scaleFactor: number): void {
  if (scaleFactor === 1.0) return;

  for (const mesh of meshes) {
    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * VERTEX_STRIDE;
      verts[base] *= scaleFactor;
      verts[base + 1] *= scaleFactor;
      verts[base + 2] *= scaleFactor;
    }
  }
}

/** Quaternion multiply: a * b (Hamilton product). */
function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotate vector v by quaternion q. */
function qrotate(q: Quat, v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  // v + 2*cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const c1x = qy * vz - qz * vy + qw * vx;
  const c1y = qz * vx - qx * vz + qw * vy;
  const c1z = qx * vy - qy * vx + qw * vz;
  const c2x = qy * c1z - qz * c1y;
  const c2y = qz * c1x - qx * c1z;
  const c2z = qx * c1y - qy * c1x;
  return [vx + 2 * c2x, vy + 2 * c2y, vz + 2 * c2z];
}

/** Check if a quaternion is identity [0,0,0,1]. */
function isIdentityQuat(q: Quat): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/**
 * Rotate all vertices and normals by a quaternion (root pre-rotation).
 * Normals are rotated by the same quaternion (correct for uniform scale;
 * for non-uniform scale the inverse-transpose would be needed, but root
 * rotations are typically uniform).
 */
export function applyRootRotation(meshes: PluginMesh[], rotation: Quat): void {
  if (isIdentityQuat(rotation)) return;

  for (const mesh of meshes) {
    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * VERTEX_STRIDE;
      // Position
      const pos: Vec3 = [verts[base], verts[base + 1], verts[base + 2]];
      const rotated = qrotate(rotation, pos);
      verts[base] = rotated[0];
      verts[base + 1] = rotated[1];
      verts[base + 2] = rotated[2];
      // Normal
      const norm: Vec3 = [verts[base + 3], verts[base + 4], verts[base + 5]];
      const rotatedN = qrotate(rotation, norm);
      verts[base + 3] = rotatedN[0];
      verts[base + 4] = rotatedN[1];
      verts[base + 5] = rotatedN[2];
    }
  }
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Compute the axis-aligned bounding box of all meshes.
 * Returns {min, max} corners. Returns degenerate bounds if no vertices.
 */
export function computeBounds(meshes: PluginMesh[]): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const mesh of meshes) {
    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * VERTEX_STRIDE;
      const x = verts[base];
      const y = verts[base + 1];
      const z = verts[base + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  if (minX === Infinity) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Get the max dimension (largest axis extent) of a bounding box. */
export function maxDimension(bounds: Bounds): number {
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    0,
  );
}

/**
 * Subtract the bounding-box center from all vertex positions, placing the
 * model at the origin. Normals are unchanged.
 */
export function centerToOrigin(meshes: PluginMesh[], bounds: Bounds): void {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;

  if (cx === 0 && cy === 0 && cz === 0) return;

  for (const mesh of meshes) {
    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const base = v * VERTEX_STRIDE;
      verts[base] -= cx;
      verts[base + 1] -= cy;
      verts[base + 2] -= cz;
    }
  }
}

/**
 * Uniformly scale the model so its max dimension equals targetMaxDim.
 * Returns the scale factor applied (or 1.0 if no scaling needed).
 */
export function autoFit(meshes: PluginMesh[], bounds: Bounds, targetMaxDim: number): number {
  const currentMax = maxDimension(bounds);
  if (currentMax <= 0 || currentMax === targetMaxDim) return 1.0;

  const scaleFactor = targetMaxDim / currentMax;
  applyRootScale(meshes, scaleFactor);
  return scaleFactor;
}

/**
 * Check if a model's max dimension is outside a sane range.
 * Used to trigger the dev-mode auto-fit prompt.
 * Threshold: < 0.01m (microscopic) or > 100m (massive).
 */
export function isExtremeScale(bounds: Bounds): boolean {
  const maxDim = maxDimension(bounds);
  return maxDim > 0 && (maxDim < 0.01 || maxDim > 100);
}

// Re-export quaternion helpers for the node-transform baking module
export { isIdentityQuat, qmul, qrotate };
export type { Quat, Vec3 };

