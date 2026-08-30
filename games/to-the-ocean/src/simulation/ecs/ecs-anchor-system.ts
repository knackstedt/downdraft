// ============================================================================
// ECS Anchor System — migrated from array-based AnchorSystem
//
// Query: ships (Transform + Velocity + EntityMeta + EntityData)
// Filters by EntityType.Ship || EntityType.SmallCraft in loop body
//
// SoA components (SimTransform, SimVelocity, SimEntityMeta) via [row].
// AoS component (SimEntityData) as regular object.
// ============================================================================

import { hmrSwap, Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { EntityType } from "@shared/types";
import {
    ANCHOR_DAMPING,
    ANCHOR_DRAG,
    ANCHOR_ROPE_LENGTH,
    ANCHOR_STIFFNESS,
    SHIP_DATA,
} from "../../shared/constants";
import { SimEntityData, type SimEntityMetaSoA, type SimTransformSoA, type SimVelocitySoA } from "./components";

const ropeLength = ANCHOR_ROPE_LENGTH;

export function createEcsAnchorSystem(shipsQuery: Query) {
  return system(
    "ecs-anchor-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;

      shipsQuery.iterate(ctx.tick, (_entity, comps, row) => {
        const transform = comps[0] as unknown as SimTransformSoA;
        const vel = comps[1] as unknown as SimVelocitySoA;
        const meta = comps[2] as unknown as SimEntityMetaSoA;
        const data = comps[3] as ReturnType<typeof SimEntityData.create>;

        if (meta.type[row] !== EntityType.Ship && meta.type[row] !== EntityType.SmallCraft) return;

        const ax = data.data[SHIP_DATA.ANCHOR_X] ?? NaN;
        const az = data.data[SHIP_DATA.ANCHOR_Z] ?? NaN;
        if (!Number.isFinite(ax) || !Number.isFinite(az)) return;

        const dx = transform.x[row]! - ax;
        const dz = transform.z[row]! - az;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > ropeLength) {
          const excess = dist - ropeLength;
          const invDist = 1 / dist;
          const dirX = -dx * invDist;
          const dirZ = -dz * invDist;

          const force = excess * ANCHOR_STIFFNESS;
          vel.vx[row] += dirX * force * dt;
          vel.vz[row] += dirZ * force * dt;

          const dampFactor = Math.max(0, 1 - ANCHOR_DAMPING * dt);
          vel.vx[row] *= dampFactor;
          vel.vz[row] *= dampFactor;
        } else {
          const dragFactor = Math.max(0, 1 - ANCHOR_DRAG * dt);
          vel.vx[row] *= dragFactor;
          vel.vz[row] *= dragFactor;
        }

        data.data[SHIP_DATA.THROTTLE] = 0;

        if (!Number.isFinite(vel.vx[row])) vel.vx[row] = 0;
        if (!Number.isFinite(vel.vz[row])) vel.vz[row] = 0;
        const maxVel = 50;
        if (vel.vx[row]! > maxVel) vel.vx[row] = maxVel;
        else if (vel.vx[row]! < -maxVel) vel.vx[row] = -maxVel;
        if (vel.vz[row]! > maxVel) vel.vz[row] = maxVel;
        else if (vel.vz[row]! < -maxVel) vel.vz[row] = -maxVel;
      });
    },
    { queries: [shipsQuery] },
  );
}

if (import.meta.hot) {
  import.meta.hot.accept((newMod) => {
    if (newMod) hmrSwap("ecs-anchor-system", newMod);
  });
}
