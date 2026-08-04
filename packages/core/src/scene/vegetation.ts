import { Component } from "../ecs/component";

export interface VegetationPatchData {
  [key: string]: unknown;
  patchX: number;
  patchZ: number;
  density: number;
  instanceCount: number;
  meshId: number;
  materialId: number;
  castShadows: boolean;
  receiveShadows: boolean;
  windEnabled: boolean;
  windStrength: number;
  windDirection: [number, number];
  windFrequency: number;
  lodDistance: number;
  cullDistance: number;
}

export const VegetationPatch = Component.register<VegetationPatchData>("VegetationPatch", {
  patchX: 0,
  patchZ: 0,
  density: 1.0,
  instanceCount: 0,
  meshId: -1,
  materialId: -1,
  castShadows: true,
  receiveShadows: false,
  windEnabled: true,
  windStrength: 0.3,
  windDirection: [1, 0],
  windFrequency: 1.5,
  lodDistance: 50,
  cullDistance: 200,
});

export interface VegetationInstance {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  colorVariation: number;
}

export interface WindState {
  time: number;
  gustStrength: number;
  gustFrequency: number;
  direction: [number, number];
}

export class VegetationWindSystem {
  private time = 0;
  private config: WindState;

  constructor(config?: Partial<WindState>) {
    this.config = {
      time: 0,
      gustStrength: 0.5,
      gustFrequency: 0.3,
      direction: [1, 0],
      ...config,
    };
  }

  update(dt: number): void {
    this.time += dt;
    this.config.time = this.time;
  }

  computeWindOffset(x: number, z: number, height: number): [number, number, number] {
    const t = this.time;
    const gust = Math.sin(x * 0.1 + t * this.config.gustFrequency) *
                 Math.cos(z * 0.1 + t * this.config.gustFrequency * 0.7);
    const sway = Math.sin(t * 2 + x * 0.3 + z * 0.2) * 0.5 + 0.5;
    const strength = this.config.gustStrength * (0.5 + gust * 0.5);
    const heightFactor = Math.min(1, height / 2);

    const dirLen = Math.sqrt(this.config.direction[0] ** 2 + this.config.direction[1] ** 2);
    const dx = dirLen > 0 ? this.config.direction[0] / dirLen : 1;
    const dz = dirLen > 0 ? this.config.direction[1] / dirLen : 0;

    return [
      dx * strength * sway * heightFactor,
      0,
      dz * strength * sway * heightFactor,
    ];
  }

  packWindUniforms(): Float32Array {
    const data = new Float32Array(8);
    data[0] = this.config.gustStrength;
    data[1] = this.config.gustFrequency;
    data[2] = this.config.direction[0];
    data[3] = this.config.direction[1];
    data[4] = this.time;
    return data;
  }

  setDirection(dir: [number, number]): void {
    this.config.direction = dir;
  }

  setGustStrength(strength: number): void {
    this.config.gustStrength = strength;
  }

  setGustFrequency(freq: number): void {
    this.config.gustFrequency = freq;
  }
}

export function generateInstances(
  patchX: number,
  patchZ: number,
  patchSize: number,
  density: number,
  seed: number,
): VegetationInstance[] {
  const instances: VegetationInstance[] = [];
  const count = Math.floor(patchSize * patchSize * density * 0.01);

  for (let i = 0; i < count; i++) {
    const hash1 = hash(seed + i * 3);
    const hash2 = hash(seed + i * 3 + 1);
    const hash3 = hash(seed + i * 3 + 2);

    const x = patchX * patchSize + hash1 * patchSize;
    const z = patchZ * patchSize + hash2 * patchSize;
    const y = 0;

    instances.push({
      position: [x, y, z],
      rotation: [0, hash3 * Math.PI * 2, 0],
      scale: 0.8 + hash(seed + i * 7) * 0.4,
      colorVariation: hash(seed + i * 11),
    });
  }

  return instances;
}

function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

export function packInstanceData(instances: VegetationInstance[]): Float32Array {
  const data = new Float32Array(instances.length * 8);
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const offset = i * 8;
    data[offset] = inst.position[0];
    data[offset + 1] = inst.position[1];
    data[offset + 2] = inst.position[2];
    data[offset + 3] = inst.rotation[1];
    data[offset + 4] = inst.scale;
    data[offset + 5] = inst.colorVariation;
    data[offset + 6] = 0;
    data[offset + 7] = 0;
  }
  return data;
}
