// ============================================================================
// Recast obstacle / stuck regression spec
//
// Reproduces the failure mode where agents get stuck inside obstacles because
// a target inside an obstacle footprint snaps to the obstacle's walkable top
// (a disconnected navmesh island the agent cannot climb). Verifies that:
//   1. setTarget rejects an unreachable (in-obstacle) target and returns false.
//   2. setTarget accepts a reachable target and the agent progresses toward it.
//   3. the stuck-detection backstop flips an agent's state to "stuck" when it
//      is given a target it cannot make progress toward (reachability check
//      disabled via reachabilityTolerance: 0) and the stuckTimeout elapses.
// ============================================================================
import { PhysicsTransform, Query, World, type Entity } from "@downdraft/engine";
import {
    RecastAgent,
    RecastBackend,
    RecastCrowdSystem,
    type RecastAgentData,
    type Vec3,
} from "@downdraft/engine/libraries/recast";

// ── Obstacle scene (mirrors games/downdraft-gpu-bench/.../obstacle-scene.ts) ──

const OBSTACLES: { minX: number; maxX: number; minZ: number; maxZ: number; height: number }[] = [
  { minX: -8, maxX: -2, minZ: -3, maxZ: 3, height: 3 }, // central wall
  { minX: 5, maxX: 12, minZ: -8, maxZ: -5, height: 2.5 },
  { minX: 9, maxX: 12, minZ: -5, maxZ: 5, height: 2.5 },
  { minX: -20, maxX: -17, minZ: 8, maxZ: 11, height: 2 },
  { minX: 15, maxX: 18, minZ: 10, maxZ: 13, height: 2 },
  { minX: -5, maxX: -3, minZ: 15, maxZ: 17, height: 1.5 },
];

function buildBoxTriangles(
  minX: number, maxX: number, minZ: number, maxZ: number, height: number, baseVertex: number,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const y0 = 0, y1 = height;
  const c = [
    [minX, y0, minZ], [maxX, y0, minZ], [maxX, y0, maxZ], [minX, y0, maxZ],
    [minX, y1, minZ], [maxX, y1, minZ], [maxX, y1, maxZ], [minX, y1, maxZ],
  ];
  c.forEach((p) => { positions.push(p[0], p[1], p[2]);; });
  indices.push(4, 5, 6, 4, 6, 7); // top (walkable)
  indices.push(0, 2, 1, 0, 3, 2); // bottom
  indices.push(0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7); // sides
  for (let i = 0; i < indices.length; i++) indices[i] += baseVertex;
  return { positions, indices };
}

function buildObstacleScene(): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const GS = 50, GH = GS / 2, quads = 10, step = GS / quads;
  for (let z = 0; z <= quads; z++)
    for (let x = 0; x <= quads; x++) positions.push(-GH + x * step, 0, -GH + z * step);
  const vpr = quads + 1;
  for (let z = 0; z < quads; z++)
    for (let x = 0; x < quads; x++) {
      const v0 = z * vpr + x, v1 = v0 + 1, v2 = (z + 1) * vpr + x, v3 = v2 + 1;
      indices.push(v0, v2, v1, v1, v2, v3);
    }
  let bv = positions.length / 3;
  OBSTACLES.forEach((obs) => {
    const box = buildBoxTriangles(obs.minX, obs.maxX, obs.minZ, obs.maxZ, obs.height, bv);
    positions.push(...box.positions);
    indices.push(...box.indices);
    bv += 8;
  });
  return { positions, indices };
}

/** True if (x,z) lies inside any obstacle footprint (at ground level). */
function isInsideObstacle(x: number, z: number): boolean {
  for (let _i = 0, _it = OBSTACLES, _n = _it.length; _i < _n; _i++) { const o = _it[_i]; if (x >= o.minX && x <= o.maxX && z >= o.minZ && z <= o.maxZ) return true; }
  return false;
}

// ── Fixture ──

interface Fixture {
  backend: RecastBackend;
  crowd: RecastCrowdSystem;
  world: World;
  spawn(start: Vec3): Entity;
}

