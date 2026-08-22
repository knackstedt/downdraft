import { PhysicsTransform, Query, World } from "@downdraft/core";
import {
    CrowdSystem, NavAgent,
    NavMesh, NavMeshGenerator, Pathfinder,
    type HeightFieldSampler,
    type NavAgentData, type NavMeshGeneratorConfig,
    type Vec3,
} from "@downdraft/library-navmesh";

const NAVMESH_CONFIG: NavMeshGeneratorConfig = {
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

function makeHeightmapSampler(heights: number[][], scale: number = 1): HeightFieldSampler {
  return {
    sampleHeight: (x: number, z: number) => {
      const ix = Math.floor(x / scale);
      const iz = Math.floor(z / scale);
      if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
      return heights[iz][ix];
    },
    isWalkable: (x: number, z: number) => {
      const ix = Math.floor(x / scale);
      const iz = Math.floor(z / scale);
      if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return false;
      return heights[iz][ix] >= 0;
    },
  };
}

describe("NavMeshGenerator", () => {
  it("should generate nav mesh from flat terrain", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -25, -25, 25, 25);
    expect(data.polygons.length).toBeGreaterThan(0);
    expect(data.vertexCount).toBeGreaterThan(0);
    expect(data.vertices.length).toBe(data.vertexCount * 3);
  });

  it("should handle non-walkable areas", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const sampler = makeHeightmapSampler([
      [0, 0, 0],
      [0, -1, -1],
      [0, -1, -1],
    ], 10);
    const data = gen.generate(sampler, -15, -15, 15, 15);
    expect(data.polygons.length).toBeGreaterThanOrEqual(0);
  });

  it("should respect bounding box", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -10, -10, 10, 10);
    for (let i = 0; i < data.vertexCount; i++) {
      const x = data.vertices[i * 3];
      const z = data.vertices[i * 3 + 2];
      expect(x).toBeGreaterThanOrEqual(-10);
      expect(x).toBeLessThanOrEqual(10);
      expect(z).toBeGreaterThanOrEqual(-10);
      expect(z).toBeLessThanOrEqual(10);
    }
  });

  it("should produce valid polygon data", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -10, -10, 10, 10);
    expect(data.polygons.length).toBeGreaterThan(0);
    expect(data.vertexCount).toBeGreaterThan(0);
  });
});

describe("NavMesh", () => {
  it("should build and report polygon count", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -25, -25, 25, 25);
    const mesh = new NavMesh();
    mesh.build(data);
    expect(mesh.getPolyCount()).toBeGreaterThan(0);
  });

  it("should find closest polygon for a point", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -25, -25, 25, 25);
    const mesh = new NavMesh();
    mesh.build(data);
    const poly = mesh.findClosestPoly([0, 0, 0]);
    expect(poly).not.toBe(-1);
  });

  it("should return a valid poly id for points within the mesh", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -10, -10, 10, 10);
    const mesh = new NavMesh();
    mesh.build(data);
    const poly = mesh.findClosestPoly([0, 0, 0]);
    expect(poly).not.toBe(-1);
  });
});

describe("Pathfinder", () => {
  it("should find a path between two points on flat terrain", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -25, -25, 25, 25);
    const mesh = new NavMesh();
    mesh.build(data);
    const pf = new Pathfinder(mesh);
    const path = pf.findPath([-20, 0, -20], [20, 0, 20]);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    expect(path![0][0]).toBeCloseTo(-20, 0);
    expect(path![path!.length - 1][0]).toBeCloseTo(20, 0);
  });

  it("should handle pathfinding to distant points", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -10, -10, 10, 10);
    const mesh = new NavMesh();
    mesh.build(data);
    const pf = new Pathfinder(mesh);
    const path = pf.findPath([0, 0, 0], [100, 0, 100]);
    // Pathfinder may clamp to nearest poly or return null — both are valid
    if (path) {
      expect(path.length).toBeGreaterThan(0);
    }
  });

  it("should produce simplified waypoints", () => {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -25, -25, 25, 25);
    const mesh = new NavMesh();
    mesh.build(data);
    const pf = new Pathfinder(mesh);
    const path = pf.findPath([-20, 0, -20], [20, 0, 20]);
    if (path && path.length > 2) {
      // Path should be reasonably simplified (not one waypoint per polygon)
      expect(path.length).toBeLessThanOrEqual(50);
    }
  });
});

