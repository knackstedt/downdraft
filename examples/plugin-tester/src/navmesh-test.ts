// ============================================================================
// NavMesh Test — generate navmesh, spawn agents, set targets, update each tick
// ============================================================================

import { PhysicsTransform, Query, World } from "@downdraft/engine";
import {
    CrowdSystem, NavAgent,
    NavMesh, NavMeshGenerator, Pathfinder,
    type HeightFieldSampler,
    type NavAgentData, type NavMeshGeneratorConfig,
    type Vec3,
} from "@downdraft/engine/libraries/navmesh";

const NAVMESH_CONFIG: NavMeshGeneratorConfig = {
  cellSize: 1,
  cellHeight: 0.5,
  agentRadius: 0.4,
  agentHeight: 1.8,
  maxSlope: 45,
  maxStep: 0.5,
  regionMinSize: 2,
};

const AGENT_COLORS: [number, number, number][] = [
  [1, 0.2, 0.2],
  [0.2, 1, 0.2],
  [0.2, 0.4, 1],
  [1, 1, 0.2],
  [1, 0.4, 1],
];

export interface NavMeshTestResult {
  navMesh: NavMesh;
  pathfinder: Pathfinder;
  crowd: CrowdSystem;
  world: World;
  crowdQuery: Query;
  agents: { entity: Entity; color: [number, number, number] }[];
}

export function initNavMeshTest(): NavMeshTestResult {
  // Flat ground sampler — walkable everywhere
  const sampler: HeightFieldSampler = {
    sampleHeight: () => 0,
    isWalkable: () => true,
  };

  // Generate navmesh over 50x50 area
  const gen = new NavMeshGenerator(NAVMESH_CONFIG);
  const navData = gen.generate(sampler, -25, -25, 25, 25);
  const navMesh = new NavMesh();
  navMesh.build(navData);

  // Create pathfinder + crowd
  const pathfinder = new Pathfinder(navMesh);
  const crowd = new CrowdSystem(navMesh, pathfinder, {
    spatialCellSize: 4,
    terrainSampleFn: null,
  });

  // Create ECS world and register crowd
  const world = new World();
  const crowdQuery = new Query([NavAgent.id, PhysicsTransform.id]);
  world.schedule.updateQueryArchetypes(world.allArchetypes);
  crowd.register(world, crowdQuery);

  // Spawn 5 agents at different positions
  const agents: NavMeshTestResult["agents"] = [];
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
    const agentData: NavAgentData = {
      radius: 0.4,
      height: 1.8,
      maxSpeed: 3.5,
      acceleration: 10,
      path: [],
      pathIndex: 0,
      velocity: [0, 0, 0],
      target: null,
      state: "idle",
      avoidanceRadius: 2.0,
      separationWeight: 1.0,
      alignmentWeight: 0.5,
      cohesionWeight: 0.3,
      polyId: -1,
      repathTimer: 0,
    };

    const transformData = {
      position: [startPositions[i][0], startPositions[i][1], startPositions[i][2]] as Vec3,
      rotation: [0, 0, 0, 1] as Vec3,
      prevPosition: [...startPositions[i]] as Vec3,
      prevRotation: [0, 0, 0, 1] as Vec3,
    };

    const components = new Map();
    components.set(NavAgent.id, agentData);
    components.set(PhysicsTransform.id, transformData);
    const entity = world.spawn(components);
    world.schedule.updateQueryArchetypes(world.allArchetypes);

    crowd.setTarget(entity, targets[i]);
    agents.push({ entity, color: AGENT_COLORS[i] });
  }

  return { navMesh, pathfinder, crowd, world, crowdQuery, agents };
}

export function getAgentPositions(result: NavMeshTestResult): { index: number; pos: Vec3; state: string }[] {
  const positions: { index: number; pos: Vec3; state: string }[] = [];
  for (let i = 0; i < result.agents.length; i++) {
    const { entity } = result.agents[i];
    const transform = result.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const agent = result.world.getComponent<NavAgentData>(entity, NavAgent.id);
    if (transform && agent) {
      positions.push({
        index: i,
        pos: [...transform.position] as Vec3,
        state: agent.state,
      });
    }
  }
  return positions;
}
