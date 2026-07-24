import { Component } from "../ecs/component.ts";

export type EmitterShape = "point" | "sphere" | "box" | "cone" | "disc";

export interface EmitterShapeData {
  type: EmitterShape;
  size: [number, number, number];
}

export interface ParticleEmitterData {
  [key: string]: unknown;
  maxParticles: number;
  emissionRate: number;
  shape: EmitterShapeData;
  shapeSize: [number, number, number];
  position: [number, number, number];
  direction: [number, number, number];
  speed: number;
  speedVariance: number;
  lifetime: number;
  lifetimeVariance: number;
  startColor: [number, number, number, number];
  endColor: [number, number, number, number];
  startSize: number;
  endSize: number;
  sizeVariance: number;
  gravity: [number, number, number];
  drag: number;
  angularVelocity: number;
  angularVelocityVariance: number;
  textureIndex: number;
  blendAdditive: boolean;
  worldSpace: boolean;
  loops: number;
  active: boolean;
  emitted: number;
  elapsed: number;
}

export const ParticleEmitter = Component.register<ParticleEmitterData>("ParticleEmitter", {
  maxParticles: 1000,
  emissionRate: 50,
  shape: { type: "point", size: [0, 0, 0] },
  shapeSize: [0, 0, 0],
  position: [0, 0, 0],
  direction: [0, 1, 0],
  speed: 0,
  speedVariance: 0,
  lifetime: 2,
  lifetimeVariance: 0.5,
  startColor: [1, 1, 1, 1],
  endColor: [0, 0, 0, 0],
  startSize: 0.2,
  endSize: 0.01,
  sizeVariance: 0.05,
  gravity: [0, -9.81, 0],
  drag: 0.1,
  angularVelocity: 0,
  angularVelocityVariance: 0,
  textureIndex: 0,
  blendAdditive: true,
  worldSpace: true,
  loops: 0,
  active: true,
  emitted: 0,
  elapsed: 0,
});

export function createParticleEmitter(overrides?: Partial<ParticleEmitterData>): ParticleEmitterData & { __componentId?: number } {
  return ParticleEmitter.create(overrides);
}

export function createFireEmitter(overrides?: Partial<ParticleEmitterData>): ParticleEmitterData & { __componentId?: number } {
  return ParticleEmitter.create({
    maxParticles: 500,
    emissionRate: 80,
    shape: { type: "cone", size: [0.3, 0, 0] },
    direction: [0, 1, 0],
    speed: 3,
    speedVariance: 1.5,
    lifetime: 1.5,
    lifetimeVariance: 0.3,
    startColor: [1, 0.6, 0.1, 1],
    endColor: [0.3, 0, 0, 0],
    startSize: 0.5,
    endSize: 0.01,
    gravity: [0, 2, 0],
    drag: 0.3,
    blendAdditive: true,
    ...overrides,
  });
}

export function createSmokeEmitter(overrides?: Partial<ParticleEmitterData>): ParticleEmitterData & { __componentId?: number } {
  return ParticleEmitter.create({
    maxParticles: 300,
    emissionRate: 20,
    shape: { type: "disc", size: [0.5, 0, 0] },
    direction: [0, 1, 0],
    speed: 1.5,
    speedVariance: 0.5,
    lifetime: 4,
    lifetimeVariance: 1,
    startColor: [0.3, 0.3, 0.3, 0.6],
    endColor: [0.1, 0.1, 0.1, 0],
    startSize: 0.8,
    endSize: 2,
    gravity: [0, -0.5, 0],
    drag: 0.5,
    blendAdditive: false,
    ...overrides,
  });
}

export function createSparkEmitter(overrides?: Partial<ParticleEmitterData>): ParticleEmitterData & { __componentId?: number } {
  return ParticleEmitter.create({
    maxParticles: 200,
    emissionRate: 100,
    shape: { type: "point", size: [0, 0, 0] },
    direction: [0, 1, 0],
    speed: 8,
    speedVariance: 3,
    lifetime: 0.8,
    lifetimeVariance: 0.2,
    startColor: [1, 1, 0.8, 1],
    endColor: [1, 0.5, 0, 0],
    startSize: 0.1,
    endSize: 0.01,
    gravity: [0, -9.81, 0],
    drag: 0.2,
    blendAdditive: true,
    ...overrides,
  });
}

export function createExplosionEmitter(overrides?: Partial<ParticleEmitterData>): ParticleEmitterData & { __componentId?: number } {
  return ParticleEmitter.create({
    maxParticles: 800,
    emissionRate: 800,
    shape: { type: "sphere", size: [0.1, 0, 0] },
    direction: [0, 1, 0],
    speed: 10,
    speedVariance: 5,
    lifetime: 1.2,
    lifetimeVariance: 0.4,
    startColor: [1, 0.8, 0.2, 1],
    endColor: [0.2, 0, 0, 0],
    startSize: 0.6,
    endSize: 0.01,
    gravity: [0, -5, 0],
    drag: 0.4,
    blendAdditive: true,
    loops: 1,
    ...overrides,
  });
}
