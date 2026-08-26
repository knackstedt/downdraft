export type Vec3 = [number, number, number];

export interface NavPoly {
  id: number;
  vertexIndices: number[];
  neighborPolys: number[];
  portalEdges: PortalEdge[];
  centroid: Vec3;
  area: number;
  region: number;
}

export interface PortalEdge {
  fromPoly: number;
  toPoly: number;
  left: Vec3;
  right: Vec3;
}

export interface NavMeshData {
  polygons: NavPoly[];
  vertices: Float32Array;
  vertexCount: number;
}

export interface NavMeshGeneratorConfig {
  cellSize: number;
  cellHeight: number;
  agentRadius: number;
  agentHeight: number;
  maxSlope: number;
  maxStep: number;
  regionMinSize: number;
}

export interface HeightFieldSampler {
  sampleHeight(x: number, z: number): number;
  isWalkable(x: number, z: number): boolean;
}

export interface NavAgentData {
  [key: string]: unknown;
  radius: number;
  height: number;
  maxSpeed: number;
  acceleration: number;
  path: Vec3[];
  pathIndex: number;
  velocity: Vec3;
  target: Vec3 | null;
  state: "idle" | "seeking" | "arrived";
  avoidanceRadius: number;
  separationWeight: number;
  alignmentWeight: number;
  cohesionWeight: number;
  polyId: number;
  repathTimer: number;
}

export interface CrowdSystemConfig {
  spatialCellSize: number;
  terrainSampleFn: ((x: number, z: number) => number) | null;
}