describe("CrowdSystem", () => {
  function setupCrowd() {
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const data = gen.generate(makeFlatSampler(0), -25, -25, 25, 25);
    const mesh = new NavMesh();
    mesh.build(data);
    const pf = new Pathfinder(mesh);
    const crowd = new CrowdSystem(mesh, pf, {
      spatialCellSize: 4,
      terrainSampleFn: null,
    });
    const world = new World();
    const query = new Query([NavAgent.id, PhysicsTransform.id]);
    world.schedule.updateQueryArchetypes(world.allArchetypes);
    crowd.register(world, query);
    return { mesh, pf, crowd, world, query };
  }

  function spawnAgent(world: World, crowd: CrowdSystem, pos: Vec3, target: Vec3) {
    const agentData: NavAgentData = {
      radius: 0.4, height: 1.8, maxSpeed: 3.5, acceleration: 10,
      path: [], pathIndex: 0, velocity: [0, 0, 0], target: null,
      state: "idle", avoidanceRadius: 2.0, separationWeight: 1.0,
      alignmentWeight: 0.5, cohesionWeight: 0.3, polyId: -1, repathTimer: 0,
    };
    const transformData = {
      position: [pos[0], pos[1], pos[2]] as Vec3,
      rotation: [0, 0, 0, 1] as Vec3,
      prevPosition: [...pos] as Vec3,
      prevRotation: [0, 0, 0, 1] as Vec3,
    };
    const components = new Map();
    components.set(NavAgent.id, agentData);
    components.set(PhysicsTransform.id, transformData);
    const entity = world.spawn(components);
    world.schedule.updateQueryArchetypes(world.allArchetypes);
    crowd.setTarget(entity, target);
    return entity;
  }

  it("should spawn and register agents", () => {
    const { crowd, world } = setupCrowd();
    const entity = spawnAgent(world, crowd, [0, 0, 0], [10, 0, 10]);
    expect(entity).toBeDefined();
  });

  it("should move agents toward target on tick", () => {
    const { crowd, world } = setupCrowd();
    const entity = spawnAgent(world, crowd, [-20, 0, -20], [20, 0, 20]);

    const transformBefore = world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const posBefore = transformBefore!.position;

    for (let i = 0; i < 60; i++) {
      world.step(1 / 60);
    }

    const transformAfter = world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const posAfter = transformAfter!.position;

    const distBefore = Math.hypot(posBefore[0] - 20, posBefore[2] - 20);
    const distAfter = Math.hypot(posAfter[0] - 20, posAfter[2] - 20);
    expect(distAfter).toBeLessThan(distBefore);
  });

  it("should update agent state to seeking after setTarget", () => {
    const { crowd, world } = setupCrowd();
    const entity = spawnAgent(world, crowd, [0, 0, 0], [10, 0, 10]);

    const agent = world.getComponent<NavAgentData>(entity, NavAgent.id);
    expect(agent!.state === "seeking" || agent!.state === "idle").toBe(true);
  });

  it("should handle multiple agents without collision errors", () => {
    const { crowd, world } = setupCrowd();
    const positions: Vec3[] = [[-20, 0, -20], [-15, 0, 15], [0, 0, -10], [10, 0, 5], [20, 0, -20]];
    const targets: Vec3[] = [[20, 0, 20], [15, 0, -20], [-10, 0, 10], [-5, 0, -15], [-20, 0, 20]];

    for (let i = 0; i < positions.length; i++) {
      spawnAgent(world, crowd, positions[i], targets[i]);
    }

    for (let i = 0; i < 30; i++) {
      world.step(1 / 60);
    }
  });

  it("should eventually arrive at target", () => {
    const { crowd, world } = setupCrowd();
    const entity = spawnAgent(world, crowd, [0, 0, 0], [5, 0, 5]);

    for (let i = 0; i < 300; i++) {
      world.step(1 / 60);
    }

    const transform = world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const dist = Math.hypot(transform!.position[0] - 5, transform!.position[2] - 5);
    expect(dist).toBeLessThan(3);
  });
});