async function buildFixture(opts?: {
  stuckTimeout?: number;
  reachabilityTolerance?: number;
}): Promise<Fixture> {
  const backend = new RecastBackend();
  await backend.init();
  const { positions, indices } = buildObstacleScene();
  const ok = backend.buildNavMesh(positions, indices, {
    cs: 0.3, ch: 0.2, walkableSlopeAngle: 45, walkableHeight: 2, walkableClimb: 0.4, walkableRadius: 0.4,
  });
  if (!ok) throw new Error("recast: failed to build obstacle navmesh");
  const crowd = new RecastCrowdSystem(backend, {
    maxAgents: 32,
    maxAgentRadius: 0.6,
    stuckTimeout: opts?.stuckTimeout,
    reachabilityTolerance: opts?.reachabilityTolerance,
  });
  const world = new World();
  const crowdQuery = new Query([RecastAgent.id, PhysicsTransform.id]);
  world.schedule.updateQueryArchetypes(world.allArchetypes);
  crowd.register(world, crowdQuery);
  const spawn = (start: Vec3): Entity => {
    const components = new Map();
    components.set(RecastAgent.id, {
      agentId: -1, radius: 0.4, height: 1.8, maxSpeed: 3.5, maxAcceleration: 10,
      target: null, state: "idle", velocity: [0, 0, 0],
    } as RecastAgentData);
    components.set(PhysicsTransform.id, {
      position: [...start] as Vec3,
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      prevPosition: [...start] as Vec3,
      prevRotation: [0, 0, 0, 1] as [number, number, number, number],
    });
    const entity = world.spawn(components);
    world.schedule.updateQueryArchetypes(world.allArchetypes);
    crowd.addAgent(entity, { radius: 0.4, height: 1.8, maxSpeed: 3.5, maxAcceleration: 10 });
    return entity;
  };
  return { backend, crowd, world, spawn };
}

describe("RecastCrowdSystem obstacle reachability", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await buildFixture();
  });
  afterAll(() => fx.backend.destroy());

  it("rejects a target inside an obstacle footprint (unreachable island)", () => {
    const agent = fx.spawn([-20, 0, -20]);
    // (-5, 0, 0) is inside the central wall (-8..-2, -3..3).
    expect(isInsideObstacle(-5, 0)).toBe(true);
    const accepted = fx.crowd.setTarget(agent, [-5, 0, 0]);
    expect(accepted).toBe(false);
    const data = fx.world.getComponent<RecastAgentData>(agent, RecastAgent.id)!;
    // Rejected targets must not be stored — agent stays idle with no target.
    expect(data.target).toBeNull();
    expect(data.state).toBe("idle");
  });

  it("accepts a reachable target and the agent progresses toward it", () => {
    const agent = fx.spawn([-20, 0, -20]);
    const target: Vec3 = [20, 0, 20];
    expect(isInsideObstacle(target[0], target[2])).toBe(false);
    const accepted = fx.crowd.setTarget(agent, target);
    expect(accepted).toBe(true);
    const tBefore = fx.world.getComponent<{ position: Vec3 }>(agent, PhysicsTransform.id)!;
    const distBefore = Math.hypot(tBefore.position[0] - target[0], tBefore.position[2] - target[2]);
    for (let i = 0; i < 60; i++) fx.world.step(1 / 60);
    const tAfter = fx.world.getComponent<{ position: Vec3 }>(agent, PhysicsTransform.id)!;
    const distAfter = Math.hypot(tAfter.position[0] - target[0], tAfter.position[2] - target[2]);
    expect(distAfter).toBeLessThan(distBefore);
  });
});

describe("RecastCrowdSystem stuck detection", () => {
  // With the reachability check disabled, an in-obstacle target is accepted
  // (snapped to the obstacle's walkable top, an island the agent cannot climb).
  // The agent cannot make progress → stuck detection must flip state to "stuck".
  let fx: Fixture;
  beforeAll(async () => {
    fx = await buildFixture({ stuckTimeout: 0.5, reachabilityTolerance: 0 });
  });
  afterAll(() => fx.backend.destroy());

  it("flips an agent to 'stuck' when it makes no progress toward an unreachable target", () => {
    // Spawn just outside the central wall (-8..-2) so the agent reaches the
    // wall base quickly and wedges there, unable to climb to the target on top.
    const agent = fx.spawn([-9, 0, 0]);
    const accepted = fx.crowd.setTarget(agent, [-5, 0, 0]); // inside central wall
    expect(accepted).toBe(true);
    const data = fx.world.getComponent<RecastAgentData>(agent, RecastAgent.id)!;
    // The agent creeps slowly toward the wall base (recast avoidance bleeds
    // speed as it approaches), then stalls against it. With reachability
    // disabled the target is accepted, so the only thing that surfaces the
    // wedge is the stuck-detection backstop. Tick past the creep + timeout.
    for (let i = 0; i < 360; i++) fx.world.step(1 / 60); // 6s
    expect(data.state).toBe("stuck");
  });

  it("does not mark an agent stuck while it is progressing toward a reachable target", () => {
    const agent = fx.spawn([-20, 0, -20]);
    fx.crowd.setTarget(agent, [20, 0, 20]);
    const data = fx.world.getComponent<RecastAgentData>(agent, RecastAgent.id)!;
    for (let i = 0; i < 30; i++) fx.world.step(1 / 60); // 0.5s
    expect(data.state).not.toBe("stuck");
  });
});
