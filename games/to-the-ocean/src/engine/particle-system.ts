// ============================================================================
// Weather Particle System — GPU compute with LOD voxel collision
// Near-zone particles (within ~30m) collide with terrain voxel density fields.
// Far-zone particles are gravity-only VFX with no collision cost.
// ============================================================================

import type { ITrackedRenderPass } from "@downdraft/core";
import { WeatherType } from "@shared/types";
import { CameraState } from "./camera-system";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./graphics-config";
import { calculateViewProj } from "./math-utils";

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
// WGSL: Compute shader — emit + update particles with LOD voxel collision
// ============================================================================

const COMPUTE_WGSL = /* wgsl */ `
struct Particle {
  posX: f32, posY: f32, posZ: f32,
  velX: f32, velY: f32, velZ: f32,
  life: f32, size: f32,
  colorR: f32, colorG: f32, colorB: f32,
  alive: f32,
};

struct SimParams {
  deltaTime: f32,
  time: f32,
  spawnCount: f32,
  maxParticles: f32,
  cursor: f32,
  weatherType: f32,
  isSnow: f32,
  _pad0: f32,
  cameraPos: vec3<f32>,
  collisionRadius: f32,
  spawnSpread: f32,
  spawnHeight: f32,
  baseVelY: f32,
  particleSize: f32,
  lifetime: f32,
  colorR: f32, colorG: f32, colorB: f32,
  windX: f32, windZ: f32,
  _pad1: f32, _pad2: f32,
  voxelOrigin: vec3<f32>,
  voxelSize: f32,
  voxelDimX: f32, voxelDimY: f32, voxelDimZ: f32,
  voxelCount: f32,
  isoLevel: f32,
  seed: f32,
};

struct Counter {
  cursor: atomic<u32>,
  activeCount: atomic<u32>,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: SimParams;
@group(0) @binding(2) var<storage, read_write> counter: Counter;
@group(0) @binding(3) var<storage, read> voxelData: array<f32>;

fn hash(seed: ptr<function, u32>) -> f32 {
  *seed = *seed * 1103515245u + 12345u;
  return f32(*seed) / 4294967296.0;
}

fn randRange(seed: ptr<function, u32>, min: f32, max: f32) -> f32 {
  return min + hash(seed) * (max - min);
}

fn sampleVoxel(x: i32, y: i32, z: i32) -> f32 {
  if (x < 0 || x >= i32(params.voxelDimX) ||
      y < 0 || y >= i32(params.voxelDimY) ||
      z < 0 || z >= i32(params.voxelDimZ)) {
    return -1.0;
  }
  let idx = u32(x) * u32(params.voxelDimY) * u32(params.voxelDimZ) + u32(y) * u32(params.voxelDimZ) + u32(z);
  if (idx >= u32(params.voxelCount)) { return -1.0; }
  return voxelData[idx];
}

fn sampleVoxelGrad(p: vec3<f32>) -> vec3<f32> {
  let vs = params.voxelSize;
  let ox = params.voxelOrigin.x;
  let oy = params.voxelOrigin.y;
  let oz = params.voxelOrigin.z;
  let vx = i32(floor((p.x - ox) / vs));
  let vy = i32(floor((p.y - oy) / vs));
  let vz = i32(floor((p.z - oz) / vs));
  let dx = sampleVoxel(vx + 1, vy, vz) - sampleVoxel(vx - 1, vy, vz);
  let dy = sampleVoxel(vx, vy + 1, vz) - sampleVoxel(vx, vy - 1, vz);
  let dz = sampleVoxel(vx, vy, vz + 1) - sampleVoxel(vx, vy, vz - 1);
  let n = vec3<f32>(dx, dy, dz);
  let len = length(n);
  if (len < 1e-6) { return vec3<f32>(0.0, 1.0, 0.0); }
  return n / len;
}

fn voxelDensityAt(p: vec3<f32>) -> f32 {
  let vs = params.voxelSize;
  let ox = params.voxelOrigin.x;
  let oy = params.voxelOrigin.y;
  let oz = params.voxelOrigin.z;
  let vx = i32(floor((p.x - ox) / vs));
  let vy = i32(floor((p.y - oy) / vs));
  let vz = i32(floor((p.z - oz) / vs));
  return sampleVoxel(vx, vy, vz);
}

@compute @workgroup_size(64)
fn cs_emit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u32(params.spawnCount)) { return; }

  let cursor = atomicAdd(&counter.cursor, 1u) % u32(params.maxParticles);
  var seed = u32(params.seed) + idx * 7919u + u32(params.time * 1000.0);

  let px = params.cameraPos.x + randRange(&seed, -params.spawnSpread, params.spawnSpread);
  let py = params.cameraPos.y + params.spawnHeight + randRange(&seed, 0.0, params.spawnHeight * 0.3);
  let pz = params.cameraPos.z + randRange(&seed, -params.spawnSpread, params.spawnSpread);

  let vx = params.windX + randRange(&seed, -2.0, 2.0);
  let vy = params.baseVelY + randRange(&seed, -3.0, 3.0);
  let vz = params.windZ + randRange(&seed, -2.0, 2.0);

  particles[cursor].posX = px;
  particles[cursor].posY = py;
  particles[cursor].posZ = pz;
  particles[cursor].velX = vx;
  particles[cursor].velY = vy;
  particles[cursor].velZ = vz;
  particles[cursor].life = params.lifetime + randRange(&seed, -0.5, 0.5);
  particles[cursor].size = params.particleSize;
  particles[cursor].colorR = params.colorR;
  particles[cursor].colorG = params.colorG;
  particles[cursor].colorB = params.colorB;
  particles[cursor].alive = 1.0;
}

@compute @workgroup_size(64)
fn cs_update(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u32(params.maxParticles)) { return; }

  if (particles[idx].alive < 0.5) { return; }

  var p = particles[idx];

  // Apply gravity (snow has gentler fall)
  let gravity = select(-30.0, -3.0, u32(params.isSnow) == 1u);
  p.velY += gravity * params.deltaTime;

  // Apply wind
  p.velX += params.windX * params.deltaTime * 0.5;
  p.velZ += params.windZ * params.deltaTime * 0.5;

  // Snow: add gentle sway
  if (u32(params.isSnow) == 1u) {
    let swayPhase = params.time * 2.0 + f32(idx) * 0.1;
    p.velX += sin(swayPhase) * 0.5 * params.deltaTime;
    p.velZ += cos(swayPhase * 0.7) * 0.5 * params.deltaTime;
  }

  // Drag — frame-rate independent: pow(perFrameDrag, dt*60) = exp(log(drag)*dt*60)
  let dragRate = select(log(0.99) * 60.0, log(0.98) * 60.0, u32(params.isSnow) == 1u);
  let dragMul = exp(dragRate * params.deltaTime);
  p.velX *= dragMul;
  p.velY *= dragMul;
  p.velZ *= dragMul;

  // Compute new position
  var newPos = vec3<f32>(p.posX, p.posY, p.posZ) + vec3<f32>(p.velX, p.velY, p.velZ) * params.deltaTime;

  // LOD collision: only check voxel density if within collision radius of camera
  // TEMPORARILY DISABLED — voxel collision causing premature particle death
  let distToCam = length(newPos - params.cameraPos);
  if (false && distToCam < params.collisionRadius && u32(params.voxelCount) > 0u) {
    let density = voxelDensityAt(newPos);
    if (density >= params.isoLevel) {
      // Compute surface normal from density gradient (6-tap)
      let normal = sampleVoxelGrad(newPos);

      if (u32(params.isSnow) == 1u) {
        // Snow: stick to surface — zero out velocity, clamp to just above surface
        let surfacePoint = newPos - normal * (density - params.isoLevel) * params.voxelSize * 0.5;
        newPos = surfacePoint + normal * 0.05;
        p.velX = 0.0;
        p.velY = 0.0;
        p.velZ = 0.0;
        // Snow stays longer once settled
        p.life = min(p.life, 2.0);
      } else {
        // Rain: splash and die
        p.alive = 0.0;
        particles[idx] = p;
        return;
      }
    }
  }

  // Kill below water level or if dead
  p.life -= params.deltaTime;
  if (p.life <= 0.0 || newPos.y < -1.0) {
    p.alive = 0.0;
    particles[idx] = p;
    return;
  }

  // Kill if too far from camera (squared distance)
  let dx = newPos.x - params.cameraPos.x;
  let dz = newPos.z - params.cameraPos.z;
  if (dx * dx + dz * dz > 22500.0) {  // 150² — must be > spawnSpread²
    p.alive = 0.0;
    particles[idx] = p;
    return;
  }

  p.posX = newPos.x;
  p.posY = newPos.y;
  p.posZ = newPos.z;

  particles[idx] = p;
}
`;

