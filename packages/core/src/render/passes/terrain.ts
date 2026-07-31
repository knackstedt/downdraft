import { type Mat4 } from "wgpu-matrix";
import type { RenderPassContext } from "../render-pass.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";

const TERRAIN_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  patchSize: f32,
  originX: f32,
  originZ: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) depth: f32,
};

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn terrainHeight(x: f32, z: f32) -> f32 {
  let p = vec2<f32>(x * 0.01, z * 0.01);
  var h = 0.0;
  h += noise(p) * 40.0;
  h += noise(p * 2.0) * 20.0;
  h += noise(p * 4.0) * 10.0;
  h += noise(p * 8.0) * 5.0;
  return -h - 10.0;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldX = uniforms.originX + input.position.x * 4.0;
  let worldZ = uniforms.originZ + input.position.y * 4.0;
  let h = terrainHeight(worldX, worldZ);
  let worldPos = vec3<f32>(worldX, h, worldZ);
  output.worldPos = worldPos;
  output.depth = -h;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let depth = input.depth;

  let shallowColor = vec3<f32>(0.6, 0.5, 0.3);
  let midColor = vec3<f32>(0.3, 0.3, 0.2);
  let deepColor = vec3<f32>(0.1, 0.1, 0.05);

  var color = mix(shallowColor, midColor, smoothstep(10.0, 50.0, depth));
  color = mix(color, deepColor, smoothstep(50.0, 200.0, depth));

  let dist = length(uniforms.cameraPos - input.worldPos);
  let fogFactor = min(dist / 500.0, 1.0);
  color = mix(color, vec3<f32>(0.0, 0.1, 0.2), fogFactor);

  return vec4<f32>(color, 1.0);
}
`;

export interface TerrainUniforms {
  viewProj: Mat4;
  cameraPos: [number, number, number];
  time: number;
  patchSize: number;
  originX: number;
  originZ: number;
}

export class TerrainPass extends RenderPass {
  name = "terrain";
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;
  private surfaceFormat: GPUTextureFormat;
  private msaaSampleCount: number = 1;
  private gridSize: number;
  private uniformData = new Float32Array(24);

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, msaaSampleCount = 1, gridSize = 128) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.msaaSampleCount = msaaSampleCount;
    this.gridSize = gridSize;
  }

  prepare(_device: GPUDevice): void {
    if (this.pipeline) return;

    this.shaderModule = this.device.createShaderModule({ code: TERRAIN_SHADER });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const gridSize = this.gridSize;
    const vertices: number[] = [];
    for (let z = 0; z <= gridSize; z++) {
      for (let x = 0; x <= gridSize; x++) {
        vertices.push(x, z);
      }
    }
    this.vertexBuffer = this.device.createBuffer({
      size: vertices.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));

    const indices: number[] = [];
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const i = z * (gridSize + 1) + x;
        indices.push(i, i + 1, i + gridSize + 1);
        indices.push(i + 1, i + gridSize + 2, i + gridSize + 1);
      }
    }
    this.indexCount = indices.length;
    this.indexBuffer = this.device.createBuffer({
      size: indices.length * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, new Uint16Array(indices));

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        }],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: this.msaaSampleCount },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  setUniforms(u: TerrainUniforms): void {
    if (!this.uniformBuffer) return;
    const data = this.uniformData;
    data.set(u.viewProj as Float32Array, 0);
    data[16] = u.cameraPos[0];
    data[17] = u.cameraPos[1];
    data[18] = u.cameraPos[2];
    data[19] = u.time;
    data[20] = u.patchSize;
    data[21] = u.originX;
    data[22] = u.originZ;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data as unknown as BufferSource);
  }

  execute(ctx: RenderPassContext): void {
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer || !this.indexBuffer) return;

    const tracked = ctx.pass instanceof TrackedRenderPass ? ctx.pass : new TrackedRenderPass(ctx.pass);
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.setVertexBuffer(0, this.vertexBuffer);
    tracked.setIndexBuffer(this.indexBuffer, "uint16");
    tracked.drawIndexed(this.indexCount);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.pipeline = null;
    this.shaderModule = null;
    this.bindGroup = null;
  }
}
