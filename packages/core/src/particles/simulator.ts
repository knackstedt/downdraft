import type { ParticleEmitterData, EmitterShape } from "./emitter.ts";
import type { ParticleGPUData } from "./particle-data.ts";

const TWO_PI = Math.PI * 2;

function rand(): number {
  return Math.random();
}

function randRange(min: number, max: number): number {
  return min + rand() * (max - min);
}

function sampleShape(shape: EmitterShape, size: [number, number, number]): [number, number, number] {
  const [sx, sy, sz] = size;
  switch (shape) {
    case "point":
      return [0, 0, 0];
    case "sphere": {
      const theta = rand() * TWO_PI;
      const phi = Math.acos(rand() * 2 - 1);
      const r = sx * Math.cbrt(rand());
      return [
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      ];
    }
    case "box":
      return [randRange(-sx, sx), randRange(-sy, sy), randRange(-sz, sz)];
    case "cone": {
      const angle = rand() * TWO_PI;
      const r = sx * Math.sqrt(rand());
      return [r * Math.cos(angle), 0, r * Math.sin(angle)];
    }
    case "disc": {
      const angle = rand() * TWO_PI;
      const r = sx * Math.sqrt(rand());
      return [r * Math.cos(angle), 0, r * Math.sin(angle)];
    }
    default:
      return [0, 0, 0];
  }
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-9) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function sampleConeDirection(dir: [number, number, number], angle: number): [number, number, number] {
  const n = normalize(dir);
  // Find an arbitrary perpendicular
  const up: [number, number, number] = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const tangent = normalize(cross(up, n));
  const bitangent = cross(n, tangent);

  const cosAngle = Math.cos(angle);
  const phi = rand() * TWO_PI;
  const theta = Math.acos(randRange(cosAngle, 1));

  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  return [
    n[0] * cosTheta + tangent[0] * sinTheta * cosPhi + bitangent[0] * sinTheta * sinPhi,
    n[1] * cosTheta + tangent[1] * sinTheta * cosPhi + bitangent[1] * sinTheta * sinPhi,
    n[2] * cosTheta + tangent[2] * sinTheta * cosPhi + bitangent[2] * sinTheta * sinPhi,
  ];
}

export interface ParticleSimulatorConfig {
  maxParticlesPerEmitter: number;
}

export class ParticleSimulator {
  private gpuData: Map<number, ParticleGPUData> = new Map();
  private cursor: Map<number, number> = new Map();
  private config: ParticleSimulatorConfig;

  constructor(config: Partial<ParticleSimulatorConfig> = {}) {
    this.config = {
      maxParticlesPerEmitter: config.maxParticlesPerEmitter ?? 10000,
    };
  }

  getOrCreateData(emitterId: number, maxParticles: number): ParticleGPUData {
    let data = this.gpuData.get(emitterId);
    if (!data) {
      const capped = Math.min(maxParticles, this.config.maxParticlesPerEmitter);
      data = this._createData(capped);
      this.gpuData.set(emitterId, data);
      this.cursor.set(emitterId, 0);
    }
    return data;
  }

  private _createData(max: number): ParticleGPUData {
    return {
      position: new Float32Array(max * 3),
      velocity: new Float32Array(max * 3),
      color: new Float32Array(max * 4),
      size: new Float32Array(max),
      lifetime: new Float32Array(max),
      maxLifetime: new Float32Array(max),
      rotation: new Float32Array(max),
      angularVelocity: new Float32Array(max),
      active: new Uint8Array(max),
    };
  }

