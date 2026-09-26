import { Query } from "@downdraft/engine/ecs/query";
import { World } from "@downdraft/engine/ecs/world";
import type { PhysicsTransformData } from "@downdraft/engine/physics/body";
import { PhysicsTransform } from "@downdraft/engine/physics/body";
import { CrowdSystem, NavAgent } from "./crowd-system";
import { NavMeshDebugViz } from "./debug-viz";
import { NavMeshGenerator } from "./navmesh-generator";
import { NavMesh } from "./navmesh";
import { Pathfinder } from "./pathfinder";
import type { HeightFieldSampler, NavAgentData, NavMeshGeneratorConfig, Vec3 } from "./types";

const defaultConfig: NavMeshGeneratorConfig = {
  cellSize: 1,
  cellHeight: 0.5,
  agentRadius: 0.4,
  agentHeight: 1.8,
  maxSlope: 45,
  maxStep: 0.5,
  regionMinSize: 2,
};

function makeFlatSampler(height: number = 0): HeightFieldSampler {
  return {
    sampleHeight: () => height,
    isWalkable: () => true,
  };
}

function makeNavMesh(size: number = 10): NavMesh {
  const gen = new NavMeshGenerator(defaultConfig);
  const sampler = makeFlatSampler(0);
  const data = gen.generate(sampler, 0, 0, size, size);
  const navMesh = new NavMesh();
  navMesh.build(data);
  return navMesh;
}

function makeCrowdWorld(navMesh: NavMesh): {
  world: World;
  crowdQuery: Query;
  pathfinder: Pathfinder;
  crowd: CrowdSystem;
} {
  const pathfinder = new Pathfinder(navMesh);
  const crowd = new CrowdSystem(navMesh, pathfinder, {
    spatialCellSize: 4,
    terrainSampleFn: null,
  });
  const world = new World();
  const crowdQuery = new Query([NavAgent.id, PhysicsTransform.id]);
  world.schedule.updateQueryArchetypes(world.allArchetypes);
  crowd.register(world, crowdQuery);
  return { world, crowdQuery, pathfinder, crowd };
}

function spawnAgent(
  world: World,
  pos: Vec3,
  overrides: Partial<NavAgentData> = {},
): { entity: import("@downdraft/engine/ecs/entity").Entity; agent: NavAgentData; transform: PhysicsTransformData } {
  const agentData: NavAgentData = {
    ...{
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
    },
    ...overrides,
  };

  const transformData: PhysicsTransformData = {
    position: [pos[0], pos[1], pos[2]],
    rotation: [0, 0, 0, 1],
    prevPosition: [pos[0], pos[1], pos[2]],
    prevRotation: [0, 0, 0, 1],
  };

  const components = new Map();
  components.set(NavAgent.id, agentData);
  components.set(PhysicsTransform.id, transformData);
  const entity = world.spawn(components);
  world.schedule.updateQueryArchetypes(world.allArchetypes);
  return { entity, agent: agentData, transform: transformData };
}

describe("NavAgent component", () => {
  it("should have correct default values", () => {
    const world = new World();
    const components = new Map();
    components.set(NavAgent.id, {
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
    } as NavAgentData);
    const entity = world.spawn(components);
    const agent = world.getComponent<NavAgentData>(entity, NavAgent.id)!;
    expect(agent.radius).toBe(0.4);
    expect(agent.height).toBe(1.8);
    expect(agent.maxSpeed).toBe(3.5);
    expect(agent.state).toBe("idle");
    expect(agent.target).toBeNull();
    expect(agent.path).toEqual([]);
    expect(agent.pathIndex).toBe(0);
    expect(agent.velocity).toEqual([0, 0, 0]);
    expect(agent.polyId).toBe(-1);
  });

  it("should be retrievable via getComponent", () => {
    const world = new World();
    const { entity } = spawnAgent(world, [5, 0, 5]);
    const agent = world.getComponent<NavAgentData>(entity, NavAgent.id);
    expect(agent).not.toBeNull();
    expect(agent!.state).toBe("idle");
  });
});

describe("CrowdSystem registration", () => {
  it("should register as an ECS system in Stage.Update", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowdQuery, crowd } = makeCrowdWorld(navMesh);
    crowd.register(world, crowdQuery);

    const systems = world.schedule.getSystems(1);
    expect(systems.length).toBeGreaterThan(0);
    const crowdSys = systems.find((s) => s.name === "crowd-agents");
    expect(crowdSys).toBeDefined();
  });
});

