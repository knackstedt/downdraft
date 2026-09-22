import { mat4 } from "wgpu-matrix";
import { createValidatedShaderModule } from "./shader-validator";

const SKYBOX_SHADER = /* wgsl */ `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  position: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var envMap: texture_cube<f32>;
@group(0) @binding(2) var envSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
  // Full-screen triangle
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );

  let pos = positions[vid];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 1.0, 1.0);
  // Reconstruct direction from clip position using inverse view-proj
  let farPoint = camera.invViewProj * vec4<f32>(pos, 1.0, 1.0);
  let nearPoint = camera.invViewProj * vec4<f32>(pos, -1.0, 1.0);
  let dir = normalize(farPoint.xyz / farPoint.w - nearPoint.xyz / nearPoint.w);
  output.direction = dir;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(envMap, envSampler, normalize(input.direction));
  return vec4<f32>(color.rgb, 1.0);
}
`;

export interface SkyboxOptions {
  format?: GPUTextureFormat;
  depthFormat?: GPUTextureFormat;
}

export class SkyboxRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;

  constructor(device: GPUDevice, options?: SkyboxOptions) {
    this.device = device;
    this.format = options?.format ?? "bgra8unorm";
    this.depthFormat = options?.depthFormat ?? "depth32float";
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  private ensurePipeline(): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    const shaderModule = createValidatedShaderModule(this.device, { code: SKYBOX_SHADER, label: "SkyboxPass" });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });

    this.cameraBuffer = this.device.createBuffer({
      size: 144, // mat4x4 (64) + mat4x4 (64) + vec4 (16)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  render(
    passEncoder: GPURenderPassEncoder,
    cubemap: GPUTexture,
    viewProj: Float32Array,
    cameraPos: [number, number, number],
  ): void {
    this.ensurePipeline();

    // Update camera buffer
    const camData = new Float32Array(36);
    camData.set(viewProj, 0);
    camData.set(mat4.invert(viewProj) as Float32Array, 16);
    camData[32] = cameraPos[0];
    camData[33] = cameraPos[1];
    camData[34] = cameraPos[2];
    camData[35] = 0;
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, camData);

    const cubemapView = cubemap.createView({ dimension: "cube" });

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer! } },
        { binding: 1, resource: cubemapView },
        { binding: 2, resource: this.sampler },
      ],
    });

    passEncoder.setPipeline(this.pipeline!);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3, 1, 0, 0);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
  }
}
