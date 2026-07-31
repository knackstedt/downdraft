import { type Mat4 } from "wgpu-matrix";
import type { GraphRenderContext } from "../render/frame-graph.ts";
import { ParticleComputePass } from "./compute-pass.ts";
import type { ParticleEmitterData } from "./emitter.ts";
import type { ParticleGPUData } from "./particle-data.ts";
import { ParticleRenderPass } from "./render-pass.ts";
import { ParticleSimulator } from "./simulator.ts";

export interface ParticleSystemConfig {
  maxParticlesPerEmitter: number;
  useGPUCompute: boolean;
  surfaceFormat: GPUTextureFormat;
}

export const DEFAULT_PARTICLE_CONFIG: ParticleSystemConfig = {
  maxParticlesPerEmitter: 10000,
  useGPUCompute: true,
  surfaceFormat: "rgba16float",
};

interface EmitterEntry {
  id: number;
  data: ParticleEmitterData;
  gpuData?: ParticleGPUData;
  computePass?: ParticleComputePass;
}

let nextEmitterId = 0;

export class ParticleSystem {
  private simulator: ParticleSimulator;
  private renderPass: ParticleRenderPass | null = null;
  private computePasses: Map<number, ParticleComputePass> = new Map();
  private emitters: Map<number, EmitterEntry> = new Map();
  private config: ParticleSystemConfig;
  private device: GPUDevice | null = null;

  constructor(config: Partial<ParticleSystemConfig> = {}) {
    this.config = { ...DEFAULT_PARTICLE_CONFIG, ...config };
    this.simulator = new ParticleSimulator({
      maxParticlesPerEmitter: this.config.maxParticlesPerEmitter,
    });
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.renderPass = new ParticleRenderPass(this.config.surfaceFormat, this.config.maxParticlesPerEmitter);
    this.renderPass.prepare(device);
  }

  registerEmitter(emitterData: ParticleEmitterData): number {
    const id = nextEmitterId++;
    this.emitters.set(id, { id, data: emitterData });

    if (this.config.useGPUCompute && this.device) {
      const compute = new ParticleComputePass(emitterData.maxParticles);
      compute.prepare(this.device);
      this.computePasses.set(id, compute);
    }

    return id;
  }

  unregisterEmitter(id: number): void {
    this.emitters.delete(id);
    const compute = this.computePasses.get(id);
    if (compute) {
      compute.destroy();
      this.computePasses.delete(id);
    }
    this.simulator.dispose(id);
  }

  updateEmitter(id: number, data: Partial<ParticleEmitterData>): void {
    const entry = this.emitters.get(id);
    if (entry) {
      entry.data = { ...entry.data, ...data };
    }
  }

  getEmitter(id: number): ParticleEmitterData | undefined {
    return this.emitters.get(id)?.data;
  }

  update(dt: number): void {
    for (const [id, entry] of this.emitters) {
      if (!entry.data.active) continue;

      if (this.config.useGPUCompute && this.device) {
        const compute = this.computePasses.get(id);
        if (compute) {
          compute.emit({
            deltaTime: dt,
            emissionRate: entry.data.emissionRate,
            speed: entry.data.speed,
            speedVariance: entry.data.speedVariance,
            lifetime: entry.data.lifetime,
            lifetimeVariance: entry.data.lifetimeVariance,
            startSize: entry.data.startSize,
            sizeVariance: entry.data.sizeVariance,
            startColor: entry.data.startColor,
            emitterPos: entry.data.position,
            emitterDir: entry.data.direction,
          });

          compute.update({
            deltaTime: dt,
            gravity: entry.data.gravity,
            drag: entry.data.drag,
            maxParticles: entry.data.maxParticles,
            emissionRate: entry.data.emissionRate,
            speed: entry.data.speed,
            speedVariance: entry.data.speedVariance,
            lifetime: entry.data.lifetime,
            lifetimeVariance: entry.data.lifetimeVariance,
            startSize: entry.data.startSize,
            endSize: entry.data.endSize,
            sizeVariance: entry.data.sizeVariance,
            startColor: entry.data.startColor,
            endColor: entry.data.endColor,
            angularVelocity: entry.data.angularVelocity,
            angularVelocityVariance: entry.data.angularVelocityVariance,
            emitterPos: entry.data.position,
            emitterDir: entry.data.direction,
          });
        }
      } else {
        // CPU simulation fallback
        entry.gpuData = this.simulator.simulate(id, entry.data, dt);
      }

      entry.data.elapsed += dt;
    }
  }

  render(ctx: GraphRenderContext, viewProj: Mat4, cameraPos: [number, number, number]): void {
    if (!this.renderPass) return;

    this.renderPass.setCamera(viewProj, cameraPos);

    for (const [, entry] of this.emitters) {
      if (this.config.useGPUCompute) {
        // GPU compute path: render directly from compute buffer
        // This requires the render pass to read from the compute buffer
        // For now, we use the CPU fallback data for rendering
        if (entry.gpuData) {
          this.renderPass.renderInstances(ctx, entry.gpuData, entry.data.maxParticles);
        }
      } else {
        if (entry.gpuData) {
          this.renderPass.renderInstances(ctx, entry.gpuData, entry.data.maxParticles);
        }
      }
    }
  }

  getRenderPass(): ParticleRenderPass | null {
    return this.renderPass;
  }

  getSimulator(): ParticleSimulator {
    return this.simulator;
  }

  getEmitterCount(): number {
    return this.emitters.size;
  }

  setTexture(texture: GPUTexture): void {
    this.renderPass?.setTexture(texture);
  }

  destroy(): void {
    for (const [, compute] of this.computePasses) {
      compute.destroy();
    }
    this.computePasses.clear();
    this.renderPass?.destroy();
    this.renderPass = null;
    this.simulator.disposeAll();
    this.emitters.clear();
  }
}
