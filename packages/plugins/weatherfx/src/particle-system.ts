// ============================================================================
// Weather Particle System — GPU compute with LOD voxel collision
// Near-zone particles (within ~30m) collide with terrain voxel density fields.
// Far-zone particles are gravity-only VFX with no collision cost.
// ============================================================================

import type { ITrackedRenderPass } from "@downdraft/core";
import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import type { RenderBackend } from "@downdraft/core/render/backend/render-backend";
import type { BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendRenderPipeline, TextureFormat } from "@downdraft/core/render/backend/types";
import { WeatherType } from "@downdraft/plugin-weather";
import COMPUTE_WGSL from "./shaders/particle-compute.wgsl?raw";
import RENDER_WGSL from "./shaders/particle-render.wgsl?raw";

// --- Particle layout (12 floats = 48 bytes per particle) ---
// posX, posY, posZ, velX, velY, velZ, life, size, colorR, colorG, colorB, alive

const MAX_PARTICLES = 20000;
const PARTICLE_FLOATS = 12;
const PARTICLE_BYTES = PARTICLE_FLOATS * 4;

// Voxel collision buffer: packed density values for nearby terrain
export const MAX_VOXEL_FLOATS = 32768 * 4; // ~128KB — covers ~32³ voxels at 4 bytes each
export const COLLISION_RADIUS = 30.0; // world units

// Weather spawn parameters per weather type
interface WeatherParams {
  spawnRate: number;   // particles per frame
  velY: number;        // base downward velocity
  size: number;        // particle billboard size
  color: [number, number, number];
  lifetime: number;    // seconds
  spread: number;      // horizontal spawn area half-extent
  heightRange: number; // spawn height above camera
  isSnow: boolean;     // snow gets gentle fall + no splash
}

function getWeatherParams(weatherType: WeatherType): WeatherParams | null {
  switch (weatherType) {
    case WeatherType.Rain:
      return { spawnRate: 4000, velY: -18, size: 0.3, color: [0.6, 0.7, 0.9], lifetime: 4, spread: 50, heightRange: 25, isSnow: false };
    case WeatherType.Storm:
      return { spawnRate: 8000, velY: -28, size: 0.4, color: [0.5, 0.6, 0.85], lifetime: 3, spread: 60, heightRange: 30, isSnow: false };
    case WeatherType.HellStorm:
      return { spawnRate: 2000, velY: -22, size: 0.5, color: [0.8, 0.2, 0.1], lifetime: 3, spread: 55, heightRange: 28, isSnow: false };
    case WeatherType.Snow:
      return { spawnRate: 4000, velY: -5, size: 0.4, color: [0.9, 0.9, 1.0], lifetime: 12, spread: 40, heightRange: 8, isSnow: true };
    default:
      return null;
  }
}



// ============================================================================
// Voxel data extraction interface — called by EntityRenderer
// ============================================================================

export interface VoxelCollisionData {
  data: Float32Array;     // packed density values
  originX: number;        // world-space origin of voxel grid
  originY: number;
  originZ: number;
  voxelSize: number;
  dimX: number;
  dimY: number;
  dimZ: number;
  isoLevel: number;
}

// ============================================================================
// WeatherParticleSystem — GPU compute particle system with LOD collision
// ============================================================================

export class ParticleSystem {
  private device: GPUDevice | null;
  private backend: RenderBackend | null;
  private format: GPUTextureFormat | TextureFormat;

  // Compute pipelines (one for emit, one for update — same bind group, different entry points)
  // Compute is WebGPU-only — null on backend
  private computePipeline: GPUComputePipeline | null = null;
  private emitPipeline: GPUComputePipeline | null = null;
  private computeBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private computeBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;

  // Render pipeline
  private renderPipeline: GPURenderPipeline | BackendRenderPipeline | null = null;
  private renderBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private renderBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;