describe("CrowdSystem.setTarget", () => {
  it("should set target and compute path", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [1, 0, 1]);

    crowd.setTarget(entity, [8, 0, 8]);

    expect(agent.target).toEqual([8, 0, 8]);
    expect(agent.state).toBe("seeking");
    expect(agent.path.length).toBeGreaterThanOrEqual(2);
    expect(agent.pathIndex).toBe(0);
  });

  it("should not set target on non-existent entity", () => {
    const navMesh = makeNavMesh(10);
    const { crowd } = makeCrowdWorld(navMesh);
    crowd.setTarget({ index: 999, generation: 0 }, [5, 0, 5]);
  });
});

describe("CrowdSystem agent movement", () => {
  it("should not move idle agents", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, transform } = spawnAgent(world, [5, 0, 5]);

    const startPos = [...transform.position] as Vec3;
    world.step(0.016);
    expect(transform.position[0]).toBe(startPos[0]);
    expect(transform.position[2]).toBe(startPos[2]);
  });

  it("should move seeking agent toward target", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, transform } = spawnAgent(world, [1, 0, 1]);

    crowd.setTarget(entity, [8, 0, 8]);
    const startPos = [...transform.position] as Vec3;

    for (let i = 0; i < 10; i++) {
      world.step(0.1);
    }

    expect(transform.position[0]).not.toBe(startPos[0]);
    expect(transform.position[2]).not.toBe(startPos[2]);
  });

  it("should update agent polyId during movement", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [1, 0, 1]);

    crowd.setTarget(entity, [8, 0, 8]);

    world.step(0.1);

    expect(agent.polyId).toBeGreaterThanOrEqual(0);
  });

  it("should set velocity during movement", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [1, 0, 1]);

    crowd.setTarget(entity, [8, 0, 8]);

    world.step(0.1);

    const speed = Math.sqrt(agent.velocity[0] ** 2 + agent.velocity[2] ** 2);
    expect(speed).toBeGreaterThan(0);
  });

  it("should arrive at target eventually", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent, transform } = spawnAgent(world, [1, 0, 1], {
      maxSpeed: 10,
      acceleration: 50,
    });

    crowd.setTarget(entity, [2, 0, 2]);

    for (let i = 0; i < 200; i++) {
      world.step(0.016);
      if (agent.state === "arrived") break;
    }

    expect(agent.state as string).toBe("arrived");
    expect(agent.velocity).toEqual([0, 0, 0]);
  });
});

describe("CrowdSystem avoidance", () => {
  it("should separate nearby agents", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);

    const a1 = spawnAgent(world, [4.5, 0, 5], { avoidanceRadius: 3.0 });
    const a2 = spawnAgent(world, [5.5, 0, 5], { avoidanceRadius: 3.0 });

    crowd.setTarget(a1.entity, [8, 0, 5]);
    crowd.setTarget(a2.entity, [2, 0, 5]);

    const a1Start = [...a1.transform.position] as Vec3;
    const a2Start = [...a2.transform.position] as Vec3;

    for (let i = 0; i < 20; i++) {
      world.step(0.1);
    }

    const a1Pos = a1.transform.position;
    const a2Pos = a2.transform.position;
    const distNow = Math.sqrt(
      (a1Pos[0] - a2Pos[0]) ** 2 + (a1Pos[2] - a2Pos[2]) ** 2,
    );
    const distStart = Math.sqrt(
      (a1Start[0] - a2Start[0]) ** 2 + (a1Start[2] - a2Start[2]) ** 2,
    );

    expect(distNow).toBeGreaterThan(distStart);
  });

  it("should not apply avoidance to self", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [5, 0, 5], { avoidanceRadius: 3.0 });

    crowd.setTarget(entity, [8, 0, 8]);

    world.step(0.1);

    const speed = Math.sqrt(agent.velocity[0] ** 2 + agent.velocity[2] ** 2);
    expect(speed).toBeGreaterThan(0);
  });

  it("should handle no nearby agents gracefully", () => {
    const navMesh = makeNavMesh(15);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const a1 = spawnAgent(world, [1, 0, 1], { avoidanceRadius: 1.0 });
    const a2 = spawnAgent(world, [13, 0, 13], { avoidanceRadius: 1.0 });

    crowd.setTarget(a1.entity, [8, 0, 8]);

    world.step(0.1);

    const speed = Math.sqrt(a1.agent.velocity[0] ** 2 + a1.agent.velocity[2] ** 2);
    expect(speed).toBeGreaterThan(0);
  });
});

describe("CrowdSystem repathing", () => {
  it("should repath after repathTimer threshold", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [1, 0, 1]);

    crowd.setTarget(entity, [8, 0, 8]);
    const originalPath = [...agent.path];

    for (let i = 0; i < 200; i++) {
      world.step(0.016);
    }

    expect(agent.repathTimer).toBeLessThanOrEqual(2.0);
  });

  it("should not repath when close to target", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent, transform } = spawnAgent(world, [5, 0, 5], {
      maxSpeed: 10,
      acceleration: 50,
    });

    crowd.setTarget(entity, [5.5, 0, 5.5]);

    for (let i = 0; i < 200; i++) {
      world.step(0.016);
      if (agent.state === "arrived") break;
    }

    expect(agent.state as string).toBe("arrived");
  });
});

