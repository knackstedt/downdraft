// ============================================================================
// Obstacle Scene — shared scene geometry for navmesh tests
//
// A 50×50 ground plane with several box obstacles (walls + blocks) that the
// navmesh must route around. Both the recast and legacy navmesh tests use
// this so they visualize the same scene.
//
// Obstacles are defined as axis-aligned boxes. For recast, we generate the
// full triangle mesh (ground + box faces). For the legacy navmesh, we
// provide a HeightFieldSampler that returns obstacle tops as raised height
// and marks obstacle interiors as non-walkable.
// ============================================================================

import type { CubeInstance } from "./cube-renderer";

export interface BoxObstacle {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  height: number;
}

// ── Scene definition ──

export const OBSTACLES: BoxObstacle[] = [
  // Central wall (forces agents to go around)
  { minX: -8, maxX: -2, minZ: -3, maxZ: 3, height: 3 },
  // L-shaped wall on the right
  { minX: 5, maxX: 12, minZ: -8, maxZ: -5, height: 2.5 },
  { minX: 9, maxX: 12, minZ: -5, maxZ: 5, height: 2.5 },
  // Small blocks scattered around
  { minX: -20, maxX: -17, minZ: 8, maxZ: 11, height: 2 },
  { minX: 15, maxX: 18, minZ: 10, maxZ: 13, height: 2 },
  { minX: -5, maxX: -3, minZ: 15, maxZ: 17, height: 1.5 },
];

export const GROUND_SIZE = 50;
export const GROUND_HALF = GROUND_SIZE / 2;

// ── Geometry generation (for recast) ──

function buildBoxTriangles(
  minX: number, maxX: number, minZ: number, maxZ: number, height: number,
  baseVertex: number,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const y0 = 0, y1 = height;

  // 8 corners of the box
  const c = [
    [minX, y0, minZ], [maxX, y0, minZ], [maxX, y0, maxZ], [minX, y0, maxZ], // bottom
    [minX, y1, minZ], [maxX, y1, minZ], [maxX, y1, maxZ], [minX, y1, maxZ], // top
  ];
  for (const p of c) positions.push(p[0], p[1], p[2]);

  // Top face (walkable surface — recast will treat it as walkable if slope allows)
  indices.push(4, 5, 6, 4, 6, 7);
  // Bottom face (facing down — not walkable)
  indices.push(0, 2, 1, 0, 3, 2);
  // Side faces
  indices.push(0, 1, 5, 0, 5, 4); // -Z side
  indices.push(1, 2, 6, 1, 6, 5); // +X side
  indices.push(2, 3, 7, 2, 7, 6); // +Z side
  indices.push(3, 0, 4, 3, 4, 7); // -X side

  // Offset indices
  for (let i = 0; i < indices.length; i++) indices[i] += baseVertex;

  return { positions, indices };
}

/** Builds the full triangle mesh: ground plane + all obstacle boxes. */
export function buildObstacleScene(): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];

  // Ground plane (50×50, subdivided 10×10)
  const quads = 10;
  const step = GROUND_SIZE / quads;
  for (let z = 0; z <= quads; z++) {
    for (let x = 0; x <= quads; x++) {
      positions.push(-GROUND_HALF + x * step, 0, -GROUND_HALF + z * step);
    }
  }
  const vertsPerRow = quads + 1;
  for (let z = 0; z < quads; z++) {
    for (let x = 0; x < quads; x++) {
      const v0 = z * vertsPerRow + x;
      const v1 = v0 + 1;
      const v2 = (z + 1) * vertsPerRow + x;
      const v3 = v2 + 1;
      indices.push(v0, v2, v1, v1, v2, v3);
    }
  }

  // Add obstacle boxes
  let baseVertex = positions.length / 3;
  for (const obs of OBSTACLES) {
    const box = buildBoxTriangles(obs.minX, obs.maxX, obs.minZ, obs.maxZ, obs.height, baseVertex);
    positions.push(...box.positions);
    indices.push(...box.indices);
    baseVertex += 8;
  }

  return { positions, indices };
}

// ── HeightFieldSampler (for legacy navmesh) ──

export function buildObstacleSampler(): {
  sampleHeight: (x: number, z: number) => number;
  isWalkable: (x: number, z: number) => boolean;
} {
  return {
    sampleHeight(x: number, z: number): number {
      // Return the top of the obstacle if inside one, else 0.
      for (const obs of OBSTACLES) {
        if (x >= obs.minX && x <= obs.maxX && z >= obs.minZ && z <= obs.maxZ) {
          return obs.height;
        }
      }
      return 0;
    },
    isWalkable(x: number, z: number): boolean {
      // The ground is walkable, but the interior of obstacles (at ground level) is not.
      // Obstacle tops ARE walkable (agents can walk on top).
      // The legacy navmesh uses isWalkable to mark cells — we mark the ground
      // under obstacles as non-walkable so the mesh routes around them.
      for (const obs of OBSTACLES) {
        if (x >= obs.minX && x <= obs.maxX && z >= obs.minZ && z <= obs.maxZ) {
          return false;
        }
      }
      return true;
    },
  };
}

// ── Cube instances for rendering obstacles ──

export function getObstacleCubeInstances(): CubeInstance[] {
  return OBSTACLES.map((obs) => {
    const cx = (obs.minX + obs.maxX) / 2;
    const cz = (obs.minZ + obs.maxZ) / 2;
    const sx = obs.maxX - obs.minX;
    const sz = obs.maxZ - obs.minZ;
    return {
      position: [cx, 0, cz],
      color: [0.5, 0.5, 0.55] as [number, number, number],
      size: Math.max(sx, sz), // we'll scale via a separate path; see note below
    };
  });
}

// Obstacles are boxes, not uniform cubes. The CubeRenderer draws uniform cubes.
// For a better visual, we provide the box dimensions separately so tests can
// draw them with the correct aspect ratio. Since CubeRenderer only supports
// uniform cubes, we approximate by drawing the largest dimension. A proper
// box renderer would be better, but for debug viz this is sufficient.
export function getObstacleBoxes(): { center: [number, number, number]; size: [number, number, number]; color: [number, number, number] }[] {
  return OBSTACLES.map((obs) => {
    const cx = (obs.minX + obs.maxX) / 2;
    const cz = (obs.minZ + obs.maxZ) / 2;
    return {
      center: [cx, obs.height / 2, cz],
      size: [obs.maxX - obs.minX, obs.height, obs.maxZ - obs.minZ],
      color: [0.45, 0.45, 0.5],
    };
  });
}
