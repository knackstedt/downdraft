export { RecastBackend, loadRecastLib } from "./backend";
export { RecastAgent, RecastCrowdSystem } from "./crowd-system";
export type {
  RecastAgentData,
  RecastAgentParams,
  RecastNavMeshConfig,
  Vec3,
} from "./types";

// Declarative library descriptor
export { RecastLib, RecastNavMeshTok, RecastCrowdTok } from "./library";
export type { RecastLibConfig } from "./library";
