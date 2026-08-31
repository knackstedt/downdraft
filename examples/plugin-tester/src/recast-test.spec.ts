import { PhysicsTransform, Query, World } from "@downdraft/core";
import {
  RecastAgent,
  RecastBackend,
  RecastCrowdSystem,
  type RecastAgentData,
  type Vec3,
} from "@downdraft/library-recast";
import { getRecastAgentPositions, initRecastTest, type RecastTestResult } from "./recast-test";

// recast-navigation's WASM init is async — set up the test fixture once.
let result: RecastTestResult | null = null;

beforeAll(async () => {
  result = await initRecastTest();
});

function buildFlatPlane(size: number, quads: number): { positions: number[]; indices: number[] } {
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
      indices.push(v0, v2, v1);
      indices.push(v1, v2, v3);
    }
  }
  return { positions, indices };
}

describe("RecastBackend", () => {
  it("should load WASM + build a navmesh from flat ground geometry", async () => {
    const backend = new RecastBackend();
    await backend.init();
    const { positions, indices } = buildFlatPlane(50, 10);
    const ok = backend.buildNavMesh(positions, indices, {
      cs: 0.3,
      ch: 0.2,
      walkableSlopeAngle: 45,
      walkableHeight: 2,
      walkableClimb: 0.4,
      walkableRadius: 0.4,
    });
    expect(ok).toBe(true);
    expect(backend.isBuilt()).toBe(true);
    backend.destroy();
  });

  it("should expose a NavMeshQuery after building", async () => {
    const backend = new RecastBackend();
    await backend.init();
    const { positions, indices } = buildFlatPlane(50, 10);
    backend.buildNavMesh(positions, indices, { cs: 0.3, walkableRadius: 0.4 });
    const query = backend.getQuery();
    expect(query).toBeDefined();
    backend.destroy();
  });

  it("should fail gracefully on empty geometry", async () => {
    const backend = new RecastBackend();
    await backend.init();
    const ok = backend.buildNavMesh([], []);
    expect(ok).toBe(false);
    expect(backend.isBuilt()).toBe(false);
    backend.destroy();
  });
});

describe("RecastBackend NavMeshQuery", () => {
  it("should compute a path between two points on flat terrain", async () => {
    const backend = new RecastBackend();
    await backend.init();
    const { positions, indices } = buildFlatPlane(50, 10);
    backend.buildNavMesh(positions, indices, { cs: 0.3, walkableRadius: 0.4 });
    const query = backend.getQuery();
    const pathResult = query.computePath({ x: -20, y: 0, z: -20 }, { x: 20, y: 0, z: 20 });
    expect(pathResult.success).toBe(true);
    expect(pathResult.path.length).toBeGreaterThan(0);
    // First waypoint should be near the start.
    const first = pathResult.path[0];
    expect(Math.hypot(first.x - (-20), first.z - (-20))).toBeLessThan(5);
    // Last waypoint should be near the end.
    const last = pathResult.path[pathResult.path.length - 1];
    expect(Math.hypot(last.x - 20, last.z - 20)).toBeLessThan(5);
    backend.destroy();
  });
});

describe("RecastCrowdSystem", () => {
  it("should spawn + register agents via the ECS", () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.agents.length).toBe(5);
    for (const { entity } of r.agents) {
      const agent = r.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
      expect(agent).toBeDefined();
      expect(agent!.agentId).toBeGreaterThanOrEqual(0);
    }
  });

  it("should move agents toward their targets on tick", () => {
    const r = result!;
    const { entity } = r.agents[0];
    const transformBefore = r.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const posBefore = [...transformBefore!.position] as Vec3;
    // Target for agent 0 is [20, 0, 20].
    const target: Vec3 = [20, 0, 20];
    const distBefore = Math.hypot(posBefore[0] - target[0], posBefore[2] - target[2]);

    for (let i = 0; i < 60; i++) {
      r.world.step(1 / 60);
    }

    const transformAfter = r.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const posAfter = [...transformAfter!.position] as Vec3;
    const distAfter = Math.hypot(posAfter[0] - target[0], posAfter[2] - target[2]);
    expect(distAfter).toBeLessThan(distBefore);
  });

  it("should handle multiple agents without errors", () => {
    const r = result!;
    // Tick a bunch more — all 5 agents are active with targets.
    for (let i = 0; i < 120; i++) {
      r.world.step(1 / 60);
    }
    const positions = getRecastAgentPositions(r);
    expect(positions.length).toBe(5);
  });

  it("should eventually arrive at (or near) the target", () => {
    const r = result!;
    // Use agent 2 (start [0,0,-10] → target [-10,0,10]) — short distance.
    const { entity } = r.agents[2];
    const target: Vec3 = [-10, 0, 10];
    for (let i = 0; i < 600; i++) {
      r.world.step(1 / 60);
    }
    const transform = r.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const dist = Math.hypot(
      transform!.position[0] - target[0],
      transform!.position[2] - target[2],
    );
    expect(dist).toBeLessThan(3);
  });
});
