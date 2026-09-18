import type { ComponentDefinition } from "@downdraft/engine/ecs/component";
import { Component } from "@downdraft/engine/ecs/component";
import type { Entity } from "@downdraft/engine/ecs/entity";
import type { Query } from "@downdraft/engine/ecs/query";
import { Stage, system } from "@downdraft/engine/ecs/system";
import type { World } from "@downdraft/engine/ecs/world";
import { PhysicsTransform } from "@downdraft/engine/physics/body";
import { SpatialGrid } from "@downdraft/engine/scene/spatial-grid";
import type { NavMesh } from "./navmesh";
import type { Pathfinder } from "./pathfinder";
import type { CrowdSystemConfig, NavAgentData, Vec3 } from "./types";

export const NavAgent: ComponentDefinition<NavAgentData> = Component.register<NavAgentData>("NavAgent", {
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
});

export class CrowdSystem {
  private navMesh: NavMesh;
  private pathfinder: Pathfinder;
  private config: CrowdSystemConfig;
  private spatialGrid: SpatialGrid;
  private query: Query | null = null;
  private world: World | null = null;

  constructor(navMesh: NavMesh, pathfinder: Pathfinder, config: CrowdSystemConfig) {
    this.navMesh = navMesh;
    this.pathfinder = pathfinder;
    this.config = config;
    this.spatialGrid = new SpatialGrid(config.spatialCellSize ?? 4);
  }

  register(world: World, query: Query): void {
    this.world = world;
    this.query = query;
    const self = this;
    const crowdSys = system(
      "crowd-agents",
      Stage.Update,
      (ctx) => {
        if (!self.query) return;
        self.spatialGrid.clear();
        const agents: { entity: Entity; data: NavAgentData }[] = [];
        self.query.iterate(ctx.tick, (entity, components) => {
          const agent = components[0] as NavAgentData;
          agents.push({ entity, data: agent });
          const pos = self.getEntityPosition(entity);
          if (pos) {
            self.spatialGrid.insert({ entity, position: pos, radius: agent.radius, layer: 0 });
          }
        });

        for (const { entity, data } of agents) {
          self.updateAgent(entity, data, ctx.dt);
        }
      },
      { queries: [query] },
    );
    world.schedule.add(crowdSys);
  }

  setTarget(entity: Entity, target: Vec3): void {
    if (!this.world) return;
    const agent = this.world.getComponent<NavAgentData>(entity, NavAgent.id);
    if (!agent) return;
    agent.target = target;
    agent.state = "seeking";
    agent.path = this.pathfinder.findPath(this.getEntityPosition(entity) ?? target, target);
    agent.pathIndex = 0;
    agent.repathTimer = 0;
  }

