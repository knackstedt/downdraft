// ============================================================================
// RecastCrowdSystem — ECS-integrated wrapper over recast-navigation's Crowd
//
// Mirrors the structure of @downdraft/engine/libraries/navmesh's CrowdSystem but uses
// recast's WASM Crowd (real RVO avoidance + Detour pathfollowing) instead of
// the hand-rolled boids steering. Defines its own RecastAgent component so
// the two navmesh libraries can coexist without ECS schema coupling.
// ============================================================================

import type { ComponentDefinition } from "@downdraft/engine/ecs/component";
import { Component } from "@downdraft/engine/ecs/component";
import type { Entity } from "@downdraft/engine/ecs/entity";
import type { Query } from "@downdraft/engine/ecs/query";
import { Stage, system } from "@downdraft/engine/ecs/system";
import type { World } from "@downdraft/engine/ecs/world";
import { PhysicsTransform } from "@downdraft/engine/physics/body";
import type { RecastBackend } from "./backend";
import type { RecastAgentData, RecastAgentParams, Vec3 } from "./types";

// ── ECS component ──

export const RecastAgent: ComponentDefinition<RecastAgentData> = Component.register<RecastAgentData>(
  "RecastAgent",
  {
    agentId: -1,
    radius: 0.5,
    height: 1.8,
    maxSpeed: 3.5,
    maxAcceleration: 10,
    target: null,
    state: "idle",
    velocity: [0, 0, 0],
  },
);

// ── Crowd system ──

interface RecastCrowdConfig {
  maxAgents: number;
  maxAgentRadius: number;
  /**
   * Seconds an agent may make no appreciable progress toward its target before
   * its state flips to `"stuck"`. Set to `0` (or `Infinity`) to disable stuck
   * detection. Default: `2`.
   */
  stuckTimeout?: number;
  /**
   * Minimum per-tick displacement (metres) that counts as "making progress"
   * for stuck detection. Default: `0.05`.
   */
  stuckMoveEpsilon?: number;
  /**
   * Horizontal distance (metres) from the snapped target at which an agent is
   * considered to have arrived. Default: `0.5`.
   */
  arrivalDistance?: number;
  /**
   * When `setTarget` is called, the engine runs a `computePath` from the
   * agent's current position to the requested target and rejects the target
   * if the resulting path is partial (its final waypoint is farther than this
   * from the snapped target — i.e. the target lies on a disconnected navmesh
   * island, such as the top of an obstacle the agent cannot climb). Set to
   * `0` to accept any target that snaps onto the navmesh without a
   * reachability check. Default: `1.5`.
   */
  reachabilityTolerance?: number;
}

/**
 * Wraps a recast-navigation {@link Crowd}. Created by the {@link RecastLib}
 * descriptor and exposed via {@link RecastCrowdTok}. Games register it with
 * their ECS world via {@link register}, then add agents with {@link addAgent}
 * and steer them with {@link setTarget}.
 *
 * Each tick the system calls `crowd.update(dt)` then writes agent
 * position/velocity back into the ECS `RecastAgent` + `PhysicsTransform`
 * components (mirroring the read-back pattern in library-navmesh's
 * CrowdSystem).
 */
export class RecastCrowdSystem {
  private backend: RecastBackend;
  private config: RecastCrowdConfig;
  private crowd: import("recast-navigation").Crowd | null = null;
  private world: World | null = null;
  private query: Query | null = null;
  /** entity.index → recast CrowdAgent index, for write-back during tick. */
  private entityToAgent = new Map<number, number>();
  /** Per-agent stuck-detection state, keyed by recast agent index. */
  private stuckState = new Map<number, { lastPos: Vec3; timer: number }>();

  // Resolved config (defaults applied once).
  private readonly stuckTimeout: number;
  private readonly stuckMoveEpsilon: number;
  private readonly arrivalDistance: number;
  private readonly reachabilityTolerance: number;

  constructor(backend: RecastBackend, config: RecastCrowdConfig) {
    this.backend = backend;
    this.config = config;
    this.stuckTimeout = config.stuckTimeout ?? 2;
    this.stuckMoveEpsilon = config.stuckMoveEpsilon ?? 0.05;
    this.arrivalDistance = config.arrivalDistance ?? 0.5;
    this.reachabilityTolerance = config.reachabilityTolerance ?? 1.5;
  }

  /**
   * Lazily creates the recast Crowd. The Crowd requires a built NavMesh, so
   * this is called from {@link register} (after the game has built the mesh)
   * or explicitly by the game once the mesh is ready.
   */
  private ensureCrowd(): import("recast-navigation").Crowd {
    if (this.crowd) return this.crowd;
    const mod = this.backend.getModule();
    const navMesh = this.backend.getNavMesh();
    this.crowd = new mod.Crowd(navMesh, {
      maxAgents: this.config.maxAgents,
      maxAgentRadius: this.config.maxAgentRadius,
    });
    return this.crowd;
  }

