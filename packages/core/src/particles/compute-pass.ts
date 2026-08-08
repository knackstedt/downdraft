import type { GraphRenderContext } from "../render/frame-graph";
import { RenderPass } from "../render/render-pass";

const PARTICLE_COMPUTE_SHADER = `
struct Particle {
  position: vec3<f32>,
  _pad0: f32,
  velocity: vec3<f32>,
  _pad1: f32,
  color: vec4<f32>,
  size: f32,
  lifetime: f32,
  maxLifetime: f32,
  rotation: f32,
};

struct SimParams {
  deltaTime: f32,
  gravity: vec3<f32>,
  drag: f32,
  emitCount: u32,
  maxParticles: u32,
  emissionRate: f32,
  speed: f32,
  speedVariance: f32,
  lifetime: f32,
  lifetimeVariance: f32,
  startSize: f32,
  endSize: f32,
  sizeVariance: f32,
  startColor: vec4<f32>,
  endColor: vec4<f32>,
  angularVelocity: f32,
  angularVelocityVariance: f32,
  emitterPos: vec3<f32>,
  emitterDir: vec3<f32>,
  seed: u32,
};

struct Counter {
  cursor: u32,
  activeCount: u32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: SimParams;
@group(0) @binding(2) var<storage, read_write> counter: Counter;

fn hash(seed: ptr<function, u32>) -> f32 {
  *seed = *seed * 1103515245u + 12345u;
  return f32(*seed) / 4294967296.0;
}

fn randRange(seed: ptr<function, u32>, min: f32, max: f32) -> f32 {
  return min + hash(seed) * (max - min);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.maxParticles) { return; }

  // Update existing particles
  if (particles[idx].lifetime > 0.0) {
    // Apply gravity
    particles[idx].velocity += params.gravity * params.deltaTime;

    // Apply drag
    let dragFactor = exp(-params.drag * params.deltaTime);
    particles[idx].velocity *= dragFactor;

    // Update position
    particles[idx].position += particles[idx].velocity * params.deltaTime;

    // Update rotation
    particles[idx].rotation += params.angularVelocity * params.deltaTime;

    // Decrease lifetime
    particles[idx].lifetime -= params.deltaTime;

    if (particles[idx].lifetime <= 0.0) {
      particles[idx].lifetime = 0.0;
      particles[idx].size = 0.0;
      return;
    }

    // Interpolate color and size
    let t = 1.0 - particles[idx].lifetime / particles[idx].maxLifetime;
    particles[idx].color = mix(params.startColor, params.endColor, t);
    particles[idx].size = mix(params.startSize, params.endSize, t) + randRange(&params.seed, -params.sizeVariance, params.sizeVariance);
  }
}
`;

const PARTICLE_COMPUTE_EMIT_SHADER = `
struct Particle {
  position: vec3<f32>,
  _pad0: f32,
  velocity: vec3<f32>,
  _pad1: f32,
  color: vec4<f32>,
  size: f32,
  lifetime: f32,
  maxLifetime: f32,
  rotation: f32,
};

struct EmitParams {
  emitCount: u32,
  maxParticles: u32,
  speed: f32,
  speedVariance: f32,
  lifetime: f32,
  lifetimeVariance: f32,
  startSize: f32,
  sizeVariance: f32,
  startColor: vec4<f32>,
  emitterPos: vec3<f32>,
  emitterDir: vec3<f32>,
  seed: u32,
};

struct Counter {
  cursor: u32,
  activeCount: u32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: EmitParams;
@group(0) @binding(2) var<storage, read_write> counter: Counter;

fn hash(seed: ptr<function, u32>) -> f32 {
  *seed = *seed * 1103515245u + 12345u;
  return f32(*seed) / 4294967296.0;
}

fn randRange(seed: ptr<function, u32>, min: f32, max: f32) -> f32 {
  return min + hash(seed) * (max - min);
}

@compute @workgroup_size(64)
fn cs_emit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.emitCount) { return; }

  let cursor = atomicAdd(&counter.cursor, 1u) % params.maxParticles;
  let pi = cursor;

  var seed = params.seed + idx * 7919u;

  let speed = params.speed + randRange(&seed, -params.speedVariance, params.speedVariance);
  let life = params.lifetime + randRange(&seed, -params.lifetimeVariance, params.lifetimeVariance);
  let sz = params.startSize + randRange(&seed, -params.sizeVariance, params.sizeVariance);

  particles[pi].position = params.emitterPos;
  particles[pi].velocity = params.emitterDir * speed;
  particles[pi].color = params.startColor;
  particles[pi].size = sz;
  particles[pi].lifetime = life;
  particles[pi].maxLifetime = life;
  particles[pi].rotation = hash(&seed) * 6.2831853;
}
`;

export interface ParticleComputeParams {
  deltaTime: number;
  gravity: [number, number, number];
  drag: number;
  maxParticles: number;
  emissionRate: number;
  speed: number;
  speedVariance: number;
  lifetime: number;
  lifetimeVariance: number;
  startSize: number;
  endSize: number;
  sizeVariance: number;
  startColor: [number, number, number, number];
  endColor: [number, number, number, number];
  angularVelocity: number;
  angularVelocityVariance: number;
  emitterPos: [number, number, number];
  emitterDir: [number, number, number];
}

export class ParticleComputePass extends RenderPass {
  name = "particle-compute";
  private device: GPUDevice | null = null;
  private updatePipeline: GPUComputePipeline | null = null;
  private emitPipeline: GPUComputePipeline | null = null;
  private updateShader: GPUShaderModule | null = null;
  private emitShader: GPUShaderModule | null = null;
  private particleBuffer: GPUBuffer | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private emitParamBuffer: GPUBuffer | null = null;
  private counterBuffer: GPUBuffer | null = null;
  private maxParticles: number;
  private bindGroup: GPUBindGroup | null = null;
  private emitBindGroup: GPUBindGroup | null = null;

