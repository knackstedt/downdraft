import { createValidatedShaderModule } from "../render/shader-validator";
import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, mat4x4f, vec3f, wgsl } from "@downdraft/shader-graph";
import { type Mat4 } from "wgpu-matrix";
import type { GraphRenderContext } from "..";
import { RenderPass } from "..";
import type { ParticleGPUData } from "./particle-data";
import { packParticleBuffer } from "./particle-data";

// ─── Uniform structs (single source of truth for layout) ───────────────────
const CameraUniformsStruct: WgslStruct = wgsl.struct("CameraUniforms", {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  _pad: f32,
});

const PARTICLE_VERTEX_SHADER = `
${CameraUniformsStruct.wgsl}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var particleTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct ParticleInstance {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) size: f32,
  @location(3) rotation: f32,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

fn rotate2d(v: vec2<f32>, angle: f32) -> vec2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(v.x * c - v.y * s, v.x * s + v.y * c);
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) size: f32,
  @location(3) rotation: f32,
  @builtin(vertex_index) vi: u32,
) -> VertexOutput {
  // Quad: 2 triangles = 6 vertices
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );

  let corner = corners[vi];
  let rotated = rotate2d(corner, rotation);
  let worldPos = position + vec3<f32>(rotated * size, 0.0);

  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(worldPos, 1.0);
  output.uv = corner * 0.5 + 0.5;
  output.color = color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(particleTex, texSampler, input.uv);
  return input.color * texColor;
}
`;

const PARTICLE_VERTEX_SHADER_NO_TEX = `
${CameraUniformsStruct.wgsl}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

fn rotate2d(v: vec2<f32>, angle: f32) -> vec2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(v.x * c - v.y * s, v.x * s + v.y * c);
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) size: f32,
  @location(3) rotation: f32,
  @builtin(vertex_index) vi: u32,
) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );

  let corner = corners[vi];
  let rotated = rotate2d(corner, rotation);
  let worldPos = position + vec3<f32>(rotated * size, 0.0);

  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(worldPos, 1.0);
  output.uv = corner * 0.5 + 0.5;
  output.color = color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Soft circular falloff
  let d = length(input.uv - 0.5) * 2.0;
  let alpha = 1.0 - smoothstep(0.8, 1.0, d);
  return vec4<f32>(input.color.rgb, input.color.a * alpha);
}
`;

const INSTANCE_STRIDE = 48; // 3 pos + 4 color + 1 size + 1 rot + padding = 12 floats * 4

export class ParticleRenderPass extends RenderPass {
  name = "particle-render";
  private device: GPUDevice | null = null;
  private surfaceFormat: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private pipelineNoTex: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private shaderModuleNoTex: GPUShaderModule | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupNoTex: GPUBindGroup | null = null;
  private texture: GPUTexture | null = null;
  private textureView: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;
  private maxInstances: number;
  private useTexture: boolean = false;
  private _cameraView: StructView | null = null;
  private _cameraBuf: Float32Array | null = null;