  /**
   * Registers the per-tick crowd update system with the ECS world.
   * @param world  the ECS world
   * @param query  a query over `[RecastAgent, PhysicsTransform]`
   */
  register(world: World, query: Query): void {
    this.world = world;
    this.query = query;
    const crowdSys = system(
      "recast-crowd-agents",
      Stage.Update,
      (ctx) => {
        if (!this.query) return;
        const crowd = this.crowd;
        if (!crowd) return; // mesh not built yet — no-op until ensureCrowd runs
        crowd.update(ctx.dt);
        this.query.iterate(ctx.tick, (entity, components) => {
          const agent = components[0] as RecastAgentData;
          const transform = components[1] as { position: Vec3; rotation: [number, number, number, number] };
          const agentIdx = this.entityToAgent.get(entity.index);
          if (agentIdx === undefined) return;
          const crowdAgent = crowd.getAgent(agentIdx);
          if (!crowdAgent) return;
          const pos = crowdAgent.position();
          transform.position[0] = pos.x;
          transform.position[1] = pos.y;
          transform.position[2] = pos.z;
          const vel = crowdAgent.velocity();
          agent.velocity[0] = vel.x;
          agent.velocity[1] = vel.y;
          agent.velocity[2] = vel.z;
          // State heuristic: arrived when within arrivalDistance of the
          // (snapped) target; otherwise seeking, with stuck detection as a
          // backstop for agents that make no progress (e.g. target on an
          // unreachable navmesh island, or wedged against geometry).
          if (agent.target) {
            const dx = agent.target[0] - pos.x;
            const dz = agent.target[2] - pos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < this.arrivalDistance * this.arrivalDistance) {
              agent.state = "arrived";
              this.stuckState.delete(agentIdx);
            } else {
              this.updateStuckState(agentIdx, agent, [pos.x, pos.y, pos.z], ctx.dt);
            }
          } else {
            this.stuckState.delete(agentIdx);
          }
        });
      },
      { queries: [query] },
    );
    world.schedule.add(crowdSys);
  }

  /**
   * Adds an agent to the crowd. Reads the entity's current `PhysicsTransform`
   * position as the spawn point. Stores the recast agent index on the
   * `RecastAgent` component and in the entity→agent map.
   */
  addAgent(entity: Entity, params?: RecastAgentParams): number {
    if (!this.world) throw new Error("RecastCrowdSystem not registered with a world.");
    const crowd = this.ensureCrowd();
    const transform = this.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    const pos = transform?.position ?? [0, 0, 0];
    const crowdAgent = crowd.addAgent({ x: pos[0], y: pos[1], z: pos[2] }, {
      radius: params?.radius ?? 0.5,
      height: params?.height ?? 1.8,
      maxAcceleration: params?.maxAcceleration ?? 10,
      maxSpeed: params?.maxSpeed ?? 3.5,
      collisionQueryRange: params?.collisionQueryRange ?? 2.5,
      pathOptimizationRange: params?.pathOptimizationRange ?? 0,
      separationWeight: params?.separationWeight ?? 0,
      updateFlags: params?.updateFlags ?? 7,
      obstacleAvoidanceType: params?.obstacleAvoidanceType ?? 0,
      queryFilterType: params?.queryFilterType ?? 0,
    });
    const agentIdx = crowdAgent.agentIndex;
    const agent = this.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
    if (agent) {
      agent.agentId = agentIdx;
      agent.radius = params?.radius ?? agent.radius;
      agent.height = params?.height ?? agent.height;
      agent.maxSpeed = params?.maxSpeed ?? agent.maxSpeed;
      agent.maxAcceleration = params?.maxAcceleration ?? agent.maxAcceleration;
    }
    this.entityToAgent.set(entity.index, agentIdx);
    this.stuckState.delete(agentIdx);
    return agentIdx;
  }

  /**
   * Sets a move target for the agent. The crowd will pathfind + steer to it.
   *
   * The requested target is validated before being issued:
   *   1. It is snapped to the nearest walkable navmesh polygon.
   *   2. A `computePath` is run from the agent's current position to the
   *      snapped target. If the path is partial (its final waypoint is
   *      farther than `reachabilityTolerance` from the target — i.e. the
   *      target lies on a disconnected navmesh island such as the top of an
   *      obstacle the agent cannot climb), the target is rejected and
   *      `false` is returned. The agent's existing target is left untouched.
   *
   * On success, the *snapped, reachable* endpoint is stored as the agent's
   * target (not the raw input) so the arrival heuristic measures distance to
   * the actual goal rather than a point inside geometry.
   *
   * @returns `true` if the target was accepted and issued to the crowd.
   */
  setTarget(entity: Entity, target: Vec3): boolean {
    if (!this.world) return false;
    const agent = this.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
    if (!agent || agent.agentId < 0) return false;
    const crowd = this.crowd;
    if (!crowd) return false;
    const crowdAgent = crowd.getAgent(agent.agentId);
    if (!crowdAgent) return false;

    // Snap the requested target to the nearest walkable polygon, then verify
    // the agent can actually reach it. Without this, a target inside an
    // obstacle snaps to the nearest navmesh polygon — which may be the
    // obstacle's walkable *top*, a disconnected island the agent cannot climb
    // to — and the crowd spends forever steering into the obstacle base.
    if (this.reachabilityTolerance > 0 && this.backend.isBuilt()) {
      const query = this.backend.getQuery();
      const startPos = crowdAgent.position();
      const path = query.computePath(
        { x: startPos.x, y: startPos.y, z: startPos.z },
        { x: target[0], y: target[1], z: target[2] },
      );
      if (!path.success || path.path.length === 0) return false;
      const last = path.path[path.path.length - 1];
      const dx = last.x - target[0];
      const dz = last.z - target[2];
      // Partial path → target is on a disconnected island. Reject it.
      if (Math.hypot(dx, dz) > this.reachabilityTolerance) return false;
      // Issue the move target at the reachable endpoint and store the snapped
      // target so arrival detection is accurate.
      const ok = crowdAgent.requestMoveTarget({ x: last.x, y: last.y, z: last.z });
      if (!ok) return false;
      agent.target = [last.x, last.y, last.z];
    } else {
      // Reachability check disabled: fall back to recast's built-in snapping.
      const ok = crowdAgent.requestMoveTarget({ x: target[0], y: target[1], z: target[2] });
      if (!ok) return false;
      agent.target = [target[0], target[1], target[2]];
    }

    agent.state = "seeking";
    this.stuckState.delete(agent.agentId);
    return true;
  }

  /**
   * Per-tick stuck detection. Uses a sliding window: every `stuckTimeout`
   * seconds it checks whether the agent has made appreciable *net* progress
   * from its position at the start of the window. Measuring net displacement
   * (rather than per-tick movement) correctly classifies an agent that
   * oscillates against an obstacle as stuck — it jittered but ended up back
   * where it started. This is a backstop for cases the `setTarget`
   * reachability check cannot catch (dynamic obstacles, crowd local minima,
   * agents wedged against geometry).
   */
  private updateStuckState(agentIdx: number, agent: RecastAgentData, pos: Vec3, dt: number): void {
    if (this.stuckTimeout <= 0 || !Number.isFinite(this.stuckTimeout)) {
      agent.state = "seeking";
      return;
    }
    let s = this.stuckState.get(agentIdx);
    if (!s) {
      s = { lastPos: [pos[0], pos[1], pos[2]], timer: 0 };
      this.stuckState.set(agentIdx, s);
    }
    s.timer += dt;
    if (s.timer >= this.stuckTimeout) {
      // Window elapsed — evaluate net displacement from the window start.
      const moved = Math.hypot(
        pos[0] - s.lastPos[0], pos[1] - s.lastPos[1], pos[2] - s.lastPos[2],
      );
      if (moved < this.stuckMoveEpsilon) {
        agent.state = "stuck";
      } else {
        // Made progress — start a fresh window from the current position.
        s.lastPos[0] = pos[0];
        s.lastPos[1] = pos[1];
        s.lastPos[2] = pos[2];
        s.timer = 0;
        agent.state = "seeking";
      }
    } else {
      agent.state = "seeking";
    }
  }

  /** Clears the agent's move target (it will decelerate to a stop). */
  clearTarget(entity: Entity): void {
    if (!this.world) return;
    const agent = this.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
    if (!agent || agent.agentId < 0) return;
    const crowd = this.crowd;
    if (!crowd) return;
    const crowdAgent = crowd.getAgent(agent.agentId);
    if (!crowdAgent) return;
    crowdAgent.resetMoveTarget();
    agent.target = null;
    agent.state = "idle";
    this.stuckState.delete(agent.agentId);
  }

  /** Removes an agent from the crowd. */
  removeAgent(entity: Entity): void {
    if (!this.world) return;
    const agent = this.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
    if (!agent || agent.agentId < 0) return;
    const crowd = this.crowd;
    if (crowd) crowd.removeAgent(agent.agentId);
    agent.agentId = -1;
    agent.state = "idle";
    this.entityToAgent.delete(entity.index);
    this.stuckState.delete(agent.agentId);
  }

  /** Releases the recast Crowd. The backend + navmesh are owned by RecastBackend. */
  destroy(): void {
    this.crowd = null;
    this.world = null;
    this.query = null;
    this.entityToAgent.clear();
    this.stuckState.clear();
  }
}
