// ============================================================================
// ECS Pet System — migrated from array-based PetSystem
//
// Query: entities with Transform + Velocity + EntityMeta + EntityData
// Filters by EntityType.Pet in loop body
// Uses players query for owner lookup and shark targeting
// Uses allEntities query for shark wildlife targeting
// ============================================================================

import { Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { SimEntityData, SimEntityMeta, SimPlayerState, SimTransform, SimVelocity } from "./components";
import { EntityType, PetType } from "@shared/types";

interface PetData {
  type: PetType;
  ownerId: number;
  happiness: number;
  hunger: number;
  cooldown: number;
  mischiefLevel: number;
  scoutTarget: { x: number; z: number } | null;
  stolenItem: string | null;
}

const pets = new Map<number, PetData>();

export function createEcsPetSystem(query: Query, playersQuery: Query, allEntitiesQuery: Query) {
  return system(
    "ecs-pet-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;

      // Collect player data for owner lookup and shark targeting
      const playerList: { playerId: number; x: number; y: number; z: number; active: boolean }[] = [];
      playersQuery.iterate(ctx.tick, (_entity, comps) => {
        const ps = comps[0] as ReturnType<typeof SimPlayerState.create>;
        playerList.push({ playerId: ps.playerId, x: ps.x, y: ps.y, z: ps.z, active: ps.active });
      });

      query.iterate(ctx.tick, (entity, comps) => {
        const transform = comps[0] as ReturnType<typeof SimTransform.create>;
        const vel = comps[1] as ReturnType<typeof SimVelocity.create>;
        const meta = comps[2] as ReturnType<typeof SimEntityMeta.create>;
        const data = comps[3] as ReturnType<typeof SimEntityData.create>;

        if (meta.type !== EntityType.Pet) return;

        const pd = pets.get(meta.id);
        if (!pd) return;

        pd.cooldown -= dt;
        pd.hunger = Math.max(0, pd.hunger - 0.3 * dt);

        // Find owner
        let owner: { x: number; y: number; z: number } | null = null;
        for (let p = 0; p < playerList.length; p++) {
          if (playerList[p].playerId === pd.ownerId) {
            owner = playerList[p];
            break;
          }
        }

        switch (pd.type) {
          case PetType.Cat:
            tickCat(transform, vel, data, pd, dt, owner);
            break;
          case PetType.Dog:
            tickDog(transform, vel, data, pd, dt, owner);
            break;
          case PetType.Parrot:
            tickParrot(transform, vel, data, pd, dt, owner);
            break;
          case PetType.Crow:
            tickCrow(transform, vel, data, pd, dt, owner);
            break;
          case PetType.Raccoon:
            tickRaccoon(transform, vel, data, pd, dt, owner);
            break;
          case PetType.Shark:
            tickShark(transform, vel, data, pd, dt, playerList, allEntitiesQuery, ctx.tick);
            break;
        }
      });
    },
    { queries: [query] },
  );
}

function tickCat(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  pd: PetData,
  dt: number,
  owner: { x: number; y: number; z: number } | null,
): void {
  if (!owner) return;
  const dx = owner.x - transform.x;
  const dz = owner.z - transform.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist > 3) {
    data.data[0] = Math.atan2(dz, dx);
    vel.vx = Math.cos(data.data[0]) * 2;
    vel.vz = Math.sin(data.data[0]) * 2;
  } else {
    vel.vx *= 0.8;
    vel.vz *= 0.8;
    pd.happiness = Math.min(100, pd.happiness + 0.5 * dt);
  }

  if (pd.cooldown <= 0 && Math.random() < 0.01) {
    pd.cooldown = 10;
    data.data[2] = 1;
  }
}

function tickDog(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  pd: PetData,
  _dt: number,
  owner: { x: number; y: number; z: number } | null,
): void {
  if (!owner) return;
  const dx = owner.x - transform.x;
  const dz = owner.z - transform.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist > 2) {
    data.data[0] = Math.atan2(dz, dx);
    vel.vx = Math.cos(data.data[0]) * 4;
    vel.vz = Math.sin(data.data[0]) * 4;
  } else {
    const angle = performance.now() / 500;
    vel.vx = Math.cos(angle) * 3;
    vel.vz = Math.sin(angle) * 3;
  }

  if (pd.cooldown <= 0 && Math.random() < 0.05) {
    pd.cooldown = 3;
    data.data[2] = 1;
  }
}

function tickParrot(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  pd: PetData,
  _dt: number,
  owner: { x: number; y: number; z: number } | null,
): void {
  if (!owner) return;
  const dx = owner.x - transform.x;
  const dz = owner.z - transform.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  const targetY = owner.y + 2;
  if (dist > 5) {
    data.data[0] = Math.atan2(dz, dx);
    vel.vx = Math.cos(data.data[0]) * 3;
    vel.vz = Math.sin(data.data[0]) * 3;
    vel.vy = (targetY - transform.y) * 0.5;
  } else {
    vel.vx *= 0.7;
    vel.vz *= 0.7;
    vel.vy = (targetY - transform.y) * 0.3;
  }

  if (pd.cooldown <= 0 && Math.random() < 0.02) {
    pd.cooldown = 8;
    data.data[2] = 1;
  }

  if (pd.cooldown <= 0 && Math.random() < 0.001) {
    pd.cooldown = 300;
    data.data[3] = 1;
  }
}

