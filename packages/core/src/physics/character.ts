import { Component } from "../ecs/component.ts";
import type { PhysicsRealm } from "./realm.ts";
import type { RaycastResult } from "./interface.ts";

export interface CharacterControllerData {
  [key: string]: unknown;
  handleRealmId: number;
  handleBodyId: number;
  radius: number;
  halfHeight: number;
  slopeLimit: number;
  stepHeight: number;
  maxGroundSpeed: number;
  jumpForce: number;
  airControl: number;
  grounded: boolean;
  groundNormal: [number, number, number];
  groundEntity: number;
  velocity: [number, number, number];
}

export const CharacterController = Component.register<CharacterControllerData>("CharacterController", {
  handleRealmId: -1,
  handleBodyId: -1,
  radius: 0.4,
  halfHeight: 0.9,
  slopeLimit: 0.7,
  stepHeight: 0.3,
  maxGroundSpeed: 8,
  jumpForce: 9.8,
  airControl: 0.5,
  grounded: false,
  groundNormal: [0, 1, 0],
  groundEntity: -1,
  velocity: [0, 0, 0],
});

export class CharacterControllerSystem {
  private realm: PhysicsRealm;
  private gravity: [number, number, number];

  constructor(realm: PhysicsRealm, gravity: [number, number, number] = [0, -9.81, 0]) {
    this.realm = realm;
    this.gravity = gravity;
  }

  update(
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
}