  constructor(maxParticles: number = 10000) {
    super();
    this.maxParticles = maxParticles;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.updateShader = device.createShaderModule({ code: PARTICLE_COMPUTE_SHADER });
    this.emitShader = device.createShaderModule({ code: PARTICLE_COMPUTE_EMIT_SHADER });

    this.updatePipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: this.updateShader, entryPoint: "cs_main" },
    });

    this.emitPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: this.emitShader, entryPoint: "cs_emit" },
    });

    const particleSize = 48; // bytes per particle
    this.particleBuffer = device.createBuffer({
      size: this.maxParticles * particleSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.paramBuffer = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.emitParamBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.counterBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = device.createBindGroup({
      layout: this.updatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.paramBuffer } },
        { binding: 2, resource: { buffer: this.counterBuffer } },
      ],
    });

    this.emitBindGroup = device.createBindGroup({
      layout: this.emitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.emitParamBuffer } },
        { binding: 2, resource: { buffer: this.counterBuffer } },
      ],
    });
  }

  getParticleBuffer(): GPUBuffer | null {
    return this.particleBuffer;
  }

  getMaxParticles(): number {
    return this.maxParticles;
  }

  emit(params: Partial<ParticleComputeParams>): void {
    if (!this.device || !this.emitPipeline || !this.emitBindGroup) return;

    const dt = params.deltaTime ?? 0.016;
    if (!(dt > 0) || !Number.isFinite(dt)) return;

    const emitCount = Math.min(
      Math.ceil((params.emissionRate ?? 50) * dt),
      this.maxParticles,
    );

    if (emitCount === 0) return;

    const emitData = new Float32Array(24);
    emitData[0] = emitCount;
    emitData[1] = this.maxParticles;
    emitData[2] = params.speed ?? 5;
    emitData[3] = params.speedVariance ?? 1;
    emitData[4] = params.lifetime ?? 2;
    emitData[5] = params.lifetimeVariance ?? 0.5;
    emitData[6] = params.startSize ?? 0.2;
    emitData[7] = params.sizeVariance ?? 0.05;
    emitData[8] = params.startColor?.[0] ?? 1;
    emitData[9] = params.startColor?.[1] ?? 1;
    emitData[10] = params.startColor?.[2] ?? 1;
    emitData[11] = params.startColor?.[3] ?? 1;
    emitData[12] = params.emitterPos?.[0] ?? 0;
    emitData[13] = params.emitterPos?.[1] ?? 0;
    emitData[14] = params.emitterPos?.[2] ?? 0;
    emitData[15] = params.emitterDir?.[0] ?? 0;
    emitData[16] = params.emitterDir?.[1] ?? 1;
    emitData[17] = params.emitterDir?.[2] ?? 0;
    emitData[18] = Math.floor(Math.random() * 0xFFFFFFFF);
    this.device.queue.writeBuffer(this.emitParamBuffer!, 0, emitData as unknown as BufferSource);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.emitPipeline);
    pass.setBindGroup(0, this.emitBindGroup);
    pass.dispatchWorkgroups(Math.ceil(emitCount / 64));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  update(params: ParticleComputeParams): void {
    if (!this.device || !this.updatePipeline || !this.bindGroup) return;
    if (!(params.deltaTime > 0) || !Number.isFinite(params.deltaTime)) return;

    const paramData = new Float32Array(32);
    paramData[0] = params.deltaTime;
    paramData[1] = params.gravity[0];
    paramData[2] = params.gravity[1];
    paramData[3] = params.gravity[2];
    paramData[4] = params.drag;
    paramData[5] = 0; // emitCount (unused in update)
    paramData[6] = params.maxParticles;
    paramData[7] = params.emissionRate;
    paramData[8] = params.speed;
    paramData[9] = params.speedVariance;
    paramData[10] = params.lifetime;
    paramData[11] = params.lifetimeVariance;
    paramData[12] = params.startSize;
    paramData[13] = params.endSize;
    paramData[14] = params.sizeVariance;
    paramData[15] = params.startColor[0];
    paramData[16] = params.startColor[1];
    paramData[17] = params.startColor[2];
    paramData[18] = params.startColor[3];
    paramData[19] = params.endColor[0];
    paramData[20] = params.endColor[1];
    paramData[21] = params.endColor[2];
    paramData[22] = params.endColor[3];
    paramData[23] = params.angularVelocity;
    paramData[24] = params.angularVelocityVariance;
    paramData[25] = params.emitterPos[0];
    paramData[26] = params.emitterPos[1];
    paramData[27] = params.emitterPos[2];
    paramData[28] = params.emitterDir[0];
    paramData[29] = params.emitterDir[1];
    paramData[30] = params.emitterDir[2];
    paramData[31] = Math.floor(Math.random() * 0xFFFFFFFF);
    this.device.queue.writeBuffer(this.paramBuffer!, 0, paramData as unknown as BufferSource);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.updatePipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.maxParticles / 64));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  execute(_ctx: GraphRenderContext): void {
    // Compute passes are invoked via emit() and update() directly
  }

  destroy(): void {
    this.particleBuffer?.destroy();
    this.paramBuffer?.destroy();
    this.emitParamBuffer?.destroy();
    this.counterBuffer?.destroy();
    this.particleBuffer = null;
    this.paramBuffer = null;
    this.emitParamBuffer = null;
    this.counterBuffer = null;
    this.updatePipeline = null;
    this.emitPipeline = null;
  }
}
