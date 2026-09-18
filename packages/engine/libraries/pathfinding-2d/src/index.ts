// ============================================================================
// @downdraft/engine/libraries/pathfinding-2d — weighted multi-goal A* over a 2D grid
//
// Generic A* machinery (binary heap, visited arrays, multi-goal search,
// adjacent-goal enumeration, X-axis cylinder wrap). The game supplies move
// grading via `gradeMove` (walkability, support, gravity modeling, per-mode
// costs) and optional `expandExtra` for non-cardinal moves like jumps.
// ============================================================================

export { createAStarGrid } from "./astar-grid";
export type { AStarGrid, AStarGridConfig, GradedMove, PathNode } from "./astar-grid";
