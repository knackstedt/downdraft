// ============================================================================
// Overburden — pathfinding shim
//
// The pathfinding logic has been refactored into grid-movement.ts, which
// implements the weighted grid-movement A* with the explicit cost/priority
// model (walk < ladder < wall-climb < back-wall-diagonal < back-wall-vertical
// < back-wall-horizontal < crawl) plus crawl routing and diagonal back-wall
// traversal. See grid-movement.ts for the full documentation.
//
// This file re-exports the public API so existing importers keep compiling
// during the transition. New code should import from ./grid-movement.
// ============================================================================

export {
    COST_BACKWALL_DIAG,
    COST_BACKWALL_H,
    COST_BACKWALL_V,
    COST_CRAWL_H, COST_FALL, COST_JUMP, COST_LADDER_V, COST_WALK_H, COST_WALL_CLIMB_V, findPath,
    findPathToAdjacent, type MoveMode, type PathNode
} from "./grid-movement";

