// ============================================================================
// IslandNoise — shared procedural island generation for renderer & physics
// Generates Perlin-like fBm noise heightmaps for low-poly island meshes.
// Mesh is in unit space (radius 1.0), scaled by entity.scale at render time.
// ============================================================================

export const ISLAND_PEAK = 0.22;   // above-water peak height in unit space
export const ISLAND_DEPTH = 0.28;  // below-water depth — underwater shelf

// --- Hash-based gradient noise (Perlin-like) ---

function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
}

function fbm(x: number, z: number, octaves: number): number {
  let v = 0, a = 0.5;
  for (let i = 0; i < octaves; i++) {
    v += a * smoothNoise(x, z);
    x *= 2; z *= 2;
    a *= 0.5;
  }
  return v;
}

// --- Island height at normalized position (x, z) in [-1, 1] ---
// Returns Y in unit space: positive = above water, negative = below.
export function islandHeight(x: number, z: number): number {
  const r = Math.sqrt(x * x + z * z);
  if (r > 1.0) return -ISLAND_DEPTH;

  // fBm noise for natural terrain variation
  const n = (fbm(x * 3, z * 3, 4) - 0.5) * 0.2;

  // Parabolic falloff with low exponent — wide flat top, gentle gradient
  const falloff = 1 - r * r;

  // Noise modulated by a gentler curve so terrain features persist across
  // the whole island, not just the center (prevents cone appearance)
  const noiseMod = Math.min(1, falloff * 2);

  return falloff * (ISLAND_PEAK + ISLAND_DEPTH) - ISLAND_DEPTH + n * noiseMod;
}

// --- Vertex colors based on height (low-poly terrain bands) ---

function islandColor(y: number): [number, number, number] {
  if (y < -ISLAND_DEPTH * 0.5) return [0.08, 0.07, 0.06];   // deep underwater rock
  if (y < -ISLAND_DEPTH * 0.15) return [0.16, 0.14, 0.11];  // shallow underwater rock
  if (y < 0) return [0.35, 0.32, 0.25];                      // shoreline transition
  if (y < ISLAND_PEAK * 0.08) return [0.76, 0.70, 0.50];    // sand
  if (y < ISLAND_PEAK * 0.4) return [0.3, 0.5, 0.2];        // grass
  if (y < ISLAND_PEAK * 0.7) return [0.22, 0.38, 0.14];     // forest
  return [0.4, 0.38, 0.35];                                  // rock peak
}

// Convert an indexed pos+color mesh (6 floats/vertex) into a non-indexed
// pos+normal+color mesh (9 floats/vertex) with per-face flat normals.
// Each triangle's 3 vertices are duplicated so every face gets its own normal.
// Downward-facing normals are flipped up to match the previous dpdx/dpdy shader behavior.
export function computeFlatNormals(
  verts: Float32Array,
  indices: Uint16Array,
): { verts: Float32Array; indices: Uint16Array } {
  const outVerts: number[] = [];
  const outIndices: number[] = [];
  let outIdx = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 6;
    const i1 = indices[i + 1] * 6;
    const i2 = indices[i + 2] * 6;

    const p0x = verts[i0], p0y = verts[i0 + 1], p0z = verts[i0 + 2];
    const p1x = verts[i1], p1y = verts[i1 + 1], p1z = verts[i1 + 2];
    const p2x = verts[i2], p2y = verts[i2 + 1], p2z = verts[i2 + 2];

    const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
    const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) {
      nx /= len; ny /= len; nz /= len;
    } else {
      nx = 0; ny = 1; nz = 0;
    }
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

    outVerts.push(p0x, p0y, p0z, nx, ny, nz, verts[i0 + 3], verts[i0 + 4], verts[i0 + 5]);
    outVerts.push(p1x, p1y, p1z, nx, ny, nz, verts[i1 + 3], verts[i1 + 4], verts[i1 + 5]);
    outVerts.push(p2x, p2y, p2z, nx, ny, nz, verts[i2 + 3], verts[i2 + 4], verts[i2 + 5]);
    outIndices.push(outIdx, outIdx + 1, outIdx + 2);
    outIdx += 3;
  }

  return { verts: new Float32Array(outVerts), indices: new Uint16Array(outIndices) };
}

