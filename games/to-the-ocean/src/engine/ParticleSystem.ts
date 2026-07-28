// ============================================================================
// Particle System — rain, snow, splashes, bioluminescent particles
// ============================================================================

import { WeatherType } from "@shared/types";
import { CameraState } from "./CameraSystem";
import { calculateViewProj } from "./mathUtils";

const PARTICLE_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  particleCount: u32,
  weatherType: u32,
  aspect: f32,
  focalLength: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

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
  _pad: f32,
};

@group(0) @binding(1) var<storage, read> particles: array<Particle>;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var output: VertexOutput;

  let particleIdx = vid / 6u;
  if (particleIdx >= uniforms.particleCount) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  let p = particles[particleIdx];

  // Quad corner offsets: 2 triangles (0,1,2) and (0,2,3)
  var cornerX = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
  var cornerY = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let cx = cornerX[vid % 6u];
  let cy = cornerY[vid % 6u];

  // Project center to clip space
  let center = uniforms.viewProj * vec4<f32>(vec3<f32>(p.posX, p.posY, p.posZ), 1.0);

  // World-space billboard: offset in NDC, perspective-correct
  let halfSize = p.size * 0.5;
  let offsetX = cx * halfSize * uniforms.focalLength / center.w / uniforms.aspect;
  let offsetY = cy * halfSize * uniforms.focalLength / center.w;

  output.clipPos = vec4<f32>(center.x + offsetX, center.y + offsetY, center.z, center.w);
  output.color = vec3<f32>(p.colorR, p.colorG, p.colorB);
  output.uv = vec2<f32>(cx, cy);

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.uv);
  if (dist > 1.0) { discard; }
  let alpha = (1.0 - dist * dist) * 0.7;
  return vec4<f32>(input.color, alpha);
}
`;

interface ParticleData {
  pos: Float32Array;
  vel: Float32Array;
  life: number;
  maxLife: number;
  size: number;
  color: Float32Array;
  expandRate: number;
}

export class ParticleSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private particleBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  private particles: ParticleData[] = [];
  private maxParticles = 2000;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
    const shaderModule = this.device.createShaderModule({ code: PARTICLE_WGSL });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Particle storage buffer (pos(3) + vel(3) + life(1) + size(1) + color(3) + pad(1) = 12 floats per particle)
    this.particleBuffer = this.device.createBuffer({
      size: this.maxParticles * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.particleBuffer } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: 4 },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });
  }

  tick(dt: number, camera: CameraState, weatherType: WeatherType): void {
    this.spawnWeatherParticles(weatherType, camera);
    this.updateParticles(dt, camera);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    camera: CameraState,
    weatherType: WeatherType,
    timeOfDay: number,
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer) return;

    // Write particle data to buffer
    const particleData = new Float32Array(this.maxParticles * 12);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const lifeRatio = p.maxLife > 0 ? p.life / p.maxLife : 0;
      // Fade size: full size at start, shrinks to 0 at death
      const fadedSize = p.size * Math.min(1, lifeRatio * 2);
      particleData[i * 12 + 0] = p.pos[0];
      particleData[i * 12 + 1] = p.pos[1];
      particleData[i * 12 + 2] = p.pos[2];
      particleData[i * 12 + 3] = p.vel[0];
      particleData[i * 12 + 4] = p.vel[1];
      particleData[i * 12 + 5] = p.vel[2];
      particleData[i * 12 + 6] = p.life;
      particleData[i * 12 + 7] = fadedSize;
      particleData[i * 12 + 8] = p.color[0];
      particleData[i * 12 + 9] = p.color[1];
      particleData[i * 12 + 10] = p.color[2];
    }
    this.device.queue.writeBuffer(this.particleBuffer!, 0, particleData);

    // Write uniforms
    const viewProj = calculateViewProj(camera);
    const uniforms = new Float32Array(16 + 8);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camera.position[0];
    uniforms[17] = camera.position[1];
    uniforms[18] = camera.position[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = this.particles.length;
    uniforms[21] = weatherType;
    uniforms[22] = camera.aspect;
    uniforms[23] = 1 / Math.tan((camera.fov * Math.PI / 180) / 2);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    if (this.particles.length > 0) {
      passEncoder.draw(this.particles.length * 6);
    }
  }

  private spawnWeatherParticles(weatherType: WeatherType, camera: CameraState): void {
    let spawnRate = 0;
    let particleSize = 0.1;
    let velY = -10;
    let color: Float32Array;

    switch (weatherType) {
      case WeatherType.Rain:
        spawnRate = 20;
        particleSize = 0.05;
        velY = -15;
        color = new Float32Array([0.6, 0.7, 0.9]);
        break;
      case WeatherType.Storm:
        spawnRate = 50;
        particleSize = 0.08;
        velY = -25;
        color = new Float32Array([0.6, 0.7, 0.9]);
        break;
      case WeatherType.HellStorm:
        spawnRate = 30;
        particleSize = 0.15;
        velY = -20;
        color = new Float32Array([0.8, 0.2, 0.1]);
        break;
      case WeatherType.Snow:
        spawnRate = 10;
        particleSize = 0.1;
        velY = -2;
        color = new Float32Array([0.9, 0.9, 1.0]);
        break;
      default:
        return;
    }

    for (let i = 0; i < spawnRate; i++) {
      if (this.particles.length >= this.maxParticles) break;
      this.particles.push({
        pos: new Float32Array([
          camera.position[0] + (Math.random() - 0.5) * 100,
          camera.position[1] + 30 + Math.random() * 20,
          camera.position[2] + (Math.random() - 0.5) * 100,
        ]),
        vel: new Float32Array([
          (Math.random() - 0.5) * 2,
          velY + (Math.random() - 0.5) * 3,
          (Math.random() - 0.5) * 2,
        ]),
        life: 3,
        maxLife: 3,
        size: particleSize,
        color,
        expandRate: 0,
      });
    }
  }

  private updateParticles(dt: number, camera: CameraState): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
      p.life -= dt;

      // Expand wake particles outward over time (cone shape)
      if (p.expandRate > 0) {
        const ageRatio = 1.0 - p.life / p.maxLife;
        const expansion = p.expandRate * ageRatio * dt;
        const len = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]) || 1;
        // Push outward along existing lateral velocity direction
        p.vel[0] += (p.vel[0] / len) * expansion;
        p.vel[2] += (p.vel[2] / len) * expansion;
      }

      // Remove dead or far below water
      if (p.life <= 0 || p.pos[1] < -1.0) {
        this.particles.splice(i, 1);
        continue;
      }

      // Remove if too far from camera
      const dx = p.pos[0] - camera.position[0];
      const dz = p.pos[2] - camera.position[2];
      if (dx * dx + dz * dz > 10000) {
        this.particles.splice(i, 1);
      }
    }
  }

}
