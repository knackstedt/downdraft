export { CrowdSystem, NavAgent } from "./crowd-system";
export { NavMeshDebugViz } from "./debug-viz";
export { NavMesh } from "./navmesh";
export { NavMeshGenerator } from "./navmesh-generator";
export { Pathfinder } from "./pathfinder";
export type {
    CrowdSystemConfig, HeightFieldSampler,
    NavAgentData, NavMeshData,
    NavMeshGeneratorConfig, NavPoly, PortalEdge, Vec3
} from "./types";

// Declarative library descriptor
export { NavmeshLib, NavmeshTok, PathfinderTok } from "./library";
export type { NavmeshLibConfig } from "./library";

