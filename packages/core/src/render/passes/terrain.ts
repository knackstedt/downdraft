import { type Mat4 } from "wgpu-matrix";
import type { RenderBackend } from "../backend/render-backend.ts";
import type { BackendBindGroup, BackendBuffer, BackendRenderPipeline, BackendShaderModule, TextureFormat } from "../backend/types.ts";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph.ts";
import { RenderPass } from "../render-pass.ts";

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
  hdrHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  private device: GPUDevice | null;
  private backend: RenderBackend | null;
  private pipeline: GPURenderPipeline | BackendRenderPipeline | null = null;
  private shaderModule: GPUShaderModule | BackendShaderModule | null = null;
  private uniformBuffer: GPUBuffer | BackendBuffer | null = null;
  private bindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private vertexBuffer: GPUBuffer | BackendBuffer | null = null;
  private indexBuffer: GPUBuffer | BackendBuffer | null = null;
  private indexCount = 0;
  private surfaceFormat: GPUTextureFormat | TextureFormat;
  private msaaSampleCount: number = 1;
  private gridSize: number;
  private uniformData = new Float32Array(24);

  constructor(device: GPUDevice | null, surfaceFormat: GPUTextureFormat | TextureFormat, msaaSampleCount = 1, gridSize = 128, backend?: RenderBackend | null) {
    super();
    this.device = device;
    this.backend = backend ?? null;
    this.surfaceFormat = surfaceFormat;
    this.msaaSampleCount = msaaSampleCount;
    this.gridSize = gridSize;
  }

  prepare(_device: GPUDevice, _backend?: RenderBackend | null): void {
    if (this.pipeline) return;

    const gridSize = this.gridSize;
    const vertices: number[] = [];
    for (let z = 0; z <= gridSize; z++) {
      for (let x = 0; x <= gridSize; x++) {
        vertices.push(x, z);
      }
    }
    const indices: number[] = [];
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const i = z * (gridSize + 1) + x;
        indices.push(i, i + 1, i + gridSize + 1);
        indices.push(i + 1, i + gridSize + 2, i + gridSize + 1);
      }
    }
    this.indexCount = indices.length;

    if (this.backend && !this.device) {
      const backend = this.backend;
      this.shaderModule = backend.createShaderModule({ wgsl: TERRAIN_SHADER }, "wgsl");
      this.uniformBuffer = backend.createBuffer({ size: 256, usage: 0x40 | 0x08 });
      this.vertexBuffer = backend.createBuffer({ size: vertices.length * 4, usage: 0x20 | 0x08 });
      backend.queue.writeBuffer(this.vertexBuffer as any, 0, new Float32Array(vertices) as any);
      this.indexBuffer = backend.createBuffer({ size: indices.length * 2, usage: 0x10 | 0x08 });
      backend.queue.writeBuffer(this.indexBuffer as any, 0, new Uint16Array(indices) as any);
      this.pipeline = backend.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule, entryPoint: "vs_main",
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
        },
        fragment: { module: this.shaderModule, entryPoint: "fs_main", targets: [{ format: this.surfaceFormat as TextureFormat }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: this.msaaSampleCount },
        depthStencil: { format: "depth32float" as any, depthWriteEnabled: true, depthCompare: "less" },
      });
      const bgLayout = (this.pipeline as any).getBindGroupLayout(0);
      this.bindGroup = backend.createBindGroup({
        layout: bgLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer as any } }],
      });
      return;
    }

    const dev = this.device!;
    this.shaderModule = dev.createShaderModule({ code: TERRAIN_SHADER });
    this.uniformBuffer = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vertexBuffer = dev.createBuffer({ size: vertices.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));
    this.indexBuffer = dev.createBuffer({ size: indices.length * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.indexBuffer, 0, new Uint16Array(indices));
    this.pipeline = dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule, entryPoint: "vs_main",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
      },
      fragment: { module: this.shaderModule, entryPoint: "fs_main", targets: [{ format: this.surfaceFormat as GPUTextureFormat }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: this.msaaSampleCount },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.bindGroup = dev.createBindGroup({
      layout: (this.pipeline as GPURenderPipeline).getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer as GPUBuffer } }],
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
    const queue = this.device?.queue ?? this.backend?.queue;
    queue?.writeBuffer(this.uniformBuffer as any, 0, data as any);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer || !this.indexBuffer || !ctx.pass) return;

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline as any);
    tracked.setBindGroup(0, this.bindGroup as any);
    tracked.setVertexBuffer(0, this.vertexBuffer as any);
    tracked.setIndexBuffer(this.indexBuffer as any, "uint16");
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