// --- Generate island render mesh (unit space) ---
// Vertex format: pos(3) + normal(3) + color(3) = 9 floats = 36 bytes per vertex
// Non-indexed triangles (vertices duplicated per-face for flat shading)
export function generateIslandMesh(): { verts: Float32Array; indices: Uint16Array } {
  const GRID = 48;
  const verts: number[] = [];
  const indices: number[] = [];

  // Generate grid vertices (temporary pos+color format, 6 floats each)
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const nx = (i / GRID) * 2 - 1;
      const nz = (j / GRID) * 2 - 1;
      const y = islandHeight(nx, nz);
      const col = islandColor(y);
      verts.push(nx, y, nz, col[0], col[1], col[2]);
    }
  }

  // Generate triangle indices, skipping quads fully outside the unit circle
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x0 = (i / GRID) * 2 - 1, z0 = (j / GRID) * 2 - 1;
      const x1 = ((i + 1) / GRID) * 2 - 1, z1 = ((j + 1) / GRID) * 2 - 1;
      const r00 = x0 * x0 + z0 * z0;
      const r10 = x1 * x1 + z0 * z0;
      const r01 = x0 * x0 + z1 * z1;
      const r11 = x1 * x1 + z1 * z1;
      if (r00 > 1.0 && r10 > 1.0 && r01 > 1.0 && r11 > 1.0) continue;

      const v0 = j * (GRID + 1) + i;
      const v1 = j * (GRID + 1) + i + 1;
      const v2 = (j + 1) * (GRID + 1) + i;
      const v3 = (j + 1) * (GRID + 1) + i + 1;

      indices.push(v0, v2, v1);
      indices.push(v1, v2, v3);
    }
  }

  return computeFlatNormals(new Float32Array(verts), new Uint16Array(indices));
}

// --- Generate heightfield data for Rapier physics ---
// Returns a Float32Array of (gridSize+1)^2 height values in column-major order
// (Rapier convention: heights[col * nrows + row]).
// nrows = ncols = gridSize + 1. Heights are in unit space.
export function generateIslandHeightfield(gridSize: number): Float32Array {
  const n = gridSize + 1;
  const heights = new Float32Array(n * n);
  for (let col = 0; col < n; col++) {
    for (let row = 0; row < n; row++) {
      const nx = (row / gridSize) * 2 - 1;
      const nz = (col / gridSize) * 2 - 1;
      heights[col * n + row] = islandHeight(nx, nz);
    }
  }
  return heights;
}

// --- Generate low-resolution trimesh for Rapier physics ---
// Returns positions (3 floats/vert) and indices for a trimesh collider.
// Uses a smaller grid than the render mesh (default 16 vs 48) and skips
// normals/colors/vertex-duplication. ~512 triangles per island vs ~4608.
export function generateIslandPhysicsMesh(gridSize: number = 16, includeUnderwater: boolean = false): { positions: Float32Array; indices: Uint32Array } {
  const n = gridSize + 1;
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j <= gridSize; j++) {
    for (let i = 0; i <= gridSize; i++) {
      const nx = (i / gridSize) * 2 - 1;
      const nz = (j / gridSize) * 2 - 1;
      const y = islandHeight(nx, nz);
      const idx = (j * n + i) * 3;
      positions[idx] = nx;
      positions[idx + 1] = y;
      positions[idx + 2] = nz;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const x0 = (i / gridSize) * 2 - 1, z0 = (j / gridSize) * 2 - 1;
      const x1 = ((i + 1) / gridSize) * 2 - 1, z1 = ((j + 1) / gridSize) * 2 - 1;
      const r00 = x0 * x0 + z0 * z0;
      const r10 = x1 * x1 + z0 * z0;
      const r01 = x0 * x0 + z1 * z1;
      const r11 = x1 * x1 + z1 * z1;
      if (r00 > 1.0 && r10 > 1.0 && r01 > 1.0 && r11 > 1.0) continue;

      const v0 = j * n + i;
      const v1 = j * n + i + 1;
      const v2 = (j + 1) * n + i;
      const v3 = (j + 1) * n + i + 1;

      if (includeUnderwater) {
        // Keep all triangles within the unit circle — no gaps for players to
        // slip through into the hollow trimesh interior.
        indices.push(v0, v2, v1);
        indices.push(v1, v2, v3);
      } else {
        // Skip triangles fully below water level (y < 0) so the underwater shelf
        // doesn't create invisible collision walls that push ships in deep water.
        const y0 = positions[v0 * 3 + 1];
        const y1 = positions[v1 * 3 + 1];
        const y2 = positions[v2 * 3 + 1];
        const y3 = positions[v3 * 3 + 1];

        // Triangle 1: v0, v2, v1 — keep if any vertex is at/above water
        if (y0 >= 0 || y2 >= 0 || y1 >= 0) {
          indices.push(v0, v2, v1);
        }
        // Triangle 2: v1, v2, v3 — keep if any vertex is at/above water
        if (y1 >= 0 || y2 >= 0 || y3 >= 0) {
          indices.push(v1, v2, v3);
        }
      }
    }
  }

  return { positions, indices: new Uint32Array(indices) };
}