function tickCrow(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  pd: PetData,
  _dt: number,
  owner: { x: number; y: number; z: number } | null,
): void {
  if (pd.cooldown <= 0) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 50;
    pd.scoutTarget = {
      x: (owner?.x ?? 0) + Math.cos(angle) * dist,
      z: (owner?.z ?? 0) + Math.sin(angle) * dist,
    };
    pd.cooldown = 15;
  }

  if (pd.scoutTarget) {
    const dx = pd.scoutTarget.x - transform.x;
    const dz = pd.scoutTarget.z - transform.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 2) {
      data.data[0] = Math.atan2(dz, dx);
      vel.vx = Math.cos(data.data[0]) * 6;
      vel.vz = Math.sin(data.data[0]) * 6;
      vel.vy = 3;
    } else {
      pd.scoutTarget = null;
    }
  }

  if (Math.random() < 0.005) {
    pd.mischiefLevel++;
    data.data[2] = 1;
  }
}

function tickRaccoon(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  pd: PetData,
  dt: number,
  owner: { x: number; y: number; z: number } | null,
): void {
  if (!owner) return;
  const dx = owner.x - transform.x;
  const dz = owner.z - transform.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (pd.stolenItem) {
    if (dist > 2) {
      data.data[0] = Math.atan2(dz, dx);
      vel.vx = Math.cos(data.data[0]) * 3;
      vel.vz = Math.sin(data.data[0]) * 3;
    } else {
      data.data[3] = 1;
      pd.stolenItem = null;
    }
  } else {
    if (pd.cooldown <= 0) {
      if (Math.random() < 0.3 && dist < 50) {
        pd.stolenItem = "random_junk";
        data.data[2] = 1;
      } else {
        data.data[0] = Math.random() * Math.PI * 2;
        pd.cooldown = 5 + Math.random() * 10;
      }
    }
    pd.cooldown -= dt;
    vel.vx = Math.cos(data.data[0]) * 2;
    vel.vz = Math.sin(data.data[0]) * 2;
  }

  if (Math.random() < 0.01) {
    pd.mischiefLevel++;
  }
}

function tickShark(
  transform: ReturnType<typeof SimTransform.create>,
  vel: ReturnType<typeof SimVelocity.create>,
  data: ReturnType<typeof SimEntityData.create>,
  pd: PetData,
  dt: number,
  playerList: { playerId: number; x: number; y: number; z: number; active: boolean }[],
  allEntitiesQuery: Query,
  currentTick: number,
): void {
  let nearestDist = Infinity;
  let nearestX = 0, nearestZ = 0;
  let foundTarget = false;

  for (let p = 0; p < playerList.length; p++) {
    if (!playerList[p].active) continue;
    if (playerList[p].playerId === pd.ownerId) continue;
    const dx = playerList[p].x - transform.x;
    const dz = playerList[p].z - transform.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestX = playerList[p].x;
      nearestZ = playerList[p].z;
      foundTarget = true;
    }
  }

  // Target nearby wildlife and small craft via ECS query
  allEntitiesQuery.iterate(currentTick, (_entity, comps) => {
    const meta = comps[0] as ReturnType<typeof SimEntityMeta.create>;
    const t = comps[1] as ReturnType<typeof SimTransform.create>;
    const h = comps[2] as ReturnType<typeof import("./components").SimHealth.create>;

    if (meta.type !== EntityType.Fish && meta.type !== EntityType.SmallCraft && meta.type !== EntityType.Livestock) return;
    const dx = t.x - transform.x;
    const dz = t.z - transform.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestX = t.x;
      nearestZ = t.z;
      foundTarget = true;
      if (dist < 3) {
        h.health -= 20 * dt;
      }
    }
  });

  if (foundTarget && nearestDist < 40) {
    data.data[0] = Math.atan2(nearestZ - transform.z, nearestX - transform.x);
    vel.vx = Math.cos(data.data[0]) * 5;
    vel.vz = Math.sin(data.data[0]) * 5;
  } else {
    if (pd.cooldown <= 0) {
      data.data[0] = Math.random() * Math.PI * 2;
      pd.cooldown = 5;
    }
    pd.cooldown -= dt;
    vel.vx = Math.cos(data.data[0]) * 2;
    vel.vz = Math.sin(data.data[0]) * 2;
  }
  vel.vy = (-3 - transform.y) * 0.5;
}

export { pets as ecsPetsMap };
export type { PetData };