  private updateAgent(entity: Entity, agent: NavAgentData, dt: number): void {
    if (agent.state === "idle" || !agent.target) return;

    const pos = this.getEntityPosition(entity);
    if (!pos) return;

    agent.polyId = this.navMesh.findClosestPoly(pos);

    if (agent.path.length === 0 || agent.pathIndex >= agent.path.length) {
      agent.state = "arrived";
      agent.velocity = [0, 0, 0];
      return;
    }

    const waypoint = agent.path[agent.pathIndex];
    let dx = waypoint[0] - pos[0];
    let dz = waypoint[2] - pos[2];
    const distToWaypoint = Math.sqrt(dx * dx + dz * dz);

    if (distToWaypoint < 0.3) {
      agent.pathIndex++;
      if (agent.pathIndex >= agent.path.length) {
        agent.state = "arrived";
        agent.velocity = [0, 0, 0];
        return;
      }
      const nextWaypoint = agent.path[agent.pathIndex];
      dx = nextWaypoint[0] - pos[0];
      dz = nextWaypoint[2] - pos[2];
    }

    const desiredDir = this.normalize([dx, 0, dz]);
    const desiredVel: Vec3 = [
      desiredDir[0] * agent.maxSpeed,
      0,
      desiredDir[2] * agent.maxSpeed,
    ];

    const avoidance = this.computeAvoidance(entity, pos, agent);
    const steer: Vec3 = [
      desiredVel[0] * 0.7 + avoidance[0] * 0.3,
      0,
      desiredVel[2] * 0.7 + avoidance[2] * 0.3,
    ];

    const currentVel = agent.velocity;
    const accel = agent.acceleration * dt;
    const newVel: Vec3 = [
      this.approach(currentVel[0], steer[0], accel),
      0,
      this.approach(currentVel[2], steer[2], accel),
    ];
    agent.velocity = newVel;

    const newPos: Vec3 = [
      pos[0] + newVel[0] * dt,
      pos[1],
      pos[2] + newVel[2] * dt,
    ];

    if (this.config.terrainSampleFn) {
      newPos[1] = this.config.terrainSampleFn(newPos[0], newPos[2]);
    }

    this.setEntityPosition(entity, newPos);

    agent.repathTimer += dt;
    if (agent.repathTimer > 2.0) {
      agent.repathTimer = 0;
      const target = agent.target;
      const distToTarget = Math.sqrt(
        (target[0] - pos[0]) ** 2 + (target[2] - pos[2]) ** 2,
      );
      if (distToTarget > 1.0) {
        agent.path = this.pathfinder.findPath(newPos, target);
        agent.pathIndex = 0;
      }
    }
  }

  private computeAvoidance(entity: Entity, pos: Vec3, agent: NavAgentData): Vec3 {
    const nearby = this.spatialGrid.queryRadius(pos, agent.avoidanceRadius);
    let separation: Vec3 = [0, 0, 0];
    let alignment: Vec3 = [0, 0, 0];
    let cohesion: Vec3 = [0, 0, 0];
    let count = 0;

    for (const entry of nearby) {
      if (entry.entity.index === entity.index) continue;
      const otherAgent = this.world?.getComponent<NavAgentData>(entry.entity, NavAgent.id);
      if (!otherAgent) continue;

      const dx = pos[0] - entry.position[0];
      const dz = pos[2] - entry.position[2];
      const distSq = dx * dx + dz * dz;
      if (distSq < 0.01) continue;
      const dist = Math.sqrt(distSq);
      const invDist = 1 / dist;

      separation[0] += dx * invDist;
      separation[2] += dz * invDist;

      alignment[0] += otherAgent.velocity[0];
      alignment[2] += otherAgent.velocity[2];

      cohesion[0] += entry.position[0];
      cohesion[2] += entry.position[2];
      count++;
    }

    if (count === 0) return [0, 0, 0];

    separation[0] = (separation[0] / count) * agent.separationWeight;
    separation[2] = (separation[2] / count) * agent.separationWeight;

    alignment[0] = (alignment[0] / count) * agent.alignmentWeight;
    alignment[2] = (alignment[2] / count) * agent.alignmentWeight;

    cohesion[0] = ((cohesion[0] / count) - pos[0]) * agent.cohesionWeight;
    cohesion[2] = ((cohesion[2] / count) - pos[2]) * agent.cohesionWeight;

    return [
      separation[0] + alignment[0] + cohesion[0],
      0,
      separation[2] + alignment[2] + cohesion[2],
    ];
  }

  private getEntityPosition(entity: Entity): Vec3 | null {
    if (!this.world) return null;
    const transform = this.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    if (transform) return transform.position;
    return null;
  }

  private setEntityPosition(entity: Entity, pos: Vec3): void {
    if (!this.world) return;
    const transform = this.world.getComponent<{ position: Vec3 }>(entity, PhysicsTransform.id);
    if (transform) {
      transform.position = pos;
    }
  }

  private normalize(v: Vec3): Vec3 {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len < 0.0001) return [0, 0, 0];
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  private approach(current: number, target: number, maxDelta: number): number {
    const diff = target - current;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
  }
}