// ============================================================================
// WGSL: Render shader — billboard quads from compute output buffer
// ============================================================================

const RENDER_WGSL = /* wgsl */ `
struct RenderUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  particleCount: f32,
  weatherType: f32,
  aspect: f32,
  focalLength: f32,
  cullDistance: f32,
};

@group(0) @binding(0) var<uniform> uniforms: RenderUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

struct Particle {
  posX: f32, posY: f32, posZ: f32,
  velX: f32, velY: f32, velZ: f32,
  life: f32, size: f32,
  colorR: f32, colorG: f32, colorB: f32,
  alive: f32,
};

@group(0) @binding(1) var<storage, read> particles: array<Particle>;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var output: VertexOutput;

  let particleIdx = vid / 6u;
  if (particleIdx >= u32(uniforms.particleCount)) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  let p = particles[particleIdx];
  if (p.alive < 0.5) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  // Quad corner offsets: 2 triangles (0,1,2) and (0,2,3)
  var cornerX = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
  var cornerY = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let cx = cornerX[vid % 6u];
  let cy = cornerY[vid % 6u];

  // Project center to clip space
  let center = uniforms.viewProj * vec4<f32>(vec3<f32>(p.posX, p.posY, p.posZ), 1.0);

  // Cull if particle is too close in view space (center.w = distance along view dir)
  if (center.w < uniforms.cullDistance) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  // Fade size based on life (full at start, shrinks near death)
  let lifeRatio = clamp(p.life / 4.0, 0.0, 1.0);
  let fadedSize = p.size * min(1.0, lifeRatio * 2.0);

  // Rain: streak shape — thin horizontal, elongated vertical based on velocity
  // Snow: round billboard
  let isSnow = u32(uniforms.weatherType) == 9u;
  let speed = length(vec3<f32>(p.velX, p.velY, p.velZ));

  let halfW = select(fadedSize * 0.3, fadedSize * 0.5, isSnow);
  let halfH = select(fadedSize * 0.5 + speed * 0.06, fadedSize * 0.5, isSnow);

  let offsetX = cx * halfW * uniforms.focalLength / center.w / uniforms.aspect;
  let offsetY = cy * halfH * uniforms.focalLength / center.w;

  output.clipPos = vec4<f32>(center.x + offsetX, center.y + offsetY, center.z, center.w);
  output.color = vec3<f32>(p.colorR, p.colorG, p.colorB);
  output.uv = vec2<f32>(cx, cy);

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.uv);
  if (dist > 1.0) { discard; }
  let alpha = (1.0 - dist * dist) * 0.8;
  return vec4<f32>(input.color, alpha);
}
`;

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
  private simParamData: Float32Array;
  private counterData: Uint32Array;
  private renderUniformData: Float32Array;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    // SimParams layout: 32 floats = 128 bytes (padded to 256 for uniform alignment)
    this.simParamData = new Float32Array(64);
    this.counterData = new Uint32Array(2);
    this.renderUniformData = new Float32Array(25);
  }

  async init(): Promise<void> {
    const dev = this.device;
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

    this.device.queue.writeBuffer(this.simParamBuffer!, 0, this.simParamData as any);

    // Upload voxel data if present
    if (voxelData && voxelData.data.length > 0 && voxelData.data.length <= MAX_VOXEL_FLOATS) {
      this.device.queue.writeBuffer(this.voxelBuffer!, 0, voxelData.data as any);
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

    this.device.queue.writeBuffer(this.renderUniformBuffer!, 0, u as any);

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
    this.computePipeline = null;
    this.emitPipeline = null;
    this.renderPipeline = null;
    this.computeBindGroup = null;
    this.renderBindGroup = null;
    this.computeBindGroupLayout = null;
    this.renderBindGroupLayout = null;
  }
}
