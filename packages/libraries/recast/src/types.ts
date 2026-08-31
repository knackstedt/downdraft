// ============================================================================
// Shared types for @downdraft/library-recast
// ============================================================================

export type Vec3 = [number, number, number];

/**
 * Configuration passed to {@link RecastBackend.buildNavMesh} (forwarded to
 * recast-navigation's `generateSoloNavMesh` as `SoloNavMeshGeneratorConfig`).
 * All fields optional — recast supplies sensible defaults.
 */
export interface RecastNavMeshConfig {
  /** Voxel cell size (cs). Default from recast: 0.2. */
  cs?: number;
  /** Voxel cell height (ch). Default from recast: 0.2. */
  ch?: number;
  /** Maximum slope angle considered walkable, in degrees. Default: 45. */
  walkableSlopeAngle?: number;
  /** Minimum ceiling height (agent height) in world units. Default: 2. */
  walkableHeight?: number;
  /** Maximum ledge height considered climbable. Default: 0.4. */
  walkableClimb?: number;
  /** Agent radius (walkable radius). Default: 0.6. */
  walkableRadius?: number;
  /** Maximum edge length. Default: 12. */
  maxEdgeLen?: number;
  /** Maximum simplification error. Default: 1.3. */
  maxSimplificationError?: number;
  /** Minimum region area. Default: 8. */
  minRegionArea?: number;
  /** Region merge area. Default: 20. */
  mergeRegionArea?: number;
  /** Max vertices per polygon. Default: 6. */
  maxVertsPerPoly?: number;
  /** Detail sample distance. Default: 6. */
  detailSampleDist?: number;
  /** Detail sample max error. Default: 1. */
  detailSampleMaxError?: number;
  /** Build BV tree. Default: true. */
  buildBvTree?: boolean;
}

/**
 * Per-agent parameters. Mirrors recast-navigation's `CrowdAgentParams` but
 * uses the engine's `Vec3`-free scalar form (agents are positioned via the
 * ECS, not via a recast Vector3).
 */
export interface RecastAgentParams {
  radius?: number;
  height?: number;
  maxAcceleration?: number;
  maxSpeed?: number;
  collisionQueryRange?: number;
  pathOptimizationRange?: number;
  separationWeight?: number;
  updateFlags?: number;
  obstacleAvoidanceType?: number;
  queryFilterType?: number;
}

/**
 * ECS component data for a recast crowd agent. Stored on the entity alongside
 * `PhysicsTransform`; the crowd system reads/writes both each tick.
 */
export interface RecastAgentData {
  [key: string]: unknown;
  /** recast crowd agent index (returned by `Crowd.addAgent`). -1 = not added. */
  agentId: number;
  radius: number;
  height: number;
  maxSpeed: number;
  maxAcceleration: number;
  target: Vec3 | null;
  state: "idle" | "seeking" | "arrived";
  velocity: Vec3;
}
