import { Component } from "../ecs/component.ts";
import type { Entity } from "../ecs/entity.ts";
import type { Query } from "../ecs/query.ts";
import { Stage, system } from "../ecs/system.ts";
import type { World } from "../ecs/world.ts";
import type { CharacterControllerDesc, CharacterControllerHandle, CharacterMoveResult, RaycastResult } from "./interface.ts";
import type { PhysicsRealm } from "./realm.ts";

export interface CharacterControllerData {
  [key: string]: unknown;
  handleRealmId: number;
  handleBodyId: number;
  controllerHandle: CharacterControllerHandle | null;
  radius: number;
  halfHeight: number;
  slopeLimit: number;
  stepHeight: number;
  maxGroundSpeed: number;
  jumpForce: number;
  airControl: number;
  autostep: { enabled: boolean; minWidth: number; maxHeight: number };
  maxSlope: number;
  snapToGround: number;
  slide: boolean;
  grounded: boolean;
  groundNormal: [number, number, number];
  groundEntity: number;
  velocity: [number, number, number];
}

export const CharacterController = Component.register<CharacterControllerData>("CharacterController", {
  handleRealmId: -1,
  handleBodyId: -1,
  controllerHandle: null,
  radius: 0.4,
  halfHeight: 0.9,
  slopeLimit: 0.7,
  stepHeight: 0.3,
  maxGroundSpeed: 8,
  jumpForce: 9.8,
  airControl: 0.5,
  autostep: { enabled: true, minWidth: 0.2, maxHeight: 0.3 },
  maxSlope: Math.PI / 3,
  snapToGround: 0.1,
  slide: true,
  grounded: false,
  groundNormal: [0, 1, 0],
  groundEntity: -1,
  velocity: [0, 0, 0],
});

export interface CharacterControllerInput {
  entity: Entity;
  position: [number, number, number];
  inputDir: [number, number, number];
  jump: boolean;
}

export class CharacterControllerSystem {
  private realm: PhysicsRealm;
  private gravity: [number, number, number];
  private world: World | null = null;
  private query: Query | null = null;
  private inputs: Map<number, CharacterControllerInput> = new Map();

  constructor(realm: PhysicsRealm, gravity: [number, number, number] = [0, -9.81, 0]) {
    this.realm = realm;
    this.gravity = gravity;
  }

  setRealm(realm: PhysicsRealm): void {
    this.realm = realm;
  }

  setInput(entity: Entity, position: [number, number, number], inputDir: [number, number, number], jump: boolean): void {
    this.inputs.set(entity.index, { entity, position, inputDir, jump });
  }

  clearInput(entity: Entity): void {
    this.inputs.delete(entity.index);
  }

  createController(entity: Entity, controller: CharacterControllerData): CharacterControllerHandle | null {
    const desc: CharacterControllerDesc = {
      offset: [0, controller.radius, 0],
      radius: controller.radius,
      halfHeight: controller.halfHeight,
      slide: controller.slide,
      autostep: controller.autostep,
      maxSlope: controller.maxSlope,
      snapToGround: controller.snapToGround,
    };
    const handle = this.realm.createCharacterController(desc, entity);
    controller.controllerHandle = handle;
    return handle;
  }

  destroyController(controller: CharacterControllerData): void {
    if (controller.controllerHandle) {
      this.realm.destroyCharacterController(controller.controllerHandle);
      controller.controllerHandle = null;
    }
  }

  update(
    controller: CharacterControllerData,
    position: [number, number, number],
    inputDir: [number, number, number],
    jump: boolean,
    dt: number,
  ): [number, number, number] {
    if (controller.controllerHandle) {
      return this.updateWithBackend(controller, position, inputDir, jump, dt);
    }
    return this.updateWithRaycast(controller, position, inputDir, jump, dt);
  }

