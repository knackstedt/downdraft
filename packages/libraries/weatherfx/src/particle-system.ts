// ============================================================================
// Weather Particle System — GPU compute with LOD voxel collision
// Near-zone particles (within ~30m) collide with terrain voxel density fields.
// Far-zone particles are gravity-only VFX with no collision cost.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";
import type { ITrackedRenderPass } from "@downdraft/core";
import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import { WeatherType } from "@downdraft/library-weather";
import { StructView, wgsl } from "@downdraft/shader-graph";
import COMPUTE_WGSL from "./shaders/particle-compute.wgsl?raw" with { type: "text" };
import RENDER_WGSL from "./shaders/particle-render.wgsl?raw" with { type: "text" };

// --- Typed uniform structs (validate against particle-compute.wgsl / particle-render.wgsl) ---
export const SimParamsStruct = wgsl.struct("SimParams", {
  deltaTime: wgsl.f32,
  time: wgsl.f32,
  spawnCount: wgsl.f32,
  maxParticles: wgsl.f32,
  cursor: wgsl.f32,
  weatherType: wgsl.f32,
  isSnow: wgsl.f32,
  _pad0: wgsl.f32,
  cameraPos: wgsl.vec3f,
  collisionRadius: wgsl.f32,
  spawnSpread: wgsl.f32,
  spawnHeight: wgsl.f32,
  baseVelY: wgsl.f32,
  particleSize: wgsl.f32,
  lifetime: wgsl.f32,
  colorR: wgsl.f32,
  colorG: wgsl.f32,
  colorB: wgsl.f32,
  windX: wgsl.f32,
  windZ: wgsl.f32,
  _pad1: wgsl.f32,
  _pad2: wgsl.f32,
  voxelOrigin: wgsl.vec3f,
  voxelSize: wgsl.f32,
  voxelDimX: wgsl.f32,
  voxelDimY: wgsl.f32,
  voxelDimZ: wgsl.f32,
  voxelCount: wgsl.f32,
  isoLevel: wgsl.f32,
  seed: wgsl.f32,
});

