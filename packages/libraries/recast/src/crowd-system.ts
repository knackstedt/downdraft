// ============================================================================
// RecastCrowdSystem — ECS-integrated wrapper over recast-navigation's Crowd
//
// Mirrors the structure of @downdraft/library-navmesh's CrowdSystem but uses
// recast's WASM Crowd (real RVO avoidance + Detour pathfollowing) instead of
// the hand-rolled boids steering. Defines its own RecastAgent component so
// the two navmesh libraries can coexist without ECS schema coupling.
// ============================================================================

import type { ComponentDefinition } from "@downdraft/core/ecs/component";
import { Component } from "@downdraft/core/ecs/component";
import type { Entity } from "@downdraft/core/ecs/entity";
import type { Query } from "@downdraft/core/ecs/query";
import { Stage, system } from "@downdraft/core/ecs/system";
import type { World } from "@downdraft/core/ecs/world";
import { PhysicsTransform } from "@downdraft/core/physics/body";
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

  constructor(backend: RecastBackend, config: RecastCrowdConfig) {
    this.backend = backend;
    this.config = config;
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
          // State heuristic: arrived when velocity is near-zero and a target is set.
          if (agent.target) {
            const dx = agent.target[0] - pos.x;
            const dz = agent.target[2] - pos.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < 0.25) {
              agent.state = "arrived";
            } else {
              agent.state = "seeking";
            }
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
    return agentIdx;
  }

  /** Sets a move target for the agent. The crowd will pathfind + steer to it. */
  setTarget(entity: Entity, target: Vec3): boolean {
    if (!this.world) return false;
    const agent = this.world.getComponent<RecastAgentData>(entity, RecastAgent.id);
    if (!agent || agent.agentId < 0) return false;
    const crowd = this.crowd;
    if (!crowd) return false;
    const crowdAgent = crowd.getAgent(agent.agentId);
    if (!crowdAgent) return false;
    const ok = crowdAgent.requestMoveTarget({ x: target[0], y: target[1], z: target[2] });
    if (ok) {
      agent.target = target;
      agent.state = "seeking";
    }
    return ok;
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
  }

  /** Releases the recast Crowd. The backend + navmesh are owned by RecastBackend. */
  destroy(): void {
    this.crowd = null;
    this.world = null;
    this.query = null;
    this.entityToAgent.clear();
  }
}
