// ============================================================================
// Recast Test — build a navmesh from triangle geometry, spawn agents in a
// recast Crowd, set targets, update each tick.
//
// Mirrors navmesh-test.ts but uses @downdraft/engine/libraries/recast (WASM-based
// Recast + Detour) instead of the hand-rolled @downdraft/engine/libraries/navmesh.
// The two examples coexist to validate both libraries.
// ============================================================================

import { PhysicsTransform, Query, World, type Entity } from "@downdraft/engine";
import {
  RecastAgent,
  RecastBackend,
  RecastCrowdSystem,
  type RecastAgentData,
  type Vec3,
} from "@downdraft/engine/libraries/recast";

const AGENT_COLORS: [number, number, number][] = [
  [1, 0.2, 0.2],
  [0.2, 1, 0.2],
  [0.2, 0.4, 1],
  [1, 1, 0.2],
  [1, 0.4, 1],
];

/**
 * Builds a flat ground plane as triangle input for recast.
 * Returns flat positions [x,y,z, ...] + indices [i0,i1,i2, ...] for a
 * `size`×`size` plane centered at the origin, subdivided into `quads`×`quads`
 * quads (2 triangles each).
 */
function buildGroundPlane(size: number, quads: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = size / 2;
  const step = size / quads;
  for (let z = 0; z <= quads; z++) {
    for (let x = 0; x <= quads; x++) {
      positions.push(-half + x * step, 0, -half + z * step);
    }
  }
  const vertsPerRow = quads + 1;
  for (let z = 0; z < quads; z++) {
    for (let x = 0; x < quads; x++) {
      const v0 = z * vertsPerRow + x;
      const v1 = v0 + 1;
      const v2 = (z + 1) * vertsPerRow + x;
      const v3 = v2 + 1;
      // Two triangles per quad (counter-clockwise winding per recast/OpenGL convention).
      indices.push(v0, v2, v1);
      indices.push(v1, v2, v3);
    }
  }
  return { positions, indices };
}

export interface RecastTestResult {
  backend: RecastBackend;
  crowd: RecastCrowdSystem;
  world: World;
  crowdQuery: Query;
  agents: { entity: Entity; color: [number, number, number] }[];
}

/**
 * Initializes the recast test: loads WASM, builds a navmesh over a 50×50
 * ground plane, creates a crowd, spawns 5 agents with targets.
 *
 * Async because recast's WASM `init()` is async.
 */
export async function initRecastTest(): Promise<RecastTestResult> {
  // 1. Load WASM + build navmesh from a flat ground plane.
  const backend = new RecastBackend();
  await backend.init();
  const { positions, indices } = buildGroundPlane(50, 10);
  const ok = backend.buildNavMesh(positions, indices, {
    cs: 0.3,
    ch: 0.2,
    walkableSlopeAngle: 45,
    walkableHeight: 2,
    walkableClimb: 0.4,
    walkableRadius: 0.4,
  });
  if (!ok) throw new Error("recast: failed to build navmesh");

  // 2. Create crowd + ECS world.
  const crowd = new RecastCrowdSystem(backend, { maxAgents: 32, maxAgentRadius: 0.6 });
  const world = new World();
  const crowdQuery = new Query([RecastAgent.id, PhysicsTransform.id]);
  world.schedule.updateQueryArchetypes(world.allArchetypes);
  crowd.register(world, crowdQuery);

  // 3. Spawn 5 agents at different positions with targets.
  const agents: RecastTestResult["agents"] = [];
  const startPositions: Vec3[] = [
    [-20, 0, -20],
    [-15, 0, 15],
    [0, 0, -10],
    [10, 0, 5],
    [20, 0, -20],
  ];
  const targets: Vec3[] = [
    [20, 0, 20],
    [15, 0, -20],
    [-10, 0, 10],
    [-5, 0, -15],
    [-20, 0, 20],
  ];

  for (let i = 0; i < startPositions.length; i++) {
    const agentData: RecastAgentData = {
      agentId: -1,
      radius: 0.4,
      height: 1.8,
      maxSpeed: 3.5,
      maxAcceleration: 10,
      target: null,
      state: "idle",
      velocity: [0, 0, 0],
    };
    const transformData = {
      position: [startPositions[i][0], startPositions[i][1], startPositions[i][2]] as Vec3,
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      prevPosition: [...startPositions[i]] as Vec3,
      prevRotation: [0, 0, 0, 1] as [number, number, number, number],
    };
    const components = new Map();
    components.set(RecastAgent.id, agentData);
    components.set(PhysicsTransform.id, transformData);
    const entity = world.spawn(components);
    world.schedule.updateQueryArchetypes(world.allArchetypes);

    crowd.addAgent(entity, { radius: 0.4, height: 1.8, maxSpeed: 3.5, maxAcceleration: 10 });
    crowd.setTarget(entity, targets[i]);
    agents.push({ entity, color: AGENT_COLORS[i] });
  }

  return { backend, crowd, world, crowdQuery, agents };
}

/** Reads back agent positions + states from the ECS for assertion. */
export function getRecastAgentPositions(result: RecastTestResult): { index: number; pos: Vec3; state: string }[] {
  const out: { index: number; pos: Vec3; state: string }[] = [];
  for (let i = 0; i < result.agents.length; i++) {
    const { entity } = result.agents[i];
    const transform = result.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const agent = result.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
    if (transform && agent) {
      out.push({
        index: i,
        pos: [...transform.position] as Vec3,
        state: agent.state,
      });
    }
  }
  return out;
}