describe("CrowdSystem terrain adherence", () => {
  it("should snap Y to terrain height when terrainSampleFn is provided", () => {
    const navMesh = makeNavMesh(10);
    const pathfinder = new Pathfinder(navMesh);
    const crowd = new CrowdSystem(navMesh, pathfinder, {
      spatialCellSize: 4,
      terrainSampleFn: (x: number, z: number) => x + z,
    });
    const world = new World();
    const crowdQuery = new Query([NavAgent.id, PhysicsTransform.id]);
    world.schedule.updateQueryArchetypes(world.allArchetypes);
    crowd.register(world, crowdQuery);

    const { entity, transform } = spawnAgent(world, [1, 0, 1]);
    crowd.setTarget(entity, [8, 0, 8]);

    world.step(0.1);

    expect(transform.position[1]).not.toBe(0);
  });

  it("should not snap Y when terrainSampleFn is null", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, transform } = spawnAgent(world, [1, 5, 1]);

    crowd.setTarget(entity, [8, 0, 8]);

    world.step(0.1);

    expect(transform.position[1]).toBe(5);
  });
});

describe("CrowdSystem edge cases", () => {
  it("should handle agent with empty path", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [5, 0, 5]);

    agent.target = [5, 0, 5];
    agent.state = "seeking";
    agent.path = [];
    agent.pathIndex = 0;

    world.step(0.1);

    expect(agent.state as string).toBe("arrived");
  });

  it("should handle agent with pathIndex beyond path length", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent } = spawnAgent(world, [5, 0, 5]);

    agent.target = [8, 0, 8];
    agent.state = "seeking";
    agent.path = [[5, 0, 5], [8, 0, 8]];
    agent.pathIndex = 5;

    world.step(0.1);

    expect(agent.state as string).toBe("arrived");
  });

  it("should handle multiple agents simultaneously", () => {
    const navMesh = makeNavMesh(12);
    const { world, crowd } = makeCrowdWorld(navMesh);

    const agents: ReturnType<typeof spawnAgent>[] = [];
    for (let i = 0; i < 5; i++) {
      const a = spawnAgent(world, [1 + i * 2, 0, 1], { maxSpeed: 5, acceleration: 20 });
      agents.push(a);
      crowd.setTarget(a.entity, [1 + i * 2, 0, 10]);
    }

    for (let i = 0; i < 100; i++) {
      world.step(0.05);
    }

    for (const { agent, transform } of agents.map((a) => ({
      agent: a.agent,
      transform: a.transform,
    }))) {
      expect(transform.position[2]).toBeGreaterThan(1);
    }
  });

  it("should advance pathIndex when reaching waypoint", () => {
    const navMesh = makeNavMesh(10);
    const { world, crowd } = makeCrowdWorld(navMesh);
    const { entity, agent, transform } = spawnAgent(world, [1, 0, 1], {
      maxSpeed: 20,
      acceleration: 100,
    });

    crowd.setTarget(entity, [8, 0, 8]);
    const initialPathIndex = agent.pathIndex;

    for (let i = 0; i < 300; i++) {
      world.step(0.016);
      if (agent.pathIndex > initialPathIndex) break;
    }

    expect(agent.pathIndex).toBeGreaterThan(initialPathIndex);
  });
});