  // Buffers
  private particleBuffer: GPUBuffer | BackendBuffer | null = null;
  private simParamBuffer: GPUBuffer | BackendBuffer | null = null;
  private counterBuffer: GPUBuffer | BackendBuffer | null = null;
  private voxelBuffer: GPUBuffer | BackendBuffer | null = null;
  private renderUniformBuffer: GPUBuffer | BackendBuffer | null = null;

  // State
  private cursor: number = 0;
  private activeCount: number = 0;
  private seed: number = 12345;
  private currentVoxelCount: number = 0;
  private spawnAccumulator: number = 0;
  particleDensityMultiplier: number = 1.0;
  particleCullDistance: number = 5.0;

  // Pooled CPU buffers
  private simParamData: Float32Array;
  private counterData: Uint32Array;
  private renderUniformData: Float32Array;

  constructor(device: GPUDevice | null, format: GPUTextureFormat | TextureFormat, backend?: RenderBackend | null) {
    this.device = device;
    this.backend = backend ?? null;
    this.format = format;
    // SimParams layout: 32 floats = 128 bytes (padded to 256 for uniform alignment)
    this.simParamData = new Float32Array(64);
    this.counterData = new Uint32Array(2);
    this.renderUniformData = new Float32Array(25);
  }

  async init(): Promise<void> {
    if (this.backend && !this.device) {
      const backend = this.backend;
      const renderModule = backend.createShaderModule({ wgsl: RENDER_WGSL }, "wgsl");

      // Buffers (render-only — no compute on backend)
      this.particleBuffer = backend.createBuffer({ size: MAX_PARTICLES * PARTICLE_BYTES, usage: 0x80 | 0x08 });
      this.simParamBuffer = backend.createBuffer({ size: 256, usage: 0x40 | 0x08 });
      this.counterBuffer = backend.createBuffer({ size: 8, usage: 0x80 | 0x08 | 0x04 });
      this.voxelBuffer = backend.createBuffer({ size: MAX_VOXEL_FLOATS * 4, usage: 0x80 | 0x08 });
      this.renderUniformBuffer = backend.createBuffer({ size: 256, usage: 0x40 | 0x08 });

      backend.queue.writeBuffer(this.particleBuffer as any, 0, new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS) as any);
      backend.queue.writeBuffer(this.counterBuffer as any, 0, new Uint32Array([0, 0]) as any);

      // Render bind group + pipeline
      this.renderBindGroupLayout = backend.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 1 | 2, buffer: { type: "uniform" } },
          { binding: 1, visibility: 1, buffer: { type: "read-only-storage" } },
        ],
      });
      this.renderBindGroup = backend.createBindGroup({
        layout: this.renderBindGroupLayout as any,
        entries: [
          { binding: 0, resource: { buffer: this.renderUniformBuffer as any } },
          { binding: 1, resource: { buffer: this.particleBuffer as any } },
        ],
      });
      const renderLayout = backend.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout as any] });
      this.renderPipeline = backend.createRenderPipeline({
        layout: renderLayout as any,
        vertex: { module: renderModule, entryPoint: "vs_main", buffers: [] },
        fragment: {
          module: renderModule, entryPoint: "fs_main",
          targets: [{
            format: this.format as TextureFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: MSAA_SAMPLE_COUNT },
        depthStencil: { format: DEPTH_FORMAT as any, depthWriteEnabled: false, depthCompare: "less" },
      });
      return;
    }

    const dev = this.device!;
    const computeModule = dev.createShaderModule({ code: COMPUTE_WGSL });
    const renderModule = dev.createShaderModule({ code: RENDER_WGSL });

    // --- Buffers ---
    this.particleBuffer = dev.createBuffer({
      size: MAX_PARTICLES * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.simParamBuffer = dev.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.counterBuffer = dev.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.voxelBuffer = dev.createBuffer({
      size: MAX_VOXEL_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.renderUniformBuffer = dev.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Zero out particle buffer and counter
    dev.queue.writeBuffer(this.particleBuffer, 0, new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS));
    dev.queue.writeBuffer(this.counterBuffer, 0, new Uint32Array([0, 0]));

    // --- Compute pipeline ---
    this.computeBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });

    this.computeBindGroup = dev.createBindGroup({
      layout: this.computeBindGroupLayout as GPUBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer as GPUBuffer } },
        { binding: 1, resource: { buffer: this.simParamBuffer as GPUBuffer } },
        { binding: 2, resource: { buffer: this.counterBuffer as GPUBuffer } },
        { binding: 3, resource: { buffer: this.voxelBuffer as GPUBuffer } },
      ],
    });

    this.computePipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.computeBindGroupLayout as GPUBindGroupLayout] }),
      compute: { module: computeModule, entryPoint: "cs_update" },
    });

    this.emitPipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.computeBindGroupLayout as GPUBindGroupLayout] }),
      compute: { module: computeModule, entryPoint: "cs_emit" },
    });

    // --- Render pipeline ---
    this.renderBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });

    this.renderBindGroup = dev.createBindGroup({
      layout: this.renderBindGroupLayout as GPUBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer as GPUBuffer } },
        { binding: 1, resource: { buffer: this.particleBuffer as GPUBuffer } },
      ],
    });

    this.renderPipeline = dev.createRenderPipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout as GPUBindGroupLayout] }),
      vertex: { module: renderModule, entryPoint: "vs_main", buffers: [] },
      fragment: {
        module: renderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format as GPUTextureFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });
  }

  // Called each frame to update + spawn particles via compute shader
  tick(
    encoder: GPUCommandEncoder,
    dt: number,
    camera: CameraState,
    weatherType: WeatherType,
    windX: number,
    windZ: number,
    voxelData: VoxelCollisionData | null,
  ): void {
    if (!this.computePipeline || !this.computeBindGroup) return;

    const params = getWeatherParams(weatherType);
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;

    // Spawn rate is per-second; accumulate fractional spawns across frames
    const baseSpawnRate = params ? params.spawnRate : 0;
    const effectiveSpawnRate = baseSpawnRate * this.particleDensityMultiplier;
    this.spawnAccumulator += effectiveSpawnRate * dt;
    const spawnCount = Math.min(MAX_PARTICLES, Math.floor(this.spawnAccumulator));
    this.spawnAccumulator -= spawnCount;

    // Write sim params — indices match WGSL SimParams struct layout (with vec3 alignment padding)
    // offset 0:   deltaTime, time, spawnCount, maxParticles
    // offset 16:  cursor, weatherType, isSnow, _pad0
    // offset 32:  cameraPos.xyz, collisionRadius
    // offset 48:  spawnSpread, spawnHeight, baseVelY, particleSize
    // offset 64:  lifetime, colorR, colorG, colorB
    // offset 80:  windX, windZ, _pad1, _pad2
    // offset 96:  voxelOrigin.xyz, voxelSize
    // offset 112: voxelDimX, voxelDimY, voxelDimZ, voxelCount
    // offset 128: isoLevel, seed
    const sp = this.simParamData;
    sp.fill(0);
    sp[0] = dt;
    sp[1] = performance.now() / 1000;
    sp[2] = spawnCount;
    sp[3] = MAX_PARTICLES;
    sp[4] = this.cursor;
    sp[5] = weatherType;
    sp[6] = params ? (params.isSnow ? 1 : 0) : 0;
    // sp[7] = _pad0
    sp[8] = camera.position[0];
    sp[9] = camera.position[1];
    sp[10] = camera.position[2];
    sp[11] = COLLISION_RADIUS;
    sp[12] = params ? params.spread : 50;
    sp[13] = params ? params.heightRange : 25;
    sp[14] = params ? params.velY : -15;
    sp[15] = params ? params.size : 0.05;
    sp[16] = params ? params.lifetime : 4;
    sp[17] = params ? params.color[0] : 0.6;
    sp[18] = params ? params.color[1] : 0.7;
    sp[19] = params ? params.color[2] : 0.9;
    sp[20] = windX;
    sp[21] = windZ;
    // sp[22], sp[23] = _pad1, _pad2
    if (voxelData && voxelData.data.length > 0) {
      sp[24] = voxelData.originX;
      sp[25] = voxelData.originY;
      sp[26] = voxelData.originZ;
      sp[27] = voxelData.voxelSize;
      sp[28] = voxelData.dimX;
      sp[29] = voxelData.dimY;
      sp[30] = voxelData.dimZ;
      sp[31] = voxelData.data.length;
      sp[32] = voxelData.isoLevel;
    } else {
      sp[24] = 0; sp[25] = 0; sp[26] = 0;
      sp[27] = 1; sp[28] = 0; sp[29] = 0; sp[30] = 0;
      sp[31] = 0; sp[32] = 0;
    }
    sp[33] = this.seed;

    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeBuffer(this.simParamBuffer as any, 0, this.simParamData as any);

    // Upload voxel data if present
    if (voxelData && voxelData.data.length > 0 && voxelData.data.length <= MAX_VOXEL_FLOATS) {
      queue?.writeBuffer(this.voxelBuffer as any, 0, voxelData.data as any);
      this.currentVoxelCount = voxelData.data.length;
    } else {
      this.currentVoxelCount = 0;
    }

    // Counter buffer is managed entirely on GPU via atomicAdd — do NOT reset from CPU
    // (resetting would overwrite the GPU's cursor and cause particles to be written at index 0 every frame)

    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, this.computeBindGroup as any);

    // Emit
    if (spawnCount > 0 && this.emitPipeline) {
      pass.setPipeline(this.emitPipeline);
      const emitWorkgroups = Math.ceil(spawnCount / 64);
      pass.dispatchWorkgroups(emitWorkgroups);
    }

    // Update all particles
    pass.setPipeline(this.computePipeline);
    const updateWorkgroups = Math.ceil(MAX_PARTICLES / 64);
    pass.dispatchWorkgroups(updateWorkgroups);

    pass.end();
  }

  // Called during render pass to draw particles
  render(
    passEncoder: GPURenderPassEncoder | ITrackedRenderPass,
    camera: CameraState,
    weatherType: WeatherType,
    timeOfDay: number,
  ): void {
    if (!this.renderPipeline || !this.renderBindGroup || !this.renderUniformBuffer) return;

    // Write render uniforms
    const viewProj = calculateViewProj(camera);
    const u = this.renderUniformData;
    for (let i = 0; i < 16; i++) u[i] = viewProj[i];
    u[16] = camera.position[0];
    u[17] = camera.position[1];
    u[18] = camera.position[2];
    u[19] = performance.now() / 1000;
    u[20] = MAX_PARTICLES;
    u[21] = weatherType;
    u[22] = camera.aspect;
    u[23] = 1 / Math.tan((camera.fov * Math.PI / 180) / 2);
    u[24] = this.particleCullDistance;

    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeBuffer(this.renderUniformBuffer as any, 0, u as any);

    passEncoder.setPipeline(this.renderPipeline as any);
    passEncoder.setBindGroup(0, this.renderBindGroup as any);
    passEncoder.draw(MAX_PARTICLES * 6);
  }

  destroy(): void {
    this.particleBuffer?.destroy();
    this.simParamBuffer?.destroy();
    this.counterBuffer?.destroy();
    this.voxelBuffer?.destroy();
    this.renderUniformBuffer?.destroy();
    this.particleBuffer = null;
    this.simParamBuffer = null;
    this.counterBuffer = null;
    this.voxelBuffer = null;
    this.renderUniformBuffer = null;
    this.computePipeline = null;
    this.emitPipeline = null;
    this.renderPipeline = null;
    this.computeBindGroup = null;
    this.renderBindGroup = null;
    this.computeBindGroupLayout = null;
    this.renderBindGroupLayout = null;
  }
}
