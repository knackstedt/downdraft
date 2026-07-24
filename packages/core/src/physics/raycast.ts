import type { PhysicsRealm } from "./realm.ts";
import type { RaycastResult, ShapeCastResult, ColliderShape } from "./interface.ts";
import type { Entity } from "../ecs/entity.ts";

export class RaycastQuery {
  private realm: PhysicsRealm;

  constructor(realm: PhysicsRealm) {
    this.realm = realm;
  }

  ray(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number = 100,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult | null {
    const len = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
    if (len < 1e-9) return null;
    const dir: [number, number, number] = [direction[0] / len, direction[1] / len, direction[2] / len];
    return this.realm.raycast(origin, dir, maxDistance, filter);
  }

  rayMulti(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number = 100,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): RaycastResult[] {
    const len = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
    if (len < 1e-9) return [];
    const dir: [number, number, number] = [direction[0] / len, direction[1] / len, direction[2] / len];
    return this.realm.raycastMulti(origin, dir, maxDistance, filter);
  }

  shapeCast(
    shape: ColliderShape,
    origin: [number, number, number],
    rotation: [number, number, number, number],
    direction: [number, number, number],
    maxDistance: number = 100,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): ShapeCastResult | null {
    return this.realm.getBackend().shapeCast(
      this.realm.id,
      shape,
      origin,
      rotation,
      direction,
      maxDistance,
      filter,
    );
  }

  screenPicking(
    cameraPos: [number, number, number],
    rayDir: [number, number, number],
    maxDistance: number = 1000,
  ): RaycastResult | null {
    return this.ray(cameraPos, rayDir, maxDistance);
  }
}