  simulate(emitterId: number, emitter: ParticleEmitterData, dt: number): ParticleGPUData {
    const data = this.getOrCreateData(emitterId, emitter.maxParticles);
    const max = Math.min(emitter.maxParticles, this.config.maxParticlesPerEmitter);
    let cursor = this.cursor.get(emitterId) ?? 0;

    // Emit new particles
    if (emitter.active) {
      const toEmit = Math.min(
        Math.ceil(emitter.emissionRate * dt),
        max - this._countActive(data, max),
      );

      for (let i = 0; i < toEmit; i++) {
        const offset = sampleShape(emitter.shape, emitter.shapeSize);
        const px = emitter.position[0] + offset[0];
        const py = emitter.position[1] + offset[1];
        const pz = emitter.position[2] + offset[2];

        let dir: [number, number, number];
        if (emitter.shape === "cone") {
          const coneAngle = Math.PI / 6;
          dir = sampleConeDirection(emitter.direction, coneAngle);
        } else if (emitter.shape === "sphere") {
          dir = normalize([offset[0], offset[1], offset[2]]);
        } else {
          dir = normalize(emitter.direction);
          dir = [
            dir[0] + randRange(-0.2, 0.2),
            dir[1] + randRange(-0.2, 0.2),
            dir[2] + randRange(-0.2, 0.2),
          ];
          dir = normalize(dir);
        }

        const speed = emitter.speed + randRange(-emitter.speedVariance, emitter.speedVariance);
        const life = emitter.lifetime + randRange(-emitter.lifetimeVariance, emitter.lifetimeVariance);
        const sz = emitter.startSize + randRange(-emitter.sizeVariance, emitter.sizeVariance);
        const angVel = emitter.angularVelocity + randRange(-emitter.angularVelocityVariance, emitter.angularVelocityVariance);

        const idx = cursor;
        data.position[idx * 3 + 0] = px;
        data.position[idx * 3 + 1] = py;
        data.position[idx * 3 + 2] = pz;
        data.velocity[idx * 3 + 0] = dir[0] * speed;
        data.velocity[idx * 3 + 1] = dir[1] * speed;
        data.velocity[idx * 3 + 2] = dir[2] * speed;
        data.color[idx * 4 + 0] = emitter.startColor[0];
        data.color[idx * 4 + 1] = emitter.startColor[1];
        data.color[idx * 4 + 2] = emitter.startColor[2];
        data.color[idx * 4 + 3] = emitter.startColor[3];
        data.size[idx] = sz;
        data.lifetime[idx] = life;
        data.maxLifetime[idx] = life;
        data.rotation[idx] = rand() * TWO_PI;
        data.angularVelocity[idx] = angVel;
        data.active[idx] = 1;

        cursor = (cursor + 1) % max;
      }

      this.cursor.set(emitterId, cursor);
    }

    // Update existing particles
    const dragFactor = Math.exp(-emitter.drag * dt);
    const gx = emitter.gravity[0] * dt;
    const gy = emitter.gravity[1] * dt;
    const gz = emitter.gravity[2] * dt;

    for (let i = 0; i < max; i++) {
      if (!data.active[i]) continue;

      // Apply gravity
      data.velocity[i * 3 + 0] += gx;
      data.velocity[i * 3 + 1] += gy;
      data.velocity[i * 3 + 2] += gz;

      // Apply drag
      data.velocity[i * 3 + 0] *= dragFactor;
      data.velocity[i * 3 + 1] *= dragFactor;
      data.velocity[i * 3 + 2] *= dragFactor;

      // Update position
      data.position[i * 3 + 0] += data.velocity[i * 3 + 0] * dt;
      data.position[i * 3 + 1] += data.velocity[i * 3 + 1] * dt;
      data.position[i * 3 + 2] += data.velocity[i * 3 + 2] * dt;

      // Update rotation
      data.rotation[i] += data.angularVelocity[i] * dt;

      // Decrease lifetime
      data.lifetime[i] -= dt;
      if (data.lifetime[i] <= 0) {
        data.active[i] = 0;
        continue;
      }

      // Interpolate color and size
      const t = 1 - data.lifetime[i] / data.maxLifetime[i]; // 0=birth, 1=death
      data.color[i * 4 + 0] = emitter.startColor[0] + (emitter.endColor[0] - emitter.startColor[0]) * t;
      data.color[i * 4 + 1] = emitter.startColor[1] + (emitter.endColor[1] - emitter.startColor[1]) * t;
      data.color[i * 4 + 2] = emitter.startColor[2] + (emitter.endColor[2] - emitter.startColor[2]) * t;
      data.color[i * 4 + 3] = emitter.startColor[3] + (emitter.endColor[3] - emitter.startColor[3]) * t;
      data.size[i] = emitter.startSize + (emitter.endSize - emitter.startSize) * t;
    }

    return data;
  }

  private _countActive(data: ParticleGPUData, max: number): number {
    let count = 0;
    for (let i = 0; i < max; i++) {
      if (data.active[i]) count++;
    }
    return count;
  }

  getActiveCount(data: ParticleGPUData, max: number): number {
    return this._countActive(data, max);
  }

  reset(emitterId: number): void {
    const data = this.gpuData.get(emitterId);
    if (data) {
      data.active.fill(0);
      data.lifetime.fill(0);
    }
    this.cursor.set(emitterId, 0);
  }

  dispose(emitterId: number): void {
    this.gpuData.delete(emitterId);
    this.cursor.delete(emitterId);
  }

  disposeAll(): void {
    this.gpuData.clear();
    this.cursor.clear();
  }
}
