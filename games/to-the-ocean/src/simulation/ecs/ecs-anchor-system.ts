// ============================================================================
// ECS Anchor System — migrated from array-based AnchorSystem
//
// Query: ships (Transform + Velocity + EntityMeta + EntityData)
// Filters by EntityType.Ship || EntityType.SmallCraft in loop body
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
import { SimEntityData, SimEntityMeta, SimTransform, SimVelocity } from "./components";

const ropeLength = ANCHOR_ROPE_LENGTH;

export function createEcsAnchorSystem(shipsQuery: Query) {
  return system(
    "ecs-anchor-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const dt = ctx.dt;

      shipsQuery.iterate(ctx.tick, (_entity, comps) => {
        const transform = comps[0] as ReturnType<typeof SimTransform.create>;
        const vel = comps[1] as ReturnType<typeof SimVelocity.create>;
        const meta = comps[2] as ReturnType<typeof SimEntityMeta.create>;
        const data = comps[3] as ReturnType<typeof SimEntityData.create>;

        if (meta.type !== EntityType.Ship && meta.type !== EntityType.SmallCraft) return;

        const ax = data.data[SHIP_DATA.ANCHOR_X] ?? NaN;
        const az = data.data[SHIP_DATA.ANCHOR_Z] ?? NaN;
        if (!Number.isFinite(ax) || !Number.isFinite(az)) return;

        const dx = transform.x - ax;
        const dz = transform.z - az;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > ropeLength) {
          const excess = dist - ropeLength;
          const invDist = 1 / dist;
          const dirX = -dx * invDist;
          const dirZ = -dz * invDist;

          const force = excess * ANCHOR_STIFFNESS;
          vel.vx += dirX * force * dt;
          vel.vz += dirZ * force * dt;

          const dampFactor = Math.max(0, 1 - ANCHOR_DAMPING * dt);
          vel.vx *= dampFactor;
          vel.vz *= dampFactor;
        } else {
          const dragFactor = Math.max(0, 1 - ANCHOR_DRAG * dt);
          vel.vx *= dragFactor;
          vel.vz *= dragFactor;
        }

        data.data[SHIP_DATA.THROTTLE] = 0;

        if (!Number.isFinite(vel.vx)) vel.vx = 0;
        if (!Number.isFinite(vel.vz)) vel.vz = 0;
        const maxVel = 50;
        if (vel.vx > maxVel) vel.vx = maxVel;
        else if (vel.vx < -maxVel) vel.vx = -maxVel;
        if (vel.vz > maxVel) vel.vz = maxVel;
        else if (vel.vz < -maxVel) vel.vz = -maxVel;
      });
    },
    { queries: [shipsQuery] },
  );
}

if (import.meta.hot) {
  import.meta.hot.accept((newMod: any) => {
    if (newMod) hmrSwap("ecs-anchor-system", newMod);
  });
}