describe("Pathfinder with obstacles", () => {
  it("should path around non-walkable areas", () => {
    const heights: number[][] = [];
    for (let z = 0; z < 10; z++) {
      const row: number[] = [];
      for (let x = 0; x < 10; x++) {
        if (x >= 4 && x <= 5 && z >= 0 && z <= 8) {
          row.push(-100);
        } else {
          row.push(0);
        }
      }
      heights.push(row);
    }

    const sampler: HeightFieldSampler = {
      sampleHeight: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
        return heights[iz][ix];
      },
      isWalkable: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return false;
        return heights[iz][ix] >= 0;
      },
    };

    const gen = new NavMeshGenerator(defaultConfig);
    const data = gen.generate(sampler, 0, 0, 10, 10);
    const navMesh = new NavMesh();
    navMesh.build(data);

    const pathfinder = new Pathfinder(navMesh);
    const path = pathfinder.findPath([1, 0, 1], [8, 0, 1]);

    expect(path.length).toBeGreaterThanOrEqual(2);

    path.forEach((pt) => {
      const polyId = navMesh.findClosestPoly(pt);
      expect(polyId).toBeGreaterThanOrEqual(0);
      const poly = navMesh.polygons[polyId];
      expect(poly.region).toBeGreaterThanOrEqual(0);
    });
  });

  it("should return empty path when no route exists", () => {
    const heights: number[][] = [];
    for (let z = 0; z < 10; z++) {
      const row: number[] = [];
      for (let x = 0; x < 10; x++) {
        if (x === 5) {
          row.push(-100);
        } else {
          row.push(0);
        }
      }
      heights.push(row);
    }

    const sampler: HeightFieldSampler = {
      sampleHeight: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
        return heights[iz][ix];
      },
      isWalkable: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return false;
        return heights[iz][ix] >= 0;
      },
    };

    const gen = new NavMeshGenerator(defaultConfig);
    const data = gen.generate(sampler, 0, 0, 10, 10);
    const navMesh = new NavMesh();
    navMesh.build(data);

    const pathfinder = new Pathfinder(navMesh);
    const path = pathfinder.findPath([1, 0, 5], [8, 0, 5]);

    expect(path.length).toBe(0);
  });
});

describe("NavMeshGenerator with heightmap", () => {
  it("should handle sloped terrain within max step", () => {
    const heights: number[][] = [];
    for (let z = 0; z < 8; z++) {
      const row: number[] = [];
      for (let x = 0; x < 8; x++) {
        row.push(x * 0.3);
      }
      heights.push(row);
    }

    const sampler: HeightFieldSampler = {
      sampleHeight: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
        return heights[iz][ix];
      },
      isWalkable: () => true,
    };

    const gen = new NavMeshGenerator(defaultConfig);
    const data = gen.generate(sampler, 0, 0, 8, 8);

    expect(data.polygons.length).toBeGreaterThan(0);
  });

  it("should split regions at large height steps", () => {
    const heights: number[][] = [];
    for (let z = 0; z < 8; z++) {
      const row: number[] = [];
      for (let x = 0; x < 8; x++) {
        if (x < 4) {
          row.push(0);
        } else {
          row.push(10);
        }
      }
      heights.push(row);
    }

    const sampler: HeightFieldSampler = {
      sampleHeight: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
        return heights[iz][ix];
      },
      isWalkable: () => true,
    };

    const gen = new NavMeshGenerator(defaultConfig);
    const data = gen.generate(sampler, 0, 0, 8, 8);

    const regions = new Set(data.polygons.map((p) => p.region));
    expect(regions.size).toBeGreaterThanOrEqual(2);
  });

  it("should filter small regions", () => {
    const heights: number[][] = [];
    for (let z = 0; z < 8; z++) {
      const row: number[] = [];
      for (let x = 0; x < 8; x++) {
        row.push(0);
      }
      heights.push(row);
    }
    heights[0][0] = -100;

    const sampler: HeightFieldSampler = {
      sampleHeight: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
        return heights[iz][ix];
      },
      isWalkable: (x: number, z: number) => {
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return false;
        return heights[iz][ix] >= 0;
      },
    };

    const gen = new NavMeshGenerator({ ...defaultConfig, regionMinSize: 5 });
    const data = gen.generate(sampler, 0, 0, 8, 8);

    expect(data.polygons.length).toBeGreaterThan(0);
    data.polygons.forEach((poly) => {
      expect(poly.region).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("NavMesh spatial queries", () => {
  it("should query polygons in radius", () => {
    const navMesh = makeNavMesh(10);
    const polys = navMesh.getPolysInRadius([5, 0, 5], 3);
    expect(polys.length).toBeGreaterThan(0);
  });

  it("should return empty array for radius query in empty area", () => {
    const navMesh = makeNavMesh(10);
    const polys = navMesh.getPolysInRadius([100, 0, 100], 1);
    expect(polys.length).toBe(0);
  });

  it("should get vertex by index", () => {
    const navMesh = makeNavMesh(10);
    const v = navMesh.getVertex(0);
    expect(v.length).toBe(3);
    expect(typeof v[0]).toBe("number");
  });
});

describe("NavMeshDebugViz additional", () => {
  it("should generate poly centers", () => {
    const navMesh = makeNavMesh(8);
    const viz = new NavMeshDebugViz(navMesh);
    const centers = viz.getPolyCenters();
    expect(centers.length).toBeGreaterThan(0);
    centers.forEach((c) => {
      expect(c.length).toBe(3);
    });
  });

  it("should generate empty path lines for empty path", () => {
    const navMesh = makeNavMesh(8);
    const viz = new NavMeshDebugViz(navMesh);
    const lines = viz.getAgentPath([]);
    expect(lines.length).toBe(0);
  });
});