export const RenderUniformsStruct = wgsl.struct("RenderUniforms", {
  viewProj: wgsl.mat4x4f,
  cameraPos: wgsl.vec3f,
  time: wgsl.f32,
  particleCount: wgsl.f32,
  weatherType: wgsl.f32,
  aspect: wgsl.f32,
  focalLength: wgsl.f32,
  cullDistance: wgsl.f32,
});

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
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Compute pipelines (one for emit, one for update — same bind group, different entry points)
  private computePipeline: GPUComputePipeline | null = null;
  private emitPipeline: GPUComputePipeline | null = null;
  private computeBindGroup: GPUBindGroup | null = null;
  private computeBindGroupLayout: GPUBindGroupLayout | null = null;

  // Render pipeline
  private renderPipeline: GPURenderPipeline | null = null;
  private renderBindGroup: GPUBindGroup | null = null;
  private renderBindGroupLayout: GPUBindGroupLayout | null = null;

  // Buffers
  private particleBuffer: GPUBuffer | null = null;
  private simParamBuffer: GPUBuffer | null = null;
  private counterBuffer: GPUBuffer | null = null;
  private voxelBuffer: GPUBuffer | null = null;
  private renderUniformBuffer: GPUBuffer | null = null;

  // State
  private cursor: number = 0;
  private activeCount: number = 0;
  private seed: number = 12345;
  private currentVoxelCount: number = 0;
  private spawnAccumulator: number = 0;
  particleDensityMultiplier: number = 1.0;
  particleCullDistance: number = 5.0;

  // Pooled CPU buffers
  private _simParamView: StructView | null = null;
  private _simParamBuf: Float32Array | null = null;
  private counterData: Uint32Array;
  private _renderUniformView: StructView | null = null;
  private _renderUniformBuf: Float32Array | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this._simParamBuf = new Float32Array(64); // padded to 256 bytes
    this._simParamView = SimParamsStruct.view(this._simParamBuf);
    this.counterData = new Uint32Array(2);
    this._renderUniformBuf = new Float32Array(RenderUniformsStruct.floatCount);
    this._renderUniformView = RenderUniformsStruct.view(this._renderUniformBuf);
  }

  async init(): Promise<void> {
    const dev = this.device;
    const computeModule = createValidatedShaderModule(dev, { code: COMPUTE_WGSL, label: "WeatherFx.particleCompute" });
    const renderModule = createValidatedShaderModule(dev, { code: RENDER_WGSL, label: "WeatherFx.particleRender" });

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

    // Write sim params via typed view
    const sp = this._simParamView!;
    this._simParamBuf!.fill(0);
    sp.set("deltaTime", dt);
    sp.set("time", performance.now() / 1000);
    sp.set("spawnCount", spawnCount);
    sp.set("maxParticles", MAX_PARTICLES);
    sp.set("cursor", this.cursor);
    sp.set("weatherType", weatherType);
    sp.set("isSnow", params ? (params.isSnow ? 1 : 0) : 0);
    sp.set("cameraPos", camera.position);
    sp.set("collisionRadius", COLLISION_RADIUS);
    sp.set("spawnSpread", params ? params.spread : 50);
    sp.set("spawnHeight", params ? params.heightRange : 25);
    sp.set("baseVelY", params ? params.velY : -15);
    sp.set("particleSize", params ? params.size : 0.05);
    sp.set("lifetime", params ? params.lifetime : 4);
    sp.set("colorR", params ? params.color[0] : 0.6);
    sp.set("colorG", params ? params.color[1] : 0.7);
    sp.set("colorB", params ? params.color[2] : 0.9);
    sp.set("windX", windX);
    sp.set("windZ", windZ);
    if (voxelData && voxelData.data.length > 0) {
      sp.set("voxelOrigin", [voxelData.originX, voxelData.originY, voxelData.originZ]);
      sp.set("voxelSize", voxelData.voxelSize);
      sp.set("voxelDimX", voxelData.dimX);
      sp.set("voxelDimY", voxelData.dimY);
      sp.set("voxelDimZ", voxelData.dimZ);
      sp.set("voxelCount", voxelData.data.length);
      sp.set("isoLevel", voxelData.isoLevel);
    } else {
      sp.set("voxelOrigin", [0, 0, 0]);
      sp.set("voxelSize", 1);
      sp.set("voxelDimX", 0);
      sp.set("voxelDimY", 0);
      sp.set("voxelDimZ", 0);
      sp.set("voxelCount", 0);
      sp.set("isoLevel", 0);
    }
    sp.set("seed", this.seed);

    this.device.queue.writeBuffer(this.simParamBuffer!, 0, this._simParamBuf as unknown as GPUAllowSharedBufferSource);

    // Upload voxel data if present
    if (voxelData && voxelData.data.length > 0 && voxelData.data.length <= MAX_VOXEL_FLOATS) {
      let hasInvalid = false;
      for (let i = 0; i < voxelData.data.length; i++) {
        if (!Number.isFinite(voxelData.data[i])) {
          hasInvalid = true;
          break;
        }
      }
      if (!hasInvalid) {
        this.device.queue.writeBuffer(this.voxelBuffer!, 0, voxelData.data as unknown as GPUAllowSharedBufferSource);
        this.currentVoxelCount = voxelData.data.length;
      } else {
        this.currentVoxelCount = 0;
      }
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
    const u = this._renderUniformView!;
    u.set("viewProj", viewProj);
    u.set("cameraPos", camera.position);
    u.set("time", performance.now() / 1000);
    u.set("particleCount", MAX_PARTICLES);
    u.set("weatherType", weatherType);
    u.set("aspect", camera.aspect);
    u.set("focalLength", 1 / Math.tan((camera.fov * Math.PI / 180) / 2));
    u.set("cullDistance", this.particleCullDistance);

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, this._renderUniformBuf as unknown as GPUAllowSharedBufferSource);

    passEncoder.setPipeline(this.renderPipeline);
    passEncoder.setBindGroup(0, this.renderBindGroup);
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
    // Pipelines have .destroy() — call it before nulling.
    this.computePipeline?.destroy();
    this.emitPipeline?.destroy();
    this.renderPipeline?.destroy();
    this.computePipeline = null;
    this.emitPipeline = null;
    this.renderPipeline = null;
    // GPUBindGroup and GPUBindGroupLayout have no destroy() — just null them.
    this.computeBindGroup = null;
    this.renderBindGroup = null;
    this.computeBindGroupLayout = null;
    this.renderBindGroupLayout = null;
    this._simParamView = null;
    this._simParamBuf = null;
    this._renderUniformView = null;
    this._renderUniformBuf = null;
  }
}
