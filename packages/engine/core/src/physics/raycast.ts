import type { PhysicsRealm } from "./realm";
import type { RaycastResult, ShapeCastResult, ColliderShape } from "./interface";
import type { Entity } from "../ecs/entity";
import type { DebugDrawQueue } from "../debug-draw/queue";

const RAY_COLOR: [number, number, number, number] = [0, 1, 1, 0.8];
const HIT_COLOR: [number, number, number, number] = [1, 0, 0, 1];
const NORMAL_COLOR: [number, number, number, number] = [0, 1, 0, 1];
const NORMAL_LENGTH = 0.5;

export class RaycastQuery {
  private realm: PhysicsRealm;
  private debugQueue: DebugDrawQueue | null = null;

  constructor(realm: PhysicsRealm) {
    this.realm = realm;
  }

  setDebugQueue(queue: DebugDrawQueue | null): void {
    this.debugQueue = queue;
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
    const result = this.realm.raycast(origin, dir, maxDistance, filter);

    if (this.debugQueue) {
      const endDist = result ? result.distance : maxDistance;
      const endPoint: [number, number, number] = [
        origin[0] + dir[0] * endDist,
        origin[1] + dir[1] * endDist,
        origin[2] + dir[2] * endDist,
      ];
      this.debugQueue.line(origin, endPoint, RAY_COLOR);

      if (result) {
        this.debugQueue.point(result.point, HIT_COLOR, 6);
        const normalEnd: [number, number, number] = [
          result.point[0] + result.normal[0] * NORMAL_LENGTH,
          result.point[1] + result.normal[1] * NORMAL_LENGTH,
          result.point[2] + result.normal[2] * NORMAL_LENGTH,
        ];
        this.debugQueue.line(result.point, normalEnd, NORMAL_COLOR);
      }
    }

    return result;
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
    const results = this.realm.raycastMulti(origin, dir, maxDistance, filter);

    if (this.debugQueue) {
      const endDist = results.length > 0 ? results[results.length - 1].distance : maxDistance;
      const endPoint: [number, number, number] = [
        origin[0] + dir[0] * endDist,
        origin[1] + dir[1] * endDist,
        origin[2] + dir[2] * endDist,
      ];
      this.debugQueue.line(origin, endPoint, RAY_COLOR);

      for (let _i2870 = 0, _it2870 = results, _n2870 = _it2870.length; _i2870 < _n2870; _i2870++) { const result = _it2870[_i2870];
        this.debugQueue.point(result.point, HIT_COLOR, 5);
        const normalEnd: [number, number, number] = [
          result.point[0] + result.normal[0] * NORMAL_LENGTH,
          result.point[1] + result.normal[1] * NORMAL_LENGTH,
          result.point[2] + result.normal[2] * NORMAL_LENGTH,
        ];
        this.debugQueue.line(result.point, normalEnd, NORMAL_COLOR);
      };
    }

    return results;
  }

  shapeCast(
    shape: ColliderShape,
    origin: [number, number, number],
    rotation: [number, number, number, number],
    direction: [number, number, number],
    maxDistance: number = 100,
    filter?: { collisionGroups?: number; excludeEntity?: Entity },
  ): ShapeCastResult | null {
    const result = this.realm.getBackend().shapeCast(
      this.realm.id,
      shape,
      origin,
      rotation,
      direction,
      maxDistance,
      filter,
    );

    if (this.debugQueue) {
      const len = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
      if (len > 1e-9) {
        const dirN: [number, number, number] = [direction[0] / len, direction[1] / len, direction[2] / len];
        const endDist = result ? result.distance * maxDistance : maxDistance;
        const endPoint: [number, number, number] = [
          origin[0] + dirN[0] * endDist,
          origin[1] + dirN[1] * endDist,
          origin[2] + dirN[2] * endDist,
        ];
        this.debugQueue.line(origin, endPoint, RAY_COLOR);

        if (result) {
          this.debugQueue.point(result.point, HIT_COLOR, 6);
          const normalEnd: [number, number, number] = [
            result.point[0] + result.normal[0] * NORMAL_LENGTH,
            result.point[1] + result.normal[1] * NORMAL_LENGTH,
            result.point[2] + result.normal[2] * NORMAL_LENGTH,
          ];
          this.debugQueue.line(result.point, normalEnd, NORMAL_COLOR);
        }
      }
    }

    return result;
  }

  screenPicking(
    cameraPos: [number, number, number],
    rayDir: [number, number, number],
    maxDistance: number = 1000,
  ): RaycastResult | null {
    return this.ray(cameraPos, rayDir, maxDistance);
  }
}