  private updateWithBackend(
    controller: CharacterControllerData,
    position: [number, number, number],
    inputDir: [number, number, number],
    jump: boolean,
    dt: number,
  ): [number, number, number] {
    const speed = controller.maxGroundSpeed;
    const controlFactor = controller.grounded ? 1 : controller.airControl;

    const desiredHorizontal: [number, number, number] = [
      inputDir[0] * speed * controlFactor,
      0,
      inputDir[2] * speed * controlFactor,
    ];

    let verticalVel = controller.velocity[1];
    if (controller.grounded) {
      verticalVel = jump ? controller.jumpForce : 0;
    } else {
      verticalVel += this.gravity[1] * dt;
    }

    const desiredMovement: [number, number, number] = [
      desiredHorizontal[0] * dt,
      verticalVel * dt,
      desiredHorizontal[2] * dt,
    ];

    const result: CharacterMoveResult = this.realm.characterMove(
      controller.controllerHandle!,
      desiredMovement,
      dt,
    );

    controller.grounded = result.grounded;
    controller.groundNormal = result.groundNormal;
    controller.groundEntity = result.groundEntity?.index ?? -1;

    const effectiveSpeed = dt > 1e-6 ? 1 / dt : 0;
    controller.velocity = [
      result.effectiveMovement[0] * effectiveSpeed,
      verticalVel,
      result.effectiveMovement[2] * effectiveSpeed,
    ];

    return [
      position[0] + result.effectiveMovement[0],
      position[1] + result.effectiveMovement[1],
      position[2] + result.effectiveMovement[2],
    ];
  }

  private updateWithRaycast(
    controller: CharacterControllerData,
    position: [number, number, number],
    inputDir: [number, number, number],
    jump: boolean,
    dt: number,
  ): [number, number, number] {
    const groundCheckOrigin: [number, number, number] = [
      position[0],
      position[1] - controller.halfHeight - 0.05,
      position[2],
    ];

    const groundHit = this.realm.raycast(
      groundCheckOrigin,
      [0, -1, 0],
      0.15,
    );

    controller.grounded = groundHit !== null;
    if (groundHit) {
      controller.groundNormal = groundHit.normal;
      controller.groundEntity = groundHit.entity.index;
    } else {
      controller.groundNormal = [0, 1, 0];
      controller.groundEntity = -1;
    }

    const speed = controller.maxGroundSpeed;
    const controlFactor = controller.grounded ? 1 : controller.airControl;

    const targetVel: [number, number, number] = [
      inputDir[0] * speed * controlFactor,
      controller.velocity[1],
      inputDir[2] * speed * controlFactor,
    ];

    if (controller.grounded) {
      if (jump) {
        targetVel[1] = controller.jumpForce;
      } else {
        targetVel[1] = 0;
      }
    } else {
      targetVel[1] = controller.velocity[1] + this.gravity[1] * dt;
    }

    const slopeDot = controller.groundNormal[1];
    if (controller.grounded && slopeDot < controller.slopeLimit) {
      const slideForce = (1 - slopeDot / controller.slopeLimit) * 5;
      targetVel[0] += controller.groundNormal[0] * slideForce;
      targetVel[2] += controller.groundNormal[2] * slideForce;
    }

    controller.velocity = targetVel;

    const newPos: [number, number, number] = [
      position[0] + targetVel[0] * dt,
      position[1] + targetVel[1] * dt,
      position[2] + targetVel[2] * dt,
    ];

    return newPos;
  }

  checkWallCollision(
    position: [number, number, number],
    moveDir: [number, number, number],
    maxDist: number,
  ): RaycastResult | null {
    return this.realm.raycast(
      [position[0], position[1], position[2]],
      [moveDir[0], 0, moveDir[2]],
      maxDist,
    );
  }

  register(world: World, query: Query): void {
    this.world = world;
    this.query = query;
    const self = this;
    const charSystem = system(
      "character-controller",
      Stage.Physics,
      (ctx) => {
        if (!self.query) return;
        self.query.iterate(ctx.tick, (entity, components) => {
          const controller = components[0] as CharacterControllerData;
          const input = self.inputs.get(entity.index);
          if (!input) return;
          const newPos = self.update(controller, input.position, input.inputDir, input.jump, ctx.dt);
          input.position = newPos;
          if (!input.jump) {
            self.inputs.delete(entity.index);
          }
        });
      },
      { queries: [query] },
    );
    world.schedule.add(charSystem);
  }
}