  constructor(surfaceFormat: GPUTextureFormat = "rgba16float", maxInstances: number = 10000) {
    super();
    this.surfaceFormat = surfaceFormat;
    this.maxInstances = maxInstances;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.shaderModule = createValidatedShaderModule(device, { code: PARTICLE_VERTEX_SHADER, label: "ParticleRenderPass" });
    this.shaderModuleNoTex = createValidatedShaderModule(device, { code: PARTICLE_VERTEX_SHADER_NO_TEX, label: "ParticleRenderPass.noTex" });

    this.cameraBuffer = device.createBuffer({
      size: 80, // mat4x4 (64) + vec3 (12) + pad (4)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._cameraBuf = new Float32Array(CameraUniformsStruct.floatCount);
    this._cameraView = CameraUniformsStruct.view(this._cameraBuf);

    this.instanceBuffer = device.createBuffer({
      size: this.maxInstances * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Default 1x1 white texture
    this.texture = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const whitePixel = new Uint8Array([255, 255, 255, 255]);
    device.queue.writeTexture(
      { texture: this.texture },
      whitePixel as unknown as BufferSource,
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );
    this.textureView = this.texture.createView();
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    // Pipeline with texture
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: INSTANCE_STRIDE,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },   // position
            { shaderLocation: 1, offset: 12, format: "float32x4" },  // color
            { shaderLocation: 2, offset: 28, format: "float32" },     // size
            { shaderLocation: 3, offset: 32, format: "float32" },     // rotation
          ],
        }],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.textureView },
        { binding: 2, resource: this.sampler },
      ],
    });

    // Pipeline without texture (procedural soft particle)
    this.pipelineNoTex = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModuleNoTex,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: INSTANCE_STRIDE,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x4" },
            { shaderLocation: 2, offset: 28, format: "float32" },
            { shaderLocation: 3, offset: 32, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: this.shaderModuleNoTex,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroupNoTex = device.createBindGroup({
      layout: this.pipelineNoTex.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
      ],
    });
  }

  setCamera(viewProj: Mat4, cameraPos: [number, number, number]): void {
    if (!this.device || !this.cameraBuffer) return;
    const view = this._cameraView!;
    view.set("viewProj", viewProj as Float32Array);
    view.set("cameraPos", cameraPos);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, this._cameraBuf! as unknown as BufferSource);
  }

  setTexture(texture: GPUTexture): void {
    if (!this.device || !this.pipeline) return;
    this.textureView = texture.createView();
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer! } },
        { binding: 1, resource: this.textureView },
        { binding: 2, resource: this.sampler! },
      ],
    });
    this.useTexture = true;
  }

  renderInstances(ctx: GraphRenderContext, data: ParticleGPUData, maxParticles: number): void {
    if (!this.device || !this.pipeline || !ctx.pass) return;

    const packed = packParticleBuffer(data, maxParticles);
    const activeCount = this._countActive(data, maxParticles);
    if (activeCount === 0) return;

    // Build compacted instance data (only active particles)
    const instanceData = new Float32Array(activeCount * 12);
    let writeIdx = 0;
    for (let i = 0; i < maxParticles && writeIdx < activeCount; i++) {
      if (!data.active[i]) continue;
      const o = writeIdx * 12;
      instanceData[o + 0] = data.position[i * 3 + 0];
      instanceData[o + 1] = data.position[i * 3 + 1];
      instanceData[o + 2] = data.position[i * 3 + 2];
      instanceData[o + 3] = data.color[i * 4 + 0];
      instanceData[o + 4] = data.color[i * 4 + 1];
      instanceData[o + 5] = data.color[i * 4 + 2];
      instanceData[o + 6] = data.color[i * 4 + 3];
      instanceData[o + 7] = data.size[i];
      instanceData[o + 8] = data.rotation[i];
      writeIdx++;
    }

    const byteSize = Math.min(activeCount * INSTANCE_STRIDE, this.maxInstances * INSTANCE_STRIDE);
    this.device.queue.writeBuffer(this.instanceBuffer!, 0, instanceData.subarray(0, byteSize / 4) as unknown as BufferSource);

    const tracked = ctx.pass;

    if (this.useTexture && this.bindGroup) {
      tracked.setPipeline(this.pipeline);
      tracked.setBindGroup(0, this.bindGroup);
    } else {
      tracked.setPipeline(this.pipelineNoTex!);
      tracked.setBindGroup(0, this.bindGroupNoTex!);
    }
    tracked.setVertexBuffer(0, this.instanceBuffer!);
    tracked.draw(6, Math.min(activeCount, this.maxInstances));
  }

  private _countActive(data: ParticleGPUData, max: number): number {
    let count = 0;
    for (let i = 0; i < max; i++) {
      if (data.active[i]) count++;
    }
    return count;
  }

  execute(ctx: GraphRenderContext): void {
    // Use renderInstances() directly with particle data
    void ctx;
  }

  destroy(): void {
    this.instanceBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.texture?.destroy();
    this.instanceBuffer = null;
    this.cameraBuffer = null;
    this.texture = null;
    this.textureView = null;
    this.pipeline = null;
    this.pipelineNoTex = null;
    this._cameraView = null;
    this._cameraBuf = null;
  }
}
